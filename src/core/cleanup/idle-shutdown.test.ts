import { describe, expect, it } from "vitest";

import type { Config, RegistryView } from "../index.js";
import { idleShutdownRule } from "./idle-shutdown.js";

const config: Config = {
  diskPressure: { freeBytesThreshold: 0 },
  eventBuffer: { capacity: 1 },
  idle: { deleteAfterMs: 30_000, shutdownAfterMs: 10_000 },
  lease: { detachedTtlMs: 1, heldTtlBackstopMs: 1 },
  limits: {
    android: { maxDevices: 1, maxRunning: 1 },
    ios: { maxDevices: 1, maxRunning: 1 },
    maxRunning: 1 + 1,
  },
  ramBudget: { androidBytesPerDevice: 1, iosBytesPerDevice: 1 },
  warmPool: {},
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
