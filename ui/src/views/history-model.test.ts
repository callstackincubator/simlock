import { describe, expect, it } from "vitest";

import type { ConsoleEvent } from "./events-model";
import {
  eventsPerMinute,
  extremes,
  HISTORY_MINUTES,
  leaseHistory,
  minuteLabel,
} from "./history-model";

const MINUTE = 60_000;
/** 12:00:30 on the daemon's clock: half a minute into the current minute. */
const NOW = Date.parse("2026-10-02T12:00:30Z");
const CURRENT = Date.parse("2026-10-02T12:00:00Z");

let seq = 0;
function event(name: string, timestamp: number): ConsoleEvent {
  seq += 1;
  return { event: name, payload: {}, seq, timestamp };
}

/** The count of each minute, keyed by how many minutes before the current one it starts. */
function byMinutesAgo(minutes: readonly { at: number; count: number }[]): Map<number, number> {
  return new Map(minutes.map((minute) => [(CURRENT - minute.at) / MINUTE, minute.count]));
}

describe("the lease history", () => {
  it("the lease history counts back from today's leases through granted, released and expired events", () => {
    // Held now: 3. One was granted after the view's last tick of now, so it is in now's count.
    // Walking back: 10 s ago one was granted (1 before it); 3 min ago one was
    // released (2 before it); 5 min ago one expired (3 before it); 20 min ago one was granted
    // (2 before it). Other events change nothing.
    const events = [
      event("lease.granted", NOW + 500),
      event("lease.granted", NOW - 10_000),
      event("device.ready", NOW - 15_000),
      event("lease.released", CURRENT - 3 * MINUTE + 5_000),
      event("lease.expired", CURRENT - 5 * MINUTE + 5_000),
      event("lease.requested", CURRENT - 10 * MINUTE + 5_000),
      event("lease.granted", CURRENT - 20 * MINUTE + 5_000),
    ];

    const minutes = leaseHistory(3, events, NOW);

    expect(minutes).toHaveLength(HISTORY_MINUTES);
    expect(minutes[0]?.at).toBe(CURRENT - 59 * MINUTE);
    expect(minutes.at(-1)?.at).toBe(CURRENT);
    expect(minutes.at(-1)?.label).toBe(minuteLabel(CURRENT));
    const counts = byMinutesAgo(minutes);
    // The current minute is now: what the workers hold.
    expect(counts.get(0)).toBe(3);
    // The end of the minute before is before the grant 10 s ago.
    expect(counts.get(1)).toBe(1);
    expect(counts.get(2)).toBe(1);
    // The minute the release happened in ends after it; the minute before ends before it.
    expect(counts.get(3)).toBe(1);
    expect(counts.get(4)).toBe(2);
    expect(counts.get(5)).toBe(2);
    expect(counts.get(6)).toBe(3);
    expect(counts.get(10)).toBe(3);
    expect(counts.get(20)).toBe(3);
    expect(counts.get(21)).toBe(2);
    expect(counts.get(59)).toBe(2);
  });

  it("the lease history never counts below zero when the events granted more leases than are held now", () => {
    const events = [event("lease.granted", NOW - 10_000), event("lease.granted", NOW - 20_000)];

    const counts = byMinutesAgo(leaseHistory(1, events, NOW));

    expect(counts.get(0)).toBe(1);
    expect(counts.get(1)).toBe(0);
  });
});

describe("events per minute", () => {
  it("events per minute counts each held event in its minute", () => {
    const events = [
      event("lease.granted", NOW - 1_000),
      event("device.ready", CURRENT),
      event("lease.requested", CURRENT - 1),
      event("lease.queued", CURRENT - MINUTE),
      event("worker.connected", CURRENT - 2 * MINUTE + 59_999),
      event("daemon.started", CURRENT - 59 * MINUTE),
      // Older than the last hour: in no minute.
      event("lease.released", CURRENT - 59 * MINUTE - 1),
      // Stamped after now by a skewed clock: the current minute.
      event("lease.expired", NOW + 90_000),
    ];

    const minutes = eventsPerMinute(events, NOW);

    expect(minutes).toHaveLength(HISTORY_MINUTES);
    const counts = byMinutesAgo(minutes);
    expect(counts.get(0)).toBe(3);
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(1);
    expect(counts.get(59)).toBe(1);
    expect(minutes.reduce((sum, minute) => sum + minute.count, 0)).toBe(7);
  });
});

describe("the highest and lowest minute", () => {
  it("names the latest minute each of the highest and the lowest count was reached", () => {
    const minute = (at: number, count: number) => ({ at, count, label: String(at) });
    const minutes = [
      minute(1, 2),
      minute(2, 0),
      minute(3, 5),
      minute(4, 0),
      minute(5, 5),
      minute(6, 1),
    ];

    const found = extremes(minutes);

    expect(found?.highest).toEqual(minute(5, 5));
    expect(found?.lowest).toEqual(minute(4, 0));
    expect(extremes([])).toBeUndefined();
  });
});
