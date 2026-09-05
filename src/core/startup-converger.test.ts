import { describe, expect, it, vi } from "vitest";

import type { RunningCapacity } from "./capacity/index.js";
import type { CleanupActionExecutor } from "./cleanup-executor.js";
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
    state,
  };
}

function capacity(
  devices: readonly DeviceRecord[],
  limits: { readonly global: number; readonly ios: number; readonly android: number },
): RunningCapacity {
  const running = (platform?: Platform) =>
    devices.filter(
      (item) =>
        (item.state === "ready" || item.state === "leased" || item.state === "reclaiming") &&
        (platform === undefined || item.spec.platform === platform),
    ).length;
  const entry = (platform: Platform | undefined, maxRunning: number) => ({
    maxRunning,
    overLimit: running(platform) > maxRunning,
    reserved: 0,
    running: running(platform),
  });
  return {
    android: entry("android", limits.android),
    global: entry(undefined, limits.global),
    ios: entry("ios", limits.ios),
  };
}

function createHarness(
  devices: DeviceRecord[],
  leases: LeaseRecord[] = [],
  limits = { android: 3, global: 3, ios: 3 },
) {
  const order: string[] = [];
  const claimed = new Set<string>();
  const cleanupCalls: string[] = [];
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
  const cleanup: CleanupActionExecutor = {
    execute: vi.fn(async (proposal) => {
      order.push(`cleanup:${proposal.target}`);
      cleanupCalls.push(proposal.target);
      const current = devices.find((item) => item.id === proposal.target);
      if (current === undefined || current.state !== "ready") return false;
      updateState(current.id, "shutdown");
      return true;
    }),
  };
  const quarantineRestore = { restore: vi.fn(() => void order.push("quarantine-restore")) };
  const converger = new StartupConverger({
    capacity: {
      deviceLimit: () => limits.ios + limits.android,
      get runningCapacity() {
        return capacity(devices, limits);
      },
    },
    claims: { isClaimed: (deviceId) => claimed.has(deviceId) },
    cleanup,
    decisions: new SerializedDecision(),
    interruptedReclaimRecovery: recovery,
    quarantineRestore,
    registry: {
      get snapshot() {
        return { devices, leases };
      },
    },
    timers,
  });

  function updateState(deviceId: string, state: DeviceState): void {
    const index = devices.findIndex((item) => item.id === deviceId);
    const current = devices[index];
    if (current !== undefined) devices[index] = { ...current, state };
  }

  return {
    claimed,
    cleanup,
    cleanupCalls,
    converger,
    devices,
    get leaseIdsAtTimerRestore() {
      return leaseIdsAtTimerRestore;
    },
    leases,
    order,
    quarantineRestore,
    recovery,
    timers,
  };
}

describe("StartupConverger", () => {
  it("restores timers before recovering interrupted reclaims and converging capacity", async () => {
    const harness = createHarness(
      [device("reclaiming", "ios", "reclaiming", 1), device("ready", "ios", "ready", 2)],
      [],
      { android: 1, global: 0, ios: 1 },
    );

    await harness.converger.converge();

    expect(harness.order).toEqual([
      "timers",
      "quarantine-restore",
      "recover:reclaiming",
      "cleanup:ready",
    ]);
    expect(harness.timers.restoreExpiryTimers).toHaveBeenCalledOnce();
    expect(harness.quarantineRestore.restore).toHaveBeenCalledOnce();
    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledOnce();
  });

  it("chooses the least recently used unleased device for global excess", async () => {
    const older = device("older", "ios", "ready", 1);
    const newer = device("newer", "android", "ready", 2);
    const harness = createHarness([newer, older], [], { android: 2, global: 1, ios: 2 });

    await harness.converger.converge();

    expect(harness.cleanupCalls).toEqual(["older"]);
  });

  it("selects only an over-limit platform when global capacity remains within limit", async () => {
    const iosOlder = device("ios-older", "ios", "ready", 1);
    const iosNewer = device("ios-newer", "ios", "ready", 2);
    const android = device("android", "android", "ready", 0);
    const harness = createHarness([iosNewer, android, iosOlder], [], {
      android: 2,
      global: 3,
      ios: 1,
    });

    await harness.converger.converge();

    expect(harness.cleanupCalls).toEqual(["ios-older"]);
    expect(android.state).toBe("ready");
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
    const harness = createHarness([first, second], leases, { android: 1, global: 1, ios: 1 });

    await harness.converger.converge();

    expect(harness.cleanupCalls).toEqual([]);
    expect(first.state).toBe("leased");
    expect(second.state).toBe("leased");
  });

  it("skips claimed targets and terminates after executor refusal", async () => {
    const claimed = device("claimed", "ios", "ready", 1);
    const refused = device("refused", "ios", "ready", 2);
    const harness = createHarness([claimed, refused], [], { android: 1, global: 0, ios: 0 });
    harness.claimed.add(claimed.id);
    vi.mocked(harness.cleanup.execute).mockResolvedValue(false);

    await harness.converger.converge();

    expect(harness.cleanupCalls).toEqual([]);
    expect(harness.cleanup.execute).toHaveBeenCalledTimes(1);
    expect(harness.cleanup.execute).toHaveBeenCalledWith(
      expect.objectContaining({ target: refused.id }),
    );
  });

  it("is idempotent after recovery and successful convergence", async () => {
    const recovering = device("recovering", "ios", "reclaiming", 1);
    const ready = device("ready", "ios", "ready", 2);
    const harness = createHarness([recovering, ready], [], { android: 1, global: 0, ios: 1 });

    await harness.converger.converge();
    await harness.converger.converge();

    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledOnce();
    expect(harness.cleanupCalls).toEqual(["ready"]);
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
    const harness = createHarness([leasedDevice], leases, { android: 1, global: 1, ios: 1 });

    await harness.converger.converge();

    expect(harness.leaseIdsAtTimerRestore).toEqual(["lease-1"]);
    expect(harness.leases).toHaveLength(1);
    expect(harness.devices.find((item) => item.id === leasedDevice.id)?.state).toBe("leased");
    expect(harness.cleanupCalls).toEqual([]);
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
    const harness = createHarness([leasedDevice], leases, { android: 1, global: 0, ios: 0 });

    await harness.converger.converge();

    expect(harness.cleanupCalls).toEqual([]);
    expect(harness.devices.find((item) => item.id === leasedDevice.id)?.state).toBe("leased");
  });

  it("restores timers before quarantine and interrupted-reclaim recovery", async () => {
    const reclaiming = device("reclaiming", "ios", "reclaiming", 1);
    const harness = createHarness([reclaiming], [], { android: 1, global: 3, ios: 3 });

    await harness.converger.converge();

    expect(harness.order.indexOf("timers")).toBe(0);
    expect(harness.order.indexOf("quarantine-restore")).toBeGreaterThan(
      harness.order.indexOf("timers"),
    );
    expect(harness.order.indexOf("recover:reclaiming")).toBeGreaterThan(
      harness.order.indexOf("quarantine-restore"),
    );
  });
});
