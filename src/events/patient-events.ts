import type { Collection, FindCursor, Sort } from 'mongodb';
import type { EventDocument } from './event.document.js';

/** Key order matters: `ts`, then `receivedAt`, then `_id`. */
export const PATIENT_READ_ORDER = {
  ts: 1,
  receivedAt: 1,
  _id: 1,
} as const satisfies Sort;

/**
 * Every event of one patient (all statuses), ordered by `ts`, with ties
 * broken by `receivedAt` and then `_id`. Served by the `patient_read_order`
 * index. Uses the collection's default read concern and read preference.
 * Must not log: it returns clinical data.
 */
export function findPatientEvents(
  collection: Collection<EventDocument>,
  patientId: string,
): FindCursor<EventDocument> {
  return collection.find<EventDocument>({ patientId }).sort(PATIENT_READ_ORDER);
}
