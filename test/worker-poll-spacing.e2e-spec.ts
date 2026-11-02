import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  BlockingProcessor,
  RecordedCommand,
  seedEvent,
  TEST_APP_NAME,
  waitFor,
  workerConfigure,
  workerEnv,
  workerLines,
} from './support/worker.js';

const isClaim = (c: RecordedCommand) =>
  c.name === 'findAndModify' && c.command.findAndModify === 'events';

describe('events worker poll spacing, F-01 (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let app: NestExpressApplication | undefined;
  const sink: RecordedCommand[] = [];
  const logger = new CaptureLogger();
  const blocking = new BlockingProcessor();
  const events = () => testClient.db().collection<EventDocument>('events');

  beforeAll(async () => {
    mongo = await startMongo('worker_poll_spacing', {
      enableTestCommands: true,
    });
    testClient = await new MongoClient(mongo.uri).connect();
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: workerEnv({
        POLL_INTERVAL_MS: '1000',
        WORKER_CONCURRENCY: '10',
        PROCESSING_DELAY_MS: '100',
        PROCESSING_TIMEOUT_MS: '10000',
        LEASE_MS: '30000',
      }),
      configure: workerConfigure({ uri: mongo.uri, processor: blocking, sink }),
    });
  }, 180_000);

  afterAll(async () => {
    await testClient
      .db('admin')
      .command({ configureFailPoint: 'failCommand', mode: 'off' })
      .catch(() => undefined);
    blocking.releaseAll();
    await app?.close();
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-12 a settled attempt does not cut short the poll wait', async () => {
    await waitFor(() => sink.filter(isClaim).length >= 1);
    await events().insertOne(seedEvent());
    // The first claim after the insert takes the event (or the empty claim
    // before it); wait for the processor call, then the claim that follows.
    await waitFor(() => blocking.calls.length === 1, 5000);
    const claims = () => sink.filter(isClaim);
    const takingIndex = claims().length - 1;
    const emptyClaim = await waitFor(() => claims()[takingIndex + 1], 3000);

    // Settle the attempt shortly after the empty claim was sent.
    blocking.releaseAll('success');
    const settledAt = Date.now();
    const nextClaim = await waitFor(() => claims()[takingIndex + 2], 3000);
    const gap = nextClaim.at - emptyClaim.at;
    console.log(
      `poll spacing: empty claim to next claim ${gap} ms; settle to next claim ${nextClaim.at - settledAt} ms`,
    );
    expect(settledAt).toBeLessThan(nextClaim.at);
    expect(gap).toBeGreaterThanOrEqual(900);
  }, 20_000);

  it('CA-12 a failed claim is also followed by a full poll wait', async () => {
    const claims = () => sink.filter(isClaim);
    await events().insertOne(seedEvent());
    const callsBefore = blocking.calls.length;
    await waitFor(() => blocking.calls.length === callsBefore + 1, 5000);
    const takingIndex = claims().length - 1;
    await waitFor(() => claims()[takingIndex + 1], 3000);
    await testClient.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: {
        failCommands: ['findAndModify'],
        errorCode: 2,
        appName: TEST_APP_NAME,
      },
    });
    console.log(
      'failpoint usage (CA-12): failCommand findAndModify errorCode 2 times 1',
    );
    await waitFor(() => claims()[takingIndex + 2], 3000);
    await waitFor(() =>
      workerLines(logger).some((l) => l.message.startsWith('Claim failed')),
    );
    const failed = claims()[takingIndex + 2]!;
    blocking.releaseAll('success');
    const next = await waitFor(() => claims()[takingIndex + 3], 3000);
    console.log(
      `poll spacing: failed claim to next claim ${next.at - failed.at} ms`,
    );
    expect(next.at - failed.at).toBeGreaterThanOrEqual(900);
  }, 20_000);
});
