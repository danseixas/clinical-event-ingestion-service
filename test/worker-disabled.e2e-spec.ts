import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import type { EventDocument } from '../src/events/event.document.js';
import { ObjectId } from 'mongodb';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  RecordedCommand,
  workerConfigure,
  workerEnv,
  workerLines,
} from './support/worker.js';

describe('events worker disabled (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let app: NestExpressApplication | undefined;
  const sink: RecordedCommand[] = [];
  const logger = new CaptureLogger();

  beforeAll(async () => {
    mongo = await startMongo('worker_disabled');
    testClient = await new MongoClient(mongo.uri).connect();
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: workerEnv({ WORKER_ENABLED: 'false', POLL_INTERVAL_MS: '50' }),
      configure: workerConfigure({ uri: mongo.uri, sink }),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-17 sends no claim and logs that the worker is disabled', async () => {
    const res = await request(app!.getHttpServer())
      .post('/events')
      .send({
        patientId: 'p-test-1',
        type: 'vitals',
        ts: '2026-11-02T10:00:00Z',
        data: { hr: 72 },
      });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 500));

    const doc = await testClient
      .db()
      .collection<EventDocument>('events')
      .findOne({ _id: new ObjectId(res.body.id as string) });
    expect(doc?.status).toBe('pending');
    expect(doc?.attempts).toBe(0);
    expect(
      sink.filter(
        (c) =>
          c.name === 'findAndModify' && c.command.findAndModify === 'events',
      ),
    ).toEqual([]);
    expect(workerLines(logger)).toContainEqual({
      level: 'log',
      message: 'Worker disabled (WORKER_ENABLED=false)',
    });

    await app!.close();
    app = undefined;
    expect(
      workerLines(logger).some((l) => l.message === 'Worker stopped'),
    ).toBe(false);
    expect(
      workerLines(logger).some((l) => l.message.startsWith('Worker stopping')),
    ).toBe(false);
  });
});
