import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../../../../ports/index.js";
import type { CapacityDevice, CapacityStrategy } from "../../strategy.js";
import { resourceStrategy, type ResourceStrategyOptions } from "./index.js";

const gibibyte = 1024 ** 3;

const options: ResourceStrategyOptions = {
  limits: {
    android: { maxDevices: 4, maxRunning: 2 },
    ios: { maxDevices: 1, maxRunning: 1 },
    maxRunning: 2,
  },
  ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 1.5 * gibibyte },
};

function withRam(totalRamBytes: number): CapacityStrategy {
  return resourceStrategy.create(
    options,
    new FakeSystemStats({ cpuCount: 8, freeRamBytes: totalRamBytes, totalRamBytes }),
  );
}

describe("resource strategy defaults", () => {
  it("derives device limits from the machine", () => {
    const defaults = resourceStrategy.defaults(
      new FakeSystemStats({
        cpuCount: 8,
        freeRamBytes: 16 * gibibyte,
        totalRamBytes: 32 * gibibyte,
      }),
    );

    expect(defaults.limits).toEqual({
      android: { maxDevices: 2, maxRunning: 2 },
      ios: { maxDevices: 4, maxRunning: 4 },
      maxRunning: 6,
    });
    expect(defaults.ramBudget).toEqual({
      androidBytesPerDevice: 4 * gibibyte,
      iosBytesPerDevice: 1.5 * gibibyte,
    });
  });

  it("keeps at least one device per platform on a small machine", () => {
    const defaults = resourceStrategy.defaults(
      new FakeSystemStats({ cpuCount: 1, freeRamBytes: gibibyte, totalRamBytes: 2 * gibibyte }),
    );

    expect(defaults.limits.ios.maxDevices).toBe(1);
    expect(defaults.limits.android.maxDevices).toBe(1);
  });
});

describe("resource strategy provisioning", () => {
  it("refuses provisioning at the platform device limit", () => {
    const devices: CapacityDevice[] = [{ platform: "ios", state: "ready" }];

    expect(withRam(32 * gibibyte).canProvision("ios", devices)).toEqual({
      ok: false,
      reason: "device-limit",
    });
  });

  it("refuses provisioning when another device would exceed the RAM budget", () => {
    const devices: CapacityDevice[] = [{ platform: "android", state: "ready" }];

    expect(withRam(11 * gibibyte).canProvision("android", devices)).toEqual({
      ok: false,
      reason: "ram-budget",
    });
  });

  it("does not count deleted devices against capacity", () => {
    const devices: CapacityDevice[] = [{ platform: "ios", state: "deleted" }];

    expect(withRam(32 * gibibyte).canProvision("ios", devices)).toEqual({ ok: true });
  });

  it("accounts for active devices on both platforms in the shared RAM budget", () => {
    const devices: CapacityDevice[] = [{ platform: "android", state: "ready" }];

    expect(withRam(9 * gibibyte).canProvision("ios", devices)).toEqual({
      ok: false,
      reason: "ram-budget",
    });
  });

  it("permits provisioning when allocation exactly reaches the RAM budget", () => {
    const devices: CapacityDevice[] = [{ platform: "android", state: "ready" }];

    expect(withRam(9.5 * gibibyte).canProvision("ios", devices)).toEqual({ ok: true });
  });

  it("reports the managed-device ceiling per platform", () => {
    const strategy = withRam(32 * gibibyte);

    expect(strategy.deviceLimit("ios")).toBe(1);
    expect(strategy.deviceLimit("android")).toBe(4);
  });
});

describe("resource strategy running capacity", () => {
  it("counts only running lifecycle states and reservations", () => {
    expect(
      withRam(32 * gibibyte).runningCapacity(
        [
          { platform: "ios", state: "ready" },
          { platform: "android", state: "shutdown" },
          { platform: "android", state: "deleted" },
        ],
        ["android"],
      ),
    ).toEqual({
      global: { maxRunning: 2, overLimit: false, reserved: 1, running: 1 },
      ios: { maxRunning: 1, overLimit: false, reserved: 0, running: 1 },
      android: { maxRunning: 2, overLimit: false, reserved: 1, running: 0 },
    });
  });

  it("requires both global and platform room", () => {
    const strategy = withRam(32 * gibibyte);
    const globallyFull = [
      { platform: "ios", state: "ready" },
      { platform: "android", state: "ready" },
    ] as const;

    expect(strategy.canReserveRunning("android", globallyFull, [])).toEqual({
      ok: false,
      reason: "global-running-limit",
    });
    expect(strategy.canReserveRunning("ios", [{ platform: "ios", state: "leased" }], [])).toEqual({
      ok: false,
      reason: "platform-running-limit",
    });
  });
});
