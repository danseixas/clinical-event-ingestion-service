import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Collection, MongoServerError } from 'mongodb';
import { EVENTS_COLLECTION } from '../database/database.tokens.js';
import type { EventDocument, EventStatus } from '../events/event.document.js';
import { isStoreUnavailable } from '../events/store-errors.js';

export const STATS_MAX_TIME_MS = 5000;
export const STORE_UNAVAILABLE_MESSAGE = 'Event store unavailable, retry later';
const MAX_TIME_MS_EXPIRED = 50;

export const STATS_STATUSES: readonly EventStatus[] = [
  'pending',
  'processing',
  'done',
  'failed',
];

export interface StatsBody {
  counts: Record<EventStatus, number>;
  due: number;
  expiredLeases: number;
  oldestDueAgeMs: number;
  generatedAt: string;
}

// The two branches of the worker claim (spec D-04), so /stats cannot disagree
// with what the worker considers claimable.
export function dueFilter(now: Date) {
  return { status: 'pending' as const, nextAttemptAt: { $lte: now } };
}

export function expiredLeaseFilter(now: Date) {
  return { status: 'processing' as const, lockedUntil: { $lt: now } };
}

export const OLDEST_DUE_OPTIONS = {
  sort: { nextAttemptAt: 1 },
  projection: { nextAttemptAt: 1 },
  maxTimeMS: STATS_MAX_TIME_MS,
} as const;

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);

  constructor(
    @Inject(EVENTS_COLLECTION)
    private readonly events: Collection<EventDocument>,
  ) {}

  async snapshot(): Promise<StatsBody> {
    const now = new Date();
    const opts = { maxTimeMS: STATS_MAX_TIME_MS };
    try {
      const [statusCounts, due, expiredLeases, oldest] = await Promise.all([
        Promise.all(
          STATS_STATUSES.map((status) =>
            this.events.countDocuments({ status }, opts),
          ),
        ),
        this.events.countDocuments(dueFilter(now), opts),
        this.events.countDocuments(expiredLeaseFilter(now), opts),
        this.events.findOne(dueFilter(now), {
          ...OLDEST_DUE_OPTIONS,
          sort: { ...OLDEST_DUE_OPTIONS.sort },
          projection: { ...OLDEST_DUE_OPTIONS.projection },
        }),
      ]);
      const counts = Object.fromEntries(
        STATS_STATUSES.map((status, i) => [status, statusCounts[i]!]),
      ) as Record<EventStatus, number>;
      const oldestDueAgeMs =
        due === 0 || !oldest
          ? 0
          : Math.max(0, now.getTime() - oldest.nextAttemptAt.getTime());
      return {
        counts,
        due,
        expiredLeases,
        oldestDueAgeMs,
        generatedAt: now.toISOString(),
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  // Only the error name and code are logged, never the driver message.
  private mapError(error: unknown): unknown {
    const timedOut =
      error instanceof MongoServerError && error.code === MAX_TIME_MS_EXPIRED;
    if (!timedOut && !isStoreUnavailable(error)) return error;
    const name = (error as Error).name;
    const code = (error as { code?: string | number }).code;
    this.logger.warn(
      `Event store unavailable: ${name}${code === undefined ? '' : ` (code ${code})`}`,
    );
    return new ServiceUnavailableException(STORE_UNAVAILABLE_MESSAGE);
  }
}
