import { describe, expect, it } from "vitest";

import type { Config, RegistryView } from "../index.js";
import { idleDestroyRule } from "./idle-destroy.js";

const config: Config = {
  diskPressure: { freeBytesThreshold: 0 },
  eventBuffer: { capacity: 1 },
  idle: { deleteAfterMs: 30_000, shutdownAfterMs: 10_000 },
  lease: { detachedTtlMs: 1, heldTtlBackstopMs: 1, heartbeatIntervalMs: 1 },
  limits: {
    android: { maxDevices: 1, maxRunning: 1 },
    ios: { maxDevices: 1, maxRunning: 1 },
    maxRunning: 1 + 1,
  },
  ramBudget: { androidBytesPerDevice: 1, iosBytesPerDevice: 1 },
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
        state: "shutdown",
      },
    ],
    diskFreeBytes: 100,
    leases: [],
    now,
  };
}

describe("idleDestroyRule", () => {
  it("proposes destruction only after T2", () => {
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
});
