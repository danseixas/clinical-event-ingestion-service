import { computeBackoffMs } from './backoff.js';

describe('computeBackoffMs', () => {
  const options = { baseMs: 1000, maxMs: 60_000 };

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'stays in [cap/2, cap) for attempt %i',
    (n) => {
      const cap = Math.min(60_000, 1000 * 2 ** (n - 1));
      for (const random of [0, 0.999999]) {
        const delay = computeBackoffMs(n, options, () => random);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(cap / 2);
        expect(delay).toBeLessThan(cap);
      }
    },
  );

  it('hits the maximum from attempt 7', () => {
    expect(computeBackoffMs(7, options, () => 0)).toBe(30_000);
    expect(computeBackoffMs(8, options, () => 0)).toBe(30_000);
    expect(computeBackoffMs(6, options, () => 0)).toBe(16_000);
  });

  it('is 0 when the base is 0, even for huge attempt numbers', () => {
    expect(computeBackoffMs(1, { baseMs: 0, maxMs: 0 })).toBe(0);
    expect(computeBackoffMs(5000, { baseMs: 0, maxMs: 10 })).toBe(0);
  });

  it('keeps a constant cap when base equals max', () => {
    for (const n of [1, 2, 5, 20]) {
      const delay = computeBackoffMs(n, { baseMs: 400, maxMs: 400 }, () => 0);
      expect(delay).toBe(200);
    }
  });

  it('copes with attempt numbers that overflow the power', () => {
    expect(computeBackoffMs(5000, options, () => 0)).toBe(30_000);
  });
});
