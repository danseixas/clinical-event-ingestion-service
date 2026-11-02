import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient, ObjectId } from 'mongodb';
import request from 'supertest';
import {
  CLAIM_INDEX_NAME,
  IDEMPOTENCY_INDEX_NAME,
  PATIENT_READ_ORDER_INDEX_NAME,
} from '../src/database/database.module.js';
import { MONGO_CLIENT } from '../src/database/database.tokens.js';
import type { EventDocument } from '../src/events/event.document.js';
import { computeIdempotencyKey } from '../src/events/idempotency-key.js';
import { findPatientEvents } from '../src/events/patient-events.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';

type Command = { name: string; command: Record<string, any> };

const oid = (n: number) =>
  ObjectId.createFromHexString(n.toString(16).padStart(24, '0'));
const hex = (n: number) => n.toString(16).padStart(64, '0');
const at = (sec: number) => new Date(Date.UTC(2026, 10, 2, 12, 0, sec));

function doc(
  n: number,
  patientId: string,
  tsSec: number,
  recvSec: number,
  extra: Partial<EventDocument> = {},
): EventDocument {
  return {
    _id: oid(n),
    idempotencyKey: hex(n),
    patientId,
    type: 'vitals',
    data: { hr: 70 + n },
    ts: at(tsSec),
    receivedAt: at(recvSec),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: at(recvSec),
    ...extra,
  };
}

// Collects stage names and IXSCAN index names from a winning plan.
function walkPlan(node: unknown, stages: string[], indexes: string[]) {
  if (Array.isArray(node)) {
    node.forEach((n) => walkPlan(n, stages, indexes));
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.stage === 'string') {
      stages.push(obj.stage);
      if (obj.stage === 'IXSCAN' && typeof obj.indexName === 'string') {
        indexes.push(obj.indexName);
      }
    }
    Object.values(obj).forEach((v) => walkPlan(v, stages, indexes));
  }
}

function planOf(explain: Record<string, any>) {
  const stages: string[] = [];
  const indexes: string[] = [];
  walkPlan(explain.queryPlanner.winningPlan, stages, indexes);
  return { stages, indexes };
}

const EXPECTED_KEYS: Record<string, string[]> = {
  _id_: ['_id'],
  [IDEMPOTENCY_INDEX_NAME]: ['idempotencyKey'],
  [CLAIM_INDEX_NAME]: ['status', 'nextAttemptAt'],
  [PATIENT_READ_ORDER_INDEX_NAME]: ['patientId', 'ts', 'receivedAt', '_id'],
};

describe('events data model (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  const apps: NestExpressApplication[] = [];
  const clients: MongoClient[] = [];
  const commands: Command[] = [];

  const col = () => testClient.db().collection<EventDocument>('events');

  async function boot(logger?: CaptureLogger) {
    const app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: { WORKER_ENABLED: 'false' },
      configure: (builder) =>
        builder.overrideProvider(MONGO_CLIENT).useFactory({
          factory: () => {
            const client = new MongoClient(mongo.uri, {
              serverSelectionTimeoutMS: 5000,
              monitorCommands: true,
            });
            client.on('commandStarted', (e) =>
              commands.push({ name: e.commandName, command: e.command }),
            );
            clients.push(client);
            return client;
          },
        }),
    });
    apps.push(app);
    return app;
  }

  async function indexes() {
    return col().listIndexes().toArray();
  }

  async function expectFullIndexSet() {
    const list = await indexes();
    expect(list.map((i) => i.name as string).sort()).toEqual(
      Object.keys(EXPECTED_KEYS).sort(),
    );
    for (const index of list) {
      expect(Object.keys(index.key)).toEqual(EXPECTED_KEYS[index.name]);
      if (index.name === IDEMPOTENCY_INDEX_NAME) {
        expect(index.unique).toBe(true);
      } else {
        expect(index.unique).toBeUndefined();
      }
      expect(index.sparse).toBeUndefined();
      expect(index.partialFilterExpression).toBeUndefined();
      expect(index.expireAfterSeconds).toBeUndefined();
    }
  }

  // Shuffled on purpose, with ties on ts and on ts plus receivedAt.
  async function seed() {
    await col().insertMany(
      [
        doc(5, 'p-a', 50, 51, {
          status: 'done',
          result: { ok: true },
          processedAt: at(60),
        }),
        doc(21, 'p-b', 15, 16),
        doc(2, 'p-a', 20, 29),
        doc(22, 'p-b', 45, 46),
        doc(6, 'p-a', 60, 61, {
          status: 'failed',
          lastError: {
            code: 'simulated_failure',
            message: 'failed',
            at: at(62),
          },
          processedAt: at(62),
        }),
        doc(4, 'p-a', 40, 41, {
          status: 'processing',
          lockedUntil: at(100),
          workerId: 'w-1',
        }),
        doc(3, 'p-a', 20, 21),
        doc(9, 'p-a', 30, 31),
        doc(8, 'p-a', 30, 31),
        doc(1, 'p-a', 10, 11),
        doc(23, 'p-b', 100, 101),
        // late event, earliest ts, inserted last
        doc(7, 'p-a', 1, 200),
      ],
      { ordered: true },
    );
  }
  // p-a order: 7 (ts 1), 1 (10), 3 (20, recv 21), 2 (20, recv 29), 8 (30, id 8), 9 (30, id 9), 4, 5, 6
  const P_A_SEEDED = [7, 1, 3, 2, 8, 9, 4, 5, 6].map((n) =>
    oid(n).toHexString(),
  );

  beforeAll(async () => {
    mongo = await startMongo('events_data_model');
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  beforeEach(async () => {
    await testClient.db().dropDatabase();
    commands.length = 0;
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close().catch(() => undefined);
    for (const client of clients.splice(0)) {
      await client.close().catch(() => undefined);
    }
  });

  afterAll(async () => {
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-02 creates exactly the four indexes, in order, without a validator', async () => {
    await boot();
    await expectFullIndexSet();
    const created = commands
      .filter((c) => c.name === 'createIndexes')
      .flatMap((c) =>
        (c.command.indexes as { name: string }[]).map((i) => i.name),
      );
    expect(created).toEqual([
      IDEMPOTENCY_INDEX_NAME,
      CLAIM_INDEX_NAME,
      PATIENT_READ_ORDER_INDEX_NAME,
    ]);
    const [info] = await testClient
      .db()
      .listCollections({ name: 'events' })
      .toArray();
    expect((info as any).options.validator).toBeUndefined();
  });

  it('CA-03/CA-11 reads a patient in ts, receivedAt, _id order', async () => {
    const logger = new CaptureLogger();
    const app = await boot(logger);
    await seed();

    const posted: string[] = [];
    for (const ts of ['2026-11-02T12:00:25Z', '2026-11-02T12:00:45Z']) {
      const res = await request(app.getHttpServer())
        .post('/events')
        .send({ patientId: 'p-a', type: 'vitals', ts, data: { hr: 999 } })
        .expect(202);
      posted.push(res.body.id);
    }
    const actual = (await findPatientEvents(col(), 'p-a').toArray()).map((d) =>
      d._id.toHexString(),
    );
    // Posted events (ts 25 and 45) land between the seeded ones.
    const expected = [
      ...P_A_SEEDED.slice(0, 4),
      posted[0]!,
      ...P_A_SEEDED.slice(4, 7),
      posted[1]!,
      ...P_A_SEEDED.slice(7),
    ];
    expect(actual).toEqual(expected);

    const b = await findPatientEvents(col(), 'p-b').toArray();
    expect(b.map((d) => d._id.toHexString())).toEqual(
      [21, 22, 23].map((n) => oid(n).toHexString()),
    );
    expect(await findPatientEvents(col(), 'p-none').toArray()).toEqual([]);

    expect(logger.all).not.toMatch(/p-a|p-b|"hr"|999/);
    expect(logger.all).not.toContain(CLAIM_INDEX_NAME);
    expect(logger.all).not.toContain(PATIENT_READ_ORDER_INDEX_NAME);
  });

  it('CA-04 serves the patient read from patient_read_order without SORT', async () => {
    await boot();
    await seed();
    const explain = await findPatientEvents(col(), 'p-a').explain(
      'queryPlanner',
    );
    const { stages, indexes: used } = planOf(explain);
    expect(used).toContain(PATIENT_READ_ORDER_INDEX_NAME);
    expect(stages).not.toContain('SORT');
  });

  it('CA-05 serves the claim query from claim_status_nextAttemptAt without SORT', async () => {
    await boot();
    const now = new Date();
    const past = (ms: number) => new Date(now.getTime() - ms);
    const future = (ms: number) => new Date(now.getTime() + ms);
    await col().insertMany([
      doc(1, 'p-c', 1, 2, { nextAttemptAt: past(3000) }),
      doc(2, 'p-c', 1, 2, { nextAttemptAt: past(5000) }),
      doc(3, 'p-c', 1, 2, { nextAttemptAt: future(60_000) }),
      doc(4, 'p-c', 1, 2, { status: 'processing', nextAttemptAt: past(9000) }),
      doc(5, 'p-c', 1, 2, { nextAttemptAt: past(1000) }),
    ]);
    const query = () =>
      col()
        .find({ status: 'pending', nextAttemptAt: { $lte: now } })
        .sort({ nextAttemptAt: 1 });
    const { stages, indexes: used } = planOf(
      await query().explain('queryPlanner'),
    );
    expect(used).toContain(CLAIM_INDEX_NAME);
    expect(stages).not.toContain('SORT');
    expect((await query().toArray()).map((d) => d._id.toHexString())).toEqual(
      [2, 1, 5].map((n) => oid(n).toHexString()),
    );
  });

  it('CA-06/CA-11 restarts against the same database without changes', async () => {
    const first = new CaptureLogger();
    const app = await boot(first);
    for (const patientId of ['p-r1', 'p-r2']) {
      await request(app.getHttpServer())
        .post('/events')
        .send({
          patientId,
          type: 'vitals',
          ts: '2026-11-02T12:00:00Z',
          data: { hr: 61 },
        })
        .expect(202);
    }
    const before = await indexes();
    const count = await col().countDocuments();
    await app.close();

    const second = new CaptureLogger();
    await boot(second);
    expect(await indexes()).toEqual(before);
    expect(await col().countDocuments()).toBe(count);
    await expectFullIndexSet();
    for (const logger of [first, second]) {
      expect(logger.all).not.toMatch(/p-r1|p-r2|"hr"/);
      expect(logger.all).not.toContain(CLAIM_INDEX_NAME);
      expect(logger.all).not.toContain(PATIENT_READ_ORDER_INDEX_NAME);
    }
  });

  it('CA-07 builds the new indexes over existing Phase 1 documents', async () => {
    await col().createIndex(
      { idempotencyKey: 1 },
      { unique: true, name: IDEMPOTENCY_INDEX_NAME },
      undefined,
    );
    const known = {
      patientId: 'p-known',
      type: 'vitals',
      ts: new Date('2026-11-02T12:00:00.000Z'),
      data: { hr: 80 },
    };
    await col().insertMany([
      doc(1, 'p-known', 5, 6, { idempotencyKey: computeIdempotencyKey(known) }),
      doc(2, 'p-known', 3, 7),
      doc(3, 'p-other', 3, 7),
    ]);
    const snapshot = await col().find().sort({ _id: 1 }).toArray();

    const app = await boot();
    await expectFullIndexSet();
    expect(await col().find().sort({ _id: 1 }).toArray()).toEqual(snapshot);
    expect(
      (await findPatientEvents(col(), 'p-known').toArray()).map((d) =>
        d._id.toHexString(),
      ),
    ).toEqual([oid(2).toHexString(), oid(1).toHexString()]);

    const res = await request(app.getHttpServer())
      .post('/events')
      .send({
        patientId: 'p-known',
        type: 'vitals',
        ts: '2026-11-02T12:00:00Z',
        data: { hr: 80 },
      })
      .expect(202);
    expect(res.body).toEqual({
      id: oid(1).toHexString(),
      status: 'pending',
      duplicate: true,
    });
    expect(await col().countDocuments()).toBe(3);
  });

  it('CA-08 starts two instances concurrently', async () => {
    await Promise.all([boot(), boot()]);
    await expectFullIndexSet();
  });

  it.each([
    ['patient_read_order', { patientId: 1 }],
    ['claim_status_nextAttemptAt', { status: 1 }],
  ])('CA-09 rejects startup on a conflicting %s index', async (name, key) => {
    await col().createIndex(key, { name }, undefined);
    await expect(boot()).rejects.toThrow();
    const list = await indexes();
    const found = list.find((i) => i.name === name)!;
    expect(found.key).toEqual(key);
  });
});
