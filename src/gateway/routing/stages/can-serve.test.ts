import { describe, expect, it } from "vitest";

import { catalogFixture, physicalDeviceFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { canServe } from "./can-serve.js";

function view(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([
      {
        modelClasses: { "iPhone 17": "phone" },
        models: ["iPhone 17"],
        platform: "ios",
        runtimes: ["26.0"],
      },
    ]).platforms,
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_a",
    lastSeenAt: 1,
    leases: [],
    ...overrides,
  };
}

const REQUEST = { model: "iPhone 17", platform: "ios" as const };

describe("can-serve's reason", () => {
  it("names no-driver for a platform the catalog lacks, unknown-model for a model or class it does not list, and runtime-missing for a runtime it does not pair", () => {
    expect(canServe.check(view(), REQUEST)).toBeUndefined();
    expect(canServe.check(view(), { ...REQUEST, platform: "android" })).toEqual({
      reason: "no-driver",
    });
    expect(canServe.check(view(), { ...REQUEST, model: "iPhone 99" })).toEqual({
      reason: "unknown-model",
    });
    expect(canServe.check(view(), { class: "tablet", platform: "ios" })).toEqual({
      reason: "unknown-model",
    });
    expect(canServe.check(view(), { ...REQUEST, osVersion: "99.0" })).toEqual({
      reason: "runtime-missing",
    });
  });

  it("names no-driver for a worker missing the platform, the model and the runtime, and unknown-model for a physical request with no enrolled fit", () => {
    const empty = view({ catalog: [] });
    const physical = { ...REQUEST, physical: true as const };
    const enrolled = view({
      devices: [physicalDeviceFixture("dev_p", "ready", { model: "iPhone 17" })],
    });

    expect(canServe.check(empty, { ...REQUEST, model: "x", osVersion: "99.0" })).toEqual({
      reason: "no-driver",
    });
    expect(canServe.check(view(), physical)).toEqual({ reason: "unknown-model" });
    expect(canServe.check(enrolled, physical)).toBeUndefined();
  });
});
