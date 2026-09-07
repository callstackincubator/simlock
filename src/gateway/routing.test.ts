import { describe, expect, it } from "vitest";

import {
  createRoutingPolicy,
  DEFAULT_ROUTING_POLICY,
  isRoutingPolicyName,
  routingPolicyNames,
} from "./routing.js";
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
  it("names exactly the policies it registers, warm-then-free among them", () => {
    expect(routingPolicyNames).toContain("warm-then-free");
    expect(DEFAULT_ROUTING_POLICY).toBe("warm-then-free");
  });

  it("recognizes only registered names", () => {
    expect(isRoutingPolicyName("warm-then-free")).toBe(true);
    expect(isRoutingPolicyName("round-robin")).toBe(false);
    expect(isRoutingPolicyName(42)).toBe(false);
  });
});

describe("warm-then-free policy", () => {
  const policy = createRoutingPolicy("warm-then-free");

  it("prefers a worker with an unleased ready device matching the request", () => {
    const cold = view("wrk_cold");
    const warm = view("wrk_warm", { devices: [deviceFixture("dev_1", "ready")] });

    expect(policy.select(REQUEST, [cold, warm])).toEqual({
      reason: "warm-hit",
      workerId: "wrk_warm",
    });
  });

  it("does not treat a leased device as a warm hit", () => {
    const leased = view("wrk_1", { devices: [deviceFixture("dev_1", "leased")] });

    expect(policy.select(REQUEST, [leased])?.reason).toBe("free-capacity");
  });

  it("falls back to the worker with the most free running capacity", () => {
    const tight = view("wrk_tight", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, running: 1 },
      },
    });
    const roomy = view("wrk_roomy", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, maxRunning: 10 },
      },
    });

    expect(policy.select(REQUEST, [tight, roomy])).toEqual({
      reason: "free-capacity",
      workerId: "wrk_roomy",
    });
  });

  it("drops a disconnected, incompatible, or drained worker", () => {
    expect(policy.select(REQUEST, [view("wrk_1", { connection: "disconnected" })])).toBeUndefined();
    expect(policy.select(REQUEST, [view("wrk_1", { connection: "incompatible" })])).toBeUndefined();
    expect(policy.select(REQUEST, [view("wrk_1", { drained: true })])).toBeUndefined();
  });

  it("drops a worker whose capacity was never read, rather than guessing it has some", () => {
    const { capacity: _capacity, ...withoutCapacity } = view("wrk_1");
    expect(policy.select(REQUEST, [withoutCapacity])).toBeUndefined();
  });

  it("drops a worker lacking the requested model, and one lacking the requested osVersion", () => {
    const noModel = view("wrk_1", {
      catalog: catalogFixture([{ models: ["iPhone 15"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
    });
    const noRuntime = view("wrk_2", {
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["18.0"] }])
        .platforms,
    });

    expect(policy.select(REQUEST, [noModel])).toBeUndefined();
    expect(policy.select(REQUEST, [noRuntime])).toBeUndefined();
  });

  it("drops a worker lacking the platform in its catalog at all", () => {
    const androidOnly = view("wrk_1", {
      catalog: catalogFixture([{ models: ["Pixel 9"], platform: "android", runtimes: ["15"] }])
        .platforms,
    });
    expect(policy.select(REQUEST, [androidOnly])).toBeUndefined();
  });

  it("only counts a missing model/runtime as fillable by a download when the request allows one and the worker's own policy permits it", () => {
    const noModel = view("wrk_1", {
      catalog: catalogFixture([{ models: ["iPhone 15"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      downloads: { policy: "on-request" },
    });

    expect(policy.select(REQUEST, [noModel])).toBeUndefined();
    expect(policy.select({ ...REQUEST, allowDownload: true }, [noModel])).toEqual({
      reason: "free-capacity",
      workerId: "wrk_1",
    });

    const refusesDownloads = view("wrk_2", {
      catalog: catalogFixture([{ models: ["iPhone 15"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      downloads: { policy: "never" },
    });
    expect(policy.select({ ...REQUEST, allowDownload: true }, [refusesDownloads])).toBeUndefined();
  });

  it("names no worker when none is eligible", () => {
    expect(policy.select(REQUEST, [])).toBeUndefined();
  });
});
