import { describe, expect, it } from "vitest";

import { catalogFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
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
});
