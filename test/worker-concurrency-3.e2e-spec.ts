import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  BlockingProcessor,
  seedEvent,
  waitFor,
  workerConfigure,
  workerEnv,
} from './support/worker.js';

describe('events worker with concurrency 3 (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let app: NestExpressApplication | undefined;

  const events = () => testClient.db().collection<EventDocument>('events');

  const boot = async (processor: BlockingProcessor) => {
    app = await createTestApp({
      mongoUri: mongo.uri,
      env: workerEnv({ WORKER_CONCURRENCY: '3', POLL_INTERVAL_MS: '50' }),
      configure: workerConfigure({ uri: mongo.uri, processor }),
    });
  };

  beforeAll(async () => {
    mongo = await startMongo('worker_c3');
    testClient = await new MongoClient(mongo.uri).connect();
  }, 180_000);

  beforeEach(async () => {
    await events().deleteMany({});
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-07 never runs more than WORKER_CONCURRENCY attempts', async () => {
    const blocking = new BlockingProcessor();
    await boot(blocking);
    await events().insertMany(
      Array.from({ length: 10 }, (_, i) => seedEvent({ data: { i } })),
    );
    await waitFor(() => blocking.current === 3);
    await new Promise((r) => setTimeout(r, 300));
    expect(blocking.max).toBe(3);
    expect(await events().countDocuments({ status: 'processing' })).toBe(3);

    const deadline = Date.now() + 20_000;
    while (
      (await events().countDocuments({ status: 'done' })) < 10 &&
      Date.now() < deadline
    ) {
      blocking.releaseAll();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await events().countDocuments({ status: 'done' })).toBe(10);
    expect(blocking.max).toBe(3);
  }, 30_000);
});
