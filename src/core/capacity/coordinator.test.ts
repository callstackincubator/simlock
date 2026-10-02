import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../../ports/index.js";
import { CapacityCoordinator } from "./coordinator.js";
import { resourceStrategy } from "./strategies/resource/index.js";

const gibibyte = 1024 ** 3;

function coordinator(): CapacityCoordinator {
  return new CapacityCoordinator(
    resourceStrategy.create(
      {
        limits: {
          android: { maxDevices: 4, maxRunning: 2 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 2,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 1.5 * gibibyte },
      },
      new FakeSystemStats({
        cpuCount: 8,
        freeRamBytes: 32 * gibibyte,
        totalRamBytes: 32 * gibibyte,
      }),
    ),
  );
}

describe("CapacityCoordinator", () => {
  it("accounts for provisioning reservations in both device and running capacity", () => {
    const capacity = coordinator();
    const first = capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, []);
    expect(first.ok).toBe(true);
    expect(capacity.runningCapacity([]).ios).toEqual({
      maxRunning: 1,
      overLimit: false,
      reserved: 1,
      running: 0,
    });

    expect(capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, [])).toEqual({
      ok: false,
      reason: "device-limit",
    });
  });

  it("accounts for running reservations and frees capacity on release", () => {
    const capacity = coordinator();
    const first = capacity.tryReserveRunning("ios", []);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected reservation");

    expect(capacity.tryReserveRunning("ios", [])).toEqual({
      ok: false,
      reason: "platform-running-limit",
    });
    first.reservation.release();
    expect(capacity.tryReserveRunning("ios", [])).toMatchObject({ ok: true });
  });

  it("releases reservation tokens idempotently", () => {
    const capacity = coordinator();
    const result = capacity.tryReserveRunning("ios", []);
    if (!result.ok) throw new Error("expected reservation");

    result.reservation.release();
    result.reservation.release();
    expect(capacity.runningCapacity([]).ios.reserved).toBe(0);
  });

  it("uses fresh snapshots, ignoring deleted devices for provisioning and unknown states for running", () => {
    const capacity = coordinator();
    const snapshot = [
      { mode: "full" as const, platform: "ios" as const, state: "deleted" },
      { mode: "full" as const, platform: "android" as const, state: "unknown-to-core" },
    ];

    expect(
      capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, snapshot),
    ).toMatchObject({ ok: true });
    expect(capacity.runningCapacity(snapshot)).toEqual({
      android: { maxRunning: 2, overLimit: false, reserved: 0, running: 0 },
      global: { maxRunning: 2, overLimit: false, reserved: 1, running: 0 },
      ios: { maxRunning: 1, overLimit: false, reserved: 1, running: 0 },
    });
  });

  it("holds the planned mode's size for a provisioning reservation until it is released", () => {
    // 12 GiB of RAM: an 8 GiB budget. Full iOS devices take 3 GiB, slim ones 1 GiB.
    const capacity = new CapacityCoordinator(
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
        new FakeSystemStats({
          cpuCount: 8,
          freeRamBytes: 12 * gibibyte,
          totalRamBytes: 12 * gibibyte,
        }),
      ),
    );
    const full = { mode: "full", platform: "ios" } as const;
    const slim = { mode: "slim", platform: "ios" } as const;

    const first = capacity.tryReserveProvisioning(full, []);
    const second = capacity.tryReserveProvisioning(full, []);
    if (!first.ok || !second.ok) throw new Error("expected reservations");
    // 6 GiB held by two full reservations: a third full one does not fit, a slim one does.
    expect(capacity.tryReserveProvisioning(full, [])).toEqual({ ok: false, reason: "ram-budget" });
    const third = capacity.tryReserveProvisioning(slim, []);
    if (!third.ok) throw new Error("expected a slim reservation");
    // 7 GiB held: a slim reservation counted at the full size would have refused this one.
    expect(capacity.tryReserveProvisioning(slim, [])).toMatchObject({ ok: true });
    expect(capacity.tryReserveProvisioning(slim, [])).toEqual({ ok: false, reason: "ram-budget" });

    first.reservation.release();
    expect(capacity.tryReserveProvisioning(full, [])).toMatchObject({ ok: true });
  });

  it("reports the RAM budget over the devices handed in, leaving in-flight provisioning out", () => {
    const capacity = coordinator();
    const reserved = capacity.tryReserveProvisioning({ mode: "full", platform: "android" }, []);
    if (!reserved.ok) throw new Error("expected a reservation");

    expect(capacity.ramBudget([{ mode: "full", platform: "ios", state: "ready" }])).toEqual({
      limitBytes: 28 * gibibyte,
      overLimit: false,
      usedBytes: 1.5 * gibibyte,
    });
  });

  it("delegates the device ceiling to the strategy it was given", () => {
    expect(coordinator().deviceLimit("android")).toBe(4);
  });
});
