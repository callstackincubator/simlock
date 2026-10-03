/**
 * Times the console shows are counted in the browser from the timestamps in the data
 * (ADR 0013 §4). The browser's clock may differ from the daemon's, so every duration is measured
 * against the daemon's time: the browser's own, plus the offset the latest `Date` header showed.
 */

/**
 * How far the daemon's clock is ahead of the browser's, in milliseconds, from a response's
 * `Date` header and the browser time it arrived at. `undefined` when the header is missing or
 * not a date, so a bad header leaves the last good offset in place.
 */
export function clockOffset(date: string | null, receivedAt: number): number | undefined {
  if (date === null) return undefined;
  const sent = Date.parse(date);
  return Number.isFinite(sent) ? sent - receivedAt : undefined;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A duration the way the console writes one: the largest two units, rounded down, such as
 * `12 s`, `4 min 5 s`, `3 h 20 min`, `2 d 1 h`. A negative duration, which a skewed timestamp
 * can produce, shows as `0 s`.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND)) * SECOND;
  if (total < MINUTE) return `${total / SECOND} s`;
  const units: readonly [number, string][] = [
    [DAY, "d"],
    [HOUR, "h"],
    [MINUTE, "min"],
    [SECOND, "s"],
  ];
  const first = units.findIndex(([size]) => total >= size);
  const parts: string[] = [];
  let rest = total;
  for (const [size, name] of units.slice(first, first + 2)) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0 || parts.length === 0) parts.push(`${count} ${name}`);
  }
  return parts.join(" ");
}
