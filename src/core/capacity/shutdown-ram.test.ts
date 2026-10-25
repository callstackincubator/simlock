import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../../ports/index.js";
import { CapacityCoordinator } from "./index.js";
import { resourceStrategy } from "./testing.js";

const gibibyte = 1024 ** 3;

function capacity(): CapacityCoordinator {
  return new CapacityCoordinator(
    resourceStrategy.create(
      {
        limits: {
          android: { maxDevices: 8, maxRunning: 8 },
          ios: { maxDevices: 8, maxRunning: 8 },
          maxRunning: 16,
        },
        ramBudget: {
          androidBytesPerDevice: 4 * gibibyte,
          iosBytesPerDevice: 3 * gibibyte,
          iosSlimBytesPerDevice: gibibyte,
        },
      },
      new FakeSystemStats({ cpuCount: 8, totalRamBytes: 12 * gibibyte }),
    ),
  );
}

describe("shutdown RAM accounting (#779 proposal)", () => {
  it("releases shutdown devices' RAM for status, provisioning and slim boots", () => {
    const devices = [
      { id: "ios-full", mode: "full" as const, platform: "ios" as const, state: "shutdown" },
      { id: "ios-slim", mode: "slim" as const, platform: "ios" as const, state: "shutdown" },
      {
        id: "android-full",
        mode: "full" as const,
        platform: "android" as const,
        state: "shutdown",
      },
    ] as const;
    const planned = { mode: "full" as const, platform: "ios" as const };
    expect(capacity().tryReserveProvisioning(planned, [])).toMatchObject({ ok: true });
    expect(capacity().tryReserveBoot(devices[1], [devices[1]])).toMatchObject({ ok: true });

    expect.soft(capacity().runningCapacity(devices).global.running).toBe(0);
    expect.soft(capacity().ramBudget(devices)).toEqual({
      limitBytes: 8 * gibibyte,
      overLimit: false,
      usedBytes: 0,
    });
    for (const platform of ["ios", "android"] as const) {
      expect.soft(capacity().atRamBudget(platform, devices), platform).toBe(false);
    }
    expect.soft(capacity().tryReserveProvisioning(planned, devices)).toMatchObject({ ok: true });
    expect.soft(capacity().tryReserveBoot(devices[1], devices)).toMatchObject({ ok: true });
  });
});
