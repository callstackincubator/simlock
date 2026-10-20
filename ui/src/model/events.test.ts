import { describe, expect, it } from "vitest";

import {
  type ConsoleEvent,
  eventsOfWorker,
  mergeEvents,
  payloadPairs,
  readEvent,
  readReplay,
  sinceFor,
  subjectOf,
  timeOfDay,
  workerIdOf,
} from "./events";

const T0 = Date.parse("2026-10-02T11:30:00Z");

function event(name: string, payload: unknown = {}, seq = 1, id = `evt_${seq}`): ConsoleEvent {
  return { event: name, id, payload, seq, timestamp: T0 };
}

describe("an envelope off the wire", () => {
  it("is not an event without a numeric seq, a timestamp that is a date, or a string name and id", () => {
    const valid = { event: "lease.granted", id: "evt_1", seq: 1, timestamp: T0 };
    const broken = [
      { event: "lease.granted", id: "evt_a", timestamp: T0 },
      { event: "lease.granted", id: "evt_b", seq: 1 },
      { id: "evt_c", seq: 2, timestamp: T0 },
      { event: "lease.granted", id: "evt_d", seq: 3, timestamp: 1e300 },
      { event: "lease.granted", id: "evt_e", seq: 5, timestamp: "2026-10-02T11:30:00Z" },
      { event: "lease.granted", id: "evt_f", seq: "6", timestamp: T0 },
      { event: 7, id: "evt_g", seq: 7, timestamp: T0 },
      { event: "lease.granted", seq: 8, timestamp: T0 },
      { event: "lease.granted", id: 9, seq: 9, timestamp: T0 },
      null,
      "text",
    ];

    expect(readReplay({ events: [...broken, valid] }).map((entry) => entry.id)).toEqual(["evt_1"]);
    expect(broken.map(readEvent)).toEqual(broken.map(() => undefined));
  });

  it("is refused as unreadable when the answer has no events list", () => {
    expect(() => readReplay({ items: [] })).toThrow(SyntaxError);
    expect(() => readReplay(null)).toThrow(SyntaxError);
  });
});

describe("the events the console holds", () => {
  it("are listed newest first, by seq inside the same millisecond", () => {
    const merged = mergeEvents([], [event("a", {}, 2), event("b", {}, 9), event("c", {}, 5)]);

    expect(merged.map((entry) => entry.seq)).toEqual([9, 5, 2]);
  });

  it("show an event seen twice once, and two ids with the same seq and time both", () => {
    const first = event("lease.granted", {}, 1, "evt_a");
    const merged = mergeEvents([first], [first, event("lease.granted", {}, 1, "evt_b")]);

    expect(merged.map((entry) => entry.id).sort()).toEqual(["evt_a", "evt_b"]);
  });

  it("change nothing for an event already held", () => {
    const held = [event("lease.granted")];

    expect(mergeEvents(held, [event("lease.granted")])).toBe(held);
  });
});

describe("the gap to load after the stream was closed", () => {
  it("is rounded up to whole seconds, so its first event is inside the window", () => {
    expect(sinceFor(1_300)).toBe("2s");
    expect(sinceFor(2_000)).toBe("2s");
  });
});

describe("an event's subject", () => {
  it("is the word before the first dot, or other for a word the console does not know", () => {
    expect(
      ["lease.granted", "device.ready", "worker.connected", "component.installed"].map(subjectOf),
    ).toEqual(["lease", "device", "worker", "component"]);
    expect(["daemon.started", "gizmo.frobnicated", "plain"].map(subjectOf)).toEqual([
      "other",
      "other",
      "other",
    ]);
  });
});

describe("an event's worker", () => {
  it("is the workerId its payload names", () => {
    expect(workerIdOf(event("lease.granted", { workerId: "wrk_1" }))).toBe("wrk_1");
    expect(workerIdOf(event("lease.granted", {}))).toBeUndefined();
    expect(workerIdOf(event("lease.granted", "text"))).toBeUndefined();
  });

  it("is none for worker.rejected, whose workerId is what a refused dial claimed", () => {
    expect(workerIdOf(event("worker.rejected", { workerId: "wrk_1" }))).toBeUndefined();
  });
});

describe("an event's payload", () => {
  it("is every key as the daemon spelled it, text as itself and anything else as JSON", () => {
    expect(
      payloadPairs({ count: 3, nested: { deep: true }, reason: "because", workerId: "wrk_1" }),
    ).toEqual([
      { key: "count", value: "3" },
      { key: "nested", value: '{"deep":true}' },
      { key: "reason", value: "because" },
      { key: "workerId", value: "wrk_1" },
    ]);
  });

  it("shows as one pair, payload, when it is not an object, and as none when absent", () => {
    expect(payloadPairs(["a", 1])).toEqual([{ key: "payload", value: '["a",1]' }]);
    expect(payloadPairs("text")).toEqual([{ key: "payload", value: "text" }]);
    expect(payloadPairs(null)).toEqual([{ key: "payload", value: "null" }]);
    expect(payloadPairs(undefined)).toEqual([]);
    expect(payloadPairs({})).toEqual([]);
  });
});

describe("an event's time", () => {
  it("is its time of day on the browser's clock face", () => {
    const zone = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      expect(timeOfDay(T0)).toBe("17:00:00");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe("the events of one worker", () => {
  const events = [
    event("lease.granted", { workerId: "wrk_1" }, 1),
    event("worker.drained", { workerId: "wrk_2" }, 3),
    event("lease.granted", { leaseId: "lse_1" }, 2),
    event("worker.rejected", { workerId: "wrk_1" }, 4),
  ];
  const ids = (list: readonly ConsoleEvent[]) => list.map((entry) => entry.id);

  it("are those whose payload names the worker, newest first, on a gateway and until the mode is known, and every event on a single host", () => {
    expect(ids(eventsOfWorker(events, "wrk_1", "gateway"))).toEqual(["evt_1"]);
    expect(ids(eventsOfWorker(events, "wrk_1", undefined))).toEqual(["evt_1"]);
    expect(ids(eventsOfWorker(events, "wrk_2", "gateway"))).toEqual(["evt_3"]);
    expect(ids(eventsOfWorker(events, "wrk_1", "worker"))).toEqual([
      "evt_4",
      "evt_3",
      "evt_2",
      "evt_1",
    ]);
  });
});
