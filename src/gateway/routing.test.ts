import { describe, expect, it } from "vitest";

import { createRoutingPolicy } from "./routing.js";
import { catalogFixture, deviceFixture, statusFixture } from "./test-support.js";
import type { WorkerView } from "./worker-registry.js";

const REQUEST = {
  model: "iPhone 17",
  osVersion: "26.0",
  platform: "ios" as const,
};

function view(id: string, overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    catalogReadAt: 1,
    connection: "connected",
    devices: [],
    drained: false,
    health: "running",
    id,
    lastSeenAt: 1,
    leases: [],
    capacity: statusFixture().capacity,
    queueDepth: 0,
    ...overrides,
  };
}

describe("the registered warm-then-free policy", () => {
  const policy = createRoutingPolicy("warm-then-free");

  function withIos(slots: { maxRunning: number; running?: number; reserved?: number }) {
    return {
      ...statusFixture().capacity,
      ios: { ...statusFixture().capacity.ios, ...slots },
    };
  }

  it("picks the worker with the most free running capacity, even when it sorts last by id", () => {
    // wrk_a_tight has the higher maxRunning, but its running and reserved slots leave it 2 free
    // against wrk_z_roomy's 5. The ascending-id tie-break alone would pick wrk_a_tight.
    const tight = view("wrk_a_tight", {
      capacity: withIos({ maxRunning: 10, reserved: 4, running: 4 }),
    });
    const roomy = view("wrk_z_roomy", { capacity: withIos({ maxRunning: 5 }) });

    expect(policy.select(REQUEST, [tight, roomy])).toEqual({
      reason: "free-capacity",
      stage: "free-capacity",
      workerId: "wrk_z_roomy",
    });
  });

  it("picks a worker with a warm device over a cold one with more free running capacity", () => {
    // The warm worker sorts last by id and has less room, so only warm-hit can pick it.
    const cold = view("wrk_a_cold", { capacity: withIos({ maxRunning: 5 }) });
    const warm = view("wrk_z_warm", {
      capacity: withIos({ maxRunning: 1 }),
      devices: [deviceFixture("dev_1", "ready")],
    });

    expect(policy.select(REQUEST, [cold, warm])).toEqual({
      reason: "warm-hit",
      stage: "warm-hit",
      workerId: "wrk_z_warm",
    });
  });

  it.each([
    ["starting", "starting" as const],
    ["failed", "failed" as const],
    ["not reporting its health", undefined],
  ])("sends a worker that is %s nothing while a healthy one serves", (_label, health) => {
    // wrk_a sorts first and holds a warm device, so only the health stage can pass it over.
    const { health: _drop, ...base } = view("wrk_a", {
      devices: [deviceFixture("dev_1", "ready")],
    });
    const sick = health === undefined ? base : { ...base, health };

    expect(policy.select(REQUEST, [sick, view("wrk_b")])?.workerId).toBe("wrk_b");
    expect(policy.select(REQUEST, [sick])).toBeUndefined();
  });

  it("passes over a worker with its own waiters queued, warm device or not", () => {
    const warmQueued = view("wrk_a", {
      devices: [deviceFixture("dev_1", "ready")],
      queueDepth: 1,
    });
    const coldQueued = view("wrk_a", { queueDepth: 1 });

    for (const queued of [warmQueued, coldQueued]) {
      expect(policy.select(REQUEST, [queued, view("wrk_b")])?.workerId).toBe("wrk_b");
      expect(policy.select(REQUEST, [queued])).toBeUndefined();
    }
  });

  it("picks a worker whose only slot is held by its own warm device, ahead of the free-slot check", () => {
    // The ready device counts as running, so wrk_a has no free slot; only warm-hit running
    // before free-slot can still pick it.
    const warm = view("wrk_a", {
      capacity: withIos({ maxRunning: 1, running: 1 }),
      devices: [deviceFixture("dev_1", "ready")],
    });

    expect(policy.select(REQUEST, [warm, view("wrk_b")])).toMatchObject({
      reason: "warm-hit",
      workerId: "wrk_a",
    });
    expect(policy.select(REQUEST, [warm])).toMatchObject({ workerId: "wrk_a" });
  });

  it("drops a worker with no free slot before it ranks RAM, so a worker at its budget with a free slot is picked", () => {
    // wrk_a is under budget but full; wrk_b is at budget with a free slot. With RAM ranked
    // first only wrk_a would survive the rank, and the free-slot filter would then leave no pick.
    const full = view("wrk_a", { capacity: withIos({ maxRunning: 1, running: 1 }) });
    const capacity = withIos({ maxRunning: 1 });
    const atBudget = view("wrk_b", {
      capacity: { ...capacity, ios: { ...capacity.ios, atRamBudget: true } },
    });

    expect(policy.select(REQUEST, [full, atBudget])).toMatchObject({ workerId: "wrk_b" });
  });

  it("passes over a worker at its RAM budget while another has room, and asks it when it is the only one", () => {
    // wrk_b has more free running capacity, so only the RAM rank can prefer wrk_a over it.
    const atBudget = (maxRunning: number) => ({
      ...withIos({ maxRunning }),
      ios: { ...withIos({ maxRunning }).ios, atRamBudget: true },
    });
    const roomy = view("wrk_a", { capacity: withIos({ maxRunning: 1 }) });
    const full = view("wrk_b", { capacity: atBudget(5) });

    expect(policy.select(REQUEST, [full, roomy])).toMatchObject({ workerId: "wrk_a" });
    // Equal free capacity: only the RAM rank removes a worker, so it is the deciding stage.
    const equal = view("wrk_b", { capacity: atBudget(1) });
    expect(policy.select(REQUEST, [equal, roomy])).toEqual({
      reason: "free-capacity",
      stage: "ram-budget",
      workerId: "wrk_a",
    });
    expect(policy.select(REQUEST, [full])).toMatchObject({ workerId: "wrk_b" });
  });

  it("still picks a worker at its RAM budget for a warm device it holds", () => {
    const capacity = withIos({ maxRunning: 1 });
    const atBudget = view("wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, atRamBudget: true } },
      devices: [deviceFixture("dev_1", "ready")],
    });

    expect(policy.select(REQUEST, [atBudget, view("wrk_b")])).toMatchObject({
      reason: "warm-hit",
      workerId: "wrk_a",
    });
  });

  it("keeps a worker whose running slots hold only devices that are not leased, and a request no warm device fits is dispatched to it at once", () => {
    // The ready device is another runtime, so no warm hit: only free-slot can decide. The
    // planner evicts it, so the slot is free, on the platform and globally.
    const other = {
      ...deviceFixture("dev_1", "ready"),
      spec: { model: "iPhone 17", osVersion: "25.0", platform: "ios" as const },
    };
    const capacity = statusFixture().capacity;
    const platformHeld = view("wrk_a", {
      capacity: {
        ...capacity,
        global: { ...capacity.global, running: 1, warm: 1 },
        ios: { ...capacity.ios, maxRunning: 1, running: 1, warm: 1 },
      },
      devices: [other],
    });
    const globalHeld = view("wrk_a", {
      capacity: {
        ...capacity,
        global: { ...capacity.global, maxRunning: 1, running: 1, warm: 1 },
        ios: { ...capacity.ios, running: 1, warm: 1 },
      },
      devices: [other],
    });

    for (const held of [platformHeld, globalHeld]) {
      expect(policy.select(REQUEST, [held])).toMatchObject({ workerId: "wrk_a" });
    }
  });

  it("passes over a worker with no free global slot although its platform has one", () => {
    const capacity = statusFixture().capacity;
    const noGlobal = view("wrk_a", {
      capacity: { ...capacity, global: { ...capacity.global, maxRunning: 1, running: 1 } },
    });

    expect(capacity.ios.maxRunning - capacity.ios.running - capacity.ios.reserved).toBeGreaterThan(
      0,
    );
    expect(policy.select(REQUEST, [noGlobal, view("wrk_b")])?.workerId).toBe("wrk_b");
    expect(policy.select(REQUEST, [noGlobal])).toBeUndefined();
  });

  it("counts a reserved slot as taken, on the platform and globally, when it looks for a free one", () => {
    const capacity = statusFixture().capacity;
    const platformReserved = view("wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 1, reserved: 1 } },
    });
    const globalReserved = view("wrk_a", {
      capacity: { ...capacity, global: { ...capacity.global, maxRunning: 1, reserved: 1 } },
    });

    for (const full of [platformReserved, globalReserved]) {
      expect(policy.select(REQUEST, [full, view("wrk_b")])?.workerId).toBe("wrk_b");
      expect(policy.select(REQUEST, [full])).toBeUndefined();
    }
  });

  it("looks at the request's platform only when it asks about the RAM budget", () => {
    const capacity = statusFixture().capacity;
    // wrk_a is at its budget for android only: for an iOS request it is as good as wrk_b.
    const androidFull = view("wrk_a", {
      capacity: { ...capacity, android: { ...capacity.android, atRamBudget: true } },
    });

    expect(policy.select(REQUEST, [androidFull, view("wrk_b")])?.workerId).toBe("wrk_a");
  });
});
