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

const LEASE_EXPIRED_MESSAGE = 'Lease expired before the attempt completed';

const WRITE_CONCERN = { w: 'majority', wtimeoutMS: WRITE_TIMEOUT_MS } as const;

type ErrorCode =
  'simulated_failure' | 'timeout' | 'processor_error' | 'lease_expired';

type Outcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: ErrorCode };

// A claimed event plus the attempt values this worker derived itself. The
// claim returns the pre-update document, so these are never read from it.
interface Claim {
  doc: EventDocument;
  attempts: number;
  lockedUntil: Date;
  reclaimed: boolean;
}

// Per-attempt state the bounded stop needs to abort and abandon the attempt.
class AttemptState {
  readonly controller = new AbortController();
  cancelled = false;
  private readonly cancelListeners = new Set<() => void>();

  cancel(): void {
    this.cancelled = true;
    this.controller.abort(new Error('shutdown'));
    for (const listener of this.cancelListeners) listener();
  }

  // Resolves after `ms`, or at once when the attempt is cancelled.
  wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.cancelled) return resolve();
      const done = () => {
        clearTimeout(timer);
        this.cancelListeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.cancelListeners.add(done);
    });
  }
}

// Claims due pending events and expired-lease processing events, calls the
// processor with bounded concurrency and records each outcome with a write
// that applies only while this attempt still holds the claim. Shutdown drains
// in-flight attempts for up to SHUTDOWN_TIMEOUT_MS, then leaves the rest for
// lease reclaim.
@Injectable()
export class EventsWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(EventsWorker.name);
  private readonly inFlight = new Map<Promise<void>, AttemptState>();
  private workerId = '';
  private stopping = false;
  private loop: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  // Ends the pool-full wait when an attempt settles.
  private slotWaiter: (() => void) | undefined;
  // Ends any dispatcher wait when the stop begins.
  private stopWake: (() => void) | undefined;

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
    const deadline = Date.now() + this.setting('SHUTDOWN_TIMEOUT_MS');
    this.logger.log(
      `Worker stopping: ${this.inFlight.size} attempts in flight`,
    );
    this.stopping = true;
    this.stopWake?.();
    await this.loop;
    const drained = await this.drain(deadline);
    if (!drained) {
      const unfinished = [...this.inFlight.values()];
      this.logger.warn(
        `Shutdown timeout after ${this.setting('SHUTDOWN_TIMEOUT_MS')} ms: ${unfinished.length} attempts left for lease reclaim`,
      );
      for (const state of unfinished) state.cancel();
    }
    this.logger.log('Worker stopped');
  }

  // Resolves true when every in-flight attempt has settled, false at the deadline.
  private async drain(deadline: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        Math.max(0, deadline - Date.now()),
      );
    });
    try {
      while (this.inFlight.size > 0) {
        const settled = await Promise.race([
          Promise.all(this.inFlight.keys()).then(() => true as const),
          expired,
        ]);
        if (!settled) return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  // Pool-full wait: ends when an attempt settles or the stop begins.
  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.slotWaiter === done) this.slotWaiter = undefined;
        if (this.stopWake === done) this.stopWake = undefined;
        resolve();
      };
      this.slotWaiter = done;
      this.stopWake = done;
    });
  }

  // Poll wait: ends only on its timer or when the stop begins.
  private waitForPoll(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.stopWake === done) this.stopWake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.stopWake = done;
    });
  }

  // The dispatcher. It never rejects.
  private async run(): Promise<void> {
    const concurrency = this.setting('WORKER_CONCURRENCY');
    const pollMs = this.setting('POLL_INTERVAL_MS');
    while (!this.stopping) {
      if (this.inFlight.size >= concurrency) {
        await this.waitForSlot();
        continue;
      }
      let claimed: Claim | null;
      try {
        claimed = await this.claim();
      } catch (error) {
        this.logger.warn(`Claim failed: ${describeError(error)}`);
        if (!this.stopping) await this.waitForPoll(pollMs);
        continue;
      }
      if (!claimed) {
        if (!this.stopping) await this.waitForPoll(pollMs);
        continue;
      }
      this.start(claimed);
    }
  }

  private async claim(): Promise<Claim | null> {
    const now = Date.now();
    const lockedUntil = new Date(now + this.setting('LEASE_MS'));
    const before = await this.events.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', nextAttemptAt: { $lte: new Date(now) } },
          { status: 'processing', lockedUntil: { $lt: new Date(now) } },
        ],
      },
      {
        $set: {
          status: 'processing',
          workerId: this.workerId,
          lockedUntil,
        },
        $inc: { attempts: 1 },
      },
      {
        sort: { nextAttemptAt: 1 },
        returnDocument: 'before',
        writeConcern: WRITE_CONCERN,
      },
    );
    if (!before) return null;
    return {
      doc: before,
      attempts: before.attempts + 1,
      lockedUntil,
      reclaimed: before.status === 'processing',
    };
  }

  private start(claim: Claim): void {
    const state = new AttemptState();
    const attempt: Promise<void> = this.attempt(claim, state)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(attempt);
        this.slotWaiter?.();
      });
    this.inFlight.set(attempt, state);
  }

  private async attempt(claim: Claim, state: AttemptState): Promise<void> {
    if (claim.reclaimed) {
      this.logger.warn(
        `Reclaimed event ${claim.doc._id.toHexString()} after lease expiry (attempt ${claim.attempts})`,
      );
      if (claim.attempts > this.setting('MAX_ATTEMPTS')) {
        await this.recordOutcome(claim, state, {
          ok: false,
          code: 'lease_expired',
        });
        return;
      }
    }
    const outcome = await this.callProcessor(claim.doc, state);
    await this.recordOutcome(claim, state, outcome);
  }

  private async callProcessor(
    claimed: EventDocument,
    state: AttemptState,
  ): Promise<Outcome> {
    const timeoutMs = this.setting('PROCESSING_TIMEOUT_MS');
    const controller = state.controller;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('timeout'));
        resolve({ ok: false, code: 'timeout' });
      }, timeoutMs);
      // A cancelled attempt settles at once so its timer does not linger.
      controller.signal.addEventListener(
        'abort',
        () => {
          if (state.cancelled) resolve({ ok: false, code: 'processor_error' });
        },
        { once: true },
      );
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
    claim: Claim,
    state: AttemptState,
    outcome: Outcome,
  ): Promise<void> {
    const claimed = claim.doc;
    const attempts = claim.attempts;
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
      // After the stop deadline no new outcome write is sent.
      if (state.cancelled) return;
      try {
        const res = await this.events.updateOne(filter, update, {
          writeConcern: WRITE_CONCERN,
        });
        if (state.cancelled) return;
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
        if (state.cancelled) return;
        if (!isStoreUnavailable(error) || retries >= OUTCOME_WRITE_RETRIES) {
          return this.abandon(id, error);
        }
        await state.wait(OUTCOME_WRITE_RETRY_DELAY_MS);
        if (state.cancelled) return;
        // The lease is the limit: past it another worker may own the event.
        if (Date.now() >= claim.lockedUntil.getTime()) {
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
      case 'lease_expired':
        return LEASE_EXPIRED_MESSAGE;
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
