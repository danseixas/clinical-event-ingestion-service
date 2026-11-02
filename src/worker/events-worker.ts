import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Collection, Document } from 'mongodb';
import { EnvironmentVariables } from '../config/env.validation.js';
import { EVENTS_COLLECTION } from '../database/database.tokens.js';
import type { EventDocument, EventError } from '../events/event.document.js';
import { isStoreUnavailable } from '../events/store-errors.js';
import { computeBackoffMs } from './backoff.js';
import { EVENT_PROCESSOR, type EventProcessor } from './event-processor.js';
import { SimulatedFailureError } from './simulated-processor.js';

const WRITE_TIMEOUT_MS = 5000;
const OUTCOME_WRITE_RETRIES = 3;
const OUTCOME_WRITE_RETRY_DELAY_MS = 1000;

const WRITE_CONCERN = { w: 'majority', wtimeoutMS: WRITE_TIMEOUT_MS } as const;

type ErrorCode = 'simulated_failure' | 'timeout' | 'processor_error';

type Outcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: ErrorCode };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Claims due events, calls the processor with bounded concurrency and records
// each outcome with a write that applies only while this attempt still holds
// the claim. Lease reclaim and signal-driven shutdown come later.
@Injectable()
export class EventsWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(EventsWorker.name);
  private readonly inFlight = new Set<Promise<void>>();
  private workerId = '';
  private stopping = false;
  private loop: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    @Inject(EVENTS_COLLECTION)
    private readonly events: Collection<EventDocument>,
    @Inject(EVENT_PROCESSOR) private readonly processor: EventProcessor,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  private setting<K extends keyof EnvironmentVariables>(
    key: K,
  ): EnvironmentVariables[K] {
    return this.config.get(key, { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.setting('WORKER_ENABLED')) {
      this.logger.log('Worker disabled (WORKER_ENABLED=false)');
      return;
    }
    this.workerId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
    this.logger.log(
      `Worker started: concurrency ${this.setting('WORKER_CONCURRENCY')}, workerId ${this.workerId}`,
    );
    this.loop = this.run();
  }

  beforeApplicationShutdown(): Promise<void> {
    this.stopPromise ??= this.stop();
    return this.stopPromise;
  }

  private async stop(): Promise<void> {
    if (!this.loop) return;
    this.stopping = true;
    this.wake?.();
    await this.loop;
    while (this.inFlight.size > 0) {
      await Promise.all(this.inFlight);
    }
    this.logger.log('Worker stopped');
  }

  // Resolves after `ms` (or never, without `ms`) unless woken earlier.
  private waitForWake(ms?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      this.wake = done;
    });
  }

  // The dispatcher. It never rejects.
  private async run(): Promise<void> {
    const concurrency = this.setting('WORKER_CONCURRENCY');
    const pollMs = this.setting('POLL_INTERVAL_MS');
    while (!this.stopping) {
      if (this.inFlight.size >= concurrency) {
        await this.waitForWake();
        continue;
      }
      let claimed: EventDocument | null;
      try {
        claimed = await this.claim();
      } catch (error) {
        this.logger.warn(`Claim failed: ${describeError(error)}`);
        if (!this.stopping) await this.waitForWake(pollMs);
        continue;
      }
      if (!claimed) {
        if (!this.stopping) await this.waitForWake(pollMs);
        continue;
      }
      this.start(claimed);
    }
  }

  private claim(): Promise<EventDocument | null> {
    const now = Date.now();
    return this.events.findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: new Date(now) } },
      {
        $set: {
          status: 'processing',
          workerId: this.workerId,
          lockedUntil: new Date(now + this.setting('LEASE_MS')),
        },
        $inc: { attempts: 1 },
      },
      {
        sort: { nextAttemptAt: 1 },
        returnDocument: 'after',
        writeConcern: WRITE_CONCERN,
      },
    );
  }

  private start(claimed: EventDocument): void {
    const attempt: Promise<void> = this.attempt(claimed)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(attempt);
        this.wake?.();
      });
    this.inFlight.add(attempt);
  }

  private async attempt(claimed: EventDocument): Promise<void> {
    const outcome = await this.callProcessor(claimed);
    await this.recordOutcome(claimed, outcome);
  }

  private async callProcessor(claimed: EventDocument): Promise<Outcome> {
    const timeoutMs = this.setting('PROCESSING_TIMEOUT_MS');
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('timeout'));
        resolve({ ok: false, code: 'timeout' });
      }, timeoutMs);
    });
    let call: Promise<Outcome>;
    try {
      call = this.processor
        .process(
          {
            eventId: claimed._id.toHexString(),
            idempotencyKey: claimed.idempotencyKey,
            patientId: claimed.patientId,
            type: claimed.type,
            ts: claimed.ts,
            data: claimed.data,
          },
          controller.signal,
        )
        .then(
          (result): Outcome => ({ ok: true, result }),
          (error: unknown): Outcome => ({
            ok: false,
            code:
              error instanceof SimulatedFailureError
                ? 'simulated_failure'
                : 'processor_error',
          }),
        );
    } catch {
      call = Promise.resolve({ ok: false, code: 'processor_error' });
    }
    try {
      // A call that loses the race to the timeout is already handled above,
      // so a late result or rejection is ignored.
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordOutcome(
    claimed: EventDocument,
    outcome: Outcome,
  ): Promise<void> {
    const attempts = claimed.attempts;
    const now = new Date();
    const unlock = { workerId: '', lockedUntil: '' };
    let update: Document;
    let lastErrorCode: ErrorCode | undefined;
    if (outcome.ok) {
      update = {
        $set: { status: 'done', result: outcome.result, processedAt: now },
        $unset: unlock,
      };
    } else {
      lastErrorCode = outcome.code;
      const lastError: EventError = {
        code: outcome.code,
        message: this.errorMessage(outcome.code),
        at: now,
      };
      update =
        attempts < this.setting('MAX_ATTEMPTS')
          ? {
              $set: {
                status: 'pending',
                nextAttemptAt: new Date(
                  now.getTime() +
                    computeBackoffMs(attempts, {
                      baseMs: this.setting('BACKOFF_BASE_MS'),
                      maxMs: this.setting('BACKOFF_MAX_MS'),
                    }),
                ),
                lastError,
              },
              $unset: unlock,
            }
          : {
              $set: { status: 'failed', processedAt: now, lastError },
              $unset: unlock,
            };
    }
    const isFinalFailure =
      lastErrorCode !== undefined && attempts >= this.setting('MAX_ATTEMPTS');
    const filter = {
      _id: claimed._id,
      status: 'processing' as const,
      workerId: this.workerId,
      attempts,
    };
    const id = claimed._id.toHexString();

    for (let retries = 0; ; retries++) {
      try {
        const res = await this.events.updateOne(filter, update, {
          writeConcern: WRITE_CONCERN,
        });
        if (res.matchedCount === 0) {
          this.logger.warn(
            `Stale write discarded for event ${id} (attempt ${attempts})`,
          );
        } else if (isFinalFailure) {
          this.logger.warn(
            `Event ${id} failed after ${attempts} attempts (${lastErrorCode})`,
          );
        }
        return;
      } catch (error) {
        if (!isStoreUnavailable(error) || retries >= OUTCOME_WRITE_RETRIES) {
          return this.abandon(id, error);
        }
        await sleep(OUTCOME_WRITE_RETRY_DELAY_MS);
        // The lease is the limit: past it another worker may own the event.
        if (Date.now() >= (claimed.lockedUntil?.getTime() ?? 0)) {
          return this.abandon(id, error);
        }
      }
    }
  }

  private abandon(id: string, error: unknown): void {
    this.logger.warn(
      `Write for event ${id} abandoned: ${describeError(error)}`,
    );
  }

  private errorMessage(code: ErrorCode): string {
    switch (code) {
      case 'simulated_failure':
        return 'Simulated external call failure';
      case 'timeout':
        return `External call timed out after ${this.setting('PROCESSING_TIMEOUT_MS')} ms`;
      case 'processor_error':
        return 'External call failed';
    }
  }
}

function describeError(error: unknown): string {
  const name =
    typeof (error as { name?: unknown } | null)?.name === 'string'
      ? (error as Error).name
      : 'Error';
  const code = (error as { code?: string | number } | null)?.code;
  return `${name}${code === undefined ? '' : ` (code ${code})`}`;
}
