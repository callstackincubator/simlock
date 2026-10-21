import { describe, expect, it } from "vitest";

import type { ConsoleEvent } from "./events";
import { figuresOf } from "./figures";
import { overviewOf } from "./overview";
import { statsOf } from "./test-support";
import type { WaitingRequest } from "./waiting";
import type { WorkerDevice, WorkerView } from "./workers";

const NOW = Date.parse("2026-10-15T12:00:00Z");

function device(id: string, state: string, platform: "ios" | "android"): WorkerDevice {
  return {
    id,
    mode: "full",
    physical: false,
    spec: {
      model: platform === "ios" ? "iPhone 16" : "Pixel 8",
      osVersion: "1",
      physical: false,
      platform,
    },
    state,
  } as unknown as WorkerDevice;
}

function worker(
  id: string,
  devices: readonly WorkerDevice[],
  overrides: Partial<WorkerView> = {},
): WorkerView {
  return {
    capacity: {
      android: { limit: 2, running: 0 },
      global: { limit: 6, running: 0, warm: 0 },
      ios: { limit: 4, running: 0 },
    },
    catalog: [],
    connection: "connected",
    devices: [...devices],
    drained: false,
    id,
    label: id,
    lastSeenAt: NOW,
    leases: devices
      .filter((entry) => entry.state === "leased")
      .map((entry) => ({ deviceId: entry.id, grantedAt: NOW - 60_000, id: `l_${entry.id}` })),
    ...overrides,
  } as unknown as WorkerView;
}

function event(seq: number, name: string, at: number): ConsoleEvent {
  return { event: name, id: `e${seq}`, payload: {}, seq, timestamp: at };
}

const fleet = [
  worker("mini-1", [
    device("a", "leased", "ios"),
    device("b", "ready", "ios"),
    device("c", "leased", "android"),
  ]),
  worker("mini-2", [device("d", "quarantined", "android")], { drained: true }),
  worker("down-1", [], { connection: "disconnected" }),
];

// why: A worker whose uplink is open but which answers `starting`: its view carries no leases, no
// devices and no capacity, which is "not known" (ADR 0005, #365), not "none". A gateway sends
// exactly this view (test: "lists no device or lease for a worker that is starting..." in
// src/gateway/dispatcher.test.ts), and it holds whatever the console cannot see: its live leases.
function unread(id: string): WorkerView {
  return {
    connection: "connected",
    drained: false,
    health: "starting",
    id,
    label: id,
    lastSeenAt: NOW,
  } as unknown as WorkerView;
}

describe("the overview", () => {
  it("counts the fleet's headline figures from what the workers, the queue and the daemon's figures say", () => {
    const requests = [{ createdAt: NOW - 74_000, id: "r1" }] as unknown as WaitingRequest[];
    const events = [
      event(1, "lease.granted", NOW - 2 * 60 * 60 * 1_000),
      event(2, "lease.granted", NOW - 10 * 60 * 1_000),
      event(3, "lease.released", NOW - 5 * 60 * 1_000),
    ];
    const stats = statsOf({
      bucketMs: 60_000,
      from: NOW - 60 * 60_000,
      granted: 3,
      to: NOW,
      waitP95: 38_000,
    });

    const { tiles } = overviewOf({
      events,
      figures: { data: figuresOf(stats, "1h", NOW), kind: "ready" },
      now: NOW,
      requests,
      workers: fleet,
    });

    expect(tiles.map((tile) => [tile.label, tile.value, tile.unit])).toEqual([
      ["Utilisation", "17", "%"],
      ["Leases", "2", "of 12"],
      ["Waiting", "1", "longest 1 min 14 s"],
      ["Workers", "2", "of 3 up"],
      ["Granted", "3", "last hour"],
      ["Wait p95", "38 s", "last hour"],
    ]);
    expect(tiles.find((tile) => tile.label === "Granted")?.to).toBe("/usage");
  });

  it("links the Granted tile to /usage from 1h and to /usage?range=6h, 24h and 7d from the others", () => {
    const links = (["1h", "6h", "24h", "7d"] as const).map((range) => {
      const stats = statsOf({ bucketMs: 60_000, from: NOW - 60 * 60_000, granted: 3, to: NOW });
      const { tiles } = overviewOf({
        events: [],
        figures: { data: figuresOf(stats, range, NOW), kind: "ready" },
        now: NOW,
        requests: [],
        workers: fleet,
      });
      return tiles.find((tile) => tile.label === "Granted")?.to;
    });

    expect(links).toEqual(["/usage", "/usage?range=6h", "/usage?range=24h", "/usage?range=7d"]);
  });

  it("shows only the fleet's four tiles while the daemon's figures are loading or refused", () => {
    const shown = [{ kind: "loading" }, { kind: "refused", message: "no" }] as const;

    const labels = shown.map((figures) =>
      overviewOf({ events: [], figures, now: NOW, requests: [], workers: fleet }).tiles.map(
        (tile) => tile.label,
      ),
    );

    expect(labels).toEqual([
      ["Utilisation", "Leases", "Waiting", "Workers"],
      ["Utilisation", "Leases", "Waiting", "Workers"],
    ]);
  });

  it("splits each platform's limit into leased, ready and booting, counting connected workers only", () => {
    const { platforms } = overviewOf({ events: [], now: NOW, requests: [], workers: fleet });

    expect(platforms).toEqual([
      {
        busyPercent: 0,
        leasedPercent: 12.5,
        limit: 8,
        name: "iOS",
        readyPercent: 12.5,
        running: 2,
      },
      { busyPercent: 0, leasedPercent: 25, limit: 4, name: "Android", readyPercent: 0, running: 1 },
    ]);
  });

  it("lists what needs attention, each linked to its own page and toned by how bad it is", () => {
    const { attention } = overviewOf({ events: [], now: NOW, requests: [], workers: fleet });

    expect(attention.map((item) => [item.word, item.tone, item.subject, item.to])).toEqual([
      ["drained", "warn", "mini-2", "/attention/mini-2%2Fdrained"],
      ["quarantined", "error", "Pixel 8 on mini-2", "/attention/mini-2%2Fd%2Fquarantined"],
      ["disconnected", "error", "down-1", "/attention/down-1%2Fdisconnected"],
    ]);
  });

  it("shows the newest eight events, newest first, each linked to its page", () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      event(
        index + 1,
        index === 9 ? "device.quarantined" : "lease.granted",
        NOW - (10 - index) * 1_000,
      ),
    );

    const { activity } = overviewOf({ events, now: NOW, requests: [], workers: fleet });

    expect(activity.map((row) => row.key)).toEqual([
      "e10",
      "e9",
      "e8",
      "e7",
      "e6",
      "e5",
      "e4",
      "e3",
    ]);
    expect(activity[0]).toMatchObject({
      name: "device.quarantined",
      to: "/events/e10",
      tone: "error",
    });
    expect(activity[1]).not.toHaveProperty("tone");
  });

  it("lists the eight latest events across a daemon restart, not the eight with the highest seq", () => {
    // why: the console's first load reads the daemon's event file, which survives a restart, so one
    // buffer holds the previous run's events beside the restarted counter's own. `seq` restarts with
    // every daemon, so only `timestamp` then `seq` orders them (the events reference).
    const previousGeneration = [91, 92, 93, 94, 95, 96].map((seq, index) => ({
      event: "lease.released",
      id: `before-${seq}`,
      payload: {},
      seq,
      timestamp: NOW - (20 - index) * 60_000,
    }));
    const currentGeneration = [1, 2, 3, 4].map((seq, index) => ({
      event: "lease.granted",
      id: `after-${seq}`,
      payload: {},
      seq,
      timestamp: NOW - (4 - index) * 60_000,
    }));

    const { activity } = overviewOf({
      events: [...previousGeneration, ...currentGeneration],
      now: NOW,
      requests: [],
      workers: fleet,
    });

    expect(activity.map((row) => row.key)).toEqual([
      "after-4",
      "after-3",
      "after-2",
      "after-1",
      "before-96",
      "before-95",
      "before-94",
      "before-93",
    ]);
  });

  it("gives each worker its health square, its slots and its load, and a lost worker no load", () => {
    const { workers } = overviewOf({ events: [], now: NOW, requests: [], workers: fleet });

    expect(workers.map((row) => [row.name, row.health.tone, row.health.word, row.leases])).toEqual([
      ["mini-1", "ok", "connected", 2],
      ["mini-2", "warn", "drained", 0],
      ["down-1", "error", "disconnected", 0],
    ]);
    expect(workers[0]?.slotsLabel).toBe("2 leased, 1 ready, 3 free");
    expect(workers[2]).not.toHaveProperty("cpu");
  });

  it("leaves the fleet's lease and device figures unknown, not zero, while a connected worker is starting", () => {
    const events = [
      event(1, "lease.granted", NOW - 10 * 60 * 1_000),
      event(2, "lease.granted", NOW - 9 * 60 * 1_000),
      event(3, "lease.granted", NOW - 8 * 60 * 1_000),
    ];

    const alone = overviewOf({ events, now: NOW, requests: [], workers: [unread("mini-3")] });

    expect(alone.tiles.map((tile) => [tile.label, tile.value])).toEqual([
      ["Utilisation", "—"],
      ["Leases", "—"],
      ["Waiting", "0"],
      ["Workers", "1"],
    ]);

    expect(alone.platforms.map((p) => [p.name, p.running, p.limit])).toEqual([
      ["iOS", undefined, undefined],
      ["Android", undefined, undefined],
    ]);

    const row = alone.workers[0];
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("leases");
    expect(row?.slotsLabel).toBe("Not reported");

    const reporting = worker("mini-1", [device("a", "leased", "ios"), device("b", "ready", "ios")]);
    const mixed = overviewOf({
      events,
      now: NOW,
      requests: [],
      workers: [reporting, unread("mini-3")],
    });

    expect(mixed.tiles.map((tile) => [tile.label, tile.value])).toEqual([
      ["Utilisation", "—"],
      ["Leases", "—"],
      ["Waiting", "0"],
      ["Workers", "2"],
    ]);

    expect(mixed.workers.map((r) => [r.name, r.leases, r.slotsLabel])).toEqual([
      ["mini-1", 1, "1 leased, 1 ready, 4 free"],
      ["mini-3", undefined, "Not reported"],
    ]);
  });
});
