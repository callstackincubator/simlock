import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../ports/index.js";
import { AcquisitionPlanner } from "./acquisition-planner.js";
import { CapacityCoordinator, createCapacityStrategy } from "./capacity/index.js";
import type { Config } from "./config.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import type { DeviceRecord, DeviceSpec, LeaseRecord } from "./domain.js";

const gibibyte = 1024 ** 3;
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const config: Config = {
  mode: "worker",
  exec: { timeoutMs: 600_000 },
  diskPressure: { freeBytesThreshold: 10 * gibibyte },
  gateway: {
    disconnectedRetentionMs: 24 * 60 * 60_000,
    execTimeoutMs: 11 * 60_000,
    leaseRequestTimeoutMs: 5 * 60_000,
    routing: "warm-then-free" as const,
  },
  drivers: {},
  eventBuffer: { capacity: 100 },
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
  idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
  warmPool: {
    quarantine: {
      maxRetries: 3,
      maxRetryBackoffMs: 300_000,
      retryBackoffMs: 30_000,
      retryBackoffMultiplier: 2,
    },
  },
  lease: { defaultTtlMs: 100, maxTtlMs: 100, identity: { ios: "reusable", android: "reusable" } },
  capacity: {
    strategy: "resource",
    config: {
      limits: {
        android: { maxDevices: 2, maxRunning: 2 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 1,
      },
      ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    },
  },
  log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
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
    createCapacityStrategy(
      config.capacity,
      new FakeSystemStats({
        cpuCount: 8,
        freeRamBytes: 32 * gibibyte,
        totalRamBytes: 32 * gibibyte,
      }),
    ),
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
        requesterId: "holder",
        ownerId: "holder",
        lastRenewedAt: 1,
        ttlMs: 60_000,
        ttlDeadline: 100,
      },
    ];

    expect(plan(acquisitionPlanner, [leased], { leases })).toEqual({ kind: "wait" });
    expect(plan(acquisitionPlanner, [leased], { leases, noWait: true })).toEqual({
      kind: "no-capacity",
    });
  });

  it("never grants a quarantined device -- it occupies capacity like a running device without being selectable", () => {
    const { planner: acquisitionPlanner } = planner();
    // ios.maxRunning is 1 in this fixture, and RUNNING_STATES (capacity.ts) counts
    // `quarantined` as running, so this device alone exhausts the only iOS slot: no
    // fresh device can be provisioned either. AcquisitionPlanner selects by exact
    // state (`=== "ready"` / `=== "shutdown"`), never by excluding a known-bad
    // state, so quarantined is invisible to every branch with no special-casing --
    // exactly the design constraint from issue #21 / #37.
    const quarantined = device("quarantined", "quarantined");

    expect(plan(acquisitionPlanner, [quarantined])).toEqual({ kind: "wait" });
    expect(plan(acquisitionPlanner, [quarantined], { noWait: true })).toEqual({
      kind: "no-capacity",
    });
  });

  it("never selects a spent fresh device from the ready scan or from the shutdown scan", () => {
    const unused = (state: "ready" | "shutdown") => ({
      ...device(`unused-${state}`, state),
      leaseIdentity: "fresh" as const,
    });
    const spent = (state: "ready" | "shutdown") => ({ ...unused(state), lastLeaseEndedAt: 5 });

    // Control: the same fresh records that have not served a lease yet are selected, so what
    // turns the spent ones away below is the lease they already served.
    expect(plan(planner().planner, [unused("ready")])).toMatchObject({ kind: "grant-ready" });
    expect(plan(planner().planner, [unused("shutdown")])).toMatchObject({ kind: "boot-shutdown" });

    // ios.maxDevices is 1 here, so the spent device is also the only managed eviction victim.
    expect(plan(planner().planner, [spent("ready")])).toMatchObject({ kind: "evict-managed" });
    expect(plan(planner().planner, [spent("shutdown")])).toMatchObject({ kind: "evict-managed" });
  });

  it("counts a spent fresh device against managed-device capacity until it is deleted", () => {
    const spent = {
      ...device("spent", "shutdown"),
      lastLeaseEndedAt: 5,
      leaseIdentity: "fresh" as const,
    };

    // At ios.maxDevices 1, the spent device fills the only slot: no provision is planned.
    expect(plan(planner().planner, [spent])).toMatchObject({
      device: spent,
      kind: "evict-managed",
    });

    const result = plan(planner().planner, [{ ...spent, state: "deleted" }]);
    expect(result).toMatchObject({ kind: "provision" });
    if (result.kind === "provision") result.reservation.release();
  });
});
