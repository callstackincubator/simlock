import { describe, expect, it } from "vitest";

import type { ConsoleEvent } from "./events";
import { overviewOf } from "./overview";
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
  it("counts the fleet's headline figures from what the workers, the queue and the events say", () => {
    const requests = [{ createdAt: NOW - 74_000, id: "r1" }] as unknown as WaitingRequest[];
    const events = [
      event(1, "lease.granted", NOW - 2 * 60 * 60 * 1_000),
      event(2, "lease.granted", NOW - 10 * 60 * 1_000),
      event(3, "lease.released", NOW - 5 * 60 * 1_000),
    ];

    const { tiles } = overviewOf({ events, now: NOW, requests, workers: fleet });

    expect(tiles.map((tile) => [tile.label, tile.value, tile.unit])).toEqual([
      ["Utilisation", "17", "%"],
      ["Leases", "2", "of 12"],
      ["Waiting", "1", "longest 1 min 14 s"],
      ["Workers", "2", "of 3 up"],
      ["Granted", "1", "last hour"],
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

  it("leaves the fleet's lease and device figures and the lease chart unknown, not zero, while a connected worker is starting", () => {
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
      ["Granted", "3"],
    ]);

    expect(alone.minutes).toEqual([]);
    expect(alone.chartSummary).toBe("");

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
      ["Granted", "3"],
    ]);
    expect(mixed.minutes).toEqual([]);
    expect(mixed.chartSummary).toBe("");

    expect(mixed.workers.map((r) => [r.name, r.leases, r.slotsLabel])).toEqual([
      ["mini-1", 1, "1 leased, 1 ready, 4 free"],
      ["mini-3", undefined, "Not reported"],
    ]);
  });
});
