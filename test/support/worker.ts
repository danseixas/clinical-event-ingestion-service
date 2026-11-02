import { TestingModuleBuilder } from '@nestjs/testing';
import { MongoClient, ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { MONGO_CLIENT } from '../../src/database/database.tokens.js';
import type { EventDocument } from '../../src/events/event.document.js';
import {
  EVENT_PROCESSOR,
  type EventProcessor,
  type EventProcessorInput,
} from '../../src/worker/event-processor.js';
import { SimulatedFailureError } from '../../src/worker/simulated-processor.js';
import type { CaptureLogger } from './capture-logger.js';

export const TEST_APP_NAME = 'events-worker-test';

/** All worker variables, explicit, so a file never depends on leaked env. */
export function workerEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    WORKER_ENABLED: 'true',
    WORKER_CONCURRENCY: '10',
    LEASE_MS: '30000',
    POLL_INTERVAL_MS: '50',
    PROCESSING_DELAY_MS: '50',
    PROCESSING_TIMEOUT_MS: '10000',
    FAILURE_RATE: '0',
    MAX_ATTEMPTS: '5',
    BACKOFF_BASE_MS: '100',
    BACKOFF_MAX_MS: '1000',
    SHUTDOWN_TIMEOUT_MS: '20000',
    ...overrides,
  };
}

export interface RecordedCommand {
  name: string;
  command: Record<string, any>;
  at: number;
}

/** Overrides the processor and, optionally, the Mongo client (command sink). */
export function workerConfigure(options: {
  uri: string;
  processor?: EventProcessor;
  sink?: RecordedCommand[];
}): (builder: TestingModuleBuilder) => TestingModuleBuilder {
  return (builder) => {
    if (options.processor) {
      builder.overrideProvider(EVENT_PROCESSOR).useValue(options.processor);
    }
    return builder.overrideProvider(MONGO_CLIENT).useFactory({
      factory: () => {
        const client = new MongoClient(options.uri, {
          serverSelectionTimeoutMS: 5000,
          monitorCommands: true,
          appName: TEST_APP_NAME,
        });
        client.on('commandStarted', (e) =>
          options.sink?.push({
            name: e.commandName,
            command: e.command,
            at: Date.now(),
          }),
        );
        return client;
      },
    });
  };
}

export interface Call {
  input: EventProcessorInput;
  signal: AbortSignal;
  startedAt: number;
}

export type Outcome = 'success' | 'simulated_failure' | 'error';

function settle(
  outcome: Outcome,
  resolve: (v: Record<string, unknown>) => void,
  reject: (e: unknown) => void,
) {
  if (outcome === 'success') resolve({ simulated: true });
  else if (outcome === 'simulated_failure') reject(new SimulatedFailureError());
  else reject(new Error('boom'));
}

/** Every call blocks until the test releases it. */
export class BlockingProcessor implements EventProcessor {
  readonly calls: Call[] = [];
  private readonly settlers: ((o: Outcome) => void)[] = [];
  private readonly released: boolean[] = [];
  current = 0;
  max = 0;

  process(input: EventProcessorInput, signal: AbortSignal) {
    this.calls.push({ input, signal, startedAt: Date.now() });
    this.current++;
    this.max = Math.max(this.max, this.current);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.released.push(false);
      const index = this.settlers.length;
      this.settlers.push((outcome) => {
        this.released[index] = true;
        this.current--;
        settle(outcome, resolve, reject);
      });
    });
  }

  release(index: number, outcome: Outcome = 'success') {
    if (!this.released[index]) this.settlers[index]!(outcome);
  }

  releaseAll(outcome: Outcome = 'success') {
    this.settlers.forEach((_, i) => this.release(i, outcome));
  }
}

/** Outcome chosen by the call number (1-based) of each event. */
export class ScriptedProcessor implements EventProcessor {
  readonly calls: Call[] = [];
  private readonly perEvent = new Map<string, number>();

  constructor(private readonly script: (callNumber: number) => Outcome) {}

  process(input: EventProcessorInput, signal: AbortSignal) {
    this.calls.push({ input, signal, startedAt: Date.now() });
    const n = (this.perEvent.get(input.eventId) ?? 0) + 1;
    this.perEvent.set(input.eventId, n);
    return new Promise<Record<string, unknown>>((resolve, reject) =>
      settle(this.script(n), resolve, reject),
    );
  }
}

/** Wraps another processor and records the calls and how they settled. */
export class SpyProcessor implements EventProcessor {
  readonly calls: Call[] = [];
  readonly settled: ('resolved' | 'rejected')[] = [];

  constructor(private readonly inner: EventProcessor) {}

  process(input: EventProcessorInput, signal: AbortSignal) {
    this.calls.push({ input, signal, startedAt: Date.now() });
    return this.inner.process(input, signal).then(
      (value) => {
        this.settled.push('resolved');
        return value;
      },
      (error: unknown) => {
        this.settled.push('rejected');
        throw error;
      },
    );
  }
}

export async function waitFor<T>(
  produce: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 10_000,
  intervalMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A Phase 1 shaped, due, pending event with fictional values. */
export function seedEvent(
  overrides: Partial<EventDocument> = {},
): EventDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    idempotencyKey: randomBytes(16).toString('hex'),
    patientId: 'p-test-1',
    type: 'vitals',
    data: { hr: 72 },
    ts: new Date('2026-11-02T10:00:00Z'),
    receivedAt: now,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(now.getTime() - 1000),
    ...overrides,
  };
}

/** Worker log lines, without the trailing Nest context. */
export function workerLines(logger: CaptureLogger) {
  return logger.lines
    .filter((l) => l.text.endsWith(' EventsWorker'))
    .map((l) => ({
      level: l.level,
      message: l.text.slice(0, -' EventsWorker'.length),
    }));
}

export const D10_PATTERNS: RegExp[] = [
  /^Worker started: concurrency \d+, workerId \S+:\d+:[0-9a-f]{8}$/,
  /^Worker disabled \(WORKER_ENABLED=false\)$/,
  /^Worker stopped$/,
  /^Event [0-9a-f]{24} failed after \d+ attempts \((simulated_failure|timeout|processor_error)\)$/,
  /^Stale write discarded for event [0-9a-f]{24} \(attempt \d+\)$/,
  /^Claim failed: \w+( \(code \S+\))?$/,
  /^Write for event [0-9a-f]{24} abandoned: \w+( \(code \S+\))?$/,
];

export const D12_MESSAGES = [
  'Simulated external call failure',
  'External call failed',
];
