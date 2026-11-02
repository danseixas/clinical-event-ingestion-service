import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { SimulatedProcessor } from '../src/worker/simulated-processor.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  seedEvent,
  SpyProcessor,
  waitFor,
  workerConfigure,
  workerEnv,
  workerLines,
} from './support/worker.js';

describe('events worker timeout and single attempt (e2e)', () => {
  let mongo: TestMongo;
  let app: NestExpressApplication | undefined;
  let testClient: MongoClient;
  let logger: CaptureLogger;

  const events = () => testClient.db().collection<EventDocument>('events');

  beforeAll(async () => {
    mongo = await startMongo('worker_timeout');
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  beforeEach(async () => {
    await events().deleteMany({});
    logger = new CaptureLogger();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  const boot = async (processor: SpyProcessor) => {
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: workerEnv({
        MAX_ATTEMPTS: '1',
        PROCESSING_DELAY_MS: '2000',
        PROCESSING_TIMEOUT_MS: '200',
        LEASE_MS: '5000',
        POLL_INTERVAL_MS: '50',
      }),
      configure: workerConfigure({ uri: mongo.uri, processor }),
    });
  };

  it('CA-12 records a timeout failure and aborts the call', async () => {
    const spy = new SpyProcessor(
      new SimulatedProcessor({ delayMs: 2000, failureRate: 0 }),
    );
    await boot(spy);
    const seeded = seedEvent();
    await events().insertOne(seeded);

    const doc = await waitFor(async () => {
      const d = await events().findOne({ _id: seeded._id });
      return d?.status === 'failed' && d;
    }, 5000);
    const callStart = spy.calls[0]!.startedAt;
    expect(Date.now() - callStart).toBeLessThanOrEqual(1500);
    expect(doc.lastError).toMatchObject({
      code: 'timeout',
      message: 'External call timed out after 200 ms',
    });
    expect(doc.lastError!.at).toBeInstanceOf(Date);
    expect(spy.calls[0]!.signal.aborted).toBe(true);
    await waitFor(() => spy.settled.length === 1);
    expect(spy.settled).toEqual(['rejected']);

    // Past the point where the simulated call would have finished.
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const d = await events().findOne({ _id: seeded._id });
      expect(d?.status).toBe('failed');
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 30_000);

  it('CA-11 with MAX_ATTEMPTS=1 the first failure is final', async () => {
    await boot(
      new SpyProcessor({
        process: () => Promise.reject(new Error('nope')),
      }),
    );
    const seeded = seedEvent();
    await events().insertOne(seeded);
    const doc = await waitFor(async () => {
      const d = await events().findOne({ _id: seeded._id });
      return d?.status === 'failed' && d;
    });
    expect(doc.attempts).toBe(1);
    expect(doc.lastError?.code).toBe('processor_error');
    // The log line follows the acknowledged write.
    await waitFor(() => workerLines(logger).some((l) => l.level === 'warn'));
    expect(workerLines(logger).filter((l) => l.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: `Event ${seeded._id.toHexString()} failed after 1 attempts (processor_error)`,
      },
    ]);
  });
});
