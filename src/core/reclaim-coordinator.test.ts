import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import type { DeviceRecord, DeviceSpec, DeviceTransitionUpdate, LeaseRecord } from "./domain.js";
import { FakeDriver } from "./fake-driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { QuarantinePurgeFailure } from "./quarantine-coordinator.js";
import type { ReleasedLease } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import {
  ReclaimCoordinator,
  type ReclaimQuarantine,
  type ReclaimRegistry,
} from "./reclaim-coordinator.js";

const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

class TestRegistry {
  #devices: DeviceRecord[];
  lastUpdate: DeviceTransitionUpdate | undefined;

  constructor(
    devices: readonly DeviceRecord[],
    readonly leases: readonly LeaseRecord[] = [],
    private readonly eventBus: EventBus,
  ) {
    this.#devices = [...devices];
  }

  get snapshot(): {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  } {
    return { devices: this.#devices.map((device) => ({ ...device })), leases: this.leases };
  }

  async transitionDevice(
    deviceId: string,
    to: Parameters<ReclaimRegistry["transitionDevice"]>[1],
    event: Parameters<ReclaimRegistry["transitionDevice"]>[2],
    update?: DeviceTransitionUpdate,
  ): Promise<DeviceRecord> {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    const current = this.#devices[index];
    if (index === -1 || current === undefined) throw new Error("missing device");
    this.lastUpdate = update;
    const updated = { ...current, ...update, state: to } as DeviceRecord;
    this.#devices[index] = updated;
    if (event.event === "device.reclaimed") {
      this.eventBus.emit(event.event, event.payload, "test-registry");
    } else {
      this.eventBus.emit(event.event, event.payload, "test-registry");
    }
    return updated;
  }

  async completeReclaimWithoutPurge(deviceId: string): Promise<DeviceRecord> {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    const current = this.#devices[index];
    if (index === -1 || current === undefined) throw new Error("missing device");
    const updated = { ...current, state: "shutdown" } as DeviceRecord;
    this.#devices[index] = updated;
    return updated;
  }
}

async function createHarness(
  options: {
    readonly devices?: readonly DeviceRecord[];
    readonly driver?: FakeDriver;
    readonly leases?: readonly LeaseRecord[];
  } = {},
) {
  const clock = new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver =
    options.driver ?? new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
  const driverDevice = await driver.provision(spec);
  const reclaiming = device("reclaiming", "reclaiming", driverDevice.deviceId, spec);
  const registry = new TestRegistry(options.devices ?? [reclaiming], options.leases, bus);
  const notifyAvailability = vi.fn();
  const quarantined: QuarantinePurgeFailure[] = [];
  const quarantine: ReclaimQuarantine = {
    enter: vi.fn(async (failure) => void quarantined.push(failure)),
  };
  const claims = new DeviceOperationClaims();
  const coordinator = new ReclaimCoordinator({
    claims,
    clock,
    decisions: new SerializedDecision(),
    drivers: new DriverCatalog([driver]),
    eventBus: bus,
    notifyAvailability,
    quarantine,
    registry,
  });
  return {
    bus,
    claims,
    clock,
    coordinator,
    driver,
    notifyAvailability,
    quarantine,
    quarantined,
    reclaiming,
    registry,
  };
}

function device(
  id: string,
  state: DeviceRecord["state"],
  driverDeviceId: string,
  deviceSpec: DeviceSpec,
): DeviceRecord {
  return {
    createdAt: 1,
    driverData: {},
    driverDeviceId,
    id,
    mode: "full",
    spec: deviceSpec,
    state,
  };
}

function released(device: DeviceRecord): ReleasedLease {
  return {
    device,
    lease: {
      deviceId: device.id,
      grantedAt: 1,
      id: "lease-1",
      requesterId: "agent",
      ownerId: "agent",
      lastRenewedAt: 1,
      ttlMs: 60_000,
      ttlDeadline: 100,
    },
  };
}

describe("ReclaimCoordinator", () => {
  it("commits shutdown, emits device.reclaimed and kicks acquisition when the driver returns shutdown", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "shutdown" });
    const harness = await createHarness({ driver });

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
    expect(harness.bus.replay().map((event) => event.event)).toEqual(["device.reclaimed"]);
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  // ReclaimCoordinator takes no capacity input at all, so "over its limit" cannot be configured
  // here; another device already running is the strongest state the harness can set up, and
  // the reclaim must still commit `ready` without shutting anything down.
  it("commits ready when the driver returns ready, without shutting it down, even with another device already running", async () => {
    const harness = await createHarness();
    const extra = device("extra", "ready", "extra-driver", { ...spec, model: "iPhone SE" });
    const overloaded = new TestRegistry([harness.reclaiming, extra], [], harness.bus);
    const coordinator = new ReclaimCoordinator({
      claims: harness.claims,
      clock: harness.clock,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([harness.driver]),
      eventBus: harness.bus,
      notifyAvailability: harness.notifyAvailability,
      quarantine: harness.quarantine,
      registry: overloaded,
    });

    await coordinator.reclaim(released(harness.reclaiming));

    expect(
      overloaded.snapshot.devices.find((device) => device.id === harness.reclaiming.id)?.state,
    ).toBe("ready");
    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("shutdown");
  });

  it("never calls makeReady on a reclaim", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "shutdown" });
    const harness = await createHarness({ driver });

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(driver.calls.map((call) => call.operation)).toContain("reclaim");
    expect(driver.calls.map((call) => call.operation)).not.toContain("makeReady");
  });

  it("hands a release-time purge failure to quarantine instead of readiness-checking the device back in", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("purge exploded"));
    const harness = await createHarness({ driver });

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.quarantined).toEqual([
      {
        attemptedStrategy: "wipe",
        deviceId: harness.reclaiming.id,
        duration: 0,
        error: "Error: purge exploded",
        leaseId: "lease-1",
      },
    ]);
    // Quarantine entry is a coordinator concern, not a capacity one: the device
    // stays running (`reclaiming` and `quarantined` both count), so nothing here
    // wakes a queued waiter -- and no readiness probe ever runs.
    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("makeReady");
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("recovers an unleased interrupted reclaim through shutdown and a committed fact", async () => {
    const harness = await createHarness();
    let stateAtFact: DeviceRecord["state"] | undefined;
    harness.bus.subscribe("device.shutdown", () => {
      stateAtFact = harness.registry.snapshot.devices[0]?.state;
    });

    await expect(harness.coordinator.recoverInterrupted(harness.reclaiming.id)).resolves.toBe(true);

    expect(stateAtFact).toBe("shutdown");
    expect(harness.driver.calls.map((call) => call.operation)).toContain("shutdown");
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  describe("a device whose wipe a daemon start put off", () => {
    async function deferredHarness(options: {
      readonly fresh?: boolean;
      readonly fail?: boolean;
      readonly slowEraseMs?: number;
    }) {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({
        clock,
        ...(options.slowEraseMs === undefined
          ? {}
          : { latencyMs: { reclaim: options.slowEraseMs } }),
        platform: "ios",
        reclaimResult: "ready",
      });
      if (options.fail === true) driver.failOn("reclaim", 1, new Error("purge exploded"));
      const driverDevice = await driver.provision(spec);
      const target: DeviceRecord = {
        ...device("deferred", "reclaiming", driverDevice.deviceId, spec),
        deferredReclaimLeaseId: "lease-deferred",
        ...(options.fresh === true ? { leaseIdentity: "fresh" as const } : {}),
        lastLeaseEndedAt: 900,
      };
      return {
        ...(await createHarness({ devices: [target], driver })),
        // The driver's own clock times its erase, not the coordinator's.
        driverClock: clock,
        target,
      };
    }

    it("is purged by the full reclaim, not only shut down, and returns to the pool ready", async () => {
      const harness = await deferredHarness({});

      await expect(harness.coordinator.recoverInterrupted(harness.target.id)).resolves.toBe(true);
      await harness.coordinator.settle();

      const operations = harness.driver.calls.map((call) => call.operation);
      expect(operations).toContain("reclaim");
      expect(operations).not.toContain("shutdown");
      expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
      expect(harness.bus.replay().map((event) => event.event)).toEqual(["device.reclaimed"]);
    });

    it("hands a failed purge to quarantine under the lease it was deferred for", async () => {
      const harness = await deferredHarness({ fail: true });

      await harness.coordinator.recoverInterrupted(harness.target.id);
      await harness.coordinator.settle();

      expect(harness.quarantined).toMatchObject([
        { deviceId: harness.target.id, leaseId: "lease-deferred" },
      ]);
      expect(harness.registry.snapshot.devices[0]?.state).toBe("reclaiming");
    });

    it("is wiped in the background: recovery returns while the erase runs, and the device stays claimed", async () => {
      const harness = await deferredHarness({ slowEraseMs: 30_000 });

      const outcome = await Promise.race([
        harness.coordinator.recoverInterrupted(harness.target.id).then((started) => started),
        new Promise<"still erasing">((resolve) => setImmediate(() => resolve("still erasing"))),
      ]);

      expect(outcome).toBe(true);
      expect(harness.registry.snapshot.devices[0]?.state).toBe("reclaiming");
      expect(harness.claims.claim(harness.target.id)?.kind).toBe("reclaim");

      await new Promise((resolve) => setImmediate(resolve));
      harness.driverClock.advance(30_000);
      await harness.coordinator.settle();

      expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
      expect(harness.claims.isClaimed(harness.target.id)).toBe(false);
      expect(harness.notifyAvailability).toHaveBeenCalled();
    });

    it("settles, with the claim released, when its commit fails and no logger was given", async () => {
      const harness = await deferredHarness({});
      vi.spyOn(harness.registry, "transitionDevice").mockRejectedValue(new Error("write failed"));

      await expect(harness.coordinator.recoverInterrupted(harness.target.id)).resolves.toBe(true);
      await expect(harness.coordinator.settle()).resolves.toBeUndefined();

      expect(harness.claims.isClaimed(harness.target.id)).toBe(false);
    });

    it("is left alone when another operation already holds the device", async () => {
      const harness = await deferredHarness({});
      const held = harness.claims.tryClaim(harness.target.id, "boot");

      await expect(harness.coordinator.recoverInterrupted(harness.target.id)).resolves.toBe(false);

      expect(harness.driver.calls.map((call) => call.operation)).not.toContain("reclaim");
      expect(harness.claims.claim(harness.target.id)?.kind).toBe("boot");
      held?.release();
    });

    it("is only shut down when the device is a spent fresh one, which is never purged", async () => {
      const harness = await deferredHarness({ fresh: true });

      await harness.coordinator.recoverInterrupted(harness.target.id);

      const operations = harness.driver.calls.map((call) => call.operation);
      expect(operations).toContain("shutdown");
      expect(operations).not.toContain("reclaim");
      expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
    });
  });

  describe("a spent fresh device", () => {
    function spent(record: DeviceRecord): DeviceRecord {
      return { ...record, lastLeaseEndedAt: 900, leaseIdentity: "fresh" };
    }

    async function freshHarness(state: DeviceRecord["state"]) {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
      const target = spent(device("fresh", state, (await driver.provision(spec)).deviceId, spec));
      const harness = await createHarness({ devices: [target], driver });
      const operations = () =>
        driver.calls.map((call) => call.operation).filter((operation) => operation !== "provision");
      return { ...harness, operations, target };
    }

    it("is never erased: its lease end is a shutdown and a delete", async () => {
      const harness = await freshHarness("reclaiming");

      await harness.coordinator.reclaim(released(harness.target));

      expect(harness.operations()).toEqual(["shutdown", "destroy"]);
      expect(harness.registry.snapshot.devices[0]?.state).toBe("deleted");
      expect(
        harness.bus.replay().map((event) => ({ event: event.event, payload: event.payload })),
      ).toEqual([
        {
          event: "device.deleted",
          payload: { deviceId: harness.target.id, initiator: "lease-end" },
        },
      ]);
      expect(harness.quarantined).toEqual([]);
    });

    it("hands a failed delete to quarantine with strategy delete, after the shutdown commit", async () => {
      const harness = await freshHarness("reclaiming");
      harness.driver.failOn("destroy", 1, new Error("delete exploded"));

      await harness.coordinator.reclaim(released(harness.target));

      expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
      expect(harness.quarantined).toEqual([
        {
          attemptedStrategy: "delete",
          deviceId: harness.target.id,
          duration: 0,
          error: "Error: delete exploded",
          leaseId: "lease-1",
        },
      ]);
      expect(harness.bus.replay().map((event) => event.event)).not.toContain("device.deleted");
    });

    it("hands a failed lease-end shutdown to quarantine with strategy delete, without deleting", async () => {
      const harness = await freshHarness("reclaiming");
      harness.driver.failOn("shutdown", 1, new Error("shutdown exploded"));

      await harness.coordinator.reclaim(released(harness.target));

      expect(harness.registry.snapshot.devices[0]?.state).toBe("reclaiming");
      expect(harness.operations()).toEqual(["shutdown"]);
      expect(harness.quarantined).toMatchObject([
        { attemptedStrategy: "delete", error: "Error: shutdown exploded" },
      ]);
    });

    it("is deleted by deleteSpent when found shutdown, while a reusable shutdown device is left alone", async () => {
      const harness = await freshHarness("shutdown");
      const reusable = device("reusable", "shutdown", "reusable-driver", spec);
      const registry = new TestRegistry([harness.target, reusable], [], harness.bus);
      const coordinator = new ReclaimCoordinator({
        claims: harness.claims,
        clock: harness.clock,
        decisions: new SerializedDecision(),
        drivers: new DriverCatalog([harness.driver]),
        eventBus: harness.bus,
        notifyAvailability: harness.notifyAvailability,
        quarantine: harness.quarantine,
        registry,
      });

      await expect(coordinator.deleteSpent(reusable.id)).resolves.toBe(false);
      await expect(coordinator.deleteSpent(harness.target.id)).resolves.toBe(true);

      expect(harness.operations()).toEqual(["destroy"]);
      expect(registry.snapshot.devices.map((record) => record.state)).toEqual([
        "deleted",
        "shutdown",
      ]);
    });
  });
});
