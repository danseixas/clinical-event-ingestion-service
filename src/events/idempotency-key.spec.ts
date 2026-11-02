import { parseEventTimestamp } from './event-timestamp.js';
import { canonicalJson, computeIdempotencyKey } from './idempotency-key.js';

function key(
  overrides: Partial<{
    data: unknown;
    patientId: string;
    ts: string;
    type: string;
  }> = {},
): string {
  const input = {
    data: { hr: 72 },
    patientId: 'p1',
    ts: '2026-11-02T10:00:00Z',
    type: 'vitals',
    ...overrides,
  };
  return computeIdempotencyKey({
    data: input.data,
    patientId: input.patientId,
    ts: parseEventTimestamp(input.ts)!,
    type: input.type,
  });
}

describe('canonicalJson', () => {
  it('sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: [2, 1, { z: 1, a: 2 }], a: null })).toBe(
      '{"a":null,"b":[2,1,{"a":2,"z":1}]}',
    );
  });

  it('treats __proto__ and constructor as normal keys', () => {
    const data = JSON.parse('{"__proto__":1,"constructor":{"x":2}}');
    expect(canonicalJson(data)).toBe('{"__proto__":1,"constructor":{"x":2}}');
  });

  it('serializes non-ASCII strings and empty objects', () => {
    expect(canonicalJson({ a: 'çã' })).toBe('{"a":"çã"}');
    expect(canonicalJson({})).toBe('{}');
  });
});

describe('computeIdempotencyKey', () => {
  it('returns 64 lowercase hex characters', () => {
    expect(key()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order at depth >= 2', () => {
    expect(key({ data: { a: { b: { c: 1, d: 2 } }, e: 3 } })).toBe(
      key({ data: { e: 3, a: { b: { d: 2, c: 1 } } } }),
    );
  });

  it('ignores equivalent ts renderings', () => {
    const base = key();
    expect(key({ ts: '2026-11-02T10:00:00.000Z' })).toBe(base);
    expect(key({ ts: '2026-11-02T07:00:00-03:00' })).toBe(base);
    expect(key({ ts: '2026-11-02T10:00:00.0009Z' })).toBe(base);
  });

  it.each([
    ['array order', { data: { a: [1, 2] } }, { data: { a: [2, 1] } }],
    ['number vs string', { data: { a: 1 } }, { data: { a: '1' } }],
    [
      'ts +1 ms',
      { ts: '2026-11-02T10:00:00Z' },
      { ts: '2026-11-02T10:00:00.001Z' },
    ],
    ['leading space', { patientId: 'p1' }, { patientId: ' p1' }],
    ['type', { type: 'a' }, { type: 'b' }],
    ['data value', { data: { a: 1 } }, { data: { a: 2 } }],
  ])('differs for %s', (_name, left, right) => {
    expect(key(left)).not.toBe(key(right));
  });

  it('handles empty data', () => {
    expect(key({ data: {} })).toMatch(/^[0-9a-f]{64}$/);
  });
});
