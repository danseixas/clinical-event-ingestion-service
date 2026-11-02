import { ObjectId } from 'mongodb';

export type EventStatus = 'pending' | 'processing' | 'done' | 'failed';

/**
 * The most recent failed attempt. `code` is a fixed machine label (for
 * example `timeout`, `simulated_failure`). `message` must never contain
 * `patientId`, `type`, `ts`, `data` or the idempotency key.
 */
export interface EventError {
  code: string;
  message: string;
  at: Date;
}

/**
 * One stored event. The optional fields are absent until set, and code that
 * clears one (for example on return to `pending`) uses `$unset`, never `null`.
 *
 * Presence rules for the processing fields:
 * - `lockedUntil` and `workerId` are present only while `status` is
 *   `processing`.
 * - `result` is present only when `status` is `done`.
 * - `processedAt` is present when `status` is `done` or `failed`.
 * - `lastError` holds the most recent failed attempt. It may be present in
 *   `pending` (waiting to retry) or `failed`, and stays as history after a
 *   successful completion.
 */
export interface EventDocument {
  _id: ObjectId;
  idempotencyKey: string;
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: Date;
  receivedAt: Date;
  status: EventStatus;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date;
  workerId?: string;
  result?: Record<string, unknown>;
  lastError?: EventError;
  processedAt?: Date;
}
