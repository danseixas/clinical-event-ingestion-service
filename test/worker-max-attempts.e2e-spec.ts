import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import type {
  EventProcessor,
  EventProcessorInput,
} from '../src/worker/event-processor.js';
import { createTestApp } from './support/app.js';
import { CaptureLogger } from './support/capture-logger.js';
import { startMongo, TestMongo } from './support/mongo.js';
import {
  D10_PATTERNS,
  seedEvent,
  waitFor,
  workerConfigure,
  workerEnv,
  workerLines,
} from './support/worker.js';

describe('events worker final failure (e2e)', () => {
  let mongo: TestMongo;
  let app: NestExpressApplication;
  let testClient: MongoClient;
  let logger: CaptureLogger;
  let calls = 0;

  const events = () => testClient.db().collection<EventDocument>('events');

  beforeAll(async () => {
    mongo = await startMongo('worker_max_attempts');
    testClient = await new MongoClient(mongo.uri).connect();
    logger = new CaptureLogger();
    const processor: EventProcessor = {
      process: (input: EventProcessorInput) => {
        calls++;
        return Promise.reject(new Error(`boom ${input.patientId}`));
      },
    };
    app = await createTestApp({
      mongoUri: mongo.uri,
      logger,
      env: workerEnv({
        MAX_ATTEMPTS: '3',
        POLL_INTERVAL_MS: '50',
        BACKOFF_BASE_MS: '100',
        BACKOFF_MAX_MS: '1000',
      }),
      configure: workerConfigure({ uri: mongo.uri, processor }),
    });
  }, 180_000);

  afterAll(async () => {
    await testClient?.close();
    await app?.close();
    await mongo?.stop();
  }, 60_000);

  it('CA-11/CA-20 ends failed after MAX_ATTEMPTS and is never claimed again', async () => {
    const seeded = seedEvent();
    await events().insertOne(seeded);
    const doc = await waitFor(async () => {
      const d = await events().findOne({ _id: seeded._id });
      return d?.status === 'failed' && d;
    }, 15_000);

    expect(doc.attempts).toBe(3);
    expect(doc.processedAt).toBeInstanceOf(Date);
    expect(doc.lastError).toMatchObject({
      code: 'processor_error',
      message: 'External call failed',
    });
    expect(doc).not.toHaveProperty('result');
    expect(doc).not.toHaveProperty('workerId');
    expect(doc).not.toHaveProperty('lockedUntil');

    // The log line follows the acknowledged write.
    await waitFor(() => workerLines(logger).some((l) => l.level === 'warn'));
    const warns = workerLines(logger).filter((l) => l.level === 'warn');
    expect(warns).toEqual([
      {
        level: 'warn',
        message: `Event ${seeded._id.toHexString()} failed after 3 attempts (processor_error)`,
      },
    ]);
    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toBe(3);
    for (const line of workerLines(logger)) {
      expect(D10_PATTERNS.some((p) => p.test(line.message))).toBe(true);
    }
    expect(logger.all).not.toMatch(
      /boom|p-test-1|vitals|2026-11-02|"hr"|\{"simulated":true\}/,
    );
    expect(logger.all).not.toContain(seeded.idempotencyKey);
  }, 30_000);
});
