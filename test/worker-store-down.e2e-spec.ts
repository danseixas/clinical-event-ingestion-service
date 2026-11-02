import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import { waitFor, workerEnv, workerLines } from './support/worker.js';

describe('events worker with the store down (e2e)', () => {
  let mongo: TestMongo;
  let app: NestExpressApplication;
  const logger = new CaptureLogger();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    mongo = await startMongo('worker_store_down');
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: workerEnv({ POLL_INTERVAL_MS: '50' }),
    });
    await app.listen(0);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop().catch(() => undefined);
    process.off('unhandledRejection', onUnhandled);
  }, 60_000);

  it('CA-15(b) survives claim failures and keeps answering /health', async () => {
    await mongo.stop();
    await waitFor(
      () =>
        workerLines(logger).some((l) =>
          /^Claim failed: Mongo\w*Error/.test(l.message),
        ),
      20_000,
      100,
    );
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(unhandled).toEqual([]);
  }, 40_000);
});
