import { createHash } from 'node:crypto';

/**
 * Serializes a JSON value with object keys sorted recursively (UTF-16 code
 * unit order), array order preserved and no whitespace. The key order rule is
 * a stored-data contract: changing it changes every idempotency key.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeIdempotencyKey(input: {
  data: unknown;
  patientId: string;
  ts: Date;
  type: string;
}): string {
  const json = canonicalJson({
    data: input.data,
    patientId: input.patientId,
    ts: input.ts.toISOString(),
    type: input.type,
  });
  return createHash('sha256').update(json, 'utf8').digest('hex');
}
