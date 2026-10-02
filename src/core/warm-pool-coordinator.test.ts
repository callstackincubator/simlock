import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  FakeClock,
  FakeSystemStats,
  JsonLinesLogger,
  type Logger,
  MemoryLogSink,
} from "../ports/index.js";
import { CapacityCoordinator, capacityDevices, createCapacityStrategy } from "./capacity/index.js";
import { resourceStrategy } from "./capacity/strategies/resource/index.js";
import type { Config } from "./config.js";
import type { DeviceRecord, DeviceSpec, DeviceTransitionUpdate, LeaseRecord } from "./domain.js";
import { FakeDriver } from "./fake-driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { QuarantinePurgeFailure } from "./quarantine-coordinator.js";
import type { ReleasedLease } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import {
  WarmPoolCoordinator,
  type WarmPoolQuarantine,
  type WarmPoolRegistry,
} from "./warm-pool-coordinator.js";

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
  ios: { defaultMode: "full", slim: { bootTimeoutMs: 600_000 } },
  android: { emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true } },
  idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
  warmPool: {
    quarantine: {
      maxRetries: 3,
      maxRetryBackoffMs: 300_000,
      retryBackoffMs: 30_000,
      retryBackoffMultiplier: 2,
    },
  },
  lease: {
    defaultTtlMs: 100,
    maxTtlMs: 100,
    identity: { ios: "reusable", android: "reusable" },
    requestRetentionMs: 600_000,
    maxRequestRecords: 10_000,
  },
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
  eventLog: { rotateBytes: 5 * 1024 * 1024 },
};

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
    to: Parameters<WarmPoolRegistry["transitionDevice"]>[1],
    event: Parameters<WarmPoolRegistry["transitionDevice"]>[2],
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
    readonly capacity?: CapacityCoordinator;
    readonly devices?: readonly DeviceRecord[];
    readonly driver?: FakeDriver;
    readonly headSpec?: DeviceSpec;
    readonly leases?: readonly LeaseRecord[];
    readonly logger?: Logger;
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
    capacity: options.capacity ?? capacity(),
    clock,
    decisions: new SerializedDecision(),
    drivers: new DriverCatalog([driver]),
    eventBus: bus,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
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

  it("stores the driver's mode when a warm re-boot slims the device", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      clock,
      mode: "slim",
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    expect(harness.registry.lastUpdate).toMatchObject({ mode: "slim" });
    expect(harness.registry.snapshot.devices[0]).toMatchObject({ mode: "slim" });
  });

  it.each([
    ["a slim spec", { ...spec, mode: "slim" as const }, "slim"],
    ["a full spec", spec, "full"],
  ] as const)(
    "passes %s's mode to makeReady on a warm re-boot",
    async (_label, deviceSpec, mode) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "shutdown" });
      const reclaiming = device(
        "reclaiming",
        "reclaiming",
        (await driver.provision(deviceSpec)).deviceId,
        deviceSpec,
      );
      const harness = await createHarness({ devices: [reclaiming], driver });

      await harness.coordinator.reclaim(released(reclaiming));

      const boot = driver.calls.filter((call) => call.operation === "makeReady").at(-1);
      expect(boot?.arguments[1]).toEqual({ mode, purpose: "prepare" });
    },
  );

  describe("a reclaimed slim device that needs a boot to stay warm", () => {
    const slimSpec: DeviceSpec = { ...spec, mode: "slim" };

    /** 12 GiB of RAM: an 8 GiB budget. Full iOS devices take 3 GiB, slim ones 1 GiB. */
    function sizedCapacity(): CapacityCoordinator {
      return new CapacityCoordinator(
        resourceStrategy.create(
          {
            limits: {
              android: { maxDevices: 8, maxRunning: 8 },
              ios: { maxDevices: 8, maxRunning: 8 },
              maxRunning: 16,
            },
            ramBudget: {
              androidBytesPerDevice: 4 * gibibyte,
              iosBytesPerDevice: 3 * gibibyte,
              iosSlimBytesPerDevice: gibibyte,
            },
          },
          new FakeSystemStats({
            cpuCount: 8,
            freeRamBytes: 12 * gibibyte,
            totalRamBytes: 12 * gibibyte,
          }),
        ),
      );
    }

    async function reclaimBeside(
      fullDevices: number,
      reclaimResult: "ready" | "shutdown" = "shutdown",
    ) {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({
        clock,
        mode: "slim",
        platform: "ios",
        reclaimResult,
      });
      const reclaiming = {
        ...device(
          "reclaiming",
          "reclaiming",
          (await driver.provision(slimSpec)).deviceId,
          slimSpec,
        ),
        mode: "slim" as const,
      };
      const others = Array.from({ length: fullDevices }, (_, index) =>
        device(`full-${index}`, "leased", `full-driver-${index}`, { ...spec, model: "iPhone SE" }),
      );
      const capacity = sizedCapacity();
      const harness = await createHarness({ capacity, devices: [reclaiming, ...others], driver });
      await harness.coordinator.reclaim(released(reclaiming));
      return { capacity, driver, harness };
    }

    it("stays shut down, without a boot, when its full size does not fit", async () => {
      // 7 GiB used of 8: the boot adds the 2 GiB between the slim and the full size.
      const { driver, harness } = await reclaimBeside(2);

      expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
      expect(driver.calls.map((call) => call.operation)).not.toContain("makeReady");
    });

    it("stays warm when its reclaim left it running, even where a boot would not fit", async () => {
      // 7 GiB used of 8, as above, but nothing needs to boot.
      const { driver, harness } = await reclaimBeside(2, "ready");

      expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
      expect(driver.calls.map((call) => call.operation)).not.toContain("shutdown");
    });

    it("boots back to warm when its full size fits, and frees the boot's extra size after", async () => {
      // 4 GiB used of 8: the boot reaches 6.
      const { capacity, driver, harness } = await reclaimBeside(1);

      expect(harness.registry.snapshot.devices[0]).toMatchObject({ mode: "slim", state: "ready" });
      expect(driver.calls.map((call) => call.operation)).toContain("makeReady");
      // Back at 4 GiB: a new device's 3 GiB fits. Were the 2 GiB still held, it would not.
      expect(
        capacity.tryReserveProvisioning(
          { mode: "full", platform: "ios" },
          capacityDevices(harness.registry.snapshot.devices),
        ),
      ).toMatchObject({ ok: true });
    });
  });

  it("stores full, replacing a stored slim, when a warm re-boot's makeReady reports no mode", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "shutdown" });
    const staleReclaiming = {
      ...device("reclaiming", "reclaiming", (await driver.provision(spec)).deviceId, spec),
      mode: "slim" as const,
    };
    const harness = await createHarness({ devices: [staleReclaiming], driver });

    await harness.coordinator.reclaim(released(staleReclaiming));

    expect(harness.registry.lastUpdate).toHaveProperty("mode", "full");
    expect(harness.registry.snapshot.devices[0]?.mode).toBe("full");
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

  it("A reclaimed device that fails to shut down logs the error.", async () => {
    const sink = new MemoryLogSink();
    // A different queue head cannot reserve capacity, so the reclaimed ready device is shut down.
    const harness = await createHarness({
      headSpec: { model: "Pixel 9", osVersion: "36", platform: "android" },
      logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }),
    });
    harness.driver.failOn("shutdown", 1, new Error("shutdown wedged"));

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        module: "daemon.warm-pool-coordinator",
        fields: {
          deviceId: harness.reclaiming.id,
          error: "Error: shutdown wedged",
          leaseId: "lease-1",
          step: "shutdown",
        },
      }),
    ]);
  });

  it("A reclaimed device that fails to become ready logs the error.", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "shutdown" });
    driver.failOn("makeReady", 1, new Error("boot wedged"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({ driver, logger: new JsonLinesLogger({ clock, sink }) });

    await harness.coordinator.reclaim(released(harness.reclaiming));

    expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          deviceId: harness.reclaiming.id,
          error: "Error: boot wedged",
          leaseId: "lease-1",
          step: "make-ready",
        },
      }),
    ]);
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
      const coordinator = new WarmPoolCoordinator({
        capacity: capacity(),
        clock: harness.clock,
        decisions: new SerializedDecision(),
        drivers: new DriverCatalog([harness.driver]),
        eventBus: harness.bus,
        notifyAvailability: harness.notifyAvailability,
        quarantine: harness.quarantine,
        queueHeadDemand: () => undefined,
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
