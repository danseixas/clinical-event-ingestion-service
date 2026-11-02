import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { startMongo, TestMongo } from './support/mongo.js';

describe('App (e2e)', () => {
  let mongo: TestMongo;
  let app: NestExpressApplication;

  beforeAll(async () => {
    mongo = await startMongo('health');
    app = await createTestApp({
      mongoUri: mongo.uri,
      env: { WORKER_ENABLED: 'false' },
    });
  }, 180_000);

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', mongo: 'up' });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  }, 60_000);
});
