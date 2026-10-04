import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../../ports/index.js";
import type { DeviceSpec } from "../domain.js";
import { CapacityCoordinator } from "./coordinator.js";
import { plannedCapacityDevice } from "./devices.js";
import { resourceStrategy } from "./strategies/resource/index.js";
import type { CapacityDevice, RegisteredCapacityDevice } from "./strategy.js";

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
        totalRamBytes: 32 * gibibyte,
      }),
    ),
  );
}

/** 12 GiB of RAM: an 8 GiB budget. Full iOS devices take 3 GiB, slim ones 1 GiB. */
function sizedCoordinator(): CapacityCoordinator {
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
      new FakeSystemStats({
        cpuCount: 8,
        totalRamBytes: 12 * gibibyte,
      }),
    ),
  );
}

function iosDevice(id: string, mode: "slim" | "full", state: string): RegisteredCapacityDevice {
  return { id, mode, platform: "ios", state };
}

const shutdownIos: RegisteredCapacityDevice = iosDevice("shutdown-1", "full", "shutdown");

describe("CapacityCoordinator", () => {
  it("reports atRamBudget for a platform exactly when the next full device is refused for RAM, by the answer tryReserveProvisioning gives", () => {
    const capacity = sizedCoordinator();
    const iosFull = (count: number) =>
      Array.from({ length: count }, (_, index) => iosDevice(`d${index}`, "full", "ready"));
    // 8 GiB budget, 3 GiB per full iOS device: two fit, a third does not.
    expect(capacity.atRamBudget("ios", iosFull(1))).toBe(false);
    expect(capacity.atRamBudget("ios", iosFull(2))).toBe(true);
    expect(capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, iosFull(2))).toEqual({
      ok: false,
      reason: "ram-budget",
    });
    expect(capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, iosFull(1)).ok).toBe(
      true,
    );
  });

  it("counts a full device, not a slim one, when it asks whether the budget is reached", () => {
    const capacity = sizedCoordinator();
    const slim = [iosDevice("a", "slim", "ready"), iosDevice("b", "slim", "ready")];
    // Two slim devices use 2 GiB of 8: a full 3 GiB one fits. A third slim one is not asked.
    expect(capacity.atRamBudget("ios", slim)).toBe(false);
    // 6 GiB used: another full device (3 GiB) does not fit although a slim one (1 GiB) would.
    const used = [iosDevice("a", "full", "ready"), iosDevice("b", "full", "ready")];
    expect(capacity.atRamBudget("ios", used)).toBe(true);
    expect(capacity.canProvision({ mode: "slim", platform: "ios" }, used).ok).toBe(true);
  });

  it("does not report a refusal for the device limit as being at the RAM budget", () => {
    const capacity = coordinator();
    const full = [iosDevice("a", "full", "ready")];

    expect(capacity.canProvision({ mode: "full", platform: "ios" }, full)).toEqual({
      ok: false,
      reason: "device-limit",
    });
    expect(capacity.atRamBudget("ios", full)).toBe(false);
  });

  it("counts a provisioning reservation it holds when it asks whether the budget is reached", () => {
    const capacity = sizedCoordinator();
    capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, []);
    capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, []);

    expect(capacity.atRamBudget("ios", [])).toBe(true);
  });

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

  it("accounts for boot reservations in running capacity and frees it on release", () => {
    const capacity = coordinator();
    const devices = [shutdownIos];
    const first = capacity.tryReserveBoot(shutdownIos, devices);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected reservation");

    expect(capacity.tryReserveBoot(shutdownIos, devices)).toEqual({
      ok: false,
      reason: "platform-running-limit",
    });
    first.reservation.release();
    expect(capacity.tryReserveBoot(shutdownIos, devices)).toMatchObject({ ok: true });
  });

  it("releases reservation tokens idempotently", () => {
    const capacity = coordinator();
    const result = capacity.tryReserveBoot(shutdownIos, [shutdownIos]);
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

  it("holds the full size for a provisioning reservation until it is released, whatever its spec's mode", () => {
    const capacity = sizedCoordinator();
    const slimSpec: DeviceSpec = {
      mode: "slim",
      model: "iPhone 16",
      osVersion: "26.0",
      platform: "ios",
    };
    const planned = plannedCapacityDevice(slimSpec);

    const first = capacity.tryReserveProvisioning(planned, []);
    const second = capacity.tryReserveProvisioning(planned, []);
    if (!first.ok || !second.ok) throw new Error("expected reservations");
    // 6 GiB held by two reservations at 3 GiB each, where 1 GiB each would leave room for 6.
    expect(capacity.tryReserveProvisioning(planned, [])).toEqual({
      ok: false,
      reason: "ram-budget",
    });

    first.reservation.release();
    expect(capacity.tryReserveProvisioning(planned, [])).toMatchObject({ ok: true });
  });

  it("refuses booting a shut-down slim device with ram-budget when its full size does not fit, before the running limits", () => {
    const capacity = new CapacityCoordinator(
      resourceStrategy.create(
        {
          limits: {
            android: { maxDevices: 8, maxRunning: 8 },
            ios: { maxDevices: 8, maxRunning: 1 },
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
          totalRamBytes: 12 * gibibyte,
        }),
      ),
    );
    const slim = iosDevice("slim-1", "slim", "shutdown");
    // 8 GiB used of 8, and the one iOS running slot taken: both would refuse; RAM is named.
    const devices: CapacityDevice[] = [
      slim,
      iosDevice("ready-1", "full", "ready"),
      { mode: "full", platform: "android", state: "ready" },
    ];

    expect(capacity.tryReserveBoot(slim, devices)).toEqual({ ok: false, reason: "ram-budget" });
  });

  it("holds a boot's extra size until the boot reservation is released", () => {
    const capacity = sizedCoordinator();
    const slim = iosDevice("slim-1", "slim", "shutdown");
    // 5 GiB used of 8: booting the slim device adds 2 GiB, leaving 1.
    const devices = [
      slim,
      iosDevice("ready-1", "full", "ready"),
      iosDevice("ready-2", "slim", "ready"),
    ];

    const boot = capacity.tryReserveBoot(slim, devices);
    if (!boot.ok) throw new Error("expected a boot reservation");
    // 7 GiB counted: no room for a new device's 3 GiB, nor for a second slim boot's 2 GiB.
    expect(capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, devices)).toEqual({
      ok: false,
      reason: "ram-budget",
    });
    const other = iosDevice("slim-2", "slim", "shutdown");
    expect(capacity.canBoot(other, [...devices, other])).toEqual({
      ok: false,
      reason: "ram-budget",
    });

    boot.reservation.release();
    expect(
      capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, devices),
    ).toMatchObject({
      ok: true,
    });
  });

  it("holds a rewarm's extra size until released, and takes no running slot", () => {
    const capacity = sizedCoordinator();
    const reclaiming = iosDevice("reclaiming-1", "slim", "reclaiming");
    // 4 GiB used of 8: booting the slim device back to warm adds 2 GiB.
    const devices = [reclaiming, iosDevice("ready-1", "full", "ready")];

    const rewarm = capacity.tryReserveRewarm(reclaiming, devices);
    if (!rewarm.ok) throw new Error("expected a rewarm reservation");
    expect(capacity.runningCapacity(devices).ios.reserved).toBe(0);
    // 6 GiB counted: a new device's 3 GiB no longer fits.
    expect(capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, devices)).toEqual({
      ok: false,
      reason: "ram-budget",
    });

    rewarm.reservation.release();
    expect(
      capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, devices),
    ).toMatchObject({
      ok: true,
    });
  });

  it("refuses a rewarm with ram-budget when the full size does not fit", () => {
    const capacity = sizedCoordinator();
    const reclaiming = iosDevice("reclaiming-1", "slim", "reclaiming");
    // 7 GiB used of 8: the 2 GiB boot does not fit.
    const devices = [
      reclaiming,
      iosDevice("ready-1", "full", "ready"),
      iosDevice("ready-2", "full", "ready"),
    ];

    expect(capacity.tryReserveRewarm(reclaiming, devices)).toEqual({
      ok: false,
      reason: "ram-budget",
    });
  });

  it("reports the RAM budget over the devices handed in, leaving in-flight provisioning and boots out", () => {
    const capacity = sizedCoordinator();
    const slim = iosDevice("slim-1", "slim", "shutdown");
    const reserved = capacity.tryReserveProvisioning({ mode: "full", platform: "android" }, []);
    const boot = capacity.tryReserveBoot(slim, [slim]);
    if (!reserved.ok || !boot.ok) throw new Error("expected reservations");

    expect(capacity.ramBudget([slim, iosDevice("ready-1", "full", "ready")])).toEqual({
      limitBytes: 8 * gibibyte,
      overLimit: false,
      usedBytes: 4 * gibibyte,
    });
  });

  it("delegates the device ceiling to the strategy it was given", () => {
    expect(coordinator().deviceLimit("android")).toBe(4);
  });
});
