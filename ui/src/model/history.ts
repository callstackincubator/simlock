import type { ConsoleEvent } from "./events";

const MINUTE = 60_000;

export const HISTORY_MINUTES = 60;

export interface MinuteCount {
  readonly at: number;
  readonly label: string;
  readonly count: number;
}

function minuteOf(at: number): number {
  return Math.floor(at / MINUTE) * MINUTE;
}

function lastHour(now: number): readonly number[] {
  const current = minuteOf(now);
  return Array.from(
    { length: HISTORY_MINUTES },
    (_, index) => current - (HISTORY_MINUTES - 1 - index) * MINUTE,
  );
}

export function minuteLabel(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function leaseChange(event: ConsoleEvent): number {
  if (event.event === "lease.granted") return 1;
  if (event.event === "lease.released" || event.event === "lease.expired") return -1;
  return 0;
}

// why: events the view does not hold, older than the last hour or past what `GET /v1/events`
// returns, cannot be walked back through, so a count never goes below 0.
export function leaseHistory(
  current: number,
  events: readonly ConsoleEvent[],
  now: number,
): readonly MinuteCount[] {
  const changes = events
    .map((event) => ({ at: event.timestamp, change: leaseChange(event) }))
    .filter((entry) => entry.change !== 0);
  const minutes = lastHour(now);
  return minutes.map((at, index) => {
    // why: the current minute is `current` itself: an event stamped after `now`, which ticks once a
    // second, is already in it.
    const end = index === minutes.length - 1 ? Infinity : at + MINUTE;
    const since = changes.reduce((sum, entry) => (entry.at > end ? sum + entry.change : sum), 0);
    return { at, count: Math.max(0, current - since), label: minuteLabel(at) };
  });
}

// why: an event stamped later than `now`, which a skewed clock can produce, counts in the current
// minute; one older than the last hour counts in none.
export function eventsPerMinute(
  events: readonly ConsoleEvent[],
  now: number,
): readonly MinuteCount[] {
  const minutes = lastHour(now);
  const counts = new Map(minutes.map((at) => [at, 0]));
  for (const event of events) {
    const at = minuteOf(Math.min(event.timestamp, now));
    const count = counts.get(at);
    if (count !== undefined) counts.set(at, count + 1);
  }
  return minutes.map((at) => ({ at, count: counts.get(at) ?? 0, label: minuteLabel(at) }));
}

export function extremes(
  minutes: readonly MinuteCount[],
): { readonly highest: MinuteCount; readonly lowest: MinuteCount } | undefined {
  const [first] = minutes;
  if (first === undefined) return undefined;
  let highest = first;
  let lowest = first;
  for (const minute of minutes) {
    if (minute.count >= highest.count) highest = minute;
    if (minute.count <= lowest.count) lowest = minute;
  }
  return { highest, lowest };
}
