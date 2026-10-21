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

    const { ending, tiles, wait } = overviewOf({
      events,
      figures: { data: figuresOf(stats, "1h", NOW), kind: "ready" },
      leases: [],
      now: NOW,
      requests,
      workers: fleet,
    });

    const shown = [...tiles, wait, ending];
    expect(shown.map((tile) => [tile?.label, tile?.value, tile?.unit])).toEqual([
      ["Leased", "2", "of 4 · 1 ready"],
      ["Waiting", "1", "longest 1 min 14 s"],
      ["Workers", "2", "of 3"],
      ["Wait p95", "38 s", "last hour"],
      ["Ending soon", "0", "under 5 min"],
    ]);
  });

  it("has no Wait p95 tile while the daemon's figures are loading or refused", () => {
    const shown = [{ kind: "loading" }, { kind: "refused", message: "no" }] as const;

    const waits = shown.map(
      (figures) => overviewOf({ events: [], figures, now: NOW, requests: [], workers: fleet }).wait,
    );

    expect(waits).toEqual([undefined, undefined]);
  });

  it("lists what needs you in the Inbox's order, each linked to its own page and toned by how bad it is", () => {
    const { inbox } = overviewOf({ events: [], now: NOW, requests: [], workers: fleet });

    expect(inbox.problems).toBe(3);
    expect(inbox.needsYou.map((item) => [item.word, item.tone, item.subject, item.to])).toEqual([
      ["quarantined", "error", "Pixel 8 on mini-2", "/inbox/mini-2%2Fd%2Fquarantined"],
      ["disconnected", "error", "down-1", "/inbox/down-1%2Fdisconnected"],
      ["drained", "warn", "mini-2", "/inbox/mini-2%2Fdrained"],
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
      to: "/activity/e10",
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
      ["Leased", "—"],
      ["Waiting", "0"],
      ["Workers", "1"],
    ]);

    expect(alone.capacity.map((p) => [p.name, p.notRead, p.parts.length])).toEqual([
      ["iOS", 1, 0],
      ["Android", 1, 0],
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
      ["Leased", "—"],
      ["Waiting", "0"],
      ["Workers", "2"],
    ]);

    expect(mixed.workers.map((r) => [r.name, r.leases, r.slotsLabel])).toEqual([
      ["mini-1", 1, "1 leased, 1 ready, 4 free"],
      ["mini-3", undefined, "Not reported"],
    ]);
  });

  it("counts every read device per platform by part: a drained worker's ready device is drained, a disconnected worker's devices are offline, a shutdown device is shut down, a deleted one is not counted, and a worker not read yet adds nothing", () => {
    const workers = [
      worker("w1", [
        device("a", "leased", "ios"),
        device("b", "ready", "ios"),
        device("c", "provisioning", "ios"),
        device("d", "reclaiming", "ios"),
        device("e", "shutdown", "ios"),
        device("f", "deleted", "ios"),
        device("g", "absent", "ios"),
        device("h", "quarantined", "android"),
      ]),
      worker("w2", [device("i", "ready", "ios"), device("j", "leased", "ios")], { drained: true }),
      worker("w3", [device("k", "ready", "ios"), device("l", "leased", "android")], {
        connection: "disconnected",
      }),
      unread("w4"),
    ];

    const { capacity } = overviewOf({ events: [], now: NOW, requests: [], workers });

    expect(
      capacity.map((platform) => [
        platform.name,
        platform.notRead,
        platform.parts.map((part) => [part.count, part.word]),
      ]),
    ).toEqual([
      [
        "iOS",
        1,
        [
          [2, "leased"],
          [1, "ready"],
          [2, "booting"],
          [1, "drained"],
          [1, "absent"],
          [1, "shut down"],
          [1, "offline"],
        ],
      ],
      [
        "Android",
        1,
        [
          [1, "quarantined"],
          [1, "offline"],
        ],
      ],
    ]);
  });
});
