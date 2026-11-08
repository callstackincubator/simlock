import { describe, expect, it } from "vitest";

import { inboxItems } from "../../../src/contract/inbox";
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
  it("draws the six tiles in order from what the workers, the queue and the daemon's figures say, each with its destination", () => {
    const requests = [
      { createdAt: NOW - 74_000, id: "r1", requesterId: "a", spec: { platform: "ios" } },
      { createdAt: NOW - 10_000, id: "r2", requesterId: "b", spec: { platform: "ios" } },
    ] as unknown as WaitingRequest[];
    const stats = statsOf({
      bucketMs: 60_000,
      from: NOW - 6 * 60 * 60_000,
      granted: 3,
      to: NOW,
      waitP95: 38_000,
    });

    const { tiles } = overviewOf({
      figures: { data: figuresOf(stats, "6h", NOW), kind: "ready" },
      leases: [],
      now: NOW,
      range: "6h",
      requests,
      workers: fleet,
    });

    expect(tiles.map((tile) => [tile.label, tile.value, tile.unit, tile.to])).toEqual([
      ["Leased", "2", "/ 4", "/leases"],
      ["Ready", "1", "warm", "/fleet"],
      ["Waiting", "2", "max 1 min 14 s", "/queue"],
      ["Wait p95", "38 s", "last 6 hours", "/usage?range=6h"],
      ["Ending soon", "0", "< 5 min", "/leases"],
      ["Workers", "2", "/ 3", "/fleet"],
    ]);
  });

  it("shows Ending soon, Wait p95 and Waiting as unknown, never zero, while their reads are missing", () => {
    const loading = overviewOf({ now: NOW, requests: undefined, workers: fleet });

    const unknown = loading.tiles.filter((tile) =>
      ["Ending soon", "Wait p95", "Waiting"].includes(tile.label),
    );
    expect(unknown.map((tile) => [tile.label, tile.value, tile.unit])).toEqual([
      ["Waiting", "—", undefined],
      ["Wait p95", "—", undefined],
      ["Ending soon", "—", undefined],
    ]);
    expect(loading.queue).toEqual({ unavailable: "The queue could not be read." });
    expect(loading.ending).toEqual({ unavailable: "The leases could not be read." });
  });

  it("makes the banner from the Inbox's problems in its order, with the first one linked and the rest counted, and leaves heads-ups out", () => {
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
    const workers = [...fleet, worker("down-2", [], { connection: "disconnected" })];
    const items = inboxItems(workers, { leases: [lease], now: NOW });

    const { banner } = overviewOf({ items, leases: [], now: NOW, requests: [], workers });

    expect(banner).toEqual({
      count: 4,
      first: { text: "Pixel 8 on mini-2 · quarantined", to: "/inbox/mini-2%2Fd%2Fquarantined" },
      more: 3,
      title: "4 things need you",
    });
    expect(overviewOf({ items: [], now: NOW, requests: [], workers }).banner).toBeUndefined();
  });

  it("lists the longest-waiting requests and the soonest-ending leases, each linked", () => {
    const requests = ["r1", "r2", "r3", "r4"].map((id, index) => ({
      createdAt: NOW - (40 - index * 10) * 1_000,
      id,
      queuePosition: index + 1,
      requesterId: `codex:${id}`,
      spec: { platform: "ios" },
      stage: "queued",
    })) as unknown as WaitingRequest[];
    const ends = (id: string, deadline: number) => ({
      deviceId: "a",
      grantedAt: NOW - 60_000,
      id,
      idChosenByRequester: false,
      lastRenewedAt: NOW - 30_000,
      ownerId: "tok_1",
      requesterId: "release-bot",
      ttlDeadline: deadline,
      ttlMs: 900_000,
      workerId: "mini-1",
    });

    const { ending, queue } = overviewOf({
      leases: [ends("late", NOW + 250_000), ends("soon", NOW + 156_000), ends("far", NOW + 9e5)],
      now: NOW,
      requests,
      workers: fleet,
    });

    expect(queue).toMatchObject({ meta: "4 waiting · longest 40 s" });
    expect(
      "rows" in queue && queue.rows.map((row) => [row.place, row.holder, row.waited, row.to]),
    ).toEqual([
      ["#1", "codex:r1", "40 s", "/queue/r1"],
      ["#2", "codex:r2", "30 s", "/queue/r2"],
      ["#3", "codex:r3", "20 s", "/queue/r3"],
    ]);
    expect(ending).toMatchObject({ meta: "2 under 5 min" });
    expect(
      "rows" in ending && ending.rows.map((row) => [row.holder, row.remaining, row.to]),
    ).toEqual([
      ["release-bot", "2:36", "/leases/soon/"],
      ["release-bot", "4:10", "/leases/late/"],
    ]);
  });

  it("lists the Fleet page's own rows for the card, a worker with an issue first, and cuts them at eight", () => {
    const { fleet: card } = overviewOf({ now: NOW, requests: [], workers: fleet });

    expect(card.total).toBe(3);
    expect(
      card.attention.map((row) => [row.name, row.health.tone, row.health.word, row.to]),
    ).toEqual([
      ["mini-2", "warn", "drained", "/fleet/mini-2"],
      ["down-1", "error", "disconnected", "/fleet/down-1"],
    ]);
    expect(card.healthy.map((row) => row.name)).toEqual(["mini-1"]);
    expect(card.healthy[0]?.slotsLabel).toBe("2 leased, 1 ready, 3 free");
    expect(card.attention[1]?.meters).toEqual([]);

    const many = Array.from({ length: 12 }, (_, index) => worker(`w-${index}`, []));
    const cut = overviewOf({
      now: NOW,
      requests: [],
      workers: [...many, worker("down-9", [], { connection: "disconnected" })],
    }).fleet;
    expect(cut.total).toBe(13);
    expect(cut.attention.map((row) => row.name)).toEqual(["down-9"]);
    expect(cut.healthy).toHaveLength(7);
  });

  it("leaves the fleet's lease figure unknown, not zero, while a connected worker is starting", () => {
    const alone = overviewOf({ now: NOW, requests: [], workers: [unread("mini-3")] });

    expect(alone.tiles.map((tile) => [tile.label, tile.value])).toEqual([
      ["Leased", "—"],
      ["Ready", "0"],
      ["Waiting", "0"],
      ["Wait p95", "—"],
      ["Ending soon", "—"],
      ["Workers", "1"],
    ]);
    expect(alone.capacity.map((p) => [p.name, p.notRead, p.parts.length])).toEqual([
      ["iOS", 1, 0],
      ["Android", 1, 0],
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
