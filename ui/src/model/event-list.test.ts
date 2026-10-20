import { describe, expect, it } from "vitest";

import {
  chosenEvent,
  dayWord,
  eventAction,
  eventDetail,
  type EventPlaces,
  eventRows,
  eventsChart,
  readSubject,
  shownEvents,
  writeSubject,
} from "./event-list";
import type { ConsoleEvent } from "./events";
import type { LeaseRecord } from "./leases";
import type { WaitingRequest } from "./waiting";
import type { WorkerView } from "./workers";

const T0 = Date.parse("2026-10-02T11:30:00Z");

function event(name: string, payload: unknown = {}, seq = 1, timestamp = T0): ConsoleEvent {
  return { event: name, id: `evt_${seq}`, payload, seq, timestamp };
}

function worker(id: string, label?: string, extra: object = {}): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id,
    lastSeenAt: T0,
    leases: [],
    ...(label === undefined ? {} : { label }),
    ...extra,
  } as unknown as WorkerView;
}

const NO_PLACES: EventPlaces = { leases: [], requests: [], workers: [] };

function places(extra: Partial<EventPlaces>): EventPlaces {
  return { ...NO_PLACES, ...extra };
}

const lease = (id: string) => ({ id }) as unknown as LeaseRecord;
const request = (id: string) => ({ id }) as unknown as WaitingRequest;

describe("the events filter in the URL", () => {
  it("reads a known subject and takes anything else as the whole feed", () => {
    expect(readSubject("?subject=lease")).toBe("lease");
    expect(readSubject("?subject=other&page=2")).toBe("other");
    expect(readSubject("?subject=gizmo")).toBe("all");
    expect(readSubject("")).toBe("all");
  });

  it("is written beside the other keys, and dropped for all", () => {
    expect(writeSubject("", "device")).toBe("?subject=device");
    expect(writeSubject("?page=2", "worker")).toBe("?page=2&subject=worker");
    expect(writeSubject("?subject=lease&page=2", "all")).toBe("?page=2");
    expect(writeSubject("?subject=lease", "all")).toBe("");
  });
});

describe("the events a filter lets through", () => {
  const events = [
    "lease.granted",
    "device.ready",
    "worker.connected",
    "component.installed",
    "daemon.started",
    "gizmo.frobnicated",
  ].map((name, index) => event(name, {}, index));
  const names = (subject: Parameters<typeof shownEvents>[1]) =>
    shownEvents(events, subject).map((entry) => entry.event);

  it("show only the events about the subject it names", () => {
    expect(names("all")).toHaveLength(6);
    expect(names("lease")).toEqual(["lease.granted"]);
    expect(names("device")).toEqual(["device.ready"]);
    expect(names("worker")).toEqual(["worker.connected"]);
    expect(names("component")).toEqual(["component.installed"]);
    expect(names("other")).toEqual(["daemon.started", "gizmo.frobnicated"]);
  });
});

describe("a list row", () => {
  it("has the time, the name, the summary and a link that keeps the filter", () => {
    const granted = event("lease.granted", { requester: "claude-1", workerId: "wrk_1" }, 7);

    const [row] = eventRows([granted], [worker("wrk_1", "mac-1")], "lease");

    expect(row).toEqual({
      id: "evt_7",
      iso: "2026-10-02T11:30:00.000Z",
      name: "lease.granted",
      summary: "claude-1 · mac-1",
      time: expect.stringMatching(/^\d\d:\d\d:\d\d$/),
      to: "/activity/evt_7?subject=lease",
    });
    expect(eventRows([granted], [], "all")[0]?.to).toBe("/activity/evt_7");
  });

  it("is toned only where the name reports trouble", () => {
    const rows = eventRows(
      [event("device.quarantined"), event("lease.expired", {}, 2), event("lease.granted", {}, 3)],
      [],
      "all",
    );

    expect(rows.map((row) => row.tone)).toEqual(["error", "warn", undefined]);
  });

  it("names no worker for worker.rejected, even one the console lists", () => {
    const rejected = event("worker.rejected", { reason: "unauthenticated", workerId: "wrk_1" });

    const [row] = eventRows([rejected], [worker("wrk_1", "mac-1")], "all");

    expect(row?.summary).toBe("unauthenticated");
  });
});

describe("an event's day", () => {
  const noon = new Date(2026, 9, 2, 12, 0, 0).getTime();

  it("is today, yesterday, or the date", () => {
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0, 0).getTime();

    expect(dayWord(at(2, 0), noon)).toBe("today");
    expect(dayWord(at(1, 23), noon)).toBe("yesterday");
    expect(dayWord(new Date(2026, 8, 29, 23).getTime(), noon)).not.toMatch(/today|yesterday/);
  });
});

describe("an event's detail", () => {
  const now = Date.now();
  const granted = event("lease.granted", { requester: "claude-1", leaseId: "lse_1" }, 1, now);

  it("has the time and day, the summary, and the payload whole", () => {
    const detail = eventDetail(
      event("gizmo.frobnicated", { count: 3, nested: { deep: true } }, 1, now),
      NO_PLACES,
      now,
    );

    expect(detail.line).toMatch(/^\d\d:\d\d:\d\d today$/);
    expect(detail.pairs).toEqual([
      { key: "count", value: "3" },
      { key: "nested", value: '{"deep":true}' },
    ]);
    expect(eventDetail(granted, NO_PLACES, now).line).toMatch(/^\d\d:\d\d:\d\d today · claude-1$/);
  });

  it("keeps a payload that holds a token-shaped value as the daemon sent it", () => {
    const secret = event("daemon.started", { config: { token: "tok_secret" } });

    expect(eventDetail(secret, NO_PLACES, T0).pairs).toEqual([
      { key: "config", value: '{"token":"tok_secret"}' },
    ]);
  });
});

describe("what an event links to", () => {
  it("is its lease when the console lists it, under the id the worker used or the gateway's", () => {
    const granted = event("lease.granted", { leaseId: "lse_1", workerId: "wrk_1" });

    expect(eventAction(granted, places({ leases: [lease("lse_1")] }))).toEqual({
      label: "Open lease",
      to: "/leases/lse_1/",
    });
    expect(eventAction(granted, places({ leases: [lease("wrk_1.lse_1")] }))).toEqual({
      label: "Open lease",
      to: "/leases/wrk_1.lse_1/",
    });
  });

  it("is no lease once the lease is gone", () => {
    expect(eventAction(event("lease.released", { leaseId: "lse_1" }), NO_PLACES)).toBeUndefined();
  });

  it("is a waiting request the console lists", () => {
    const queued = event("lease.queued", { requestId: "req_1" });

    expect(eventAction(queued, places({ requests: [request("req_1")] }))).toEqual({
      label: "Open request",
      to: "/queue/req_1",
    });
    expect(eventAction(queued, NO_PLACES)).toBeUndefined();
  });

  it("is the attention item of a quarantined device", () => {
    const quarantined = worker("wrk_1", "mac-1", {
      devices: [
        {
          id: "dev_1",
          spec: { model: "iPhone 16", osVersion: "18.4" },
          state: "quarantined",
        },
      ],
    });

    expect(
      eventAction(
        event("device.quarantined", { deviceId: "dev_1", workerId: "wrk_1" }),
        places({ workers: [quarantined] }),
      ),
    ).toEqual({ label: "Open attention item", to: "/attention/wrk_1%2Fdev_1%2Fquarantined" });
  });

  it("is the worker the console lists, and none for one it does not", () => {
    const connected = event("worker.connected", { workerId: "wrk_1" });

    expect(eventAction(connected, places({ workers: [worker("wrk_1")] }))).toEqual({
      label: "Open worker",
      to: "/fleet/wrk_1",
    });
    expect(eventAction(connected, NO_PLACES)).toBeUndefined();
  });

  it("is no worker for worker.rejected, whose workerId is only a claim", () => {
    const rejected = event("worker.rejected", { workerId: "wrk_1" });

    expect(eventAction(rejected, places({ workers: [worker("wrk_1")] }))).toBeUndefined();
  });

  it("is the lease before the worker when it names both", () => {
    const granted = event("lease.granted", { leaseId: "lse_1", workerId: "wrk_1" });

    const action = eventAction(
      granted,
      places({ leases: [lease("lse_1")], workers: [worker("wrk_1")] }),
    );

    expect(action?.label).toBe("Open lease");
  });
});

describe("the events chart", () => {
  const now = Date.parse("2026-10-02T11:30:30Z");

  it("counts every event held, in words too, with the busiest minute", () => {
    const events = [
      event("a", {}, 1, now - 5_000),
      event("b", {}, 2, now - 6_000),
      event("c", {}, 3, now - 120_000),
    ];

    const chart = eventsChart(events, now);

    expect(chart.minutes).toHaveLength(60);
    expect(chart.summary).toMatch(
      /^3 events in the last hour; the busiest minute was \d\d:\d\d, with 2\.$/,
    );
  });

  it("says one event in the singular and names no busiest minute for none", () => {
    expect(eventsChart([event("a", {}, 1, now)], now).summary).toMatch(
      /^1 event in the last hour;/,
    );
    expect(eventsChart([], now).summary).toBe("0 events in the last hour.");
  });
});

describe("the event chosen", () => {
  const events = [event("lease.granted", {}, 2), event("device.ready", {}, 1)];
  const rows = eventRows(events, [], "all");
  const choose = (id: string | undefined, shown = rows) =>
    chosenEvent(events, shown, id, NO_PLACES, T0);

  it("is the one the URL names", () => {
    const chosen = choose("evt_1");

    expect(chosen.kind === "event" && chosen.detail.name).toBe("device.ready");
  });

  it("is the first row when the URL names none", () => {
    const chosen = choose(undefined);

    expect(chosen.kind === "event" && chosen.detail.id).toBe("evt_2");
  });

  it("opens an event the filter hides", () => {
    const filtered = eventRows(events, [], "lease");

    const chosen = choose("evt_1", filtered);

    expect(chosen.kind === "event" && chosen.detail.id).toBe("evt_1");
  });

  it("is missing for an id the feed does not hold, and none for an empty feed", () => {
    expect(choose("evt_gone")).toEqual({ id: "evt_gone", kind: "missing" });
    expect(chosenEvent([], [], undefined, NO_PLACES, T0)).toEqual({ kind: "none" });
  });
});
