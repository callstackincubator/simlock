import { describe, expect, it } from "vitest";

import { createRoutingPolicy, isRoutingPolicyName } from "./routing.js";
import { catalogFixture, deviceFixture, statusFixture } from "./test-support.js";
import type { WorkerView } from "./worker-registry.js";

const REQUEST = {
  allowDownload: false,
  model: "iPhone 17",
  osVersion: "26.0",
  platform: "ios" as const,
};

function view(id: string, overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    connection: "connected",
    devices: [],
    drained: false,
    id,
    lastSeenAt: 1,
    leases: [],
    capacity: statusFixture().capacity,
    ...overrides,
  };
}

describe("routing registry", () => {
  it("recognizes only registered names", () => {
    expect(isRoutingPolicyName("warm-then-free")).toBe(true);
    expect(isRoutingPolicyName("round-robin")).toBe(false);
    expect(isRoutingPolicyName(42)).toBe(false);
  });
});

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
});
