import { describe, expect, it } from "vitest";

import { OPERATIONS } from "../contract/index.js";
import { aggregateCatalog, aggregateStatus } from "./aggregate.js";
import { deviceFixture, leaseFixture } from "./test-support.js";
import type { WorkerView } from "./worker-registry.js";

function capacity(running: number, limit: number) {
  return {
    android: {
      limit,
      maxRunning: limit,
      overLimit: false,
      reserved: 0,
      running: 0,
      used: 0,
      warm: 0,
    },
    global: { maxRunning: limit * 2, overLimit: false, reserved: 0, running, warm: 1 },
    ios: {
      limit,
      maxRunning: limit,
      overLimit: false,
      reserved: 0,
      running,
      used: running,
      warm: 1,
    },
  };
}

function view(overrides: Partial<WorkerView> & { readonly id: string }): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    lastSeenAt: 1_000,
    leases: [],
    ...overrides,
  };
}

describe("aggregateStatus", () => {
  it("returns the same shape a worker returns, with the gateway named in the daemon block", () => {
    const status = aggregateStatus([], { health: "running", queueDepth: 0 });

    // The contract is the arbiter: a gateway's answer parses as `status.get`'s output or it is
    // not the same shape.
    expect(() => OPERATIONS["status.get"].output.parse(status)).not.toThrow();
    expect(status.mode).toBe("gateway");
    expect(status.workers).toEqual([]);
  });

  it("sums capacity across connected workers", () => {
    const status = aggregateStatus(
      [
        view({ capacity: capacity(1, 2), id: "wrk_a" }),
        view({ capacity: capacity(2, 4), id: "wrk_b" }),
      ],
      { health: "running", queueDepth: 0 },
    );

    expect(status.capacity.ios).toMatchObject({ limit: 6, running: 3, used: 3, warm: 2 });
    expect(status.capacity.global).toMatchObject({ maxRunning: 12, running: 3, warm: 2 });
  });

  it("leaves a disconnected worker's capacity out of the sum", () => {
    // Free slots on a machine nobody can reach are not capacity: counting them would tell an
    // operator the fleet can take work it cannot.
    const status = aggregateStatus(
      [
        view({ capacity: capacity(1, 2), id: "wrk_a" }),
        view({ capacity: capacity(9, 9), connection: "disconnected", id: "wrk_b" }),
      ],
      { health: "running", queueDepth: 0 },
    );

    expect(status.capacity.ios).toMatchObject({ limit: 2, running: 1 });
  });

  it("counts a worker over its own limit as the fleet being over one", () => {
    const overLimit = capacity(3, 2);
    const status = aggregateStatus(
      [
        view({ capacity: capacity(0, 2), id: "wrk_a" }),
        view({
          capacity: { ...overLimit, ios: { ...overLimit.ios, overLimit: true } },
          id: "wrk_b",
        }),
      ],
      { health: "running", queueDepth: 0 },
    );

    expect(status.capacity.ios.overLimit).toBe(true);
  });

  it("stamps every device and lease with the worker it lives on", () => {
    const status = aggregateStatus(
      [
        view({
          devices: [deviceFixture("dev_1", "leased")],
          id: "wrk_a",
          leases: [leaseFixture("lease_1", "dev_1")],
        }),
        view({ devices: [deviceFixture("dev_2")], id: "wrk_b" }),
      ],
      { health: "running", queueDepth: 0 },
    );

    expect(status.devices).toEqual([
      expect.objectContaining({ id: "dev_1", workerId: "wrk_a" }),
      expect.objectContaining({ id: "dev_2", workerId: "wrk_b" }),
    ]);
    expect(status.leases).toEqual([expect.objectContaining({ id: "lease_1", workerId: "wrk_a" })]);
  });

  it("keeps a disconnected worker's leases in the aggregate", () => {
    // The opposite call from capacity, and deliberately so: a lease on a machine that dropped
    // off is still holding a device, which is exactly what an operator needs to see.
    const status = aggregateStatus(
      [
        view({
          connection: "disconnected",
          id: "wrk_a",
          leases: [leaseFixture("lease_1", "dev_1")],
        }),
      ],
      { health: "running", queueDepth: 0 },
    );

    expect(status.leases).toEqual([expect.objectContaining({ id: "lease_1", workerId: "wrk_a" })]);
  });

  it("reports the gateway's own queue depth and health, not any worker's", () => {
    const status = aggregateStatus([view({ health: "failed", id: "wrk_a", queueDepth: 7 })], {
      health: "starting",
      queueDepth: 0,
    });

    expect(status).toMatchObject({ health: "starting", queueDepth: 0 });
    expect(status.workers?.[0]).toMatchObject({ health: "failed", queueDepth: 7 });
  });
});

describe("aggregateCatalog", () => {
  const iosOnA = {
    defaultRuntime: "26.0",
    models: ["iPhone 17"],
    platform: "ios" as const,
    runtimes: ["26.0"],
  };
  const iosOnB = {
    defaultRuntime: "26.0",
    models: ["iPhone 17", "iPad Pro"],
    platform: "ios" as const,
    runtimes: ["26.0", "25.4"],
  };

  it("unions the connected workers' catalogs and annotates every entry", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);

    expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
    expect(catalog.platforms).toHaveLength(1);
    expect(catalog.platforms[0]).toMatchObject({
      models: ["iPad Pro", "iPhone 17"],
      modelWorkers: { "iPad Pro": ["wrk_b"], "iPhone 17": ["wrk_a", "wrk_b"] },
      platform: "ios",
      runtimes: ["25.4", "26.0"],
      runtimeWorkers: { "25.4": ["wrk_b"], "26.0": ["wrk_a", "wrk_b"] },
    });
  });

  it("keeps a default runtime only when every worker agrees on it", () => {
    const agreed = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);
    expect(agreed.platforms[0]?.defaultRuntime).toBe("26.0");

    const disagreed = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [{ ...iosOnB, defaultRuntime: "25.4" }], id: "wrk_b" }),
    ]);
    // Picking one at random would make `simlock lease` non-deterministic across an unchanged
    // fleet, so a fleet that disagrees has no default.
    expect(disagreed.platforms[0]?.defaultRuntime).toBeUndefined();
  });

  it("ignores a disconnected worker: a machine nobody can reach can lease nothing", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], connection: "disconnected", id: "wrk_a" }),
    ]);

    expect(catalog.platforms).toEqual([]);
  });

  it("keeps a drained worker, whose models are still installed", () => {
    const catalog = aggregateCatalog([view({ catalog: [iosOnA], drained: true, id: "wrk_a" })]);

    expect(catalog.platforms[0]?.models).toEqual(["iPhone 17"]);
  });

  it("filters to one platform when asked", () => {
    const catalog = aggregateCatalog(
      [
        view({
          catalog: [iosOnA, { models: ["Pixel 9"], platform: "android", runtimes: ["35"] }],
          id: "wrk_a",
        }),
      ],
      "android",
    );

    expect(catalog.platforms.map((entry) => entry.platform)).toEqual(["android"]);
  });
});
