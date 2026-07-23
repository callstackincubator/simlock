import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../ports/index.js";
import { AcquisitionPlanner } from "./acquisition-planner.js";
import { CapacityCoordinator } from "./capacity-coordinator.js";
import type { Config } from "./config.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import type { DeviceRecord, DeviceSpec, LeaseRecord } from "./domain.js";

const gibibyte = 1024 ** 3;
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const config: Config = {
  diskPressure: { freeBytesThreshold: 10 * gibibyte },
  eventBuffer: { capacity: 100 },
  idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
  lease: { detachedTtlMs: 100, heldTtlBackstopMs: 100 },
  limits: {
    android: { maxDevices: 2, maxRunning: 2 },
    ios: { maxDevices: 1, maxRunning: 1 },
    maxRunning: 1,
  },
  ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
};

function device(
  id: string,
  state: DeviceRecord["state"],
  deviceSpec: DeviceSpec = spec,
): DeviceRecord {
  return {
    createdAt: 1,
    driverData: {},
    driverDeviceId: `driver-${id}`,
    id,
    spec: deviceSpec,
    state,
  };
}

function planner() {
  const claims = new DeviceOperationClaims();
  const capacity = new CapacityCoordinator(
    config,
    new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
      totalRamBytes: 32 * gibibyte,
    }),
  );
  return { claims, planner: new AcquisitionPlanner(capacity, claims) };
}

function plan(
  acquisitionPlanner: AcquisitionPlanner,
  devices: readonly DeviceRecord[],
  options: { failures?: number; leases?: readonly LeaseRecord[]; noWait?: boolean } = {},
) {
  return acquisitionPlanner.plan({
    failures: options.failures ?? 0,
    noWait: options.noWait ?? false,
    snapshot: { devices, leases: options.leases ?? [] },
    spec,
  });
}

describe("AcquisitionPlanner", () => {
  it("grants a matching unclaimed ready device", () => {
    const { planner: acquisitionPlanner } = planner();
    const ready = device("ready", "ready");

    expect(plan(acquisitionPlanner, [ready])).toEqual({ device: ready, kind: "grant-ready" });
  });

  it("reserves capacity and claims a matching shutdown device for boot", () => {
    const { claims, planner: acquisitionPlanner } = planner();
    const shutdown = device("shutdown", "shutdown");

    const result = plan(acquisitionPlanner, [shutdown]);

    expect(result).toMatchObject({ device: shutdown, kind: "boot-shutdown" });
    expect(claims.operationFor(shutdown.id)).toBe("boot");
    if (result.kind === "boot-shutdown") {
      result.capacityReservation.release();
      result.claim.release();
    }
  });

  it("selects a managed same-platform victim at the device limit", () => {
    const { claims, planner: acquisitionPlanner } = planner();
    const managed = device("managed", "shutdown", { ...spec, model: "iPhone SE" });

    const result = plan(acquisitionPlanner, [managed]);

    expect(result).toMatchObject({ device: managed, kind: "evict-managed" });
    expect(claims.operationFor(managed.id)).toBe("eviction");
  });

  it("selects a warm victim when a running limit blocks provisioning", () => {
    const { claims, planner: acquisitionPlanner } = planner();
    const warm = device("warm", "ready", {
      model: "Pixel 9",
      osVersion: "36",
      platform: "android",
    });

    const result = plan(acquisitionPlanner, [warm]);

    expect(result).toMatchObject({ device: warm, kind: "evict-running" });
    expect(claims.operationFor(warm.id)).toBe("eviction");
  });

  it("excludes claimed devices from ready grants and eviction candidates", () => {
    const { claims, planner: acquisitionPlanner } = planner();
    const ready = device("ready", "ready");
    const claim = claims.tryClaim(ready.id, "cleanup");
    if (claim === undefined) throw new Error("expected claim");

    expect(plan(acquisitionPlanner, [ready])).toEqual({ kind: "wait" });
    expect(plan(acquisitionPlanner, [ready], { noWait: true })).toEqual({ kind: "no-capacity" });
    claim.release();
  });

  it("waits or rejects when policy cannot reserve capacity", () => {
    const { planner: acquisitionPlanner } = planner();
    const leased = device("leased", "leased");
    const leases = [
      {
        deviceId: leased.id,
        grantedAt: 1,
        id: "lease",
        mode: "held" as const,
        requesterId: "holder",
        ttlDeadline: 100,
      },
    ];

    expect(plan(acquisitionPlanner, [leased], { leases })).toEqual({ kind: "wait" });
    expect(plan(acquisitionPlanner, [leased], { leases, noWait: true })).toEqual({
      kind: "no-capacity",
    });
  });
});
