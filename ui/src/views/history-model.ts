/**
 * The last hour, minute by minute, for the console's two charts. Worked out from what the views
 * already hold: today's leases from `GET /v1/workers`, and the events from `GET /v1/events` and
 * the stream (ADR 0013 §1). Pure, so the charts stay drawing and these stay tested.
 */
import type { ConsoleEvent } from "./events-model";

const MINUTE = 60_000;

/** How many minutes a chart shows: the current one and the 59 before it. */
export const HISTORY_MINUTES = 60;

/** One minute of a chart: when it starts, its `HH:MM` on the browser's clock face, its count. */
export interface MinuteCount {
  readonly at: number;
  readonly label: string;
  readonly count: number;
}

/** The start of the clock minute `at` falls in. */
function minuteOf(at: number): number {
  return Math.floor(at / MINUTE) * MINUTE;
}

/** The start of each of the last {@link HISTORY_MINUTES} clock minutes, oldest first. */
function lastHour(now: number): readonly number[] {
  const current = minuteOf(now);
  return Array.from(
    { length: HISTORY_MINUTES },
    (_, index) => current - (HISTORY_MINUTES - 1 - index) * MINUTE,
  );
}

/** A minute's `HH:MM` on the browser's clock face, as the events view writes an event's time. */
export function minuteLabel(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/** What an event did to the number of leases held: one more, one fewer, or nothing. */
function leaseChange(event: ConsoleEvent): number {
  if (event.event === "lease.granted") return 1;
  if (event.event === "lease.released" || event.event === "lease.expired") return -1;
  return 0;
}

/**
 * How many leases were held at the end of each of the last 60 minutes, and now in the current
 * one. It starts from `current`, the leases held now, and walks back through `events`: before
 * a `lease.granted` there was one lease fewer, and before a `lease.released` or a
 * `lease.expired` one more. Events the view does not hold, older than the last hour or past
 * what `GET /v1/events` returns, cannot be walked back through, and a count never goes below 0.
 */
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
    // The current minute is `current` itself: an event stamped after `now`, which ticks once a
    // second, is already in it.
    const end = index === minutes.length - 1 ? Infinity : at + MINUTE;
    const since = changes.reduce((sum, entry) => (entry.at > end ? sum + entry.change : sum), 0);
    return { at, count: Math.max(0, current - since), label: minuteLabel(at) };
  });
}

/**
 * How many of `events` happened in each of the last 60 minutes. An event stamped later than
 * `now`, which a skewed clock can produce, counts in the current minute; one older than the
 * last hour counts in none.
 */
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

/** The highest and the lowest count, each at the latest minute it was reached. */
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
