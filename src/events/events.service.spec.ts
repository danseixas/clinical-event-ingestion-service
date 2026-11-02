import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  MongoError,
  MongoNetworkError,
  MongoNotConnectedError,
  MongoServerError,
  MongoServerSelectionError,
  MongoWriteConcernError,
  ObjectId,
} from 'mongodb';
import { CreateEventDto } from './create-event.dto.js';
import { EventsService } from './events.service.js';

const body: CreateEventDto = {
  patientId: 'p-secret-1',
  type: 'vitals-secret',
  ts: '2026-11-02T10:00:00Z',
  data: { hr: 72 },
};

function duplicateError(): MongoServerError {
  return new MongoServerError({
    code: 11000,
    errmsg: 'E11000 duplicate key',
    keyPattern: { idempotencyKey: 1 },
    keyValue: { idempotencyKey: 'abc' },
  });
}

function setup(collection: { insertOne?: unknown; findOne?: unknown }) {
  const service = new EventsService(collection as never);
  const warn = vi.fn();
  (service as unknown as { logger: Partial<Logger> }).logger = { warn };
  return { service, warn };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('EventsService', () => {
  it('inserts the initial document with majority write concern', async () => {
    const insertOne = vi.fn().mockResolvedValue({});
    const { service, warn } = setup({ insertOne });
    const result = await service.ingest(body);
    expect(result).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{24}$/),
      status: 'pending',
      duplicate: false,
    });
    const [doc, options] = insertOne.mock.calls[0]!;
    expect(options).toEqual({
      writeConcern: { w: 'majority', wtimeoutMS: 5000 },
    });
    expect(Object.keys(doc).sort()).toEqual(
      [
        '_id',
        'attempts',
        'data',
        'idempotencyKey',
        'nextAttemptAt',
        'patientId',
        'receivedAt',
        'status',
        'ts',
        'type',
      ].sort(),
    );
    expect(doc.nextAttemptAt).toBe(doc.receivedAt);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the original on E11000 when visible at once', async () => {
    const _id = new ObjectId();
    const findOne = vi.fn().mockResolvedValue({ _id, status: 'processing' });
    const { service } = setup({
      insertOne: vi.fn().mockRejectedValue(duplicateError()),
      findOne,
    });
    expect(await service.ingest(body)).toEqual({
      id: _id.toHexString(),
      status: 'processing',
      duplicate: true,
    });
    expect(findOne.mock.calls[0]![1]).toMatchObject({
      readConcern: { level: 'majority' },
      readPreference: 'primary',
    });
  });

  it('retries the duplicate read until visible', async () => {
    const _id = new ObjectId();
    const findOne = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id, status: 'pending' });
    const { service } = setup({
      insertOne: vi.fn().mockRejectedValue(duplicateError()),
      findOne,
    });
    expect((await service.ingest(body)).duplicate).toBe(true);
    expect(findOne).toHaveBeenCalledTimes(3);
  });

  it('answers 503 with DuplicateNotVisible when retries run out', async () => {
    const findOne = vi.fn().mockResolvedValue(null);
    const { service, warn } = setup({
      insertOne: vi.fn().mockRejectedValue(duplicateError()),
      findOne,
    });
    const error = await rejection(service.ingest(body));
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(findOne).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Event store unavailable: DuplicateNotVisible',
    );
  });

  const unavailable: [string, () => Error][] = [
    [
      'MongoServerSelectionError',
      () => new MongoServerSelectionError('secret', {} as never),
    ],
    ['MongoNetworkError', () => new MongoNetworkError('secret')],
    ['MongoNotConnectedError', () => new MongoNotConnectedError('secret')],
    [
      'MongoWriteConcernError',
      () =>
        new MongoWriteConcernError({
          ok: 1,
          writeConcernError: { errmsg: 'secret', code: 64 },
        } as never),
    ],
    [
      'MongoError',
      () => {
        const e = new MongoError('secret');
        e.addErrorLabel('RetryableWriteError');
        return e;
      },
    ],
  ];

  it.each(unavailable)(
    'maps %s on insert to 503 with a safe warn',
    async (name, make) => {
      const { service, warn } = setup({
        insertOne: vi.fn().mockRejectedValue(make()),
      });
      const error = await rejection(service.ingest(body));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        statusCode: 503,
        message: 'Event store unavailable, retry later',
        error: 'Service Unavailable',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain(name);
      expect(line).not.toMatch(/secret|vitals|abc/);
    },
  );

  it('maps a findOne selection error to 503', async () => {
    const { service, warn } = setup({
      insertOne: vi.fn().mockRejectedValue(duplicateError()),
      findOne: vi
        .fn()
        .mockRejectedValue(new MongoServerSelectionError('x', {} as never)),
    });
    expect(await rejection(service.ingest(body))).toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rethrows E11000 on a different key and generic errors', async () => {
    const other = new MongoServerError({
      code: 11000,
      errmsg: 'dup',
      keyPattern: { other: 1 },
      keyValue: { other: 1 },
    });
    for (const failure of [other, new Error('boom')]) {
      const { service, warn } = setup({
        insertOne: vi.fn().mockRejectedValue(failure),
      });
      expect(await rejection(service.ingest(body))).toBe(failure);
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
