import { describe, expect, it } from "vitest";

import { figuresOf } from "./figures";
import { overviewOf } from "./overview";
import { statsOf } from "./test-support";
import type { WaitingRequest } from "./waiting";
import { workerRow } from "./worker-page";
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

const fleet = [
  worker("mini-1", [
    device("a", "leased", "ios"),
    device("b", "ready", "ios"),
    device("c", "leased", "android"),
    device("z", "deleted", "ios"),
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
    const requests = [
      { createdAt: NOW - 74_000, id: "r1" },
      { createdAt: NOW - 10_000, id: "r2" },
    ] as unknown as WaitingRequest[];
    const stats = statsOf({
      bucketMs: 60_000,
      from: NOW - 60 * 60_000,
      granted: 3,
      to: NOW,
      waitP95: 38_000,
    });

    const { ending, tiles, wait } = overviewOf({
      figures: { data: figuresOf(stats, "1h", NOW), kind: "ready" },
      leases: [],
      now: NOW,
      requests,
      workers: fleet,
    });

    const shown = [...tiles, wait, ending];
    expect(shown.map((tile) => [tile?.label, tile?.value, tile?.unit])).toEqual([
      ["Leased", "2", "of 4 · 1 ready"],
      ["Waiting", "2", "longest 1 min 14 s"],
      ["Workers", "2", "of 3"],
      ["Wait p95", "38 s", "last hour"],
      ["Ending soon", "0", "under 5 min"],
    ]);
  });

  it("shows Ending soon as unknown, not zero, while the leases cannot be read", () => {
    const { ending } = overviewOf({ now: NOW, requests: [], workers: fleet });

    expect([ending.value, ending.unit]).toEqual(["—", undefined]);
  });

  it("has no Wait p95 tile while the daemon's figures are loading or refused", () => {
    const shown = [{ kind: "loading" }, { kind: "refused", message: "no" }] as const;

    const waits = shown.map(
      (figures) => overviewOf({ figures, now: NOW, requests: [], workers: fleet }).wait,
    );

    expect(waits).toEqual([undefined, undefined]);
  });

  it("lists the first four problems in the Inbox's order, each linked to its own page and toned by how bad it is, and leaves heads-ups out", () => {
    const lease = {
      deviceId: "a",
      grantedAt: NOW - 60_000,
      id: "lse_1",
      idChosenByRequester: false,
      lastRenewedAt: NOW - 30_000,
      ownerId: "tok_1",
      requesterId: "tok_1",
      ttlDeadline: NOW + 100_000,
      ttlMs: 900_000,
    };
    const { inbox } = overviewOf({
      leases: [lease],
      now: NOW,
      requests: [],
      workers: [
        ...fleet,
        worker("down-2", [], { connection: "disconnected" }),
        worker("down-3", [], { connection: "disconnected" }),
      ],
    });

    expect(inbox.problems).toBe(5);
    expect(inbox.needsYou.map((item) => [item.word, item.tone, item.subject, item.to])).toEqual([
      ["quarantined", "error", "Pixel 8 on mini-2", "/inbox/mini-2%2Fd%2Fquarantined"],
      ["disconnected", "error", "down-1", "/inbox/down-1%2Fdisconnected"],
      ["disconnected", "error", "down-2", "/inbox/down-2%2Fdisconnected"],
      ["disconnected", "error", "down-3", "/inbox/down-3%2Fdisconnected"],
    ]);
  });

  it("gives each worker the row Fleet draws: its health, its slots and its use, and a lost worker no use", () => {
    const { workers } = overviewOf({ now: NOW, requests: [], workers: fleet });

    expect(workers.map((row) => [row.name, row.health.tone, row.health.word])).toEqual([
      ["mini-1", "ok", "connected"],
      ["mini-2", "warn", "drained"],
      ["down-1", "error", "disconnected"],
    ]);
    expect(workers).toEqual(fleet.map((worker) => workerRow(worker)));
    expect(workers[0]?.slotsLabel).toBe("2 leased, 1 ready, 3 free");
    expect(workers[2]).not.toHaveProperty("use");
  });

  it("leaves the fleet's lease and device figures unknown, not zero, while a connected worker is starting", () => {
    const alone = overviewOf({ now: NOW, requests: [], workers: [unread("mini-3")] });

    expect(alone.tiles.map((tile) => [tile.label, tile.value])).toEqual([
      ["Leased", "—"],
      ["Waiting", "0"],
      ["Workers", "1"],
    ]);

    expect(alone.capacity.map((p) => [p.name, p.notRead, p.parts.length])).toEqual([
      ["iOS", 1, 0],
      ["Android", 1, 0],
    ]);

    expect(alone.workers).toEqual([workerRow(unread("mini-3"))]);

    const reporting = worker("mini-1", [device("a", "leased", "ios"), device("b", "ready", "ios")]);
    const mixed = overviewOf({
      now: NOW,
      requests: [],
      workers: [reporting, unread("mini-3")],
    });

    expect(mixed.tiles.map((tile) => [tile.label, tile.value])).toEqual([
      ["Leased", "—"],
      ["Waiting", "0"],
      ["Workers", "2"],
    ]);

    expect(mixed.workers.map((r) => [r.name, r.slotsLabel])).toEqual([
      ["mini-1", "1 leased, 1 ready, 4 free"],
      ["mini-3", workerRow(unread("mini-3")).slotsLabel],
    ]);
  });

  it("counts every read device per platform by part: a drained worker's ready device is drained, a disconnected worker's devices are offline, a shutdown device is shut down, a deleted one is not counted, and a worker not read yet adds nothing; the room left under connected workers' limits is free", () => {
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
      worker(
        "w2",
        [device("i", "ready", "ios"), device("j", "leased", "ios"), device("m", "ready", "ios")],
        { drained: true },
      ),
      worker(
        "w3",
        [
          device("k", "ready", "ios"),
          device("l", "leased", "android"),
          device("n", "deleted", "android"),
        ],
        { connection: "disconnected" },
      ),
      unread("w4"),
    ];

    const { capacity } = overviewOf({ now: NOW, requests: [], workers });

    expect(
      capacity.map((platform) => [
        platform.name,
        platform.notRead,
        platform.parts.map((part) => [part.count, part.word, Math.round(part.percent)]),
      ]),
    ).toEqual([
      [
        "iOS",
        1,
        [
          [2, "leased", 18],
          [1, "ready", 9],
          [2, "booting", 18],
          [2, "drained", 18],
          [1, "absent", 9],
          [1, "shut down", 9],
          [1, "offline", 9],
          [1, "free", 9],
        ],
      ],
      [
        "Android",
        1,
        [
          [1, "quarantined", 20],
          [1, "offline", 20],
          [3, "free", 60],
        ],
      ],
    ]);
  });
});
