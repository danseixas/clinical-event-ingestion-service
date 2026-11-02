import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Collection, ObjectId } from 'mongodb';
import { setTimeout as sleep } from 'node:timers/promises';
import { EVENTS_COLLECTION } from '../database/database.tokens.js';
import { CreateEventDto } from './create-event.dto.js';
import { parseEventTimestamp } from './event-timestamp.js';
import type { EventDocument, EventStatus } from './event.document.js';
import { computeIdempotencyKey } from './idempotency-key.js';
import {
  isDuplicateIdempotencyKey,
  isStoreUnavailable,
} from './store-errors.js';

export interface IngestResult {
  id: string;
  status: EventStatus;
  duplicate: boolean;
}

// Fixed timeout (spec D-04) and duplicate-read retry policy (spec D-12).
const WRITE_TIMEOUT_MS = 5000;
const DUPLICATE_READ_RETRIES = 5;
const DUPLICATE_READ_DELAY_MS = 100;

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @Inject(EVENTS_COLLECTION)
    private readonly events: Collection<EventDocument>,
  ) {}

  async ingest(body: CreateEventDto): Promise<IngestResult> {
    const ts = parseEventTimestamp(body.ts)!;
    const idempotencyKey = computeIdempotencyKey({
      data: body.data,
      patientId: body.patientId,
      ts,
      type: body.type,
    });
    const receivedAt = new Date();
    const document: EventDocument = {
      _id: new ObjectId(),
      idempotencyKey,
      patientId: body.patientId,
      type: body.type,
      data: body.data,
      ts,
      receivedAt,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: receivedAt,
    };

    try {
      await this.events.insertOne(document, {
        writeConcern: { w: 'majority', wtimeoutMS: WRITE_TIMEOUT_MS },
      });
      return {
        id: document._id.toHexString(),
        status: 'pending',
        duplicate: false,
      };
    } catch (error) {
      if (isDuplicateIdempotencyKey(error)) {
        return this.readDuplicate(idempotencyKey);
      }
      throw this.mapError(error);
    }
  }

  private async readDuplicate(idempotencyKey: string): Promise<IngestResult> {
    try {
      for (let attempt = 0; attempt <= DUPLICATE_READ_RETRIES; attempt++) {
        if (attempt > 0) await sleep(DUPLICATE_READ_DELAY_MS);
        const existing = await this.events.findOne(
          { idempotencyKey },
          {
            readConcern: { level: 'majority' },
            readPreference: 'primary',
            projection: { _id: 1, status: 1 },
          },
        );
        if (existing) {
          return {
            id: existing._id.toHexString(),
            status: existing.status,
            duplicate: true,
          };
        }
      }
    } catch (error) {
      throw this.mapError(error);
    }
    this.logger.warn('Event store unavailable: DuplicateNotVisible');
    return Promise.reject(this.unavailable());
  }

  // Unexpected errors are returned unchanged and end as Nest's default 500.
  private mapError(error: unknown): unknown {
    if (!isStoreUnavailable(error)) return error;
    const name = (error as Error).name;
    const code = (error as { code?: string | number }).code;
    this.logger.warn(
      `Event store unavailable: ${name}${code === undefined ? '' : ` (code ${code})`}`,
    );
    return this.unavailable();
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Event store unavailable, retry later',
    );
  }
}
