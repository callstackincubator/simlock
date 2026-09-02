import { describe, expect, it } from "vitest";

import type { Config, RegistryView } from "../index.js";
import { idleShutdownRule } from "./idle-shutdown.js";

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
  http: { enabled: false, host: "127.0.0.1", port: 4700 },
  ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
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

function view(now: number): RegistryView {
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
        state: "ready",
      },
    ],
    diskFreeBytes: 100,
    leases: [],
    now,
  };
}

describe("idleShutdownRule", () => {
  it("proposes shutdown only after T1, with an attributable reason", () => {
    expect(idleShutdownRule.evaluate(view(10_000))).toEqual([]);
    expect(idleShutdownRule.evaluate(view(10_001))).toEqual([
      {
        action: "shutdown",
        reason: "idle 10s > T1=10s",
        rule: "idle-shutdown",
        target: "dev_1",
      },
    ]);
  });
});
