import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
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
  WORKER_CONCURRENCY: '10',
  POLL_INTERVAL_MS: '50',
  PROCESSING_DELAY_MS: '50',
  PROCESSING_TIMEOUT_MS: '500',
  LEASE_MS: '1000',
  MAX_ATTEMPTS: '5',
});

describe('events worker lease reclaim (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let apps: NestExpressApplication[] = [];
  let logger: CaptureLogger;

  const events = () => testClient.db().collection<EventDocument>('events');
  const spy = () => new SpyProcessor(new ScriptedProcessor(() => 'success'));

  async function boot(processor: SpyProcessor) {
    const app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: ENV,
      configure: workerConfigure({ uri: mongo.uri, processor }),
    });
    apps.push(app);
    return app;
  }

  function expectCleanLogs(docs: EventDocument[]) {
    for (const line of workerLines(logger)) {
      expect(D10_PATTERNS.some((p) => p.test(line.message))).toBe(true);
    }
    for (const doc of docs) {
      expect(logger.all).not.toContain(doc.idempotencyKey);
      expect(logger.all).not.toContain(doc.patientId);
    }
  }

  beforeAll(async () => {
    mongo = await startMongo('worker_reclaim');
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  beforeEach(async () => {
    await events().deleteMany({});
    logger = new CaptureLogger();
  });

  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close().catch(() => undefined)));
    apps = [];
  });

  afterAll(async () => {
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-02 reclaims an expired processing event once', async () => {
    const expired = seedEvent({
      status: 'processing',
      attempts: 1,
      workerId: 'dead:1:aaaaaaaa',
      lockedUntil: new Date(Date.now() - 1000),
    });
    const held = seedEvent({
      status: 'processing',
      attempts: 1,
      workerId: 'dead:2:bbbbbbbb',
      lockedUntil: new Date(Date.now() + 3_600_000),
    });
    await events().insertMany([expired, held]);
    const processor = spy();
    await boot(processor);

    const done = await waitFor(async () => {
      const d = await events().findOne({ _id: expired._id });
      return d?.status === 'done' && d;
    });
    expect(done.attempts).toBe(2);
    expect(done.result).toBeDefined();
    expect(done).not.toHaveProperty('workerId');
    expect(done).not.toHaveProperty('lockedUntil');
    await new Promise((r) => setTimeout(r, 10 * 50));
    expect(processor.calls).toHaveLength(1);
    expect(processor.calls[0]!.input.idempotencyKey).toBe(
      expired.idempotencyKey,
    );
    const id = expired._id.toHexString();
    const reclaims = workerLines(logger).filter((l) =>
      l.message.startsWith('Reclaimed event'),
    );
    expect(reclaims).toEqual([
      {
        level: 'warn',
        message: `Reclaimed event ${id} after lease expiry (attempt 2)`,
      },
    ]);
    expect(await events().findOne({ _id: held._id })).toEqual(held);
    expectCleanLogs([expired, held]);
  });

  it('CA-05 two instances reclaim 100 expired events exactly once each', async () => {
    const seeded = Array.from({ length: 100 }, (_, i) =>
      seedEvent({
        status: 'processing',
        attempts: 1,
        workerId: 'dead:1:aaaaaaaa',
        lockedUntil: new Date(Date.now() - 1000),
        data: { i },
      }),
    );
    await events().insertMany(seeded);
    const a = spy();
    const b = spy();
    await boot(a);
    await boot(b);

    await waitFor(
      async () => (await events().countDocuments({ status: 'done' })) === 100,
      30_000,
    );
    const docs = await events().find().toArray();
    expect(docs.every((d) => d.attempts === 2)).toBe(true);
    const keys = [...a.calls, ...b.calls].map((c) => c.input.idempotencyKey);
    expect(keys).toHaveLength(100);
    expect(new Set(keys).size).toBe(100);
    expect(
      workerLines(logger).filter((l) =>
        l.message.startsWith('Reclaimed event'),
      ),
    ).toHaveLength(100);
    expectCleanLogs(seeded);
  }, 60_000);

  it('CA-11 the claim plan uses the claim index with no blocking sort', async () => {
    const past = new Date(Date.now() - 1000);
    await events().insertMany([
      ...Array.from({ length: 20 }, () => seedEvent()),
      ...Array.from({ length: 20 }, () =>
        seedEvent({
          status: 'processing',
          attempts: 1,
          workerId: 'x:1:aaaaaaaa',
          lockedUntil: new Date(Date.now() + 60_000),
        }),
      ),
    ]);
    const now = new Date();
    const explain = await testClient.db().command({
      explain: {
        findAndModify: 'events',
        query: {
          $or: [
            { status: 'pending', nextAttemptAt: { $lte: now } },
            { status: 'processing', lockedUntil: { $lt: now } },
          ],
        },
        sort: { nextAttemptAt: 1 },
        update: {
          $set: { status: 'processing', workerId: 'w', lockedUntil: past },
          $inc: { attempts: 1 },
        },
      },
      verbosity: 'executionStats',
    });
    const plan = explain.queryPlanner.winningPlan as Record<string, any>;
    console.log('CA-11 winning plan:', JSON.stringify(plan));
    const stages: Record<string, any>[] = [];
    const walk = (s: Record<string, any>) => {
      stages.push(s);
      if (s.inputStage) walk(s.inputStage);
      for (const child of s.inputStages ?? []) walk(child);
    };
    walk(plan);
    const scans = stages.filter((s) => s.stage === 'IXSCAN');
    expect(scans.length).toBeGreaterThanOrEqual(2);
    for (const scan of scans) {
      expect(scan.indexName).toBe('claim_status_nextAttemptAt');
    }
    expect(stages.some((s) => s.stage === 'SORT')).toBe(false);
  });
});
