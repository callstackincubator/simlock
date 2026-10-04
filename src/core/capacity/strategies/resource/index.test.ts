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
  return resourceStrategy.create(options, new FakeSystemStats({ cpuCount: 8, totalRamBytes }));
}

describe("resource strategy defaults", () => {
  it("derives device limits from the machine", () => {
    const defaults = resourceStrategy.defaults(
      new FakeSystemStats({
        cpuCount: 8,
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
      new FakeSystemStats({ cpuCount: 1, totalRamBytes: 2 * gibibyte }),
    );

    expect(defaults.limits.ios.maxDevices).toBe(1);
    expect(defaults.limits.android.maxDevices).toBe(1);
  });
});

describe("resource strategy provisioning", () => {
  it("refuses provisioning at the platform device limit", () => {
    const devices: CapacityDevice[] = [{ mode: "full" as const, platform: "ios", state: "ready" }];

    expect(withRam(32 * gibibyte).canProvision({ mode: "full", platform: "ios" }, devices)).toEqual(
      {
        ok: false,
        reason: "device-limit",
      },
    );
  });

  it("refuses provisioning when another device would exceed the RAM budget", () => {
    const devices: CapacityDevice[] = [
      { mode: "full" as const, platform: "android", state: "ready" },
    ];

    expect(
      withRam(11 * gibibyte).canProvision({ mode: "full", platform: "android" }, devices),
    ).toEqual({
      ok: false,
      reason: "ram-budget",
    });
  });

  it("does not count deleted devices against capacity", () => {
    const devices: CapacityDevice[] = [
      { mode: "full" as const, platform: "ios", state: "deleted" },
    ];

    expect(withRam(32 * gibibyte).canProvision({ mode: "full", platform: "ios" }, devices)).toEqual(
      { ok: true },
    );
  });

  it("accounts for active devices on both platforms in the shared RAM budget", () => {
    const devices: CapacityDevice[] = [
      { mode: "full" as const, platform: "android", state: "ready" },
    ];

    expect(withRam(9 * gibibyte).canProvision({ mode: "full", platform: "ios" }, devices)).toEqual({
      ok: false,
      reason: "ram-budget",
    });
  });

  it("permits provisioning when allocation exactly reaches the RAM budget", () => {
    const devices: CapacityDevice[] = [
      { mode: "full" as const, platform: "android", state: "ready" },
    ];

    expect(
      withRam(9.5 * gibibyte).canProvision({ mode: "full", platform: "ios" }, devices),
    ).toEqual({ ok: true });
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
          { mode: "full" as const, platform: "ios", state: "ready" },
          { mode: "full" as const, platform: "android", state: "shutdown" },
          { mode: "full" as const, platform: "android", state: "deleted" },
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
      { mode: "full" as const, platform: "ios", state: "ready" },
      { mode: "full" as const, platform: "android", state: "ready" },
    ] as const;

    expect(strategy.canReserveRunning("android", globallyFull, [])).toEqual({
      ok: false,
      reason: "global-running-limit",
    });
    expect(
      strategy.canReserveRunning(
        "ios",
        [{ mode: "full" as const, platform: "ios", state: "leased" }],
        [],
      ),
    ).toEqual({
      ok: false,
      reason: "platform-running-limit",
    });
  });
});

describe("resource strategy RAM budget by mode", () => {
  const roomy = {
    android: { maxDevices: 20, maxRunning: 20 },
    ios: { maxDevices: 20, maxRunning: 20 },
    maxRunning: 40,
  };

  /** 12 GiB of RAM leaves an 8 GiB budget once the 4 GiB reserve is taken. */
  function sized(ramBudget: ResourceStrategyOptions["ramBudget"]): CapacityStrategy {
    return resourceStrategy.create(
      { limits: roomy, ramBudget },
      new FakeSystemStats({
        cpuCount: 8,
        totalRamBytes: 12 * gibibyte,
      }),
    );
  }

  const device = (
    platform: "ios" | "android",
    mode: "slim" | "full",
    state = "ready",
  ): CapacityDevice => ({ mode, platform, state });

  /**
   * How many devices of one mode the strategy admits, one at a time, before it refuses. Each
   * is planned at the full size, as every new device is, and counts by its mode once booted.
   */
  function admitted(strategy: CapacityStrategy, mode: "slim" | "full"): number {
    const devices: CapacityDevice[] = [];
    while (strategy.canProvision({ mode: "full", platform: "ios" }, devices).ok) {
      devices.push(device("ios", mode));
    }
    expect(strategy.canProvision({ mode: "full", platform: "ios" }, devices)).toEqual({
      ok: false,
      reason: "ram-budget",
    });
    return devices.length;
  }

  it("admits more slim devices than full ones under one budget, refusing the first past it in either mode", () => {
    const strategy = sized({
      androidBytesPerDevice: 4 * gibibyte,
      iosBytesPerDevice: 2 * gibibyte,
      iosSlimBytesPerDevice: gibibyte,
    });

    // 8 GiB, 2 GiB full, 1 GiB slim: the seventh slim device is the last with full-size room.
    expect(admitted(strategy, "full")).toBe(4);
    expect(admitted(strategy, "slim")).toBe(7);
  });

  it("refuses booting a shut-down slim device with ram-budget when its full size does not fit, and allows it when it does", () => {
    const strategy = sized({
      androidBytesPerDevice: 4 * gibibyte,
      iosBytesPerDevice: 2 * gibibyte,
      iosSlimBytesPerDevice: gibibyte,
    });
    const shutdown = device("ios", "slim", "shutdown");
    // 7 GiB used of 8: booting adds the 1 GiB between the slim and the full size.
    const fits = [shutdown, device("ios", "full"), device("ios", "full"), device("ios", "full")];
    expect(strategy.canBoot(shutdown, fits)).toEqual({ ok: true });
    // 8 GiB used: the same boot would reach 9.
    expect(strategy.canBoot(shutdown, [...fits, device("ios", "slim")])).toEqual({
      ok: false,
      reason: "ram-budget",
    });
  });

  it("never refuses booting a shut-down full device for RAM, even over the limit", () => {
    const strategy = sized({
      androidBytesPerDevice: 4 * gibibyte,
      iosBytesPerDevice: 3 * gibibyte,
      iosSlimBytesPerDevice: gibibyte,
    });
    const shutdown = device("ios", "full", "shutdown");
    const over = [shutdown, device("ios", "full"), device("ios", "full")];

    expect(strategy.ramBudget(over)?.overLimit).toBe(true);
    expect(strategy.canBoot(shutdown, over)).toEqual({ ok: true });
  });

  it("counts slim and full devices on both platforms at the sum of each device's own size", () => {
    const strategy = sized({
      androidBytesPerDevice: 3 * gibibyte,
      androidSlimBytesPerDevice: 2 * gibibyte,
      iosBytesPerDevice: 1.5 * gibibyte,
      iosSlimBytesPerDevice: 0.5 * gibibyte,
    });
    const devices = [
      device("ios", "full"),
      device("ios", "slim"),
      device("android", "full"),
      device("android", "slim"),
    ];

    expect(strategy.ramBudget(devices)?.usedBytes).toBe(7 * gibibyte);
  });

  it("counts a slim device at the platform's configured full size when no slim size is set", () => {
    const strategy = sized({
      androidBytesPerDevice: 3 * gibibyte,
      iosBytesPerDevice: 2.5 * gibibyte,
    });

    expect(strategy.ramBudget([device("ios", "slim")])?.usedBytes).toBe(2.5 * gibibyte);
    expect(strategy.ramBudget([device("android", "slim")])?.usedBytes).toBe(3 * gibibyte);
    expect(admitted(strategy, "slim")).toBe(admitted(strategy, "full"));
    // The boot of a slim device adds nothing: its size already is the full one.
    const shutdown = device("ios", "slim", "shutdown");
    expect(
      strategy.canBoot(shutdown, [shutdown, device("ios", "full"), device("ios", "full")]),
    ).toEqual({
      ok: true,
    });
  });

  it("reports the limit as total RAM minus the reserve, use over non-deleted devices, and over only past the limit", () => {
    const strategy = sized({
      androidBytesPerDevice: 4 * gibibyte,
      iosBytesPerDevice: 2 * gibibyte,
    });
    const atLimit = [
      device("android", "full"),
      device("ios", "full", "shutdown"),
      device("ios", "full", "provisioning"),
      device("ios", "full", "deleted"),
    ];

    expect(strategy.ramBudget(atLimit)).toEqual({
      limitBytes: 8 * gibibyte,
      overLimit: false,
      usedBytes: 8 * gibibyte,
    });
    expect(strategy.ramBudget([...atLimit, device("ios", "slim")])).toEqual({
      limitBytes: 8 * gibibyte,
      overLimit: true,
      usedBytes: 10 * gibibyte,
    });
  });

  it("creates no device in either mode while the budget is over its limit", () => {
    const strategy = sized({
      androidBytesPerDevice: 4 * gibibyte,
      iosBytesPerDevice: 3 * gibibyte,
      iosSlimBytesPerDevice: 0,
    });
    const over = [device("ios", "full"), device("ios", "full"), device("ios", "full")];

    expect(strategy.ramBudget(over)?.overLimit).toBe(true);
    for (const mode of ["slim", "full"] as const) {
      expect(strategy.canProvision({ mode, platform: "ios" }, over)).toEqual({
        ok: false,
        reason: "ram-budget",
      });
    }
  });
});
