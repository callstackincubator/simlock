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
    const queued = view("wrk_a", { devices: [deviceFixture("dev_1", "ready")], queueDepth: 1 });

    expect(policy.select(REQUEST, [queued, view("wrk_b")])?.workerId).toBe("wrk_b");
    expect(policy.select(REQUEST, [queued])).toBeUndefined();
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
