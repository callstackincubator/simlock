import { describe, expect, it } from "vitest";

import type { Config, LeaseRecord, RegistryView } from "../index.js";
import { idleDestroyRule } from "./idle-destroy.js";

const gibibyte = 1024 ** 3;

const config: Config = {
  diskPressure: { freeBytesThreshold: 0 },
  eventBuffer: { capacity: 1 },
  health: {
    enabled: true,
    maxConcurrentRecoveries: 1,
    maxRecoveryAttempts: 3,
    probeIntervalMs: 30_000,
    recoveryBackoffMs: 5_000,
    stableObservations: 2,
  },
  stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
  downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
  idle: { deleteAfterMs: 30_000, shutdownAfterMs: 10_000 },
  warmPool: {
    quarantine: {
      maxRetries: 3,
      maxRetryBackoffMs: 300_000,
      retryBackoffMs: 30_000,
      retryBackoffMultiplier: 2,
    },
  },
  lease: { detachedTtlMs: 1, heldTtlBackstopMs: 1, heartbeatIntervalMs: 1 },
  capacity: {
    strategy: "resource",
    config: {
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 1 + 1,
      },
      ramBudget: { androidBytesPerDevice: 1, iosBytesPerDevice: 1 },
    },
  },
  log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
};

function view(
  now: number,
  overrides: { readonly diskFreeBytes?: number; readonly leases?: readonly LeaseRecord[] } = {},
): RegistryView {
  return {
    config,
    devices: [
      {
        createdAt: 0,
        driverData: {},
        driverDeviceId: "driver-1",
        id: "dev_1",
        lastLeaseEndedAt: 0,
        spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        state: "shutdown",
      },
    ],
    diskFreeBytes: overrides.diskFreeBytes ?? 100,
    leases: overrides.leases ?? [],
    now,
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
    const pressuredConfig: Config = {
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
    const pressuredConfig: Config = {
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
          mode: "held",
          requesterId: "agent-1",
          ttlDeadline: 1,
        },
      ],
    });

    expect(idleDestroyRule.evaluate({ ...leased, config: pressuredConfig })).toEqual([]);
  });
});
