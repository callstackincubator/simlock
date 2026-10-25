import { describe, expect, it } from "vitest";

import type { CapacityFigures } from "./figures.js";
import { capacityChangedPayload } from "./observer.js";

function figures(running: number, options: { ramBudget?: boolean } = {}): CapacityFigures {
  const entry = { maxRunning: 2, overLimit: false, reserved: 0, running };
  return {
    android: { ...entry, atRamBudget: false, limit: 4, running: 0, used: 0, warm: 0 },
    global: { ...entry, warm: 1 },
    ios: { ...entry, atRamBudget: true, limit: 4, used: 3, warm: 1 },
    ...(options.ramBudget === true
      ? { ramBudget: { limitBytes: 100, overLimit: false, usedBytes: 40 } }
      : {}),
  };
}

describe("CapacityObserver", () => {
  it("carries only running, maxRunning, reserved and warm per platform, and the budget's used and limit bytes", () => {
    expect(capacityChangedPayload(figures(1, { ramBudget: true }))).toEqual({
      android: { maxRunning: 2, reserved: 0, running: 0, warm: 0 },
      global: { maxRunning: 2, reserved: 0, running: 1, warm: 1 },
      ios: { maxRunning: 2, reserved: 0, running: 1, warm: 1 },
      ramBudget: { limitBytes: 100, usedBytes: 40 },
    });
    expect(capacityChangedPayload(figures(1))).not.toHaveProperty("ramBudget");
  });
});
