import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import { workerEnv } from './support/worker.js';

describe('read endpoints with the store down (e2e)', () => {
  let mongo: TestMongo;
  let app: NestExpressApplication;
  const logger = new CaptureLogger();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    mongo = await startMongo('read_store_down');
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: workerEnv({ WORKER_ENABLED: 'false' }),
    });
    await app.listen(0);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop().catch(() => undefined);
    process.off('unhandledRejection', onUnhandled);
  }, 60_000);

  it('CA-04 and CA-07 answer 503 for /health and /stats', async () => {
    await mongo.stop();
    logger.lines.length = 0;

    let start = Date.now();
    const health = await request(app.getHttpServer()).get('/health');
    const healthMs = Date.now() - start;
    console.log(`CA-04 (worker disabled) /health elapsed ${healthMs} ms`);
    expect(health.status).toBe(503);
    expect(health.body).toEqual({ status: 'error', mongo: 'down' });
    expect(healthMs).toBeLessThanOrEqual(1500);
    expect(logger.lines).toEqual([]);

    start = Date.now();
    const stats = await request(app.getHttpServer()).get('/stats');
    const statsMs = Date.now() - start;
    console.log(`CA-07 /stats elapsed ${statsMs} ms`);
    expect(stats.status).toBe(503);
    expect(stats.body).toEqual({
      statusCode: 503,
      message: 'Event store unavailable, retry later',
      error: 'Service Unavailable',
    });
    expect(statsMs).toBeLessThanOrEqual(10_000);
    expect(logger.lines).toHaveLength(1);
    const line = logger.lines[0]!;
    expect(line.level).toBe('warn');
    expect(line.text.endsWith(' StatsService')).toBe(true);
    expect(line.text.slice(0, -' StatsService'.length)).toMatch(
      /^Event store unavailable: Mongo\w*Error( \(code \S+\))?$/,
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(unhandled).toEqual([]);
  }, 40_000);
});
