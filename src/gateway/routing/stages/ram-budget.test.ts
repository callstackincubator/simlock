import { describe, expect, it } from "vitest";

import { catalogFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { runStages } from "../pipeline.js";
import { ramBudget } from "./ram-budget.js";

const REQUEST = { model: "iPhone 17", platform: "ios" as const };

function view(capacity: WorkerView["capacity"]): WorkerView {
  return {
    catalog: catalogFixture([]).platforms,
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_a",
    lastSeenAt: 1,
    leases: [],
    ...(capacity === undefined ? {} : { capacity }),
  };
}

describe("ram-budget", () => {
  it("scores a worker at its budget for the platform zero, and one under it, or not reporting, above zero", () => {
    const capacity = statusFixture().capacity;
    const atBudget = { ...capacity, ios: { ...capacity.ios, atRamBudget: true } };

    expect(ramBudget.score(view(atBudget), REQUEST)).toBe(0);
    expect(ramBudget.score(view(capacity), REQUEST)).toBeGreaterThan(0);
    expect(ramBudget.score(view(undefined), REQUEST)).toBeGreaterThan(0);
  });

  it("is named ram-budget when it is the stage that removed the worker at its budget", () => {
    const capacity = statusFixture().capacity;
    const atBudget = { ...capacity, ios: { ...capacity.ios, atRamBudget: true } };
    const under = { ...view(capacity), id: "wrk_b" };

    expect(runStages([ramBudget], REQUEST, [view(atBudget), under])).toEqual({
      stage: "ram-budget",
      workerId: "wrk_b",
    });
  });
});

describe("ram-budget's zero reason", () => {
  it("gives full with ram-budget for a worker it scores zero, and nothing for one under its budget", () => {
    const capacity = statusFixture().capacity;
    const atBudget = { ...capacity, ios: { ...capacity.ios, atRamBudget: true } };

    expect(ramBudget.zeroReason?.(view(atBudget), REQUEST)).toEqual({
      capacityReason: "ram-budget",
      reason: "full",
    });
    expect(ramBudget.zeroReason?.(view(capacity), REQUEST)).toBeUndefined();
  });
});
