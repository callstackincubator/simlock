import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../ports/index.js";
import type { Config } from "./config.js";
import { CapacityCoordinator } from "./capacity-coordinator.js";

const gibibyte = 1024 ** 3;
const config: Config = {
  diskPressure: { freeBytesThreshold: 10 * gibibyte },
  eventBuffer: { capacity: 1000 },
  idle: { deleteAfterMs: 60 * 60_000, shutdownAfterMs: 10 * 60_000 },
  warmPool: {
    quarantine: {
      maxRetries: 3,
      maxRetryBackoffMs: 300_000,
      retryBackoffMs: 30_000,
      retryBackoffMultiplier: 2,
    },
  },
  lease: {
    detachedTtlMs: 15 * 60_000,
    heldTtlBackstopMs: 60 * 60_000,
    heartbeatIntervalMs: 5 * 60_000,
  },
  limits: {
    android: { maxDevices: 4, maxRunning: 2 },
    ios: { maxDevices: 1, maxRunning: 1 },
    maxRunning: 2,
  },
  ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 1.5 * gibibyte },
  log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
};

function coordinator(): CapacityCoordinator {
  return new CapacityCoordinator(
    config,
    new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
      totalRamBytes: 32 * gibibyte,
    }),
  );
}

describe("CapacityCoordinator", () => {
  it("accounts for provisioning reservations in both device and running capacity", () => {
    const capacity = coordinator();
    const first = capacity.tryReserveProvisioning("ios", []);
    expect(first.ok).toBe(true);
    expect(capacity.runningCapacity([]).ios).toEqual({
      maxRunning: 1,
      overLimit: false,
      reserved: 1,
      running: 0,
    });

    expect(capacity.tryReserveProvisioning("ios", [])).toEqual({
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
      { platform: "ios" as const, state: "deleted" },
      { platform: "android" as const, state: "unknown-to-core" },
    ];

    expect(capacity.tryReserveProvisioning("ios", snapshot)).toMatchObject({ ok: true });
    expect(capacity.runningCapacity(snapshot)).toEqual({
      android: { maxRunning: 2, overLimit: false, reserved: 0, running: 0 },
      global: { maxRunning: 2, overLimit: false, reserved: 1, running: 0 },
      ios: { maxRunning: 1, overLimit: false, reserved: 1, running: 0 },
    });
  });
});
