import { describe, expect, it } from "vitest";

import type { RegistryView } from "../index.js";
import { idleShutdownRule } from "./idle-shutdown.js";

const config: RegistryView["config"] = {
  diskPressure: { freeBytesThreshold: 0 },
  idle: { deleteAfterMs: 30_000, shutdownAfterMs: 10_000 },
};

function view(now: number, targeted: readonly string[] = []): RegistryView {
  return {
    config,
    devices: [
      {
        backend: "local",
        physical: false,
        createdAt: 0,
        driverData: {},
        driverDeviceId: "driver-1",
        id: "dev_1",
        lastLeaseEndedAt: 0,
        spec: { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" },
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
