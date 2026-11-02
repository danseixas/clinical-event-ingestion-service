import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  ScriptedProcessor,
  SpyProcessor,
  waitFor,
  workerConfigure,
  workerEnv,
} from './support/worker.js';

describe('GET /stats with the worker (e2e)', () => {
  let mongo: TestMongo;
  let client: MongoClient;
  const apps: NestExpressApplication[] = [];
  const logger = new CaptureLogger();

  beforeAll(async () => {
    mongo = await startMongo('stats_worker');
    client = new MongoClient(mongo.uri);
    await client.connect();
    const env = workerEnv({
      POLL_INTERVAL_MS: '50',
      PROCESSING_DELAY_MS: '50',
      FAILURE_RATE: '0',
    });
    for (let i = 0; i < 2; i++) {
      const processor = new SpyProcessor(
        new ScriptedProcessor(() => 'success'),
      );
      apps.push(
        await createTestApp({
          mongoUri: mongo.uri,
          logger,
          env,
          configure: workerConfigure({ uri: mongo.uri, processor }),
        }),
      );
    }
  }, 180_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    await client?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-09 converges to all done and both instances agree', async () => {
    const [a, b] = apps as [NestExpressApplication, NestExpressApplication];
    const posted = Array.from({ length: 20 }, (_, i) => ({
      patientId: `p-stats-${i}`,
      type: 'labs',
      ts: '2026-11-02T10:00:00Z',
      data: { glucose: 100 + i },
    }));
    for (const body of posted) {
      const res = await request(a.getHttpServer()).post('/events').send(body);
      expect(res.status).toBe(202);
    }
    const final = await waitFor(
      async () => {
        const res = await request(a.getHttpServer()).get('/stats');
        return res.body.counts?.done === 20 ? res.body : undefined;
      },
      30_000,
      100,
    );
    expect(final.counts).toEqual({
      pending: 0,
      processing: 0,
      done: 20,
      failed: 0,
    });
    expect(final).toMatchObject({
      due: 0,
      expiredLeases: 0,
      oldestDueAgeMs: 0,
    });
    const other = await request(b.getHttpServer()).get('/stats');
    expect(other.body.counts).toEqual(final.counts);

    // CA-10
    const keys = (
      await client.db().collection<EventDocument>('events').find().toArray()
    ).map((d) => d.idempotencyKey);
    const haystack =
      JSON.stringify(final) + JSON.stringify(other.body) + logger.all;
    for (const body of posted) {
      expect(haystack).not.toContain(body.patientId);
    }
    expect(haystack).not.toContain('labs');
    expect(haystack).not.toContain('glucose');
    for (const key of keys) expect(haystack).not.toContain(key);
    // Besides Nest's own startup/route lines, only the worker logs.
    const framework = /RoutesResolver$|RouterExplorer$|NestApplication$/;
    expect(
      logger.lines.filter(
        (l) => !l.text.endsWith(' EventsWorker') && !framework.test(l.text),
      ),
    ).toEqual([]);
  }, 60_000);
});
