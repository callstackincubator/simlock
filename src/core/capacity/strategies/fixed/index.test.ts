import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../../../../ports/index.js";
import type { CapacityDevice } from "../../strategy.js";
import { fixedStrategy, type FixedStrategyOptions } from "./index.js";

const gibibyte = 1024 ** 3;

function strategy(options: FixedStrategyOptions) {
  return fixedStrategy.create(
    options,
    // Passed for interface parity only: nothing in this strategy reads it.
    new FakeSystemStats({ cpuCount: 1, freeRamBytes: gibibyte, totalRamBytes: gibibyte }),
  );
}

function ready(platform: "ios" | "android", count: number): CapacityDevice[] {
  return Array.from({ length: count }, () => ({ platform, state: "ready" }));
}

describe("fixed strategy", () => {
  it("treats a bare maxRunning as a complete configuration", () => {
    const fixed = strategy({ maxRunning: 4 });

    expect(fixed.deviceLimit("ios")).toBe(4);
    expect(fixed.deviceLimit("android")).toBe(4);
    expect(fixed.runningCapacity([], [])).toEqual({
      android: { maxRunning: 4, overLimit: false, reserved: 0, running: 0 },
      global: { maxRunning: 4, overLimit: false, reserved: 0, running: 0 },
      ios: { maxRunning: 4, overLimit: false, reserved: 0, running: 0 },
    });
  });

  it("pins the global running count regardless of platform mix", () => {
    const fixed = strategy({ maxRunning: 2 });
    const full = [...ready("ios", 1), ...ready("android", 1)];

    expect(fixed.canReserveRunning("ios", full, [])).toEqual({
      ok: false,
      reason: "global-running-limit",
    });
  });

  it("carves the budget up when per-platform overrides are given", () => {
    const fixed = strategy({ android: { maxRunning: 1 }, ios: { maxRunning: 3 }, maxRunning: 3 });

    expect(fixed.canReserveRunning("android", ready("android", 1), [])).toEqual({
      ok: false,
      reason: "platform-running-limit",
    });
    expect(fixed.canReserveRunning("ios", ready("ios", 2), [])).toEqual({ ok: true });
  });

  it("lets maxDevices exceed maxRunning so shut-down devices can be kept around", () => {
    const fixed = strategy({ ios: { maxDevices: 5, maxRunning: 2 }, maxRunning: 2 });

    expect(fixed.canProvision("ios", ready("ios", 4))).toEqual({ ok: true });
    expect(fixed.canProvision("ios", ready("ios", 5))).toEqual({
      ok: false,
      reason: "device-limit",
    });
  });

  it("never refuses on RAM, however little the machine has", () => {
    const fixed = fixedStrategy.create(
      { maxRunning: 8 },
      new FakeSystemStats({ cpuCount: 1, freeRamBytes: 0, totalRamBytes: 0 }),
    );

    expect(fixed.canProvision("android", ready("android", 7))).toEqual({ ok: true });
  });

  it("ignores deleted devices when counting against the pin", () => {
    const fixed = strategy({ maxRunning: 1 });

    expect(fixed.canProvision("ios", [{ platform: "ios", state: "deleted" }])).toEqual({
      ok: true,
    });
  });

  it("defaults to a machine-independent pin", () => {
    expect(
      fixedStrategy.defaults(
        new FakeSystemStats({ cpuCount: 64, freeRamBytes: 0, totalRamBytes: 512 * gibibyte }),
      ),
    ).toEqual({ maxRunning: 2 });
  });
});
