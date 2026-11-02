import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { MongoServerError, MongoServerSelectionError } from 'mongodb';
import {
  dueFilter,
  expiredLeaseFilter,
  StatsService,
} from './stats.service.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');

function setup(
  overrides: { countDocuments?: unknown; findOne?: unknown } = {},
) {
  const countDocuments =
    overrides.countDocuments ?? vi.fn().mockResolvedValue(0);
  const findOne = overrides.findOne ?? vi.fn().mockResolvedValue(null);
  const service = new StatsService({ countDocuments, findOne } as never);
  const warn = vi.fn();
  (service as unknown as { logger: Partial<Logger> }).logger = { warn };
  return { service, warn, countDocuments, findOne };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('StatsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('builds the body with one now and maxTimeMS on every query', async () => {
    const countDocuments = vi.fn(async (filter: Record<string, unknown>) => {
      if (filter.status === 'pending' && 'nextAttemptAt' in filter) return 3;
      if (filter.status === 'processing' && 'lockedUntil' in filter) return 1;
      return ({ pending: 5, processing: 5, done: 7, failed: 2 } as any)[
        filter.status as string
      ];
    });
    const findOne = vi
      .fn()
      .mockResolvedValue({ nextAttemptAt: new Date(NOW.getTime() - 10_500) });
    const { service, warn } = setup({ countDocuments, findOne });
    const body = await service.snapshot();
    expect(Object.keys(body)).toEqual([
      'counts',
      'due',
      'expiredLeases',
      'oldestDueAgeMs',
      'generatedAt',
    ]);
    expect(body).toEqual({
      counts: { pending: 5, processing: 5, done: 7, failed: 2 },
      due: 3,
      expiredLeases: 1,
      oldestDueAgeMs: 10_500,
      generatedAt: NOW.toISOString(),
    });
    expect(countDocuments).toHaveBeenCalledWith(dueFilter(NOW), {
      maxTimeMS: 5000,
    });
    expect(countDocuments).toHaveBeenCalledWith(expiredLeaseFilter(NOW), {
      maxTimeMS: 5000,
    });
    expect(findOne.mock.calls[0]![0]).toEqual(dueFilter(NOW));
    expect(findOne.mock.calls[0]![1]).toMatchObject({
      sort: { nextAttemptAt: 1 },
      projection: { nextAttemptAt: 1 },
      maxTimeMS: 5000,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports oldestDueAgeMs 0 when nothing is due', async () => {
    const findOne = vi.fn().mockResolvedValue({ nextAttemptAt: NOW });
    const { service } = setup({ findOne });
    const body = await service.snapshot();
    expect(body.oldestDueAgeMs).toBe(0);
    expect(body.counts).toEqual({
      pending: 0,
      processing: 0,
      done: 0,
      failed: 0,
    });
  });

  it('maps a store error to 503 with one warn', async () => {
    const countDocuments = vi
      .fn()
      .mockRejectedValue(
        new MongoServerSelectionError('secret-host', {} as never),
      );
    const { service, warn } = setup({ countDocuments });
    const error = await rejection(service.snapshot());
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).message).toBe(
      'Event store unavailable, retry later',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Event store unavailable: MongoServerSelectionError',
    );
  });

  it('maps MaxTimeMSExpired (code 50) to 503 without the driver message', async () => {
    const findOne = vi.fn().mockRejectedValue(
      new MongoServerError({
        code: 50,
        codeName: 'MaxTimeMSExpired',
        errmsg: 'operation exceeded time limit on secret-host',
      }),
    );
    const { service, warn } = setup({ findOne });
    const error = await rejection(service.snapshot());
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Event store unavailable: MongoServerError (code 50)',
    );
    expect(String(warn.mock.calls[0]![0])).not.toContain('secret-host');
  });

  it('warns once when several parallel queries fail', async () => {
    const fail = () =>
      vi
        .fn()
        .mockRejectedValue(new MongoServerSelectionError('x', {} as never));
    const { service, warn } = setup({
      countDocuments: fail(),
      findOne: fail(),
    });
    await rejection(service.snapshot());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rethrows other errors unchanged without a warn', async () => {
    const boom = new Error('boom');
    const { service, warn } = setup({
      countDocuments: vi.fn().mockRejectedValue(boom),
    });
    expect(await rejection(service.snapshot())).toBe(boom);
    expect(warn).not.toHaveBeenCalled();
  });
});
