import { describe, expect, it, vi } from "vitest";

import type { DeviceRecord, DeviceState, LeaseRecord, Platform } from "./domain.js";
import { SerializedDecision } from "./serialized-decision.js";
import { StartupConverger } from "./startup-converger.js";

function device(
  id: string,
  platform: Platform,
  state: DeviceState,
  lastLeaseEndedAt: number,
): DeviceRecord {
  return {
    createdAt: lastLeaseEndedAt,
    driverData: {},
    driverDeviceId: `driver-${id}`,
    id,
    lastLeaseEndedAt,
    spec: { model: "test", osVersion: "1", platform },
    mode: "full",
    state,
  };
}

function createHarness(
  devices: DeviceRecord[],
  leases: LeaseRecord[] = [],
  darkPlatforms: ReadonlySet<Platform> = new Set(),
) {
  const order: string[] = [];
  const claimed = new Set<string>();
  let leaseIdsAtTimerRestore: string[] | undefined;
  const timers = {
    restoreExpiryTimers: vi.fn(async () => {
      order.push("timers");
      leaseIdsAtTimerRestore = leases.map((lease) => lease.id);
    }),
  };
  const recovery = {
    recoverInterruptedReclaim: vi.fn(async (target: DeviceRecord) => {
      order.push(`recover:${target.id}`);
      updateState(target.id, "shutdown");
    }),
  };
  const quarantineRestore = { restore: vi.fn(() => void order.push("quarantine-restore")) };
  const spentDeviceDeletion = {
    deleteSpent: vi.fn(async (target: DeviceRecord) => {
      order.push(`delete-spent:${target.id}`);
      updateState(target.id, "deleted");
    }),
  };
  const converger = new StartupConverger({
    claims: { isClaimed: (deviceId) => claimed.has(deviceId) },
    decisions: new SerializedDecision(),
    drivers: { has: (platform) => !darkPlatforms.has(platform) },
    eventBus: { emit: vi.fn() as never },
    interruptedReclaimRecovery: recovery,
    quarantineRestore,
    registry: {
      failOpenLeaseRequests: async () => [],
      get snapshot() {
        return { devices, leases };
      },
    },
    spentDeviceDeletion,
    timers,
  });

  function updateState(deviceId: string, state: DeviceState): void {
    const index = devices.findIndex((item) => item.id === deviceId);
    const current = devices[index];
    if (current !== undefined) devices[index] = { ...current, state };
  }

  return {
    claimed,
    converger,
    devices,
    get leaseIdsAtTimerRestore() {
      return leaseIdsAtTimerRestore;
    },
    leases,
    order,
    quarantineRestore,
    recovery,
    spentDeviceDeletion,
    timers,
  };
}

describe("StartupConverger", () => {
  it("restores timers before recovering interrupted reclaims", async () => {
    const harness = createHarness(
      [device("reclaiming", "ios", "reclaiming", 1), device("ready", "ios", "ready", 2)],
      [],
    );

    await harness.converger.converge();

    expect(harness.order).toEqual(["timers", "quarantine-restore", "recover:reclaiming"]);
    expect(harness.timers.restoreExpiryTimers).toHaveBeenCalledOnce();
    expect(harness.quarantineRestore.restore).toHaveBeenCalledOnce();
    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledOnce();
  });

  it("leaves ready devices over maxRunning running at startup", async () => {
    const older = device("older", "ios", "ready", 1);
    const newer = device("newer", "android", "ready", 2);
    const harness = createHarness([newer, older], []);

    await harness.converger.converge();
    expect(older.state).toBe("ready");
    expect(newer.state).toBe("ready");
  });

  it("leaves unavoidable leased overage untouched", async () => {
    const first = device("first", "ios", "leased", 1);
    const second = device("second", "ios", "leased", 2);
    const leases = [
      {
        deviceId: first.id,
        grantedAt: 0,
        id: "lease-1",
        requesterId: "a",
        ownerId: "a",
        lastRenewedAt: 0,
        ttlMs: 60_000,
        ttlDeadline: 10,
      },
      {
        deviceId: second.id,
        grantedAt: 0,
        id: "lease-2",
        requesterId: "b",
        ownerId: "b",
        lastRenewedAt: 0,
        ttlMs: 60_000,
        ttlDeadline: 10,
      },
    ];
    const harness = createHarness([first, second], leases);

    await harness.converger.converge();
    expect(first.state).toBe("leased");
    expect(second.state).toBe("leased");
  });

  it("leaves a platform without a driver untouched instead of failing convergence", async () => {
    const interrupted = device("ios-reclaiming", "ios", "reclaiming", 1);
    const excess = device("ios-ready", "ios", "ready", 2);
    const androidInterrupted = device("android-reclaiming", "android", "reclaiming", 3);
    const harness = createHarness(
      [interrupted, excess, androidInterrupted],
      [],
      new Set<Platform>(["ios"]),
    );

    await harness.converger.converge();

    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledOnce();
    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledWith(
      expect.objectContaining({ id: androidInterrupted.id }),
    );
    expect(harness.devices.find((item) => item.id === interrupted.id)?.state).toBe("reclaiming");
    expect(harness.devices.find((item) => item.id === excess.id)?.state).toBe("ready");
  });

  it("is idempotent after recovery", async () => {
    const recovering = device("recovering", "ios", "reclaiming", 1);
    const ready = device("ready", "ios", "ready", 2);
    const harness = createHarness([recovering, ready], []);

    await harness.converger.converge();
    await harness.converger.converge();

    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledOnce();
    expect(harness.timers.restoreExpiryTimers).toHaveBeenCalledTimes(2);
  });

  it("restores the timer of every lease it finds, sweeping none (ADR 0004)", async () => {
    // Pre-ADR-0004 this device's lease would have been released as orphaned before timers
    // were restored, on the theory that a restart proves its holder is dead. It proves
    // nothing of the sort: the lease is TTL-bound, its holder may reconnect and renew it,
    // and if nobody does it expires on its own deadline through the restored timer.
    const leasedDevice = device("leased-device", "ios", "leased", 1);
    const leases = [
      {
        deviceId: leasedDevice.id,
        grantedAt: 0,
        id: "lease-1",
        requesterId: "a",
        ownerId: "a",
        lastRenewedAt: 0,
        ttlMs: 60_000,
        ttlDeadline: 1000,
      },
    ];
    const harness = createHarness([leasedDevice], leases);

    await harness.converger.converge();

    expect(harness.leaseIdsAtTimerRestore).toEqual(["lease-1"]);
    expect(harness.leases).toHaveLength(1);
    expect(harness.devices.find((item) => item.id === leasedDevice.id)?.state).toBe("leased");
  });

  it("leaves a leased device leased even when the running limit is now zero", async () => {
    // The device the lease holds is over the (lowered) limit, and stays exactly where it is:
    // there is no sweep left that could free it, and the capacity pass never touches a
    // leased device. It goes back to the pool when the lease expires or is released.
    const leasedDevice = device("leased-device", "ios", "leased", 1);
    const leases = [
      {
        deviceId: leasedDevice.id,
        grantedAt: 0,
        id: "lease-1",
        requesterId: "a",
        ownerId: "a",
        lastRenewedAt: 0,
        ttlMs: 60_000,
        ttlDeadline: 1000,
      },
    ];
    const harness = createHarness([leasedDevice], leases);

    await harness.converger.converge();
    expect(harness.devices.find((item) => item.id === leasedDevice.id)?.state).toBe("leased");
  });

  it("deletes every spent fresh device found reclaiming or shutdown, after recovering interrupted reclaims", async () => {
    // `device()` stamps `lastLeaseEndedAt` on every record, so the reusable one below has ended
    // a lease too: only its identity policy keeps it out of the delete.
    const spentReclaiming = { ...device("spent-reclaiming", "ios", "reclaiming", 1) };
    const spentShutdown = { ...device("spent-shutdown", "ios", "shutdown", 2) };
    const reusableShutdown = device("reusable-shutdown", "ios", "shutdown", 3);
    const harness = createHarness(
      [
        { ...spentReclaiming, leaseIdentity: "fresh" },
        { ...spentShutdown, leaseIdentity: "fresh" },
        reusableShutdown,
      ],
      [],
    );

    await harness.converger.converge();

    expect(harness.order).toEqual([
      "timers",
      "quarantine-restore",
      "recover:spent-reclaiming",
      "delete-spent:spent-reclaiming",
      "delete-spent:spent-shutdown",
    ]);
    expect(harness.devices.find((item) => item.id === reusableShutdown.id)?.state).toBe("shutdown");
  });
});
