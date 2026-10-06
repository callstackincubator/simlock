import { describe, expect, it } from "vitest";

import type { Config, RegistryView } from "../index.js";
import { idleShutdownRule } from "./idle-shutdown.js";

const config: Config = {
  mode: "worker",
  exec: { timeoutMs: 600_000 },
  diskPressure: { freeBytesThreshold: 0 },
  gateway: {
    disconnectedRetentionMs: 24 * 60 * 60_000,
    execTimeoutMs: 11 * 60_000,
    leaseRequestTimeoutMs: 5 * 60_000,
    routing: "warm-then-free" as const,
  },
  drivers: {},
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
  ios: { defaultMode: "full", defaultModels: {}, slim: { bootTimeoutMs: 600_000 } },
  android: {
    defaultModels: {},
    emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
  },
  idle: { deleteAfterMs: 30_000, shutdownAfterMs: 10_000 },
  warmPool: {
    enabled: true,
    maxConcurrentBoots: 1,
    reserveRunning: { android: 0, ios: 0 },
    targets: [],
    quarantine: {
      maxRetries: 3,
      maxRetryBackoffMs: 300_000,
      retryBackoffMs: 30_000,
      retryBackoffMultiplier: 2,
    },
  },
  lease: {
    defaultTtlMs: 60_000,
    maxTtlMs: 3_600_000,
    identity: { ios: "reusable", android: "reusable" },
    requestRetentionMs: 600_000,
    maxRequestRecords: 10_000,
  },
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
  eventLog: {
    rotateBytes: 5 * 1024 * 1024,
    retention: 7 * 24 * 60 * 60 * 1000,
    maxBytes: 256 * 1024 * 1024,
  },
};

function view(now: number, targeted: readonly string[] = []): RegistryView {
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
        mode: "full",
        state: "ready",
      },
    ],
    diskFreeBytes: 100,
    leases: [],
    now,
    targeted: new Set(targeted),
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

  it("leaves a targeted device idle past T1 alone, and still proposes the same device once it is not targeted", () => {
    expect(idleShutdownRule.evaluate(view(60_000, ["dev_1"]))).toEqual([]);
    expect(idleShutdownRule.evaluate(view(60_000, ["dev_other"]))).toEqual([
      {
        action: "shutdown",
        reason: "idle 1m > T1=10s",
        rule: "idle-shutdown",
        target: "dev_1",
      },
    ]);
  });
});
