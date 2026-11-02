import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { MONGO_CLIENT } from '../src/database/database.tokens.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';

const MALFORMED = {
  statusCode: 400,
  message: 'Malformed JSON body',
  error: 'Bad Request',
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    patientId: 'p-test-1',
    type: 'vitals',
    ts: '2026-11-02T10:00:00-03:00',
    data: { hr: 72 },
    ...overrides,
  };
}

describe('POST /events (e2e)', () => {
  let mongo: TestMongo;
  let app: NestExpressApplication;
  let testClient: MongoClient;
  let logger: CaptureLogger;
  const commands: { name: string; command: Record<string, any> }[] = [];

  const events = () => testClient.db().collection('events');
  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/events')
      .send(body as object);

  beforeAll(async () => {
    mongo = await startMongo('events');
    logger = new CaptureLogger();
    app = await createTestApp({
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
            return client;
          },
        }),
    });
    await app.listen(0);
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  beforeEach(async () => {
    await events().deleteMany({});
    logger.lines.length = 0;
    commands.length = 0;
  });

  afterAll(async () => {
    await testClient?.close();
    await app?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-01/CA-02/CA-13 accepts a new event and stores the initial document', async () => {
    const body = event();
    const res = await post(body).expect(202);
    expect(Object.keys(res.body).sort()).toEqual(['duplicate', 'id', 'status']);
    expect(res.body.id).toMatch(/^[0-9a-f]{24}$/);
    expect(res.body.status).toBe('pending');
    expect(res.body.duplicate).toBe(false);

    const docs = await events().find({}).toArray();
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc._id.toHexString()).toBe(res.body.id);
    expect(Object.keys(doc).sort()).toEqual(
      [
        '_id',
        'attempts',
        'data',
        'idempotencyKey',
        'nextAttemptAt',
        'patientId',
        'receivedAt',
        'status',
        'ts',
        'type',
      ].sort(),
    );
    expect(doc.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.ts).toEqual(new Date('2026-11-02T13:00:00.000Z'));
    expect(doc.receivedAt).toBeInstanceOf(Date);
    expect(doc.nextAttemptAt).toEqual(doc.receivedAt);
    expect(doc.status).toBe('pending');
    expect(doc.attempts).toBe(0);
    expect(doc.patientId).toBe(body.patientId);
    expect(doc.type).toBe(body.type);
    expect(doc.data).toEqual(body.data);

    // CA-13: majority insert and index set.
    const insert = commands.find((c) => c.name === 'insert');
    expect(insert?.command.writeConcern.w).toBe('majority');
    const indexes = await events().listIndexes().toArray();
    expect(
      indexes.map((i) => i.name as string).sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      '_id_',
      'claim_status_nextAttemptAt',
      'idempotencyKey_unique',
      'patient_read_order',
    ]);
    const unique = indexes.find((i) => i.name === 'idempotencyKey_unique')!;
    expect(unique.unique).toBe(true);
    expect(unique.key).toEqual({ idempotencyKey: 1 });

    // CA-17 (accept path)
    expect(logger.all).not.toMatch(/p-test-1|vitals|2026-11-02|72|"hr"/);
    expect(logger.all).not.toContain(doc.idempotencyKey);
  });

  it('CA-03 answers an identical repost as a duplicate', async () => {
    const first = await post(event()).expect(202);
    const before = await events().find({}).toArray();
    const second = await post(event()).expect(202);
    expect(second.body).toEqual({
      id: first.body.id,
      status: 'pending',
      duplicate: true,
    });
    expect(await events().find({}).toArray()).toEqual(before);
  });

  it('CA-04 treats equivalent formatting as a duplicate', async () => {
    const first = await post(
      event({
        ts: '2026-11-02T13:00:00Z',
        data: { b: { y: 1, x: [1, { n: 1, m: 2 }] }, a: 1 },
      }),
    ).expect(202);
    const second = await post(
      event({
        ts: '2026-11-02T10:00:00.0009-03:00',
        data: { a: 1, b: { x: [1, { m: 2, n: 1 }], y: 1 } },
      }),
    ).expect(202);
    expect(second.body).toEqual({
      id: first.body.id,
      status: 'pending',
      duplicate: true,
    });
    expect(await events().countDocuments()).toBe(1);
  });

  it.each([
    ['array order', { data: { a: [1, 2] } }, { data: { a: [2, 1] } }],
    ['1 vs "1"', { data: { a: 1 } }, { data: { a: '1' } }],
    [
      'ts +1 ms',
      { ts: '2026-11-02T10:00:00.000Z' },
      { ts: '2026-11-02T10:00:00.001Z' },
    ],
    ['patientId space', { patientId: 'p1' }, { patientId: ' p1' }],
  ])(
    'CA-05 keeps distinct content distinct (%s)',
    async (_name, left, right) => {
      const a = await post(event(left)).expect(202);
      const b = await post(event(right)).expect(202);
      expect(a.body.duplicate).toBe(false);
      expect(b.body.duplicate).toBe(false);
      expect(a.body.id).not.toBe(b.body.id);
      const docs = await events().find({}).toArray();
      expect(docs).toHaveLength(2);
      expect(docs[0]!.idempotencyKey).not.toBe(docs[1]!.idempotencyKey);
    },
  );

  it('CA-07 stores exactly one document under 20 concurrent identical posts', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => post(event())),
    );
    for (const res of responses) expect(res.status).toBe(202);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(responses.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(responses.filter((r) => r.body.duplicate === true)).toHaveLength(19);
    expect(await events().countDocuments()).toBe(1);
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    [
      'patientId missing',
      { patientId: undefined },
      'patientId must be a string',
    ],
    ['patientId number', { patientId: 5 }, 'patientId must be a string'],
    ['patientId blank', { patientId: '   ' }, 'patientId must not be blank'],
    [
      'patientId 129',
      { patientId: 'a'.repeat(129) },
      'patientId must be at most 128 characters',
    ],
    ['type missing', { type: undefined }, 'type must be a string'],
    ['type number', { type: 5 }, 'type must be a string'],
    ['type blank', { type: '   ' }, 'type must not be blank'],
    ['type 65', { type: 'a'.repeat(65) }, 'type must be at most 64 characters'],
    ['data null', { data: null }, 'data must be a JSON object'],
    ['data array', { data: [1] }, 'data must be a JSON object'],
    ['data string', { data: 'x' }, 'data must be a JSON object'],
    ['data missing', { data: undefined }, 'data must be a JSON object'],
    ...[
      ['ts missing', undefined],
      ['ts number', 12345],
      ['ts no offset', '2026-11-02T10:00:00'],
      ['ts no seconds', '2026-11-02T10:00Z'],
      ['ts date only', '2026-11-02'],
      ['ts lowercase t', '2026-11-02t10:00:00Z'],
      ['ts lowercase z', '2026-11-02T10:00:00z'],
      ['ts feb 30', '2026-02-30T00:00:00Z'],
      ['ts hour 24', '2026-11-02T24:00:00Z'],
      ['ts second 60', '2026-11-02T10:00:60Z'],
      ['ts year 1969', '1969-12-31T23:59:59Z'],
    ].map(
      ([name, ts]) =>
        [
          name as string,
          { ts },
          'ts must be an ISO 8601 date-time with a timezone offset',
        ] as [string, Record<string, unknown>, string],
    ),
  ];

  it.each(invalid)('CA-08 rejects %s', async (_name, overrides, message) => {
    const res = await post(event(overrides)).expect(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.statusCode).toBe(400);
    expect(res.body.message).toContain(message);
    expect(await events().countDocuments()).toBe(0);
    expect(logger.all).not.toMatch(/p-test-1|vitals/);
  });

  it.each([
    ['128-char patientId', { patientId: 'a'.repeat(128) }],
    ['64-char type', { type: 't'.repeat(64) }],
    ['empty data', { data: {} }],
    ['non-ASCII patientId', { patientId: 'pacienté-çã-日本' }],
  ])('CA-09 accepts boundary: %s', async (_name, overrides) => {
    const res = await post(event(overrides)).expect(202);
    expect(res.body.duplicate).toBe(false);
  });

  it('CA-09 truncates 9 fraction digits with an offset', async () => {
    await post(event({ ts: '2026-11-02T10:00:00.123456789+05:30' })).expect(
      202,
    );
    const doc = await events().findOne({});
    expect(doc?.ts).toEqual(new Date('2026-11-02T04:30:00.123Z'));
  });

  it('CA-10 rejects unknown fields, non-object bodies and malformed JSON', async () => {
    const extra = await post(event({ source: 'x' })).expect(400);
    expect(extra.body.message).toContain('property source should not exist');
    await post([]).expect(400);

    for (const raw of ['{"a":', '{"patientId":p-secret-123}']) {
      const res = await request(app.getHttpServer())
        .post('/events')
        .set('content-type', 'application/json')
        .send(raw)
        .expect(400);
      expect(res.body).toEqual(MALFORMED);
      expect(res.text).not.toContain('secret');
    }
    expect(await events().countDocuments()).toBe(0);
  });

  const firstRules = [
    'patientId must be a string',
    'type must be a string',
    'ts must be an ISO 8601 date-time with a timezone offset',
    'data must be a JSON object',
  ];

  it('rejects non-JSON content types and JSON primitives with the four first-rule messages', async () => {
    const attempts = [
      () =>
        request(app.getHttpServer())
          .post('/events')
          .type('form')
          .send('patientId=p&type=t&ts=2026-11-02T10:00:00Z&data[hr]=72'),
      () =>
        request(app.getHttpServer())
          .post('/events')
          .type('text/plain')
          .send('hello'),
      () =>
        request(app.getHttpServer())
          .post('/events')
          .set('content-type', 'application/json')
          .send('"x"'),
      () => request(app.getHttpServer()).post('/events'),
    ];
    for (const attempt of attempts) {
      const res = await attempt().expect(400);
      expect(
        [...res.body.message].sort((a: string, b: string) =>
          a.localeCompare(b),
        ),
      ).toEqual([...firstRules].sort((a, b) => a.localeCompare(b)));
    }
    expect(await events().countDocuments()).toBe(0);
  });

  it('rejects a top-level constructor key but stores data keys as received', async () => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .set('content-type', 'application/json')
      .send(
        '{"constructor":1,"patientId":"p","type":"t","ts":"2026-11-02T10:00:00Z","data":{}}',
      )
      .expect(400);
    expect(res.body.message).toContain('property constructor should not exist');

    const data = JSON.parse('{"constructor":1,"prototype":{"x":1}}');
    await request(app.getHttpServer())
      .post('/events')
      .set('content-type', 'application/json')
      .send(
        '{"patientId":"p","type":"t","ts":"2026-11-02T10:00:00Z","data":{"constructor":1,"prototype":{"x":1}}}',
      )
      .expect(202);
    const doc = await events().findOne({});
    expect(doc?.data).toEqual(data);
  });

  it('CA-11 answers 413 for bodies over 100 kb', async () => {
    await post(event({ data: { blob: 'x'.repeat(150_000) } })).expect(413);
    expect(await events().countDocuments()).toBe(0);
  });

  it('CA-14 stores data keys starting with $ or containing a dot', async () => {
    const data = { $set: 1, 'a.b': 2 };
    const res = await post(event({ data })).expect(202);
    expect(res.body.duplicate).toBe(false);
    const doc = await events().findOne({});
    expect(doc?.data).toEqual(data);
  });
});
