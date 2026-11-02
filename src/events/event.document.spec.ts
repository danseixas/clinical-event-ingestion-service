import { ObjectId } from 'mongodb';
import type { EventDocument } from './event.document.js';

const base = {
  _id: new ObjectId(),
  idempotencyKey: 'a'.repeat(64),
  patientId: 'p-type',
  type: 'vitals',
  data: { hr: 72 },
  ts: new Date('2026-11-02T13:00:00.000Z'),
  receivedAt: new Date('2026-11-02T13:00:01.000Z'),
  attempts: 0,
  nextAttemptAt: new Date('2026-11-02T13:00:01.000Z'),
};

// These checks are made by the compiler (`tsc --noEmit`): an unused
// `@ts-expect-error` is itself an error.
const pending = { ...base, status: 'pending' } satisfies EventDocument;

const done = {
  ...base,
  status: 'done',
  lockedUntil: new Date(),
  workerId: 'w-1',
  result: { ok: true },
  lastError: {
    code: 'timeout',
    message: 'Processing timed out',
    at: new Date(),
  },
  processedAt: new Date(),
} satisfies EventDocument;

// null is not the way to clear a field (use $unset).
const nullLock: EventDocument = {
  ...base,
  status: 'processing',
  // @ts-expect-error null is not a valid lockedUntil
  lockedUntil: null,
};

const noAt: EventDocument = {
  ...base,
  status: 'failed',
  // @ts-expect-error lastError requires `at`
  lastError: { code: 'x', message: 'y' },
};

const badResult: EventDocument = {
  ...base,
  status: 'done',
  // @ts-expect-error result must be an object
  result: 'x',
};

describe('EventDocument type', () => {
  it('compiles the pending and done fixtures', () => {
    expect(pending.status).toBe('pending');
    expect(typeof done.lastError.code).toBe('string');
    expect([nullLock, noAt, badResult]).toHaveLength(3);
  });
});
