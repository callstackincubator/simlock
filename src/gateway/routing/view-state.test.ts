import { describe, expect, it } from "vitest";

import { deviceFixture, leaseFixture, statusFixture } from "../test-support.js";
import type { WorkerView } from "../worker-registry.js";
import { viewLoadKey } from "./view-state.js";

function view(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: [],
    connection: "connected",
    devices: [{ ...deviceFixture("dev_1", "leased"), transitionAgeMs: 10 }],
    drained: false,
    health: "running",
    id: "wrk_a",
    lastSeenAt: 1_000,
    leases: [leaseFixture("lse_1", "dev_1")],
    queueDepth: 0,
    ...overrides,
  };
}

describe("viewLoadKey", () => {
  it("gives two views that differ only in lastSeenAt or transitionAgeMs the same key", () => {
    const base = view();
    const later = view({
      devices: [{ ...deviceFixture("dev_1", "leased"), transitionAgeMs: 5_000 }],
      lastSeenAt: 9_000,
    });

    expect(viewLoadKey(later)).toBe(viewLoadKey(base));
  });

  it("gives views that differ in capacity, queue depth, health, a device's state, or lease ids different keys", () => {
    const base = viewLoadKey(view());
    const capacity = statusFixture().capacity;
    const changed = [
      view({ capacity: { ...capacity, ios: { ...capacity.ios, running: 1 } } }),
      view({ queueDepth: 1 }),
      view({ health: "failed" }),
      view({ devices: [deviceFixture("dev_1", "ready")] }),
      view({ leases: [leaseFixture("lse_2", "dev_1")] }),
    ];

    for (const other of changed) expect(viewLoadKey(other)).not.toBe(base);
  });

  it("does not depend on the order fields were written in", () => {
    const base = view();
    const capacity = Object.fromEntries(
      Object.entries(statusFixture().capacity).reverse(),
    ) as WorkerView["capacity"];

    expect(viewLoadKey(view({ capacity }))).toBe(viewLoadKey(base));
  });
});
