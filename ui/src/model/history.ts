import type { ConsoleEvent } from "./events";

const MINUTE = 60_000;

export const HISTORY_MINUTES = 60;

export interface MinuteCount {
  readonly at: number;
  readonly label: string;
  readonly count: number | null;
}

export type CountedMinute = MinuteCount & { readonly count: number };

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

// why: an event stamped later than `now`, which a skewed clock can produce, counts in the current
// minute; one older than the last hour counts in none.
export function eventsPerMinute(
  events: readonly ConsoleEvent[],
  now: number,
): readonly CountedMinute[] {
  const minutes = lastHour(now);
  const counts = new Map(minutes.map((at) => [at, 0]));
  for (const event of events) {
    const at = minuteOf(Math.min(event.timestamp, now));
    const count = counts.get(at);
    if (count !== undefined) counts.set(at, count + 1);
  }
  return minutes.map((at) => ({ at, count: counts.get(at) ?? 0, label: minuteLabel(at) }));
}

// why: a bucket with no data is not 0, so it is neither the highest nor the lowest.
export function extremes(
  minutes: readonly MinuteCount[],
): { readonly highest: CountedMinute; readonly lowest: CountedMinute } | undefined {
  let highest: CountedMinute | undefined;
  let lowest: CountedMinute | undefined;
  for (const minute of minutes) {
    if (minute.count === null) continue;
    const counted = { ...minute, count: minute.count };
    if (highest === undefined || counted.count >= highest.count) highest = counted;
    if (lowest === undefined || counted.count <= lowest.count) lowest = counted;
  }
  return highest === undefined || lowest === undefined ? undefined : { highest, lowest };
}
