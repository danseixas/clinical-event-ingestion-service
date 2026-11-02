import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import { SimulatedProcessor } from '../src/worker/simulated-processor.js';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  RecordedCommand,
  seedEvent,
  SpyProcessor,
  waitFor,
  workerConfigure,
  workerEnv,
} from './support/worker.js';

describe('events worker pool-full wake (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let app: NestExpressApplication | undefined;
  const sink: RecordedCommand[] = [];
  const spy = new SpyProcessor(
    new SimulatedProcessor({ delayMs: 100, failureRate: 0 }),
  );
  const events = () => testClient.db().collection<EventDocument>('events');

  beforeAll(async () => {
    mongo = await startMongo('worker_pool_wake');
    testClient = await new MongoClient(mongo.uri).connect();
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger: new CaptureLogger(),
      env: workerEnv({
        POLL_INTERVAL_MS: '1000',
        WORKER_CONCURRENCY: '1',
        PROCESSING_DELAY_MS: '100',
        PROCESSING_TIMEOUT_MS: '10000',
        LEASE_MS: '30000',
      }),
      configure: workerConfigure({ uri: mongo.uri, processor: spy, sink }),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-12 a freed slot triggers the next claim promptly', async () => {
    await new Promise((r) => setTimeout(r, 200));
    const base = Date.now() - 10_000;
    await events().insertMany(
      [0, 1, 2].map((i) =>
        seedEvent({ nextAttemptAt: new Date(base + i), data: { i } }),
      ),
    );
    await waitFor(
      async () => (await events().countDocuments({ status: 'done' })) === 3,
      15_000,
    );
    const claims = sink.filter(
      (c) => c.name === 'findAndModify' && c.command.findAndModify === 'events',
    );
    // Settle time of call n is its start plus the 100 ms simulated delay.
    for (let n = 1; n < 3; n++) {
      const settled = spy.calls[n - 1]!.startedAt + 100;
      const next = claims.find(
        (c) => c.at >= settled - 20 && c.at >= spy.calls[n - 1]!.startedAt + 80,
      );
      expect(next).toBeDefined();
      const gap = next!.at - settled;
      console.log(`pool wake: claim ${gap} ms after settle (call ${n})`);
      expect(gap).toBeLessThanOrEqual(200);
    }
  }, 30_000);
});
