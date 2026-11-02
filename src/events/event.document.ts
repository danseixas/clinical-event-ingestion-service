import { ObjectId } from 'mongodb';

export type EventStatus = 'pending' | 'processing' | 'done' | 'failed';

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
}
