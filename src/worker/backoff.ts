export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

/**
 * Exponential backoff with equal jitter after failed attempt `attempt`
 * (1-based): the delay is in [cap/2, cap) with
 * cap = min(maxMs, baseMs * 2^(attempt-1)).
 */
export function computeBackoffMs(
  attempt: number,
  { baseMs, maxMs }: BackoffOptions,
  random: () => number = Math.random,
): number {
  if (baseMs === 0) return 0;
  const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(cap / 2 + (random() * cap) / 2);
}
