import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';

describe('POST /events with the store down (e2e)', () => {
  let mongo: TestMongo;
  let app: NestExpressApplication;
  let logger: CaptureLogger;

  beforeAll(async () => {
    mongo = await startMongo('store_down');
    logger = new CaptureLogger();
    app = await createTestApp({ mongoUri: mongo.uri, logger });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop().catch(() => undefined);
  }, 60_000);

  it('CA-12/CA-17 answers 503 within 15 s and logs one safe warn line', async () => {
    await mongo.stop();
    logger.lines.length = 0;
    const started = Date.now();
    const res = await request(app.getHttpServer())
      .post('/events')
      .send({
        patientId: 'p-test-1',
        type: 'vitals',
        ts: '2026-11-02T10:00:00Z',
        data: { hr: 72 },
      });
    expect(Date.now() - started).toBeLessThanOrEqual(15_000);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      statusCode: 503,
      message: 'Event store unavailable, retry later',
      error: 'Service Unavailable',
    });
    const warns = logger.lines.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.text).toMatch(/Mongo\w*Error/);
    expect(logger.all).not.toMatch(/p-test-1|vitals|2026-11-02|72/);
  }, 30_000);
});
