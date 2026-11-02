import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import type { EventDocument } from '../src/events/event.document.js';
import {
  dueFilter,
  expiredLeaseFilter,
  OLDEST_DUE_OPTIONS,
} from '../src/stats/stats.service.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  RecordedCommand,
  seedEvent,
  workerConfigure,
  workerEnv,
} from './support/worker.js';

const CLAIM = 'claim_status_nextAttemptAt';

function collectWinningPlans(node: unknown, out: unknown[]) {
  if (Array.isArray(node)) node.forEach((n) => collectWinningPlans(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'winningPlan') out.push(v);
      else collectWinningPlans(v, out);
    }
  }
}

function walk(node: unknown, stages: string[], indexes: string[]) {
  if (Array.isArray(node)) node.forEach((n) => walk(n, stages, indexes));
  else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.stage === 'string') {
      stages.push(obj.stage);
      if (
        (obj.stage === 'IXSCAN' || obj.stage === 'COUNT_SCAN') &&
        typeof obj.indexName === 'string'
      ) {
        indexes.push(obj.indexName);
      }
    }
    Object.values(obj).forEach((v) => walk(v, stages, indexes));
  }
}

describe('GET /stats (e2e)', () => {
  let mongo: TestMongo;
  let app: NestExpressApplication;
  let client: MongoClient;
  const logger = new CaptureLogger();
  const sink: RecordedCommand[] = [];
  const col = () => client.db().collection<EventDocument>('events');

  async function seedMain(t0: number) {
    const docs: EventDocument[] = [
      ...[10_000, 5000, 1000].map((ms) =>
        seedEvent({ nextAttemptAt: new Date(t0 - ms) }),
      ),
      ...[0, 1].map(() => seedEvent({ nextAttemptAt: new Date(t0 + 60_000) })),
      ...[0, 1, 2, 3].map(() =>
        seedEvent({
          status: 'processing',
          attempts: 1,
          workerId: 'w',
          lockedUntil: new Date(t0 + 30_000),
        }),
      ),
      seedEvent({
        status: 'processing',
        attempts: 1,
        workerId: 'w',
        lockedUntil: new Date(t0 - 1000),
      }),
      ...[0, 1, 2, 3, 4].map(() => seedEvent({ status: 'done' })),
      ...[0, 1].map(() => seedEvent({ status: 'failed' })),
    ];
    await col().insertMany(docs);
    return docs;
  }

  beforeAll(async () => {
    mongo = await startMongo('stats');
    client = new MongoClient(mongo.uri);
    await client.connect();
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: workerEnv({ WORKER_ENABLED: 'false' }),
      configure: workerConfigure({ uri: mongo.uri, sink }),
    });
  }, 180_000);

  beforeEach(async () => {
    await col().deleteMany({});
    sink.length = 0;
    logger.lines.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-06 reports exact counts, due, leases and age for the seed', async () => {
    const t0 = Date.now();
    const docs = await seedMain(t0);
    const start = Date.now();
    const res = await request(app.getHttpServer()).get('/stats?foo=1');
    const end = Date.now();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual([
      'counts',
      'due',
      'expiredLeases',
      'oldestDueAgeMs',
      'generatedAt',
    ]);
    expect(Object.keys(res.body.counts)).toEqual([
      'pending',
      'processing',
      'done',
      'failed',
    ]);
    expect(res.body.counts).toEqual({
      pending: 5,
      processing: 5,
      done: 5,
      failed: 2,
    });
    expect(res.body.due).toBe(3);
    expect(res.body.expiredLeases).toBe(1);
    expect(Number.isInteger(res.body.oldestDueAgeMs)).toBe(true);
    expect(res.body.oldestDueAgeMs).toBeGreaterThanOrEqual(10_000);
    expect(res.body.oldestDueAgeMs).toBeLessThanOrEqual(10_000 + (end - t0));
    const generated = new Date(res.body.generatedAt);
    expect(generated.toISOString()).toBe(res.body.generatedAt);
    expect(generated.getTime()).toBeGreaterThanOrEqual(start);
    expect(generated.getTime()).toBeLessThanOrEqual(end);

    // CA-10
    expect(logger.lines).toEqual([]);
    const text = JSON.stringify(res.body);
    for (const needle of ['p-test-1', 'vitals', '72', '2026-11-02T10:00:00']) {
      expect(text).not.toContain(needle);
    }
    for (const d of docs) {
      expect(text).not.toContain(d._id.toHexString());
      expect(text).not.toContain(d.idempotencyKey);
    }
  });

  it('CA-06 reports zeros for an empty collection', async () => {
    const res = await request(app.getHttpServer()).get('/stats');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      pending: 0,
      processing: 0,
      done: 0,
      failed: 0,
    });
    expect(res.body).toMatchObject({
      due: 0,
      expiredLeases: 0,
      oldestDueAgeMs: 0,
    });
  });

  it('CA-06 reports no lag when pending events are only in the future', async () => {
    const t0 = Date.now();
    await col().insertMany([
      seedEvent({ nextAttemptAt: new Date(t0 + 60_000) }),
      seedEvent({ nextAttemptAt: new Date(t0 + 60_000) }),
    ]);
    const res = await request(app.getHttpServer()).get('/stats');
    expect(res.body.counts.pending).toBe(2);
    expect(res.body.due).toBe(0);
    expect(res.body.oldestDueAgeMs).toBe(0);
  });

  it('D-05 sends six counts and one find with maxTimeMS and no read concern', async () => {
    await seedMain(Date.now());
    sink.length = 0;
    const res = await request(app.getHttpServer()).get('/stats');
    const eventsCmds = sink.filter(
      (c) => c.command.aggregate === 'events' || c.command.find === 'events',
    );
    const aggregates = eventsCmds.filter((c) => c.name === 'aggregate');
    const finds = eventsCmds.filter((c) => c.name === 'find');
    expect(aggregates).toHaveLength(6);
    expect(finds).toHaveLength(1);
    for (const c of eventsCmds) {
      expect(c.command.maxTimeMS).toBe(5000);
      expect(c.command.readConcern).toBeUndefined();
      expect(c.command.startTransaction).toBeUndefined();
      expect(c.command.txnNumber).toBeUndefined();
    }
    const find = finds[0]!.command;
    expect(Object.fromEntries(find.sort)).toEqual({ nextAttemptAt: 1 });
    expect(find.projection).toEqual({ nextAttemptAt: 1 });
    expect(find.limit).toBe(1);
    expect(find.filter.nextAttemptAt.$lte.toISOString()).toBe(
      res.body.generatedAt,
    );
  });

  it('CA-08 serves every query from the claim index', async () => {
    await seedMain(Date.now());
    const now = new Date();
    const filters: [string, Record<string, unknown>][] = [
      ['count pending', { status: 'pending' }],
      ['count processing', { status: 'processing' }],
      ['count done', { status: 'done' }],
      ['count failed', { status: 'failed' }],
      ['count due', dueFilter(now)],
      ['count expiredLeases', expiredLeaseFilter(now)],
    ];
    const explains: [string, any][] = [];
    for (const [name, f] of filters) {
      explains.push([
        name,
        await col()
          .aggregate([{ $match: f }, { $group: { _id: 1, n: { $sum: 1 } } }])
          .explain('executionStats'),
      ]);
    }
    explains.push([
      'findOne oldest due',
      await col()
        .find(dueFilter(now), {
          sort: { ...OLDEST_DUE_OPTIONS.sort },
          projection: { ...OLDEST_DUE_OPTIONS.projection },
        })
        .limit(1)
        .explain('executionStats'),
    ]);
    for (const [name, explain] of explains) {
      const plans: unknown[] = [];
      collectWinningPlans(explain, plans);
      expect(plans.length, name).toBeGreaterThan(0);
      const stages: string[] = [];
      const indexes: string[] = [];
      plans.forEach((p) => walk(p, stages, indexes));
      console.log(`CA-08 ${name}:`, JSON.stringify(plans));
      expect(indexes.length, name).toBeGreaterThan(0);
      expect(
        indexes.every((i) => i === CLAIM),
        name,
      ).toBe(true);
      expect(stages, name).not.toContain('COLLSCAN');
      expect(stages, name).not.toContain('SORT');
    }
  });
});
