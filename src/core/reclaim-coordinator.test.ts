import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, type Logger, MemoryFilesystem } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import type {
  DeviceRecord,
  DeviceTransitionUpdate,
  LeaseRecord,
  PhysicalDevice,
  VirtualDevice,
  VirtualSpec,
} from "./domain.js";
import { FakeDriver } from "./fake-driver.js";
import { DriverCatalog, NoDriverError } from "./driver-catalog.js";
import { QuarantineCoordinator, type QuarantinePurgeFailure } from "./quarantine-coordinator.js";
import { Registry, type ReleasedLease } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import {
  ReclaimCoordinator,
  type ReclaimDriverCatalog,
  type ReclaimQuarantine,
  type ReclaimRegistry,
} from "./reclaim-coordinator.js";

const spec = { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

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
    readonly virtualDevices: readonly VirtualDevice[];
    readonly leases: readonly LeaseRecord[];
  } {
    return {
      devices: this.#devices.map((device) => ({ ...device })),
      leases: this.leases,
      virtualDevices: this.#devices.flatMap((device) => (device.physical ? [] : [{ ...device }])),
    };
  }

  deviceById(deviceId: string): DeviceRecord | undefined {
    return this.#devices.find((device) => device.id === deviceId);
  }

  remove(deviceId: string): void {
    this.#devices = this.#devices.filter((device) => device.id !== deviceId);
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
      this.eventBus.emit(event.event, { ...event.payload, physical: false }, "test-registry");
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
    readonly physicalDeviceReady?: (deviceId: string) => void;
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
  const decisions = new SerializedDecision();
  const coordinator = new ReclaimCoordinator({
    claims,
    clock,
    decisions,
    drivers: new DriverCatalog([driver]),
    eventBus: bus,
    notifyAvailability,
    ...(options.physicalDeviceReady === undefined
      ? {}
      : { physicalDeviceReady: options.physicalDeviceReady }),
    quarantine,
    registry,
  });
  return {
    bus,
    claims,
    clock,
    coordinator,
    decisions,
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
  state: VirtualDevice["state"],
  driverDeviceId: string,
  deviceSpec: VirtualSpec,
): VirtualDevice {
  return {
    physical: false,
    createdAt: 1,
    driverData: {},
    driverDeviceId,
    id,
    mode: "full",
    spec: deviceSpec,
    state,
  };
}

function released(device: VirtualDevice): ReleasedLease {
  return {
    device,
    lease: {
      deviceId: device.id,
      grantedAt: 1,
      id: "lease-1",
      requesterId: "agent",
      ownerId: "agent",
      lastRenewedAt: 1,
      idChosenByRequester: false,
      ttlMs: 60_000,
      ttlDeadline: 100,
    },
  };
}

describe("ReclaimCoordinator", () => {
  it("reclaims a released physical lease through the driver with its enrollment app list, and commits ready with the uninstall strategy and its missing apps", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      clock,
      physicalDevices: [
        {
          apps: ["com.example.kept", "com.example.stray"],
          ids: ["00008110-001A2B3C4D5E"],
          model: "iPhone 15 Pro",
          osVersion: "18.4",
        },
      ],
      platform: "ios",
    });
    const physical: PhysicalDevice = {
      createdAt: 1,
      driverData: {},
      driverDeviceId: "00008110-001A2B3C4D5E",
      enrolledApps: ["com.example.kept", "com.example.removed"],
      id: "dev_physical",
      lastLeaseEndedAt: 1_000,
      physical: true,
      spec: {
        class: "phone",
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        physical: true,
        platform: "ios",
      },
      state: "reclaiming",
    };
    const harness = await createHarness({ devices: [physical], driver });

    await harness.coordinator.reclaim({ ...released(harness.reclaiming), device: physical });

    expect(driver.calls.filter((call) => call.operation === "reclaim")).toEqual([
      {
        arguments: [
          expect.objectContaining({
            deviceId: "00008110-001A2B3C4D5E",
            enrolledApps: ["com.example.kept", "com.example.removed"],
            physical: true,
          }),
          { clean: "standard" },
        ],
        operation: "reclaim",
      },
    ]);
    expect(harness.registry.deviceById("dev_physical")?.state).toBe("ready");
    expect(harness.bus.replay().map((event) => event.payload)).toEqual([
      expect.objectContaining({
        missingApps: ["com.example.removed"],
        strategy: "uninstall",
      }),
    ]);
    expect(harness.quarantined).toEqual([]);
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  it("hands the driver's reclaim a device marked virtual", async () => {
    const harness = await createHarness();

    await harness.coordinator.reclaim(released(harness.reclaiming));

    const reclaims = harness.driver.calls.filter((call) => call.operation === "reclaim");
    expect(reclaims.map((call) => call.arguments[0])).toEqual([
      expect.objectContaining({ physical: false }),
    ]);
  });

  it("asks the driver for the strategy of a standard clean before it reclaims", async () => {
    const harness = await createHarness();
    const strategy = vi.spyOn(harness.driver, "reclaimStrategy");
    const reclaim = vi.spyOn(harness.driver, "reclaim");

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(strategy.mock.calls.map((call) => call[1])).toEqual([{ clean: "standard" }]);
    expect(strategy.mock.invocationCallOrder[0]).toBeLessThan(
      reclaim.mock.invocationCallOrder[0] as number,
    );
  });

  it("emits device.reclaimed for a virtual device without a missingApps field", async () => {
    const harness = await createHarness();

    await harness.coordinator.reclaim(released(harness.reclaiming));

    const payload = harness.bus.replay()[0]?.payload as object;
    expect("missingApps" in payload).toBe(false);
  });

  it("reclaims a physical device through the driver even when its record carries a spent fresh identity", async () => {
    const physical = {
      createdAt: 1,
      driverData: {},
      driverDeviceId: "00008110-001A2B3C4D5E",
      enrolledApps: [],
      id: "dev_physical",
      lastLeaseEndedAt: 1_000,
      leaseIdentity: "fresh",
      physical: true,
      spec: {
        class: "phone",
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        physical: true,
        platform: "ios",
      },
      state: "reclaiming",
    } as unknown as PhysicalDevice;
    const harness = await createHarness({ devices: [physical] });

    await harness.coordinator.reclaim({ ...released(harness.reclaiming), device: physical });

    expect(harness.driver.calls.map((call) => call.operation)).toEqual(["provision", "reclaim"]);
    expect(harness.registry.deviceById("dev_physical")?.state).toBe("ready");
  });

  it("commits shutdown, emits device.reclaimed and kicks acquisition when the driver returns shutdown", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "shutdown" });
    const harness = await createHarness({ driver });

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("shutdown");
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
      overloaded.snapshot.virtualDevices.find((device) => device.id === harness.reclaiming.id)
        ?.state,
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
        kind: "purge-failed",
        leaseId: "lease-1",
      },
    ]);
    // Quarantine entry is a coordinator concern, not a capacity one: the device
    // stays running (`reclaiming` and `quarantined` both count), so nothing here
    // wakes a queued waiter -- and no readiness probe ever runs.
    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("makeReady");
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("recovers an unleased interrupted reclaim through shutdown, a committed fact, and itself as the emitter", async () => {
    const harness = await createHarness();
    let stateAtFact: VirtualDevice["state"] | undefined;
    harness.bus.subscribe("device.shutdown", () => {
      stateAtFact = harness.registry.snapshot.virtualDevices[0]?.state;
    });

    await expect(harness.coordinator.recoverInterrupted(harness.reclaiming.id)).resolves.toBe(true);

    expect(stateAtFact).toBe("shutdown");
    expect(harness.driver.calls.map((call) => call.operation)).toContain("shutdown");
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
    // why: Events rule 7 binds the emitting module onto every event, and both EVENTS.md cuts name
    // the reclaim coordinator as this shutdown's emitter — `simlock events` and the `events.jsonl`
    // audit trail print that string, so it must name the module that actually did it.
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "device.shutdown")
        .map((event) => ({ module: event.module, payload: event.payload })),
    ).toEqual([
      {
        module: "reclaim-coordinator",
        payload: { deviceId: harness.reclaiming.id, initiator: "startup-interrupted-reclaim" },
      },
    ]);
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
      const target: VirtualDevice = {
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
      expect(
        harness.driver.calls.find((call) => call.operation === "reclaim")?.arguments[1],
      ).toEqual({ clean: "standard" });
      expect(operations).not.toContain("shutdown");
      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
      expect(harness.bus.replay().map((event) => event.event)).toEqual(["device.reclaimed"]);
    });

    it("hands a failed purge to quarantine under the lease it was deferred for", async () => {
      const harness = await deferredHarness({ fail: true });

      await harness.coordinator.recoverInterrupted(harness.target.id);
      await harness.coordinator.settle();

      expect(harness.quarantined).toMatchObject([
        { deviceId: harness.target.id, kind: "purge-failed", leaseId: "lease-deferred" },
      ]);
      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("reclaiming");
    });

    it("is wiped in the background: recovery returns while the erase runs, and the device stays claimed", async () => {
      const harness = await deferredHarness({ slowEraseMs: 30_000 });

      const outcome = await Promise.race([
        harness.coordinator.recoverInterrupted(harness.target.id).then((started) => started),
        new Promise<"still erasing">((resolve) => setImmediate(() => resolve("still erasing"))),
      ]);

      expect(outcome).toBe(true);
      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("reclaiming");
      expect(harness.claims.claim(harness.target.id)?.kind).toBe("reclaim");

      await new Promise((resolve) => setImmediate(resolve));
      harness.driverClock.advance(30_000);
      await harness.coordinator.settle();

      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
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
      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("shutdown");
    });
  });

  describe("a spent fresh device", () => {
    function spent(record: VirtualDevice): VirtualDevice {
      return { ...record, lastLeaseEndedAt: 900, leaseIdentity: "fresh" };
    }

    async function freshHarness(state: VirtualDevice["state"]) {
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
      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
      expect(
        harness.bus.replay().map((event) => ({ event: event.event, payload: event.payload })),
      ).toEqual([
        {
          event: "device.deleted",
          payload: { deviceId: harness.target.id, initiator: "lease-end", physical: false },
        },
      ]);
      expect(harness.quarantined).toEqual([]);
    });

    it("hands a failed delete to quarantine with strategy delete, after the shutdown commit", async () => {
      const harness = await freshHarness("reclaiming");
      harness.driver.failOn("destroy", 1, new Error("delete exploded"));

      await harness.coordinator.reclaim(released(harness.target));

      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("shutdown");
      expect(harness.quarantined).toEqual([
        {
          attemptedStrategy: "delete",
          deviceId: harness.target.id,
          duration: 0,
          error: "Error: delete exploded",
          kind: "delete-failed",
          leaseId: "lease-1",
        },
      ]);
      expect(harness.bus.replay().map((event) => event.event)).not.toContain("device.deleted");
    });

    it("hands a failed lease-end shutdown to quarantine with strategy delete, without deleting", async () => {
      const harness = await freshHarness("reclaiming");
      harness.driver.failOn("shutdown", 1, new Error("shutdown exploded"));

      await harness.coordinator.reclaim(released(harness.target));

      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("reclaiming");
      expect(harness.operations()).toEqual(["shutdown"]);
      expect(harness.quarantined).toMatchObject([
        { attemptedStrategy: "delete", error: "Error: shutdown exploded", kind: "shutdown-failed" },
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
      expect(registry.snapshot.virtualDevices.map((record) => record.state)).toEqual([
        "deleted",
        "shutdown",
      ]);
    });
  });
});

describe("ReclaimCoordinator for a physical device the platform no longer lists (ADR 0022 §8)", () => {
  const PHYSICAL_ID = "00008110-001A2B3C4D5E";

  async function physicalHarness(
    state: "reclaiming" | "absent",
    options: {
      readonly driver?: FakeDriver;
      readonly drivers?: (driver: FakeDriver) => ReclaimDriverCatalog;
      readonly logger?: Logger;
      readonly realQuarantine?: boolean;
    } = {},
  ) {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const driver =
      options.driver ??
      new FakeDriver({
        clock,
        physicalDevices: [
          { apps: [], ids: [PHYSICAL_ID], model: "iPhone 15 Pro", osVersion: "18.4" },
        ],
        platform: "ios",
        reclaimResult: "ready",
      });
    const filesystem = new MemoryFilesystem();
    await filesystem.writeFileAtomic(
      "/state.json",
      JSON.stringify({
        devices: [],
        leases: [],
        physicalDevices: [
          {
            createdAt: 1,
            driverData: {},
            driverDeviceId: PHYSICAL_ID,
            enrolledApps: [],
            id: "dev_physical",
            lastLeaseEndedAt: 900,
            physical: true,
            spec: {
              class: "phone",
              model: "iPhone 15 Pro",
              osVersion: "18.4",
              physical: true,
              platform: "ios",
            },
            state,
            ...(state === "absent" ? { absentReason: "not-present" } : {}),
          },
        ],
      }),
    );
    const loaded = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator: { generate: () => "id" },
      statePath: "/state.json",
    }).catch((error: unknown) => error);
    expect(loaded, `a state.json holding a physical device in state ${state} loads`).toBeInstanceOf(
      Registry,
    );
    const registry = loaded as Registry;
    const drivers = options.drivers?.(driver) ?? new DriverCatalog([driver]);
    const claims = new DeviceOperationClaims();
    const decisions = new SerializedDecision();
    const notifyAvailability = vi.fn();
    const mockedQuarantine = {
      enter: vi.fn(async (_failure: QuarantinePurgeFailure) => undefined),
    };
    const quarantine: ReclaimQuarantine =
      options.realQuarantine === true
        ? new QuarantineCoordinator({
            claims,
            clock,
            config: {
              maxRetries: 2,
              maxRetryBackoffMs: 5_000,
              retryBackoffMs: 1_000,
              retryBackoffMultiplier: 2,
            },
            decisions,
            drivers,
            eventBus: bus,
            notifyAvailability,
            registry,
          })
        : mockedQuarantine;
    const coordinator = new ReclaimCoordinator({
      claims,
      clock,
      decisions,
      drivers,
      eventBus: bus,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      notifyAvailability,
      quarantine,
      registry,
    });
    const device = () =>
      registry.snapshot.devices.find((candidate) => candidate.id === "dev_physical");
    const events = () => bus.replay().map((event) => event.event);
    return {
      bus,
      claims,
      coordinator,
      decisions,
      device,
      driver,
      events,
      mockedQuarantine,
      registry,
    };
  }

  function releasedPhysical(device: DeviceRecord | undefined): ReleasedLease {
    return {
      device: device as PhysicalDevice,
      lease: {
        deviceId: "dev_physical",
        grantedAt: 1,
        id: "lease-1",
        idChosenByRequester: false,
        lastRenewedAt: 1,
        ownerId: "agent",
        requesterId: "agent",
        ttlDeadline: 100,
        ttlMs: 60_000,
      },
    };
  }

  type ReturnedReclaims = {
    reclaimReturned(
      deviceId: string,
      osVersion?: string,
      proceed?: () => boolean,
    ): Promise<unknown>;
  };

  it("a returned device's reclaim that fails while present enters quarantine with device.quarantined and no device.purge-failed", async () => {
    const harness = await physicalHarness("absent", { realQuarantine: true });
    harness.driver.setPhysicalPresence(PHYSICAL_ID, true, { osVersion: "18.5" });
    harness.driver.failOn("reclaim", 1, new Error("uninstall exploded"));
    const returned = harness.coordinator as unknown as Partial<ReturnedReclaims>;
    expect(returned.reclaimReturned, "ReclaimCoordinator.reclaimReturned").toBeTypeOf("function");

    await returned.reclaimReturned?.(PHYSICAL_ID, "18.5");
    await harness.coordinator.settle();

    expect(harness.driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(1);
    expect(
      harness.driver.calls.filter((call) => call.operation === "listPresentPhysical").length,
    ).toBeGreaterThan(0);
    expect(harness.device()?.state).toBe("quarantined");
    expect(harness.events()).toContain("device.quarantined");
    expect(harness.events()).not.toContain("device.purge-failed");
    expect(harness.events()).not.toContain("device.absence-detected");
    const quarantined = harness.bus.replay().find((event) => event.event === "device.quarantined");
    expect(quarantined?.payload).toMatchObject({ deviceId: "dev_physical" });
    expect(harness.device()).toMatchObject({
      quarantineCause: { kind: "purge-failed", message: "Error: uninstall exploded" },
    });
  });

  it("a physical device's purge that fails while present after its lease is handed to quarantine as purge-failed", async () => {
    const harness = await physicalHarness("reclaiming");
    harness.driver.setPhysicalPresence(PHYSICAL_ID, true);
    harness.driver.failOn("reclaim", 1, new Error("uninstall exploded"));

    await harness.coordinator.reclaim(releasedPhysical(harness.device()));

    expect(harness.mockedQuarantine.enter.mock.calls.map(([failure]) => failure)).toMatchObject([
      { deviceId: "dev_physical", error: "Error: uninstall exploded", kind: "purge-failed" },
    ]);
  });

  it("a failed physical reclaim whose presence read rejects, or whose platform has no driver, commits absent with not-present", async () => {
    const rejected = await physicalHarness("reclaiming");
    rejected.driver.setPhysicalPresence(PHYSICAL_ID, true);
    rejected.driver.failOn("reclaim", 1, new Error("uninstall exploded"));
    rejected.driver.failOn("listPresentPhysical", 1, new Error("link down"));
    let lost = false;
    const withoutDriver = await physicalHarness("reclaiming", {
      drivers: (driver) => ({
        get: (platform) => {
          if (lost) throw new NoDriverError(platform);
          return driver;
        },
      }),
    });
    withoutDriver.driver.setPhysicalPresence(PHYSICAL_ID, true);
    vi.spyOn(withoutDriver.driver, "reclaim").mockImplementation(async () => {
      lost = true;
      throw new Error("uninstall exploded");
    });

    for (const harness of [rejected, withoutDriver]) {
      await harness.coordinator.reclaim(releasedPhysical(harness.device()));

      expect(harness.device()).toMatchObject({ absentReason: "not-present", state: "absent" });
      const absence = harness.bus
        .replay()
        .find((event) => (event.event as string) === "device.absence-detected");
      expect((absence as { payload?: unknown } | undefined)?.payload).toMatchObject({
        absentReason: "not-present",
        deviceId: "dev_physical",
        previousState: "reclaiming",
      });
      expect(harness.events()).not.toContain("device.purge-failed");
      expect(harness.events()).not.toContain("device.quarantined");
      expect(harness.mockedQuarantine.enter).not.toHaveBeenCalled();
    }
  });

  function recordingLogger() {
    const logger: Logger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    return logger;
  }

  it("commits the reason the platform reports for a device it lists as not usable, not not-present", async () => {
    const harness = await physicalHarness("reclaiming");
    harness.driver.setPhysicalPresence(PHYSICAL_ID, false, { reason: "locked" });
    harness.driver.failOn("reclaim", 1, new Error("device is locked"));

    await harness.coordinator.reclaim(releasedPhysical(harness.device()));

    expect(harness.device()).toMatchObject({ absentReason: "locked", state: "absent" });
    const absence = harness.bus.replay().find((event) => event.event === "device.absence-detected");
    expect(absence?.payload).toMatchObject({ absentReason: "locked" });
  });

  it("logs the failed reclaim of an absent device as an error naming the device and the error", async () => {
    const logger = recordingLogger();
    const harness = await physicalHarness("reclaiming", { logger });
    harness.driver.setPhysicalPresence(PHYSICAL_ID, false);
    harness.driver.failOn("reclaim", 1, new Error("uninstall exploded"));

    await harness.coordinator.reclaim(releasedPhysical(harness.device()));

    expect(logger.error).toHaveBeenCalledWith("reclaim of a device that is not present failed", {
      deviceId: "dev_physical",
      error: "Error: uninstall exploded",
    });
  });

  it("logs a presence read that rejects after a failed reclaim as a warning naming the device and the error", async () => {
    const logger = recordingLogger();
    const harness = await physicalHarness("reclaiming", { logger });
    harness.driver.failOn("reclaim", 1, new Error("uninstall exploded"));
    harness.driver.failOn("listPresentPhysical", 1, new Error("link down"));

    await harness.coordinator.reclaim(releasedPhysical(harness.device()));

    expect(logger.warn).toHaveBeenCalledWith("presence read after a failed reclaim failed", {
      deviceId: "dev_physical",
      error: "Error: link down",
    });
  });

  it("a returned device's reclaim whose caller no longer proceeds when the decision runs writes nothing, starts no wipe and leaves no claim", async () => {
    const harness = await physicalHarness("absent");
    harness.driver.setPhysicalPresence(PHYSICAL_ID, true, { osVersion: "18.5" });
    const returned = harness.coordinator as unknown as ReturnedReclaims;

    let proceeding = true;
    let open!: () => void;
    const busy = harness.decisions.run(() => new Promise<void>((resolve) => void (open = resolve)));

    const pending = returned.reclaimReturned(PHYSICAL_ID, "18.5", () => proceeding);
    await Promise.resolve();
    proceeding = false;
    open();
    await busy;
    const started = await pending;

    expect(started).toBeUndefined();
    expect(harness.device()?.state).toBe("absent");
    expect(harness.driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(0);
    expect(harness.claims.isClaimed("dev_physical")).toBe(false);
  });

  it("records the OS version a returned device reports on its record before the wipe", async () => {
    const harness = await physicalHarness("absent");
    harness.driver.setPhysicalPresence(PHYSICAL_ID, true, { osVersion: "18.5" });
    const returned = harness.coordinator as unknown as ReturnedReclaims;
    const original = harness.driver.reclaim.bind(harness.driver);
    const versionsAtWipe: unknown[] = [];
    vi.spyOn(harness.driver, "reclaim").mockImplementationOnce(async (device, options) => {
      versionsAtWipe.push(harness.device()?.spec.osVersion);
      return original(device, options);
    });

    await returned.reclaimReturned(PHYSICAL_ID, "18.5");
    await harness.coordinator.settle();

    expect(versionsAtWipe).toEqual(["18.5"]);
    expect(harness.device()).toMatchObject({
      spec: { osVersion: "18.5" },
      state: "ready",
    });
  });
});

describe("ReclaimCoordinator readiness callback and returned-device reclaims", () => {
  const PHYSICAL_ID = "00008110-001A2B3C4D5E";

  function physicalRecord(state: PhysicalDevice["state"], id = "dev_physical"): PhysicalDevice {
    return {
      createdAt: 1,
      driverData: {},
      driverDeviceId: PHYSICAL_ID,
      enrolledApps: [],
      id,
      lastLeaseEndedAt: 900,
      physical: true,
      spec: {
        class: "phone",
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        physical: true,
        platform: "ios",
      },
      state,
    };
  }

  function lease(deviceId: string): LeaseRecord {
    return released({ ...device("x", "reclaiming", "x", spec), id: deviceId }).lease;
  }

  function physicalDriver() {
    return new FakeDriver({
      clock: new FakeClock(1_000),
      physicalDevices: [
        { apps: [], ids: [PHYSICAL_ID], model: "iPhone 15 Pro", osVersion: "18.4" },
      ],
      platform: "ios",
    });
  }

  function reclaimsOf(driver: FakeDriver) {
    return driver.calls.filter((call) => call.operation === "reclaim");
  }

  it("calls the readiness callback with the ID of a physical device whose reclaim committed ready", async () => {
    const physicalDeviceReady = vi.fn();
    const harness = await createHarness({
      devices: [physicalRecord("reclaiming")],
      driver: physicalDriver(),
      physicalDeviceReady,
    });

    await harness.coordinator.reclaim({
      ...released(harness.reclaiming),
      device: physicalRecord("reclaiming"),
    });

    expect(harness.registry.deviceById("dev_physical")?.state).toBe("ready");
    expect(physicalDeviceReady).toHaveBeenCalledExactlyOnceWith("dev_physical");
  });

  it("does not call the readiness callback for a virtual device reclaimed to ready", async () => {
    const physicalDeviceReady = vi.fn();
    const harness = await createHarness({ physicalDeviceReady });

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.registry.deviceById("reclaiming")?.state).toBe("ready");
    expect(physicalDeviceReady).not.toHaveBeenCalled();
  });

  it("does not call the readiness callback for a physical device whose reclaim committed shutdown", async () => {
    const physicalDeviceReady = vi.fn();
    const driver = physicalDriver();
    vi.spyOn(driver, "reclaim").mockResolvedValue({ state: "shutdown", strategy: "uninstall" });
    const harness = await createHarness({
      devices: [physicalRecord("reclaiming")],
      driver,
      physicalDeviceReady,
    });

    await harness.coordinator.reclaim({
      ...released(harness.reclaiming),
      device: physicalRecord("reclaiming"),
    });

    expect(harness.registry.deviceById("dev_physical")?.state).toBe("shutdown");
    expect(physicalDeviceReady).not.toHaveBeenCalled();
  });

  it("answers undefined to a returned reclaim for an ID that is no physical device, taking no claim", async () => {
    const harness = await createHarness({ driver: physicalDriver() });

    await expect(harness.coordinator.reclaimReturned("nobody")).resolves.toBeUndefined();

    expect(harness.claims.tryClaim("nobody", "reclaim")).toBeDefined();
  });

  it("answers undefined and frees the claim when a returned reclaim finds the device not reclaiming", async () => {
    const driver = physicalDriver();
    const harness = await createHarness({ devices: [physicalRecord("ready")], driver });

    await expect(harness.coordinator.reclaimReturned("dev_physical")).resolves.toBeUndefined();

    expect(reclaimsOf(driver)).toHaveLength(0);
    const again = harness.claims.tryClaim("dev_physical", "reclaim");
    expect(again).toBeDefined();
    again?.release();
  });

  it("wipes a reclaiming device with no lease, found by its driver ID, while a lease of another device does not stop it", async () => {
    const driver = physicalDriver();
    const harness = await createHarness({
      devices: [physicalRecord("reclaiming")],
      driver,
      leases: [lease("other_device")],
    });

    const started = await harness.coordinator.reclaimReturned(PHYSICAL_ID);
    await started?.settled;

    expect(started).toBeDefined();
    expect(reclaimsOf(driver)).toHaveLength(1);
    expect(harness.registry.deviceById("dev_physical")?.state).toBe("ready");
    expect(harness.claims.tryClaim("dev_physical", "reclaim")).toBeDefined();
  });

  it("answers undefined and wipes nothing when a returned reclaim finds the device still leased", async () => {
    const driver = physicalDriver();
    const harness = await createHarness({
      devices: [physicalRecord("reclaiming")],
      driver,
      leases: [lease("dev_physical")],
    });

    await expect(harness.coordinator.reclaimReturned("dev_physical")).resolves.toBeUndefined();

    expect(reclaimsOf(driver)).toHaveLength(0);
    expect(harness.registry.deviceById("dev_physical")?.state).toBe("reclaiming");
  });

  it("answers undefined and commits nothing when a device that reports an OS version is not absent", async () => {
    const driver = physicalDriver();
    const harness = await createHarness({ devices: [physicalRecord("ready")], driver });

    await expect(
      harness.coordinator.reclaimReturned("dev_physical", "18.5"),
    ).resolves.toBeUndefined();

    expect(harness.registry.deviceById("dev_physical")?.state).toBe("ready");
    expect(harness.bus.replay()).toEqual([]);
    expect(reclaimsOf(driver)).toHaveLength(0);
  });

  it("answers undefined and frees the claim when the device record is gone by the time its turn comes", async () => {
    const driver = physicalDriver();
    const harness = await createHarness({ devices: [physicalRecord("absent")], driver });
    let open!: () => void;
    const busy = harness.decisions.run(() => new Promise<void>((resolve) => void (open = resolve)));

    const pending = harness.coordinator.reclaimReturned("dev_physical", "18.5");
    await Promise.resolve();
    harness.registry.remove("dev_physical");
    open();
    await busy;

    await expect(pending).resolves.toBeUndefined();
    expect(harness.claims.tryClaim("dev_physical", "reclaim")).toBeDefined();
  });
});
