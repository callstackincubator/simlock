import { describe, expect, it, vi } from "vitest";

import type { DeviceRecord, DeviceState, LeaseRecord, Platform } from "./domain.js";
import { SerializedDecision } from "./serialized-decision.js";
import { StartupConverger } from "./startup-converger.js";
import { StartupRead } from "./startup-read.js";

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
  const recovery = {
    recoverInterruptedReclaim: vi.fn(async (target: DeviceRecord) => {
      order.push(`recover:${target.id}`);
      updateState(target.id, "shutdown");
    }),
  };
  const quarantined = new Set<string>();
  const restored: string[] = [];
  const quarantineRestore = {
    restore: vi.fn((include: (target: DeviceRecord) => boolean) => {
      order.push("quarantine-restore");
      for (const target of devices) {
        if (quarantined.has(target.id) && include(target)) restored.push(target.id);
      }
    }),
  };
  const spentDeviceDeletion = {
    deleteSpent: vi.fn(async (target: DeviceRecord) => {
      order.push(`delete-spent:${target.id}`);
      updateState(target.id, "deleted");
    }),
  };
  const converger = new StartupConverger({
    claims: { isClaimed: (deviceId) => claimed.has(deviceId) },
    decisions: new SerializedDecision(),
    interruptedReclaimRecovery: recovery,
    quarantineRestore,
    registry: {
      get snapshot() {
        return { devices, leases };
      },
    },
    spentDeviceDeletion,
  });

  function updateState(deviceId: string, state: DeviceState): void {
    const index = devices.findIndex((item) => item.id === deviceId);
    const current = devices[index];
    if (current !== undefined) devices[index] = { ...current, state };
  }

  const read = new StartupRead(
    new Map(
      (["ios", "android"] as const)
        .filter((platform) => !darkPlatforms.has(platform))
        .map((platform) => [platform, { devices: [], processes: [] }] as const),
    ),
  );

  return {
    claimed,
    converger,
    read,
    devices,
    leases,
    order,
    quarantined,
    quarantineRestore,
    recovery,
    restored,
    spentDeviceDeletion,
  };
}

describe("StartupConverger", () => {
  it("restores quarantine timers before recovering interrupted reclaims", async () => {
    const harness = createHarness(
      [device("reclaiming", "ios", "reclaiming", 1), device("ready", "ios", "ready", 2)],
      [],
    );

    await harness.converger.converge(harness.read);

    expect(harness.order).toEqual(["quarantine-restore", "recover:reclaiming"]);
    expect(harness.quarantineRestore.restore).toHaveBeenCalledOnce();
    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledOnce();
  });

  it("leaves every ready device ready at startup", async () => {
    const older = device("older", "ios", "ready", 1);
    const newer = device("newer", "android", "ready", 2);
    const harness = createHarness([newer, older], []);

    await harness.converger.converge(harness.read);

    expect(harness.devices.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "newer", state: "ready" },
      { id: "older", state: "ready" },
    ]);
    expect(harness.recovery.recoverInterruptedReclaim).not.toHaveBeenCalled();
    expect(harness.spentDeviceDeletion.deleteSpent).not.toHaveBeenCalled();
  });

  it("leaves every leased device leased at startup", async () => {
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
        idChosenByRequester: false,
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
        idChosenByRequester: false,
        ttlMs: 60_000,
        ttlDeadline: 10,
      },
    ];
    const harness = createHarness([first, second], leases);

    await harness.converger.converge(harness.read);

    expect(harness.devices.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "first", state: "leased" },
      { id: "second", state: "leased" },
    ]);
    expect(harness.recovery.recoverInterruptedReclaim).not.toHaveBeenCalled();
    expect(harness.spentDeviceDeletion.deleteSpent).not.toHaveBeenCalled();
  });

  it("leaves a platform the startup read could not list (no driver, or a listing that failed or hung) untouched instead of failing convergence", async () => {
    const interrupted = device("ios-reclaiming", "ios", "reclaiming", 1);
    const excess = device("ios-ready", "ios", "ready", 2);
    const androidInterrupted = device("android-reclaiming", "android", "reclaiming", 3);
    const harness = createHarness(
      [interrupted, excess, androidInterrupted],
      [],
      new Set<Platform>(["ios"]),
    );

    await harness.converger.converge(harness.read);

    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledOnce();
    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledWith(
      expect.objectContaining({ id: androidInterrupted.id }),
    );
    expect(harness.devices.find((item) => item.id === interrupted.id)?.state).toBe("reclaiming");
    expect(harness.devices.find((item) => item.id === excess.id)?.state).toBe("ready");
  });

  it("re-arms the retry of a quarantined device on a platform the read listed and none on a platform it could not list", async () => {
    const listed = device("android-quarantined", "android", "quarantined", 1);
    const unlisted = device("ios-quarantined", "ios", "quarantined", 2);
    const harness = createHarness([listed, unlisted], [], new Set<Platform>(["ios"]));
    harness.quarantined.add(listed.id).add(unlisted.id);

    await harness.converger.converge(harness.read);

    expect(harness.restored).toEqual(["android-quarantined"]);
  });

  it("is idempotent after recovery", async () => {
    const recovering = device("recovering", "ios", "reclaiming", 1);
    const ready = device("ready", "ios", "ready", 2);
    const harness = createHarness([recovering, ready], []);

    await harness.converger.converge(harness.read);
    await harness.converger.converge(harness.read);

    expect(harness.recovery.recoverInterruptedReclaim).toHaveBeenCalledOnce();
    expect(harness.quarantineRestore.restore).toHaveBeenCalledTimes(2);
  });

  it("sweeps no lease: a leased device keeps its lease across startup (ADR 0004)", async () => {
    // Pre-ADR-0004 this device's lease would have been released as orphaned, on the theory that a
    // restart proves its holder is dead. It proves nothing of the sort: the lease is TTL-bound,
    // its holder may reconnect and renew it, and if nobody does it expires on its own deadline
    // through the timer leasing restores.
    const leasedDevice = device("leased-device", "ios", "leased", 1);
    const leases = [
      {
        deviceId: leasedDevice.id,
        grantedAt: 0,
        id: "lease-1",
        requesterId: "a",
        ownerId: "a",
        lastRenewedAt: 0,
        idChosenByRequester: false,
        ttlMs: 60_000,
        ttlDeadline: 1000,
      },
    ];
    const harness = createHarness([leasedDevice], leases);

    await harness.converger.converge(harness.read);

    expect(harness.leases).toHaveLength(1);
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

    await harness.converger.converge(harness.read);

    expect(harness.order).toEqual([
      "quarantine-restore",
      "recover:spent-reclaiming",
      "delete-spent:spent-reclaiming",
      "delete-spent:spent-shutdown",
    ]);
    expect(harness.devices.find((item) => item.id === reusableShutdown.id)?.state).toBe("shutdown");
  });
});
