import { describe, expect, it } from "vitest";

import type { ConsoleEvent } from "./events";
import { eventsPerMinute, extremes, HISTORY_MINUTES } from "./history";

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-02T12:00:30Z");
const CURRENT = Date.parse("2026-10-02T12:00:00Z");

let seq = 0;
function event(name: string, timestamp: number): ConsoleEvent {
  seq += 1;
  return { event: name, id: `evt_${seq}`, payload: {}, seq, timestamp };
}

function byMinutesAgo(minutes: readonly { at: number; count: number }[]): Map<number, number> {
  return new Map(minutes.map((minute) => [(CURRENT - minute.at) / MINUTE, minute.count]));
}

describe("events per minute", () => {
  it("events per minute counts each held event in its minute", () => {
    const events = [
      event("lease.granted", NOW - 1_000),
      event("device.ready", CURRENT),
      event("lease.requested", CURRENT - 1),
      event("lease.queued", CURRENT - MINUTE),
      event("worker.connected", CURRENT - 2 * MINUTE + 59_999),
      event("daemon.started", CURRENT - 59 * MINUTE),
      event("lease.released", CURRENT - 59 * MINUTE - 1),
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
