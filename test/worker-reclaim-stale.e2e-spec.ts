import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  BlockingProcessor,
  D10_PATTERNS,
  ScriptedProcessor,
  seedEvent,
  SpyProcessor,
  waitFor,
  workerConfigure,
  workerEnv,
  workerLines,
} from './support/worker.js';

const ENV = workerEnv({
  WORKER_CONCURRENCY: '1',
  POLL_INTERVAL_MS: '50',
  PROCESSING_DELAY_MS: '50',
  PROCESSING_TIMEOUT_MS: '10000',
  LEASE_MS: '30000',
});

describe('events worker stale holder after reclaim (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  const apps: NestExpressApplication[] = [];
  const logger = new CaptureLogger();
  const events = () => testClient.db().collection<EventDocument>('events');

  const boot = async (processor: BlockingProcessor | SpyProcessor) => {
    apps.push(
      await createTestApp({
        mongoUri: mongo.uri,
        logger,
        env: ENV,
        configure: workerConfigure({ uri: mongo.uri, processor }),
      }),
    );
  };

  beforeAll(async () => {
    mongo = await startMongo('worker_reclaim_stale');
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close().catch(() => undefined)));
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-04 fences the old holder after another worker reclaims', async () => {
    const blocking = new BlockingProcessor();
    await boot(blocking);
    const seed = seedEvent();
    await events().insertOne(seed);
    await waitFor(() => blocking.calls.length === 1);

    await events().updateOne(
      { _id: seed._id },
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );
    const spyB = new SpyProcessor(new ScriptedProcessor(() => 'success'));
    await boot(spyB);
    const done = await waitFor(async () => {
      const d = await events().findOne({ _id: seed._id });
      return d?.status === 'done' && d;
    });
    expect(done.attempts).toBe(2);

    blocking.releaseAll('success');
    const id = seed._id.toHexString();
    await waitFor(() =>
      workerLines(logger).some(
        (l) =>
          l.message === `Stale write discarded for event ${id} (attempt 1)`,
      ),
    );
    expect(await events().findOne({ _id: seed._id })).toEqual(done);
    expect(
      workerLines(logger).filter((l) =>
        l.message.startsWith('Reclaimed event'),
      ),
    ).toEqual([
      {
        level: 'warn',
        message: `Reclaimed event ${id} after lease expiry (attempt 2)`,
      },
    ]);
    expect(spyB.calls).toHaveLength(1);
    for (const line of workerLines(logger)) {
      expect(D10_PATTERNS.some((p) => p.test(line.message))).toBe(true);
    }
    expect(logger.all).not.toContain(seed.idempotencyKey);
  });
});
