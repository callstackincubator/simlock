import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../ports/index.js";
import { canProvision, type Config, type CapacityDevice } from "./index.js";

const gibibyte = 1024 ** 3;

const config: Config = {
  diskPressure: { freeBytesThreshold: 10 * gibibyte },
  eventBuffer: { capacity: 1000 },
  idle: { deleteAfterMs: 60 * 60_000, shutdownAfterMs: 10 * 60_000 },
  lease: { detachedTtlMs: 15 * 60_000, heldTtlBackstopMs: 60 * 60_000 },
  limits: { android: { maxDevices: 4 }, ios: { maxDevices: 1 } },
  ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 1.5 * gibibyte },
  warmPool: {},
};

function withStats(totalRamBytes: number): FakeSystemStats {
  return new FakeSystemStats({ cpuCount: 8, freeRamBytes: totalRamBytes, totalRamBytes });
}

describe("canProvision", () => {
  it("refuses provisioning at the platform device limit", () => {
    const devices: CapacityDevice[] = [{ platform: "ios", state: "ready" }];

    expect(canProvision("ios", devices, config, withStats(32 * gibibyte))).toEqual({
      ok: false,
      reason: "device-limit",
    });
  });

  it("refuses provisioning when another device would exceed the RAM budget", () => {
    const devices: CapacityDevice[] = [{ platform: "android", state: "ready" }];

    expect(canProvision("android", devices, config, withStats(11 * gibibyte))).toEqual({
      ok: false,
      reason: "ram-budget",
    });
  });

  it("does not count deleted devices against capacity", () => {
    const devices: CapacityDevice[] = [{ platform: "ios", state: "deleted" }];

    expect(canProvision("ios", devices, config, withStats(32 * gibibyte))).toEqual({ ok: true });
  });

  it("accounts for active devices on both platforms in the shared RAM budget", () => {
    const devices: CapacityDevice[] = [{ platform: "android", state: "ready" }];

    expect(canProvision("ios", devices, config, withStats(9 * gibibyte))).toEqual({
      ok: false,
      reason: "ram-budget",
    });
  });

  it("permits provisioning when allocation exactly reaches the RAM budget", () => {
    const devices: CapacityDevice[] = [{ platform: "android", state: "ready" }];

    expect(canProvision("ios", devices, config, withStats(9.5 * gibibyte))).toEqual({ ok: true });
  });
});
