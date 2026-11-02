import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient, ObjectId } from 'mongodb';
import request from 'supertest';
import type { EventDocument } from '../src/events/event.document.js';
import { SimulatedProcessor } from '../src/worker/simulated-processor.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  BlockingProcessor,
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
import type { EventProcessor } from '../src/worker/event-processor.js';

const ENV = workerEnv({
  WORKER_CONCURRENCY: '10',
  POLL_INTERVAL_MS: '50',
  PROCESSING_DELAY_MS: '50',
  FAILURE_RATE: '0',
  BACKOFF_BASE_MS: '200',
  BACKOFF_MAX_MS: '10000',
});

const BODY = {
  patientId: 'p-test-1',
  type: 'vitals',
  ts: '2026-11-02T10:00:00Z',
  data: { hr: 72 },
};

describe('events worker (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let apps: NestExpressApplication[] = [];
  let logger: CaptureLogger;
  let sink: RecordedCommand[];
  const failMethods: string[] = [];

  const events = () => testClient.db().collection<EventDocument>('events');
  const findDoc = (id: ObjectId) => events().findOne({ _id: id });

  async function boot(processor: EventProcessor, log = logger) {
    const app = await createTestApp({
      mongoUri: mongo.uri,
      logger: log,
      env: ENV,
      configure: workerConfigure({ uri: mongo.uri, processor, sink }),
    });
    apps.push(app);
    return app;
  }

  const failPoint = (data: Record<string, unknown> | null, mode: unknown) =>
    testClient.db('admin').command({
      configureFailPoint: 'failCommand',
      mode,
      ...(data ? { data: { appName: TEST_APP_NAME, ...data } } : {}),
    });

  beforeAll(async () => {
    mongo = await startMongo('worker', { enableTestCommands: true });
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  beforeEach(async () => {
    await events().deleteMany({});
    logger = new CaptureLogger();
    sink = [];
  });

  afterEach(async () => {
    await failPoint({ failCommands: ['update'] }, 'off').catch(() => undefined);
    for (const app of apps) await app.close();
    apps = [];
  }, 60_000);

  afterAll(async () => {
    await testClient?.close();
    await mongo?.stop();
    console.log(`failpoint usage: ${failMethods.join('; ')}`);
  }, 60_000);

  function expectCleanLogs(extraForbidden: string[] = []) {
    for (const line of workerLines(logger)) {
      expect(
        D10_PATTERNS.some((p) => p.test(line.message)),
        line.message,
      ).toBe(true);
    }
    expect(logger.all).not.toMatch(
      /p-test-1|vitals|2026-11-02|"hr"|\{"simulated":true\}/,
    );
    for (const text of extraForbidden) expect(logger.all).not.toContain(text);
  }

  it('CA-03/CA-20/D-11 processes a posted event to done', async () => {
    const spy = new SpyProcessor(
      new SimulatedProcessor({ delayMs: 50, failureRate: 0 }),
    );
    const app = await boot(spy);

    const res = await request(app.getHttpServer()).post('/events').send(BODY);
    expect(res.status).toBe(202);
    const id = new ObjectId(res.body.id as string);

    const doc = await waitFor(async () => {
      const d = await findDoc(id);
      return d && d.status !== 'pending' && d.status !== 'processing'
        ? d
        : undefined;
    });
    expect(doc.status).toBe('done');
    expect(doc.attempts).toBe(1);
    expect(doc.result).toEqual({ simulated: true });
    expect(doc.processedAt).toBeInstanceOf(Date);
    expect(doc).not.toHaveProperty('workerId');
    expect(doc).not.toHaveProperty('lockedUntil');
    expect(doc).not.toHaveProperty('lastError');
    expect(doc.patientId).toBe(BODY.patientId);
    expect(doc.type).toBe(BODY.type);
    expect(doc.data).toEqual(BODY.data);
    expect(doc.ts).toEqual(new Date(BODY.ts));

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.input.idempotencyKey).toBe(doc.idempotencyKey);
    expect(spy.calls[0]!.input.eventId).toBe(id.toHexString());

    // D-11: claim and outcome use a majority write concern.
    const claim = sink.find((c) => c.name === 'findAndModify');
    const update = sink.find(
      (c) => c.name === 'update' && c.command.update === 'events',
    );
    expect(claim?.command.writeConcern).toMatchObject({
      w: 'majority',
      wtimeout: 5000,
    });
    expect(update?.command.writeConcern).toMatchObject({
      w: 'majority',
      wtimeout: 5000,
    });

    expect(
      workerLines(logger).some((l) =>
        l.message.startsWith('Worker started: concurrency 10, workerId '),
      ),
    ).toBe(true);
    expect(workerLines(logger).filter((l) => l.level === 'warn')).toEqual([]);
    expectCleanLogs([doc.idempotencyKey]);
  });

  it('CA-04 holds the claim while processing, then completes', async () => {
    const blocking = new BlockingProcessor();
    await boot(blocking);
    const seeded = seedEvent();
    await events().insertOne(seeded);

    await waitFor(() => blocking.calls.length === 1);
    const claimedAt = blocking.calls[0]!.startedAt;
    const processing = (await findDoc(seeded._id))!;
    expect(processing.status).toBe('processing');
    expect(processing.attempts).toBe(1);
    expect(processing.workerId).toMatch(/^.+:\d+:[0-9a-f]{8}$/);
    expect(
      Math.abs(processing.lockedUntil!.getTime() - (claimedAt + 30_000)),
    ).toBeLessThan(1000);

    blocking.releaseAll();
    const done = await waitFor(async () => {
      const d = await findDoc(seeded._id);
      return d?.status === 'done' && d;
    });
    expect(done).not.toHaveProperty('workerId');
    expect(done).not.toHaveProperty('lockedUntil');
  });

  it('CA-05 claims due pending and expired processing events', async () => {
    const future = new Date(Date.now() + 3_600_000);
    const past = new Date(Date.now() - 60_000);
    const due = seedEvent();
    const expired = seedEvent({
      status: 'processing',
      attempts: 1,
      workerId: 'old:1:aaaaaaaa',
      lockedUntil: past,
    });
    const others = [
      seedEvent({ nextAttemptAt: future }),
      seedEvent({
        status: 'processing',
        attempts: 1,
        workerId: 'old:2:bbbbbbbb',
        lockedUntil: new Date(Date.now() + 3_600_000),
      }),
      seedEvent({
        status: 'done',
        attempts: 1,
        result: { simulated: true },
        processedAt: past,
      }),
      seedEvent({
        status: 'failed',
        attempts: 5,
        processedAt: past,
        lastError: { code: 'timeout', message: 'x', at: past },
      }),
    ];
    await events().insertMany([due, expired, ...others]);
    const spy = new SpyProcessor(new ScriptedProcessor(() => 'success'));
    await boot(spy);

    await waitFor(async () => (await findDoc(due._id))?.status === 'done');
    const reclaimed = await waitFor(async () => {
      const d = await findDoc(expired._id);
      return d?.status === 'done' && d;
    });
    expect(reclaimed.attempts).toBe(2);
    await new Promise((r) => setTimeout(r, 500));
    expect(spy.calls).toHaveLength(2);
    for (const other of others) {
      expect(await findDoc(other._id)).toEqual(other);
    }
  });

  it('CA-09 two instances never process an event twice', async () => {
    const make = () =>
      new SpyProcessor(new SimulatedProcessor({ delayMs: 20, failureRate: 0 }));
    const spyA = make();
    const spyB = make();
    await boot(spyA);
    await boot(spyB);

    const docs = Array.from({ length: 200 }, (_, i) =>
      seedEvent({ data: { n: i } }),
    );
    await events().insertMany(docs);
    await waitFor(
      async () => (await events().countDocuments({ status: 'done' })) === 200,
      30_000,
      50,
    );

    const all = await events().find().toArray();
    expect(all.every((d) => d.attempts === 1)).toBe(true);
    const keys = [...spyA.calls, ...spyB.calls].map(
      (c) => c.input.idempotencyKey,
    );
    expect(keys).toHaveLength(200);
    expect(new Set(keys).size).toBe(200);
    expect(spyA.calls.length).toBeGreaterThan(0);
    expect(spyB.calls.length).toBeGreaterThan(0);
  }, 60_000);

  it('CA-10/CA-20 retries with backoff and keeps lastError history', async () => {
    const scripted = new ScriptedProcessor((n) =>
      n < 3 ? 'simulated_failure' : 'success',
    );
    await boot(scripted);
    const seeded = seedEvent();
    await events().insertOne(seeded);

    const snapshots = new Map<number, EventDocument>();
    const final = await waitFor(async () => {
      const d = (await findDoc(seeded._id))!;
      if (d.status === 'pending' && d.lastError) snapshots.set(d.attempts, d);
      return d.status === 'done' && d;
    }, 15_000);

    for (const [attempts, cap] of [
      [1, 200],
      [2, 400],
    ] as const) {
      const snap = snapshots.get(attempts);
      expect(snap, `snapshot after attempt ${attempts}`).toBeDefined();
      expect(snap).not.toHaveProperty('workerId');
      expect(snap).not.toHaveProperty('lockedUntil');
      expect(snap!.lastError).toMatchObject({
        code: 'simulated_failure',
        message: 'Simulated external call failure',
      });
      const delay =
        snap!.nextAttemptAt.getTime() - snap!.lastError!.at.getTime();
      expect(delay).toBeGreaterThanOrEqual(cap / 2);
      expect(delay).toBeLessThanOrEqual(cap);
    }
    expect(final.attempts).toBe(3);
    expect(final.lastError?.code).toBe('simulated_failure');
    expect(final.lastError!.at).toEqual(snapshots.get(2)!.lastError!.at);
    expect(workerLines(logger).filter((l) => l.level === 'warn')).toEqual([]);
    expectCleanLogs();
    expect(D12_MESSAGES).toContain(final.lastError!.message);
  });

  describe('CA-13 fenced writes', () => {
    async function run(
      tamper: Record<string, unknown>,
      outcome: 'success' | 'error',
    ) {
      const blocking = new BlockingProcessor();
      await boot(blocking);
      const seeded = seedEvent();
      await events().insertOne(seeded);
      await waitFor(() => blocking.calls.length === 1);
      await events().updateOne({ _id: seeded._id }, tamper);
      const snapshot = (await findDoc(seeded._id))!;

      blocking.releaseAll(outcome);
      await waitFor(() =>
        workerLines(logger).some((l) => l.message.startsWith('Stale write')),
      );
      expect(await findDoc(seeded._id)).toEqual(snapshot);
      expect(workerLines(logger).filter((l) => l.level === 'warn')).toEqual([
        {
          level: 'warn',
          message: `Stale write discarded for event ${seeded._id.toHexString()} (attempt 1)`,
        },
      ]);
      expectCleanLogs();
    }

    it('rejects a success after attempts changed', () =>
      run({ $inc: { attempts: 1 } }, 'success'));
    it('rejects a failure after attempts changed', () =>
      run({ $inc: { attempts: 1 } }, 'error'));
    it('rejects a success after workerId changed', () =>
      run({ $set: { workerId: 'other:1:cccccccc' } }, 'success'));
  });

  async function failpointWorks(): Promise<boolean> {
    try {
      await failPoint({ failCommands: ['update'] }, 'off');
      return true;
    } catch {
      return false;
    }
  }

  it('CA-14(a) retries the outcome write through a short outage', async () => {
    expect(await failpointWorks()).toBe(true);
    const scripted = new ScriptedProcessor(() => 'success');
    await boot(scripted);
    await failPoint(
      { failCommands: ['update'], closeConnection: true },
      { times: 4 },
    );
    const seeded = seedEvent();
    await events().insertOne(seeded);

    const done = await waitFor(async () => {
      const d = await findDoc(seeded._id);
      return d?.status === 'done' && d;
    }, 15_000);
    const updates = sink.filter(
      (c) => c.name === 'update' && c.command.update === 'events',
    );
    failMethods.push(
      `CA-14(a) failCommand update closeConnection times=4, observed ${updates.length} update commands`,
    );
    expect(done.attempts).toBe(1);
    expect(scripted.calls).toHaveLength(1);
    expect(workerLines(logger).filter((l) => l.level === 'warn')).toEqual([]);
    expectCleanLogs();
  }, 30_000);

  it('CA-14(b) abandons the write after the retries and keeps working', async () => {
    expect(await failpointWorks()).toBe(true);
    const scripted = new ScriptedProcessor(() => 'success');
    await boot(scripted);
    await failPoint(
      { failCommands: ['update'], closeConnection: true },
      'alwaysOn',
    );
    const first = seedEvent();
    await events().insertOne(first);

    await waitFor(
      () => workerLines(logger).some((l) => l.message.includes('abandoned')),
      20_000,
    );
    const warns = workerLines(logger).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toMatch(
      new RegExp(
        `^Write for event ${first._id.toHexString()} abandoned: Mongo\\w*Error`,
      ),
    );
    const stuck = (await findDoc(first._id))!;
    expect(stuck.status).toBe('processing');
    expect(stuck.attempts).toBe(1);
    expect(stuck.workerId).toBeDefined();
    expect(stuck.lockedUntil).toBeDefined();
    expect(scripted.calls).toHaveLength(1);

    await failPoint({ failCommands: ['update'] }, 'off');
    const second = seedEvent();
    await events().insertOne(second);
    await waitFor(async () => (await findDoc(second._id))?.status === 'done');
    failMethods.push('CA-14(b) failCommand update closeConnection alwaysOn');
    expectCleanLogs();
  }, 40_000);

  it('CA-15(a) keeps polling after claim errors', async () => {
    expect(await failpointWorks()).toBe(true);
    const scripted = new ScriptedProcessor(() => 'success');
    await boot(scripted);
    await failPoint(
      { failCommands: ['findAndModify'], errorCode: 2 },
      { times: 3 },
    );
    const seeded = seedEvent();
    await events().insertOne(seeded);

    await waitFor(async () => (await findDoc(seeded._id))?.status === 'done');
    const warns = workerLines(logger).filter((l) => l.level === 'warn');
    expect(warns.map((w) => w.message)).toEqual([
      'Claim failed: MongoServerError (code 2)',
      'Claim failed: MongoServerError (code 2)',
      'Claim failed: MongoServerError (code 2)',
    ]);
    failMethods.push(
      'CA-15(a) failCommand findAndModify errorCode=2 times=3 (non-retryable)',
    );
  }, 30_000);
});
