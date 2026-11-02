import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import { TEST_APP_NAME, workerConfigure, workerEnv } from './support/worker.js';

describe('GET /health (e2e)', () => {
  let mongo: TestMongo;
  let app: NestExpressApplication;
  let admin: MongoClient;
  const logger = new CaptureLogger();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  const failPoint = (mode: 'alwaysOn' | 'off') =>
    admin.db('admin').command({
      configureFailPoint: 'failCommand',
      mode,
      ...(mode === 'alwaysOn'
        ? {
            data: {
              appName: TEST_APP_NAME,
              failCommands: ['ping'],
              blockConnection: true,
              blockTimeMS: 3000,
            },
          }
        : {}),
    });

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    mongo = await startMongo('health_ping', { enableTestCommands: true });
    admin = new MongoClient(mongo.uri);
    await admin.connect();
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: workerEnv({ WORKER_ENABLED: 'false' }),
      configure: workerConfigure({ uri: mongo.uri }),
    });
  }, 180_000);

  afterEach(async () => {
    await failPoint('off');
  });

  afterAll(async () => {
    console.log('health ping slow method: failCommand');
    await app?.close();
    await admin?.close();
    await mongo?.stop();
    process.off('unhandledRejection', onUnhandled);
  }, 60_000);

  it('CA-02 answers 200 { status: ok, mongo: up } when Mongo is up', async () => {
    const before = logger.lines.length;
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: 'ok', mongo: 'up' });
    expect(logger.lines.length).toBe(before);
  });

  it('CA-03 and CA-05 answer 503 within the bound when ping is slow, then recover', async () => {
    const beforeLines = logger.lines.length;
    await failPoint('alwaysOn');
    const start = Date.now();
    const res = await request(app.getHttpServer()).get('/health');
    const elapsed = Date.now() - start;
    console.log(`CA-03 /health elapsed ${elapsed} ms`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', mongo: 'down' });
    expect(elapsed).toBeLessThanOrEqual(1500);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(unhandled).toEqual([]);
    expect(logger.lines.length).toBe(beforeLines);

    await failPoint('off');
    const ok = await request(app.getHttpServer()).get('/health');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ok', mongo: 'up' });
    expect(logger.all).not.toMatch(/p-test-1|vitals/);
  }, 30_000);
});
