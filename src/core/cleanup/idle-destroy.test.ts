import { describe, expect, it } from "vitest";

import type { LeaseRecord, RegistryView } from "../index.js";
import { idleDestroyRule } from "./idle-destroy.js";

const gibibyte = 1024 ** 3;

const config: RegistryView["config"] = {
  diskPressure: { freeBytesThreshold: 0 },
  idle: { deleteAfterMs: 30_000, shutdownAfterMs: 10_000 },
};

function view(
  now: number,
  overrides: {
    readonly devices?: RegistryView["devices"];
    readonly diskFreeBytes?: number;
    readonly leases?: readonly LeaseRecord[];
  } = {},
): RegistryView {
  return {
    config,
    devices: overrides.devices ?? [
      {
        physical: false as const,
        createdAt: 0,
        driverData: {},
        driverDeviceId: "driver-1",
        id: "dev_1",
        lastLeaseEndedAt: 0,
        spec: { physical: false as const, model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        mode: "full",
        state: "shutdown",
      },
    ],
    diskFreeBytes: overrides.diskFreeBytes ?? 100,
    leases: overrides.leases ?? [],
    now,
    targeted: new Set(),
  };
}

describe("idleDestroyRule", () => {
  it("proposes destruction only after T2 when not under disk pressure", () => {
    expect(idleDestroyRule.evaluate(view(30_000))).toEqual([]);
    expect(idleDestroyRule.evaluate(view(30_001))).toEqual([
      {
        action: "destroy",
        reason: "idle 30s > T2=30s",
        rule: "idle-destroy",
        target: "dev_1",
      },
    ]);
  });

  it("shortens the threshold to T1 and names disk pressure as the reason when under pressure", () => {
    const pressuredConfig: RegistryView["config"] = {
      ...config,
      diskPressure: { freeBytesThreshold: 10 * gibibyte },
    };
    const pressured = (now: number): RegistryView => ({
      ...view(now, { diskFreeBytes: 2 * gibibyte }),
      config: pressuredConfig,
    });

    // Still within T1: no proposal even though disk is under pressure.
    expect(idleDestroyRule.evaluate(pressured(10_000))).toEqual([]);
    // Past T1 but well short of T2: pressure is what makes this fire.
    expect(idleDestroyRule.evaluate(pressured(10_001))).toEqual([
      {
        action: "destroy",
        reason: "disk pressure (free 2GiB < 10GiB): idle 10s > T1=10s",
        rule: "idle-destroy",
        target: "dev_1",
      },
    ]);
  });

  it("never proposes a leased device for destruction under disk pressure", () => {
    const pressuredConfig: RegistryView["config"] = {
      ...config,
      diskPressure: { freeBytesThreshold: 10 * gibibyte },
    };
    const leased = view(1_000_000, {
      diskFreeBytes: 2 * gibibyte,
      leases: [
        {
          deviceId: "dev_1",
          grantedAt: 0,
          id: "lse_1",
          requesterId: "agent-1",
          ownerId: "agent-1",
          lastRenewedAt: 0,
          idChosenByRequester: false,
          ttlMs: 60_000,
          ttlDeadline: 1,
        },
      ],
    });

    expect(idleDestroyRule.evaluate({ ...leased, config: pressuredConfig })).toEqual([]);
  });

  describe("a device that never served a lease", () => {
    const never = (id: string, overrides: Partial<RegistryView["devices"][number]> = {}) => ({
      physical: false as const,
      createdAt: 0,
      driverData: {},
      driverDeviceId: `driver-${id}`,
      id,
      mode: "full" as const,
      readyAt: 1_000,
      shutdownAt: 5_000,
      spec: {
        physical: false as const,
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios" as const,
      },
      state: "shutdown" as const,
      ...overrides,
    });

    it("is proposed for destruction once it has been shut down past T2, timed from shutdownAt and not readyAt, and not before", () => {
      const devices = [never("dev_never")];

      expect(idleDestroyRule.evaluate(view(35_000, { devices }))).toEqual([]);
      expect(idleDestroyRule.evaluate(view(35_001, { devices }))).toEqual([
        {
          action: "destroy",
          reason: "idle 30s > T2=30s",
          rule: "idle-destroy",
          target: "dev_never",
        },
      ]);
    });

    it("is left alone when the record carries no shutdownAt, because nothing says when it was shut down", () => {
      const { shutdownAt: _shutdownAt, ...older } = never("dev_old");

      expect(idleDestroyRule.evaluate(view(1_000_000, { devices: [older] }))).toEqual([]);
    });

    it("uses T1 under disk pressure, as a device that was leased does", () => {
      const devices = [never("dev_never")];
      const pressured = (now: number): RegistryView => ({
        ...view(now, { devices, diskFreeBytes: 2 * gibibyte }),
        config: { ...config, diskPressure: { freeBytesThreshold: 10 * gibibyte } },
      });

      expect(idleDestroyRule.evaluate(pressured(15_000))).toEqual([]);
      expect(idleDestroyRule.evaluate(pressured(15_001))).toMatchObject([{ target: "dev_never" }]);
    });

    it("is never proposed while it is ready, leased, or still has a lease record", () => {
      const ready = never("ready", { state: "ready" });
      const leased = never("leased", { state: "leased" });
      const recorded = never("recorded");
      const lease = { deviceId: "recorded" } as LeaseRecord;

      expect(
        idleDestroyRule.evaluate(
          view(1_000_000, { devices: [ready, leased, recorded], leases: [lease] }),
        ),
      ).toEqual([]);
    });
  });
});
