import { LoggerService } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  BlockingProcessor,
  RecordedCommand,
  ScriptedProcessor,
  seedEvent,
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

describe('events worker with concurrency 1 (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let app: NestExpressApplication | undefined;
  let sink: RecordedCommand[];
  let logger: MarkingLogger;

  const events = () => testClient.db().collection<EventDocument>('events');
  const env = workerEnv({
    WORKER_CONCURRENCY: '1',
    POLL_INTERVAL_MS: '50',
    PROCESSING_DELAY_MS: '50',
  });

  const boot = async (processor: ScriptedProcessor | BlockingProcessor) => {
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger: logger as LoggerService,
      env,
      configure: workerConfigure({ uri: mongo.uri, processor, sink }),
    });
  };

  beforeAll(async () => {
    mongo = await startMongo('worker_c1');
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  beforeEach(async () => {
    await events().deleteMany({});
    sink = [];
    logger = new MarkingLogger(sink);
  });

  afterEach(async () => {
    await app?.close().catch(() => undefined);
    app = undefined;
  });

  afterAll(async () => {
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-06 claims in ascending nextAttemptAt order', async () => {
    const base = Date.now() - 100_000;
    const seeded = [3, 0, 4, 1, 2].map((i) =>
      seedEvent({ nextAttemptAt: new Date(base + i * 1000), data: { i } }),
    );
    await events().insertMany(seeded);
    const scripted = new ScriptedProcessor(() => 'success');
    await boot(scripted);

    await waitFor(() => scripted.calls.length === 5);
    expect(scripted.calls.map((c) => c.input.data.i)).toEqual([0, 1, 2, 3, 4]);
  });

  it('CA-16(a) close waits for the in-flight attempt', async () => {
    const blocking = new BlockingProcessor();
    await boot(blocking);
    const seeded = Array.from({ length: 4 }, (_, i) =>
      seedEvent({
        nextAttemptAt: new Date(Date.now() - 10_000 + i),
        data: { i },
      }),
    );
    await events().insertMany(seeded);
    await waitFor(() => blocking.calls.length === 1);

    let closed = false;
    const closing = app!.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(closed).toBe(false);
    blocking.releaseAll();
    await closing;
    app = undefined;

    const docs = await events().find().sort({ nextAttemptAt: 1 }).toArray();
    expect(docs[0]!.status).toBe('done');
    for (const doc of docs.slice(1)) {
      expect(doc.status).toBe('pending');
      expect(doc.attempts).toBe(0);
    }
    expect(workerLines(logger).map((l) => l.message)).toContain(
      'Worker stopped',
    );
    expect(logger.marker).toBeDefined();
    const after = sink
      .slice(logger.marker!)
      .filter(
        (c) =>
          (c.name === 'findAndModify' &&
            c.command.findAndModify === 'events') ||
          (c.name === 'update' && c.command.update === 'events'),
      );
    expect(after).toEqual([]);
  });

  it('CA-16(b) close on an idle worker is prompt', async () => {
    await boot(new ScriptedProcessor(() => 'success'));
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await app!.close();
    app = undefined;
    expect(Date.now() - started).toBeLessThanOrEqual(50 + 1000);
  });
});
