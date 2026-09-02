import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats } from "../ports/index.js";
import { CapacityCoordinator, createCapacityStrategy } from "./capacity/index.js";
import type { Config } from "./config.js";
import type { DeviceRecord, DeviceSpec, LeaseRecord } from "./domain.js";
import { FakeDriver } from "./fake-driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { QuarantinePurgeFailure } from "./quarantine-coordinator.js";
import type { ReleasedLease } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import { WarmPoolCoordinator, type WarmPoolQuarantine } from "./warm-pool-coordinator.js";

const gibibyte = 1024 ** 3;
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const config: Config = {
  diskPressure: { freeBytesThreshold: 10 * gibibyte },
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
  idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
  warmPool: {
    quarantine: {
      maxRetries: 3,
      maxRetryBackoffMs: 300_000,
      retryBackoffMs: 30_000,
      retryBackoffMultiplier: 2,
    },
  },
  lease: { detachedTtlMs: 100, heldTtlBackstopMs: 100, heartbeatIntervalMs: 25 },
  capacity: {
    strategy: "resource",
    config: {
      limits: {
        android: { maxDevices: 2, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
      ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    },
  },
  log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
};

class TestRegistry {
  #devices: DeviceRecord[];

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
    to: "ready" | "shutdown",
    event: {
      readonly event: "device.reclaimed";
      readonly payload: {
        readonly deviceId: string;
        readonly duration: number;
        readonly strategy: "erase" | "snapshot" | "wipe";
      };
    },
  ): Promise<DeviceRecord> {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    const current = this.#devices[index];
    if (index === -1 || current === undefined) throw new Error("missing device");
    const updated = { ...current, state: to } as DeviceRecord;
    this.#devices[index] = updated;
    this.eventBus.emit("device.reclaimed", event.payload, "test-registry");
    return updated;
  }

  async completeInterruptedReclaim(deviceId: string): Promise<DeviceRecord> {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    const current = this.#devices[index];
    if (index === -1 || current === undefined) throw new Error("missing device");
    const updated = { ...current, state: "shutdown" } as DeviceRecord;
    this.#devices[index] = updated;
    return updated;
  }
}

function capacity(): CapacityCoordinator {
  return new CapacityCoordinator(
    createCapacityStrategy(
      config.capacity,
      new FakeSystemStats({
        cpuCount: 8,
        freeRamBytes: 32 * gibibyte,
        totalRamBytes: 32 * gibibyte,
      }),
    ),
  );
}

async function createHarness(
  options: {
    readonly devices?: readonly DeviceRecord[];
    readonly driver?: FakeDriver;
    readonly headSpec?: DeviceSpec;
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
  const quarantine: WarmPoolQuarantine = {
    enter: vi.fn(async (failure) => void quarantined.push(failure)),
  };
  const coordinator = new WarmPoolCoordinator({
    capacity: capacity(),
    clock,
    decisions: new SerializedDecision(),
    drivers: new DriverCatalog([driver]),
    eventBus: bus,
    notifyAvailability,
    quarantine,
    queueHeadDemand: () =>
      options.headSpec === undefined ? undefined : { spec: options.headSpec },
    registry,
  });
  return {
    bus,
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
  return { createdAt: 1, driverData: {}, driverDeviceId, id, spec: deviceSpec, state };
}

function released(device: DeviceRecord): ReleasedLease {
  return {
    device,
    lease: {
      deviceId: device.id,
      grantedAt: 1,
      id: "lease-1",
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 100,
    },
  };
}

describe("WarmPoolCoordinator", () => {
  it("retains a reclaimed ready device when capacity permits", async () => {
    const harness = await createHarness();

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("shutdown");
    expect(harness.bus.replay().map((event) => event.event)).toEqual(["device.reclaimed"]);
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  it("shuts a reclaimed ready device down when running capacity is exceeded", async () => {
    const harness = await createHarness();
    const extra = device("extra", "ready", "extra-driver", { ...spec, model: "iPhone SE" });
    const overloaded = new TestRegistry([harness.reclaiming, extra], [], harness.bus);
    const coordinator = new WarmPoolCoordinator({
      capacity: capacity(),
      clock: harness.clock,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([harness.driver]),
      eventBus: harness.bus,
      notifyAvailability: harness.notifyAvailability,
      quarantine: harness.quarantine,
      queueHeadDemand: () => undefined,
      registry: overloaded,
    });

    await coordinator.reclaim(released(harness.reclaiming));

    expect(
      overloaded.snapshot.devices.find((device) => device.id === harness.reclaiming.id)?.state,
    ).toBe("shutdown");
    expect(harness.driver.calls.map((call) => call.operation)).toContain("shutdown");
  });

  it("does not retain a warm device when a different queue head cannot reserve capacity", async () => {
    const harness = await createHarness({
      headSpec: { model: "Pixel 9", osVersion: "36", platform: "android" },
    });

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
  });

  it("boots a shutdown reclaim result when warm retention is allowed", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "shutdown" });
    const harness = await createHarness({ driver });

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    expect(harness.driver.calls.map((call) => call.operation)).toContain("makeReady");
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
});
