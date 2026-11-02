const TS_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parses the strict RFC 3339 profile accepted for `ts` (spec D-10) into a UTC
 * Date truncated to milliseconds. Returns null for anything outside the profile.
 */
export function parseEventTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = TS_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const offset = match[8]!;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const sign = offset.startsWith('-') ? -1 : 1;
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMins = Number(offset.slice(4, 6));
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }

  // setUTCFullYear avoids Date.UTC mapping years 0-99 to 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  const instant = new Date(date.getTime() - offsetMinutes * 60_000);

  const time = instant.getTime();
  if (time < Date.UTC(1970, 0, 1)) return null;
  if (time > 253_402_300_799_999) return null; // 9999-12-31T23:59:59.999Z
  return instant;
}
