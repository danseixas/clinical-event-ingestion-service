import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  D10_PATTERNS,
  D12_MESSAGES,
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

const ENV = workerEnv({
  MAX_ATTEMPTS: '3',
  WORKER_CONCURRENCY: '10',
  POLL_INTERVAL_MS: '50',
  PROCESSING_DELAY_MS: '50',
  PROCESSING_TIMEOUT_MS: '500',
  LEASE_MS: '1000',
});

describe('events worker attempt-limit guard (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let app: NestExpressApplication | undefined;
  let logger: CaptureLogger;

  const events = () => testClient.db().collection<EventDocument>('events');

  async function boot(processor: SpyProcessor, sink?: RecordedCommand[]) {
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: ENV,
      configure: workerConfigure({ uri: mongo.uri, processor, sink }),
    });
  }

  const expired = (attempts: number) =>
    seedEvent({
      status: 'processing',
      attempts,
      workerId: 'dead:1:aaaaaaaa',
      lockedUntil: new Date(Date.now() - 1000),
    });

  const finalDoc = async (seed: EventDocument, status: string) =>
    waitFor(async () => {
      const d = await events().findOne({ _id: seed._id });
      return d?.status === status && d;
    }, 15_000);

  function expectCleanLogs(seed: EventDocument) {
    for (const line of workerLines(logger)) {
      expect(D10_PATTERNS.some((p) => p.test(line.message))).toBe(true);
    }
    expect(logger.all).not.toContain(seed.idempotencyKey);
    expect(logger.all).not.toContain(seed.patientId);
  }

  beforeAll(async () => {
    mongo = await startMongo('worker_reclaim_limit', {
      enableTestCommands: true,
    });
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  beforeEach(async () => {
    await events().deleteMany({});
    logger = new CaptureLogger();
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

  it('CA-03(a) fails a reclaim past the limit without calling the processor', async () => {
    const seed = expired(3);
    await events().insertOne(seed);
    const processor = new SpyProcessor(new ScriptedProcessor(() => 'success'));
    await boot(processor);

    const doc = await finalDoc(seed, 'failed');
    // The log line follows the write, so wait for it.
    await waitFor(() =>
      workerLines(logger).some((l) => l.message.includes('lease_expired')),
    );
    expect(processor.calls).toHaveLength(0);
    expect(doc.attempts).toBe(4);
    expect(doc.processedAt).toBeInstanceOf(Date);
    expect(doc.lastError).toEqual({
      code: 'lease_expired',
      message: 'Lease expired before the attempt completed',
      at: expect.any(Date),
    });
    for (const f of ['result', 'workerId', 'lockedUntil']) {
      expect(doc).not.toHaveProperty(f);
    }
    const id = seed._id.toHexString();
    expect(
      workerLines(logger)
        .filter((l) => l.level === 'warn')
        .map((l) => l.message),
    ).toEqual([
      `Reclaimed event ${id} after lease expiry (attempt 4)`,
      `Event ${id} failed after 4 attempts (lease_expired)`,
    ]);
    expect(D12_MESSAGES).toContain(doc.lastError!.message);
    expectCleanLogs(seed);
  });

  it('CA-03(b) runs a reclaim at the limit and fails it as processor_error', async () => {
    const seed = expired(2);
    await events().insertOne(seed);
    const processor = new SpyProcessor(new ScriptedProcessor(() => 'error'));
    await boot(processor);

    const doc = await finalDoc(seed, 'failed');
    expect(processor.calls).toHaveLength(1);
    expect(doc.attempts).toBe(3);
    expect(doc.lastError!.code).toBe('processor_error');
    expect(logger.all).not.toContain('lease_expired');
    expectCleanLogs(seed);
  });

  it('CA-03(c) does not apply the guard to a pending claim', async () => {
    const seed = seedEvent({ attempts: 5 });
    await events().insertOne(seed);
    const processor = new SpyProcessor(new ScriptedProcessor(() => 'success'));
    await boot(processor);

    const doc = await finalDoc(seed, 'done');
    expect(doc.attempts).toBe(6);
    expect(processor.calls).toHaveLength(1);
    expect(logger.all).not.toContain('Reclaimed event');
    expectCleanLogs(seed);
  });

  it('CA-03(d) reclaims again after an abandoned guard write', async () => {
    const seed = expired(3);
    await events().insertOne(seed);
    // One driver try plus its one driver retry, as observed in Phase 3.
    await testClient.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 2 },
      data: {
        failCommands: ['update'],
        closeConnection: true,
        appName: TEST_APP_NAME,
      },
    });
    const sink: RecordedCommand[] = [];
    const processor = new SpyProcessor(new ScriptedProcessor(() => 'success'));
    await boot(processor, sink);
    console.log(
      'failpoint usage (CA-03 d): failCommand update closeConnection times 2',
    );

    await waitFor(
      () => workerLines(logger).some((l) => l.message.includes('abandoned')),
      15_000,
    );
    const doc = await finalDoc(seed, 'failed');
    expect(doc.attempts).toBe(5);
    expect(doc.lastError!.code).toBe('lease_expired');
    expect(processor.calls).toHaveLength(0);
    expectCleanLogs(seed);
  }, 30_000);
});
