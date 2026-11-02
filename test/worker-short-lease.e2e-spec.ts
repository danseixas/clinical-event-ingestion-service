import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  RecordedCommand,
  ScriptedProcessor,
  seedEvent,
  TEST_APP_NAME,
  waitFor,
  workerConfigure,
  workerEnv,
  workerLines,
} from './support/worker.js';

describe('events worker write retry stops at the lease (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let app: NestExpressApplication;
  const sink: RecordedCommand[] = [];
  const logger = new CaptureLogger();

  const events = () => testClient.db().collection<EventDocument>('events');

  beforeAll(async () => {
    mongo = await startMongo('worker_short_lease', {
      enableTestCommands: true,
    });
    testClient = await new MongoClient(mongo.uri).connect();
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: workerEnv({
        LEASE_MS: '1500',
        PROCESSING_TIMEOUT_MS: '1000',
        PROCESSING_DELAY_MS: '50',
        // Long poll: keeps the Phase 4 reclaim from running while the abandon is asserted.
        POLL_INTERVAL_MS: '5000',
      }),
      configure: workerConfigure({
        uri: mongo.uri,
        processor: new ScriptedProcessor(() => 'success'),
        sink,
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await testClient
      ?.db('admin')
      .command({ configureFailPoint: 'failCommand', mode: 'off' })
      .catch(() => undefined);
    await app?.close();
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-14 does not retry a write at or after lockedUntil', async () => {
    await testClient.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: 'alwaysOn',
      data: {
        failCommands: ['update'],
        closeConnection: true,
        appName: TEST_APP_NAME,
      },
    });
    const seeded = seedEvent();
    await events().insertOne(seeded);

    await waitFor(
      () => workerLines(logger).some((l) => l.message.includes('abandoned')),
      15_000,
    );
    const doc = (await events().findOne({ _id: seeded._id }))!;
    expect(doc.status).toBe('processing');
    expect(workerLines(logger).filter((l) => l.level === 'warn')).toHaveLength(
      1,
    );

    const updates = sink.filter(
      (c) => c.name === 'update' && c.command.update === 'events',
    );
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u.at).toBeLessThan(doc.lockedUntil!.getTime());
    }
    // Each worker-level write is one driver try plus one driver retry.
    const workerWrites = Math.ceil(updates.length / 2);
    console.log(
      `short lease: ${updates.length} update commands, ${workerWrites} worker-level writes`,
    );
    expect(workerWrites).toBe(2);
    expect(workerWrites).toBeLessThan(1 + 3);
  }, 30_000);
});
