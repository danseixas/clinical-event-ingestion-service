import { LoggerService } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  BlockingProcessor,
  D10_PATTERNS,
  RecordedCommand,
  ScriptedProcessor,
  seedEvent,
  SpyProcessor,
  TEST_APP_NAME,
  waitFor,
  workerConfigure,
  workerEnv,
  workerLines,
} from './support/worker.js';

// Remembers how many commands had been sent when `Worker stopped` arrived.
class MarkingLogger extends CaptureLogger {
  marker: number | undefined;
  constructor(private readonly sink: RecordedCommand[]) {
    super();
  }
  override log(message: unknown, ...params: unknown[]) {
    if (message === 'Worker stopped') this.marker = this.sink.length;
    super.log(message, ...params);
  }
}

const isWrite = (c: RecordedCommand) =>
  (c.name === 'findAndModify' && c.command.findAndModify === 'events') ||
  (c.name === 'update' && c.command.update === 'events');

describe('events worker bounded shutdown (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let app: NestExpressApplication | undefined;
  let sink: RecordedCommand[];
  let logger: MarkingLogger;

  const events = () => testClient.db().collection<EventDocument>('events');

  async function boot(processor: BlockingProcessor | SpyProcessor) {
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger: logger as LoggerService,
      env: workerEnv({
        SHUTDOWN_TIMEOUT_MS: '300',
        PROCESSING_TIMEOUT_MS: '4000',
        LEASE_MS: '5000',
        POLL_INTERVAL_MS: '50',
        PROCESSING_DELAY_MS: '50',
        WORKER_CONCURRENCY: '10',
      }),
      configure: workerConfigure({ uri: mongo.uri, processor, sink }),
    });
  }

  beforeAll(async () => {
    mongo = await startMongo('worker_shutdown_timeout', {
      enableTestCommands: true,
    });
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  beforeEach(async () => {
    await events().deleteMany({});
    sink = [];
    logger = new MarkingLogger(sink);
  });

  afterEach(async () => {
    await testClient
      .db('admin')
      .command({ configureFailPoint: 'failCommand', mode: 'off' })
      .catch(() => undefined);
    await app?.close().catch(() => undefined);
    app = undefined;
  });

  afterAll(async () => {
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-08/CA-09 aborts at the deadline, sends no commands after, and is reclaimed later', async () => {
    const blocking = new BlockingProcessor();
    await boot(blocking);
    const seeded = [
      seedEvent({ data: { i: 0 } }),
      seedEvent({ data: { i: 1 } }),
    ];
    await events().insertMany(seeded);
    await waitFor(() => blocking.calls.length === 2);
    const before = await events().find().sort({ _id: 1 }).toArray();

    const started = Date.now();
    await app!.close();
    const closeMs = Date.now() - started;
    app = undefined;
    console.log(`shutdown timeout: close took ${closeMs} ms`);
    expect(closeMs).toBeLessThanOrEqual(300 + 1000);

    expect(workerLines(logger).map((l) => l.message)).toEqual([
      expect.stringMatching(/^Worker started/),
      'Worker stopping: 2 attempts in flight',
      'Shutdown timeout after 300 ms: 2 attempts left for lease reclaim',
      'Worker stopped',
    ]);
    expect(blocking.calls.every((c) => c.signal.aborted)).toBe(true);
    const after = await events().find().sort({ _id: 1 }).toArray();
    expect(after).toEqual(before);
    expect(
      after.every((d) => d.status === 'processing' && d.attempts === 1),
    ).toBe(true);

    await new Promise((r) => setTimeout(r, 4000 + 500));
    expect(sink.slice(logger.marker!).filter(isWrite)).toEqual([]);

    for (const line of workerLines(logger)) {
      expect(D10_PATTERNS.some((p) => p.test(line.message))).toBe(true);
    }

    const lockedUntil = Math.max(...after.map((d) => d.lockedUntil!.getTime()));
    await new Promise((r) =>
      setTimeout(r, Math.max(0, lockedUntil - Date.now()) + 100),
    );
    logger = new MarkingLogger(sink);
    const spy = new SpyProcessor(new ScriptedProcessor(() => 'success'));
    await boot(spy);
    await waitFor(
      async () => (await events().countDocuments({ status: 'done' })) === 2,
    );
    const done = await events().find().toArray();
    expect(done.every((d) => d.attempts === 2)).toBe(true);
  }, 30_000);

  it('CA-09 sends no write retry after the deadline', async () => {
    const blocking = new BlockingProcessor();
    await boot(blocking);
    const seed = seedEvent();
    await events().insertOne(seed);
    await waitFor(() => blocking.calls.length === 1);
    await testClient.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: 'alwaysOn',
      data: {
        failCommands: ['update'],
        closeConnection: true,
        appName: TEST_APP_NAME,
      },
    });
    blocking.releaseAll('success');
    await waitFor(() =>
      sink.some((c) => c.name === 'update' && c.command.update === 'events'),
    );

    await app!.close();
    app = undefined;
    expect(logger.marker).toBeDefined();
    await new Promise((r) => setTimeout(r, 1500));
    expect(sink.slice(logger.marker!).filter(isWrite)).toEqual([]);
    for (const line of workerLines(logger)) {
      expect(D10_PATTERNS.some((p) => p.test(line.message))).toBe(true);
    }
  }, 30_000);
});
