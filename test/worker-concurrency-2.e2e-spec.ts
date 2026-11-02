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

describe('events worker with concurrency 2 (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let app: NestExpressApplication | undefined;

  const events = () => testClient.db().collection<EventDocument>('events');

  const boot = async (processor: BlockingProcessor) => {
    app = await createTestApp({
      mongoUri: mongo.uri,
      env: workerEnv({ WORKER_CONCURRENCY: '2', POLL_INTERVAL_MS: '50' }),
      configure: workerConfigure({ uri: mongo.uri, processor }),
    });
  };

  beforeAll(async () => {
    mongo = await startMongo('worker_c2');
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

  it('CA-08 processes events of the same patient in parallel', async () => {
    const blocking = new BlockingProcessor();
    await boot(blocking);
    await events().insertMany([
      seedEvent({ data: { i: 1 } }),
      seedEvent({ data: { i: 2 } }),
    ]);
    await waitFor(() => blocking.current === 2);
    expect(blocking.calls.map((c) => c.input.patientId)).toEqual([
      'p-test-1',
      'p-test-1',
    ]);
    blocking.releaseAll();
    await waitFor(
      async () => (await events().countDocuments({ status: 'done' })) === 2,
    );
  });
});
