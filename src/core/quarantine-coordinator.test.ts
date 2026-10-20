import { describe, expect, it, vi } from "vitest";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import {
  FakeClock,
  FakeSystemStats,
  JsonLinesLogger,
  type Logger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { VirtualDevice, VirtualSpec } from "./domain.js";
import { type FakePhysicalDevice } from "./fake-driver.js";
import { FakeDriver, loadTestRegistry, openTestState, testComponentWiring } from "./testing.js";
import { createCore, loadConfig } from "./index.js";
import {
  QuarantineCoordinator,
  type QuarantineRegistry,
  type QuarantineRetryConfig,
} from "./quarantine-coordinator.js";
import type { PhysicalDevice } from "./domain.js";
import { SerializedDecision } from "./serialized-decision.js";

const spec: VirtualSpec = {
  physical: false,
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
};

const retryConfig: QuarantineRetryConfig = {
  maxRetries: 2,
  retryBackoffMs: 1_000,
  retryBackoffMultiplier: 2,
  maxRetryBackoffMs: 5_000,
};

class FakeRegistry implements QuarantineRegistry {
  #devices: VirtualDevice[];
  readonly deletions: string[] = [];

  constructor(devices: readonly VirtualDevice[]) {
    this.#devices = [...devices];
  }

  get snapshot(): {
    readonly devices: readonly VirtualDevice[];
    readonly virtualDevices: readonly VirtualDevice[];
  } {
    const copies = this.#devices.map((device) => ({ ...device }));
    return { devices: copies, virtualDevices: copies };
  }

  async enterQuarantine(deviceId: string, nextRetryAt: number): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => ({
      ...device,
      quarantineAttempts: 0,
      quarantineNextRetryAt: nextRetryAt,
      state: "quarantined",
    }));
  }

  async recordQuarantineRetryFailure(
    deviceId: string,
    attempts: number,
    nextRetryAt: number,
  ): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => ({
      ...device,
      quarantineAttempts: attempts,
      quarantineNextRetryAt: nextRetryAt,
    }));
  }

  async strandQuarantine(deviceId: string, attempts: number): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => {
      const { quarantineNextRetryAt: _quarantineNextRetryAt, ...rest } = device;
      return { ...rest, quarantineAttempts: attempts };
    });
  }

  async recoverFromQuarantine(deviceId: string, to: "ready" | "shutdown"): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => {
      const {
        quarantineAttempts: _quarantineAttempts,
        quarantineNextRetryAt: _quarantineNextRetryAt,
        quarantinedAt: _quarantinedAt,
        ...rest
      } = device;
      return { ...rest, state: to };
    });
  }

  async deleteQuarantined(deviceId: string, initiator: string): Promise<VirtualDevice> {
    this.deletions.push(initiator);
    return this.#update(deviceId, (device) => {
      const {
        quarantineAttempts: _quarantineAttempts,
        quarantineNextRetryAt: _quarantineNextRetryAt,
        quarantinedAt: _quarantinedAt,
        ...rest
      } = device;
      return { ...rest, state: "deleted" };
    });
  }

  /** Test-only escape hatch to simulate a device leaving quarantine out of band. */
  forceState(deviceId: string, state: VirtualDevice["state"]): void {
    this.#update(deviceId, (device) => ({ ...device, state }));
  }

  #update(deviceId: string, apply: (device: VirtualDevice) => VirtualDevice): VirtualDevice {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    const current = this.#devices[index];
    if (index === -1 || current === undefined) throw new Error(`missing device: ${deviceId}`);
    const updated = apply(current);
    this.#devices[index] = updated;
    return { ...updated };
  }
}

function device(id: string, driverDeviceId: string): VirtualDevice {
  return {
    physical: false,
    createdAt: 1,
    driverData: {},
    driverDeviceId,
    id,
    mode: "full",
    spec,
    state: "quarantined",
  };
}

async function createHarness(
  options: {
    readonly clock?: FakeClock;
    readonly config?: QuarantineRetryConfig;
    readonly driver?: FakeDriver;
    readonly logger?: Logger;
    readonly others?: readonly VirtualDevice[];
    readonly physicalDeviceReady?: (deviceId: string) => void;
    readonly target?: Pick<VirtualDevice, "lastLeaseEndedAt" | "leaseIdentity"> & {
      readonly state?: VirtualDevice["state"];
    };
  } = {},
) {
  const clock = options.clock ?? new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver = options.driver ?? new FakeDriver({ clock, platform: "ios" });
  const driverDevice = await driver.provision(spec);
  const target = { ...device("dev_1", driverDevice.deviceId), ...options.target };
  const registry = new FakeRegistry([...(options.others ?? []), target]);
  const notifyAvailability = vi.fn();
  const claims = new DeviceOperationClaims();
  const coordinator = new QuarantineCoordinator({
    claims,
    clock,
    config: options.config ?? retryConfig,
    decisions: new SerializedDecision(),
    drivers: new DriverCatalog([driver]),
    eventBus: bus,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    notifyAvailability,
    ...(options.physicalDeviceReady === undefined
      ? {}
      : { physicalDeviceReady: options.physicalDeviceReady }),
    registry,
  });
  return { bus, claims, clock, coordinator, driver, notifyAvailability, registry, target };
}

function eventsOf(bus: EventBus): readonly EventEnvelope[] {
  return bus.replay();
}

describe("QuarantineCoordinator", () => {
  it("commits quarantine entry, emits purge-failed and quarantined, and does not wake availability", async () => {
    const harness = await createHarness();
    // enter() starts from "reclaiming" in the real flow; the fake registry only
    // needs a device row to update, so the pre-quarantine state is irrelevant here.

    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      kind: "purge-failed",
      deviceId: harness.target.id,
      duration: 40,
      error: "Error: purge exploded",
      leaseId: "lease-1",
    });

    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 2_000,
      state: "quarantined",
    });
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
    ]);
    expect(eventsOf(harness.bus)[1]).toMatchObject({
      payload: { deviceId: harness.target.id, maxRetries: 2, nextRetryAt: 2_000 },
    });
    expect(eventsOf(harness.bus).map((event) => event.module)).toEqual([
      "quarantine-coordinator",
      "quarantine-coordinator",
    ]);
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("hands the driver's retried reclaim a device marked virtual", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const harness = await createHarness({
      clock,
      driver,
      target: { state: "provisioning" as const },
    });

    await harness.coordinator.enterFromStalledTransition(harness.target.id, "provisioning");
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    const reclaims = driver.calls.filter((call) => call.operation === "reclaim");
    expect(reclaims.map((call) => call.arguments[0])).toEqual([
      expect.objectContaining({ physical: false }),
    ]);
  });

  it("a virtual device's recovery from quarantine does not tell the physical-ready port", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const physicalDeviceReady = vi.fn();
    const harness = await createHarness({
      clock,
      driver,
      physicalDeviceReady,
      target: { state: "provisioning" as const },
    });

    await harness.coordinator.enterFromStalledTransition(harness.target.id, "provisioning");
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
    expect(physicalDeviceReady).not.toHaveBeenCalled();
  });

  it("commits stalled-transition quarantine entry, emits only quarantined (no device.purge-failed), and does not wake availability", async () => {
    const harness = await createHarness({ target: { state: "provisioning" as const } });

    await harness.coordinator.enterFromStalledTransition(harness.target.id, "provisioning");

    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 2_000,
      state: "quarantined",
    });
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual(["device.quarantined"]);
    expect(eventsOf(harness.bus)[0]).toMatchObject({
      payload: { deviceId: harness.target.id, maxRetries: 2, nextRetryAt: 2_000 },
    });
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("retries and gives up on a stalled-transition entry exactly like a purge-failure one", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const harness = await createHarness({
      clock,
      driver,
      target: { state: "provisioning" as const },
    });

    await harness.coordinator.enterFromStalledTransition(harness.target.id, "provisioning");
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.quarantined",
      "device.quarantine-recovered",
    ]);
    expect(harness.notifyAvailability).toHaveBeenCalledTimes(1);
  });

  it("recovers on a successful retry, rejoins the pool, and wakes availability", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const harness = await createHarness({ clock, driver });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      kind: "purge-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
    expect(harness.registry.snapshot.virtualDevices[0]?.quarantineAttempts).toBeUndefined();
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
      "device.quarantine-recovered",
    ]);
    expect(eventsOf(harness.bus)[2]).toMatchObject({
      payload: { attempts: 1, deviceId: harness.target.id },
    });
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  it("emits device.quarantine-recovered for a virtual device without a missingApps field", async () => {
    const harness = await createHarness();
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      kind: "purge-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    const payload = eventsOf(harness.bus)[2]?.payload as object;
    expect("missingApps" in payload).toBe(false);
  });

  it("grows the backoff after each failed retry, capped at maxRetryBackoffMs, then gives up and destroys", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    // Calls: 1 = the initial purge (handled by the caller, not exercised here),
    // so reclaim() calls from the coordinator start at call #1 for this fresh device.
    driver.failOn("reclaim", 1, new Error("still stuck"));
    driver.failOn("reclaim", 2, new Error("still stuck"));
    const harness = await createHarness({ clock, config: retryConfig, driver });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      kind: "purge-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 1,
      quarantineNextRetryAt: 4_000,
      state: "quarantined",
    });

    // Second retry (attempt 2) fails and hits maxRetries: give up and destroy.
    harness.clock.advance(2_000);
    await flush();

    expect(harness.driver.calls.map((call) => call.operation)).toContain("destroy");
    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
    expect(harness.registry.deletions).toEqual(["quarantine-coordinator"]);
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
      "device.quarantine-abandoned",
    ]);
    expect(eventsOf(harness.bus)[2]).toMatchObject({
      payload: { attempts: 2, deviceId: harness.target.id },
    });
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  it("strands a device whose give-up destroy also fails, rather than losing it silently", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("still stuck"));
    driver.failOn("reclaim", 2, new Error("still stuck"));
    driver.failOn("destroy", 1, new Error("destroy blew up"));
    const harness = await createHarness({ clock, config: retryConfig, driver });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      kind: "purge-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    harness.clock.advance(2_000);
    await flush();

    // Still quarantined: not grantable, still counted against capacity, and no further retry --
    // a terminal state an operator has to clear, which is exactly why it is worth a fact.
    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 2,
      state: "quarantined",
    });
    // Nothing is armed any more, so the record must not advertise a retry deadline.
    expect(harness.registry.snapshot.virtualDevices[0]?.quarantineNextRetryAt).toBeUndefined();
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
      "device.quarantine-stranded",
    ]);
    expect(eventsOf(harness.bus)[2]).toMatchObject({
      payload: { attempts: 2, deviceId: harness.target.id, error: "Error: destroy blew up" },
    });
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("retries a spent fresh device's delete rather than an erase, and a successful retry reaches deleted, never ready", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const harness = await createHarness({
      clock,
      driver,
      target: { lastLeaseEndedAt: 900, leaseIdentity: "fresh" },
    });
    await harness.coordinator.enter({
      attemptedStrategy: "delete",
      kind: "delete-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "Error: delete exploded",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    const operations = harness.driver.calls.map((call) => call.operation);
    expect(operations).toContain("destroy");
    expect(operations).not.toContain("reclaim");
    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
    expect(harness.registry.deletions).toEqual(["lease-end"]);
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
    ]);
    expect(eventsOf(harness.bus)[0]).toMatchObject({ payload: { attemptedStrategy: "delete" } });
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  it("keeps a spent fresh device quarantined and re-arms when its retried delete fails", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    driver.failOn("destroy", 1, new Error("still stuck"));
    const harness = await createHarness({
      clock,
      driver,
      target: { lastLeaseEndedAt: 900, leaseIdentity: "fresh" },
    });
    await harness.coordinator.enter({
      attemptedStrategy: "delete",
      kind: "delete-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 1,
      state: "quarantined",
    });
    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("reclaim");
  });

  it("A failed quarantine reclaim retry logs the error and the attempt number.", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("erase still stuck"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      clock,
      driver,
      logger: new JsonLinesLogger({ clock, sink }),
    });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      kind: "purge-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        module: "daemon.quarantine-coordinator",
        fields: {
          attempts: 1,
          deviceId: harness.target.id,
          error: "Error: erase still stuck",
          step: "reclaim",
        },
      }),
    ]);
  });

  it("a quarantine retry that itself throws logs at error with the device id", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("erase still stuck"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      clock,
      driver,
      logger: new JsonLinesLogger({ clock, sink }),
    });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      kind: "purge-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });
    vi.spyOn(harness.registry, "recordQuarantineRetryFailure").mockRejectedValue(
      new Error("state unwritable"),
    );

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(sink.records.filter((record) => record.level === "error")).toEqual([
      expect.objectContaining({
        module: "daemon.quarantine-coordinator",
        fields: {
          deviceId: harness.target.id,
          error: "Error: state unwritable",
          step: "retry",
        },
      }),
    ]);
  });

  it("A failed quarantine delete retry logs the error and the attempt number.", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("destroy", 1, new Error("delete still stuck"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      clock,
      driver,
      logger: new JsonLinesLogger({ clock, sink }),
      target: { lastLeaseEndedAt: 900, leaseIdentity: "fresh" },
    });
    await harness.coordinator.enter({
      attemptedStrategy: "delete",
      kind: "delete-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          attempts: 1,
          deviceId: harness.target.id,
          error: "Error: delete still stuck",
          step: "delete",
        },
      }),
    ]);
  });

  it("never touches a device that left quarantine before its retry timer fires", async () => {
    const harness = await createHarness();
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      kind: "purge-failed",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    // Simulate the device having been leased/recovered out of band by the time the
    // timer fires -- this is exactly the guard that keeps a leased device untouched.
    harness.registry.forceState(harness.target.id, "leased");
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("reclaim");
    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("leased");
  });

  it("restores retry timers for devices still quarantined at startup", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const driverDevice = await driver.provision(spec);
    const registry = new FakeRegistry([
      {
        ...device("dev_restored", driverDevice.deviceId),
        quarantineAttempts: 1,
        quarantineNextRetryAt: 3_000,
      },
    ]);
    const notifyAvailability = vi.fn();
    const bus = new EventBus(clock);
    const coordinator = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: retryConfig,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus: bus,
      notifyAvailability,
      registry,
    });

    coordinator.restore();
    clock.advance(2_000); // now = 3_000, exactly the persisted deadline
    await flush();

    expect(registry.snapshot.virtualDevices[0]?.state).toBe("ready");
    expect(notifyAvailability).toHaveBeenCalledOnce();
  });

  it("arms no retry for a quarantined device the include filter leaves out, even one already due", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const driverDevice = await driver.provision(spec);
    const registry = new FakeRegistry([
      {
        ...device("dev_left_out", driverDevice.deviceId),
        quarantineAttempts: 1,
        quarantineNextRetryAt: 500,
      },
    ]);
    const coordinator = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: retryConfig,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus: new EventBus(clock),
      notifyAvailability: vi.fn(),
      registry,
    });

    coordinator.restore(() => false);
    clock.advance(10_000);
    await flush();

    expect(driver.calls.map((call) => call.operation)).not.toContain("reclaim");
    expect(registry.snapshot.virtualDevices[0]?.state).toBe("quarantined");
  });

  it("arms no retry timer for a device that is not quarantined", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const driverDevice = await driver.provision(spec);
    const registry = new FakeRegistry([
      { ...device("dev_ready", driverDevice.deviceId), state: "ready", quarantineNextRetryAt: 500 },
    ]);
    const coordinator = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: retryConfig,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus: new EventBus(clock),
      notifyAvailability: vi.fn(),
      registry,
    });

    coordinator.restore();

    expect(clock.pendingTimerCount).toBe(0);
  });
});

/** Lets the microtask queue (the fire-and-forget retry chain) settle after a timer fires. */
async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) await Promise.resolve();
}

describe("QuarantineCoordinator for a physical device (ADR 0022 §4)", () => {
  const physicalRecord = { driverDeviceId: "00008110-001A2B3C4D5E" };

  async function physicalHarness(stateName: "reclaiming" | "quarantined") {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    driver.setPhysicalPresence(physicalRecord.driverDeviceId, true);
    const state = await openTestState();
    const seeding = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "physical" },
      state,
    });
    await seeding.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: physicalRecord.driverDeviceId,
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    state.database
      .prepare(
        "UPDATE devices SET created_at = 600, last_lease_ended_at = 700, ready_at = NULL, state = ?, quarantine_next_retry_at = 1500",
      )
      .run(stateName);
    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator: { generate: () => "id" },
      state,
    });
    // `decisionRuns` counts this device's own retry, which the shared clock's timer count does not.
    const decisions = new SerializedDecision();
    const decisionRuns = vi.spyOn(decisions, "run");
    const notifyAvailability = vi.fn();
    const coordinator = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: retryConfig,
      decisions,
      drivers: new DriverCatalog([driver]),
      eventBus: bus,
      notifyAvailability,
      registry,
    });
    const driverCalls = vi.spyOn(driver, "reclaim");
    return {
      bus,
      clock,
      coordinator,
      decisionRuns,
      driver,
      driverCalls,
      notifyAvailability,
      registry,
    };
  }

  it("commits quarantined for a stalled physical device and arms a retry that reclaims it when nextRetryAt falls due", async () => {
    const harness = await physicalHarness("reclaiming");

    await harness.coordinator.enterFromStalledTransition("dev_physical", "reclaiming");
    expect(harness.driverCalls).not.toHaveBeenCalled();
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.driverCalls).toHaveBeenCalledTimes(1);
    expect(harness.driverCalls.mock.calls[0]?.[0]).toMatchObject({
      deviceId: "00008110-001A2B3C4D5E",
      physical: true,
    });
    expect(eventsOf(harness.bus).map((event) => event.event)[0]).toBe("device.quarantined");
    expect(eventsOf(harness.bus)[0]?.payload).toMatchObject({ nextRetryAt: 2_000 });
  });

  it("arms a retry for a physical device quarantined by a purge failure either", async () => {
    const harness = await physicalHarness("reclaiming");

    await harness.coordinator.enter({
      attemptedStrategy: "uninstall",
      kind: "purge-failed",
      deviceId: "dev_physical",
      duration: 5,
      error: "Error: uninstall failed",
      leaseId: "lse_1",
    });
    expect(harness.driverCalls).not.toHaveBeenCalled();
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.driverCalls).toHaveBeenCalledTimes(1);
  });

  it("recovers a physical device on a successful retry with the uninstall strategy and its missing apps", async () => {
    const harness = await physicalHarness("quarantined");

    harness.coordinator.restore();
    harness.clock.advance(500);
    await flush();

    const recovered = eventsOf(harness.bus).find(
      (event) => event.event === "device.quarantine-recovered",
    );
    expect(recovered?.payload).toMatchObject({
      attempts: 1,
      deviceId: "dev_physical",
      missingApps: [],
      strategy: "uninstall",
    });
  });

  it("unenrols a physical device whose retries run out, and never destroys it", async () => {
    const harness = await physicalHarness("quarantined");
    harness.driver.failOn("reclaim", 1, new Error("still stuck"));
    harness.driver.failOn("reclaim", 2, new Error("still stuck"));

    harness.coordinator.restore();
    harness.clock.advance(500);
    await flush();
    harness.clock.advance(2_000);
    await flush();

    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("destroy");
    const events = eventsOf(harness.bus);
    expect(events.map((event) => event.event)).toEqual([
      "device.deleted",
      "device.quarantine-abandoned",
    ]);
    expect(events[0]?.payload).toMatchObject({
      deviceId: "dev_physical",
      initiator: "quarantine",
      physical: true,
    });
    expect(events[1]?.payload).toEqual({ attempts: 2, deviceId: "dev_physical", platform: "ios" });
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  it("arms a timer for a quarantined physical device when it restores, and reclaims it when quarantineNextRetryAt falls due", async () => {
    const harness = await physicalHarness("quarantined");

    harness.coordinator.restore();
    expect(harness.driverCalls).not.toHaveBeenCalled();
    harness.clock.advance(500);
    await flush();

    expect(harness.driverCalls).toHaveBeenCalledTimes(1);
  });
});

describe("QuarantineCoordinator retry claim (ADR 0022 §2)", () => {
  async function stalled(options: Parameters<typeof createHarness>[0] = {}) {
    const clock = options.clock ?? new FakeClock(1_000);
    const harness = await createHarness({
      ...options,
      clock,
      target: { ...options.target, state: "provisioning" as const },
    });
    await harness.coordinator.enterFromStalledTransition(harness.target.id, "provisioning");
    return harness;
  }

  it("makes no driver call and keeps its attempt count when its claim is held, then runs one retryBackoffMs later", async () => {
    const harness = await stalled();
    const held = harness.claims.tryClaim(harness.target.id, "enrollment");

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.driver.calls.filter((call) => call.operation === "reclaim")).toEqual([]);
    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 0,
      state: "quarantined",
    });
    held?.release();
    harness.clock.advance(retryConfig.retryBackoffMs - 1);
    await flush();
    expect(harness.driver.calls.filter((call) => call.operation === "reclaim")).toEqual([]);
    harness.clock.advance(1);
    await flush();

    expect(harness.driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(1);
    expect(eventsOf(harness.bus).at(-1)).toMatchObject({
      event: "device.quarantine-recovered",
      payload: { attempts: 1 },
    });
  });

  it.each([
    ["succeeds", false],
    ["throws", true],
  ] as const)(
    "holds the reclaim claim while the driver's reclaim runs, and frees it after the call %s",
    async (_case, throws) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
      if (throws) driver.failOn("reclaim", 1, new Error("still stuck"));
      const harness = await stalled({ clock, driver });
      const original = driver.reclaim.bind(driver);
      const duringCall: unknown[] = [];
      vi.spyOn(driver, "reclaim").mockImplementation(async (device, options) => {
        duringCall.push(harness.claims.operationFor(harness.target.id));
        return original(device, options);
      });

      harness.clock.advance(retryConfig.retryBackoffMs);
      await flush();

      expect(duringCall).toEqual(["reclaim"]);
      expect(harness.claims.isClaimed(harness.target.id)).toBe(false);
      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe(
        throws ? "quarantined" : "ready",
      );
    },
  );

  it("has freed the claim before it emits and before it wakes availability when a retry recovers the device", async () => {
    const harness = await stalled({});
    const claimedAt: boolean[] = [];
    const sees = () => claimedAt.push(harness.claims.isClaimed(harness.target.id));
    harness.bus.subscribe("device.quarantine-recovered", sees);
    harness.notifyAvailability.mockImplementation(sees);

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.notifyAvailability).toHaveBeenCalledTimes(1);
    expect(claimedAt).toEqual([false, false]);
  });

  it("has freed the claim before it wakes availability when a retry deletes a spent fresh device", async () => {
    const harness = await stalled({ target: { lastLeaseEndedAt: 900, leaseIdentity: "fresh" } });
    const claimedAt: boolean[] = [];
    harness.notifyAvailability.mockImplementation(() =>
      claimedAt.push(harness.claims.isClaimed(harness.target.id)),
    );

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices.map((device) => device.state)).toEqual([
      "deleted",
    ]);
    expect(claimedAt).toEqual([false]);
  });

  it("has freed the claim before it emits device.quarantine-abandoned and before it wakes availability when a retry gives up", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("still stuck"));
    driver.failOn("reclaim", 2, new Error("still stuck"));
    const harness = await stalled({ clock, driver });
    const claimedAt: boolean[] = [];
    const sees = () => claimedAt.push(harness.claims.isClaimed(harness.target.id));
    harness.bus.subscribe("device.quarantine-abandoned", sees);
    harness.notifyAvailability.mockImplementation(sees);

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    harness.clock.advance(2_000);
    await flush();

    expect(eventsOf(harness.bus).at(-1)?.event).toBe("device.quarantine-abandoned");
    expect(claimedAt).toEqual([false, false]);
  });

  it("has freed the claim before it emits device.quarantine-stranded when a retry gives up and cannot destroy the device", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("still stuck"));
    driver.failOn("reclaim", 2, new Error("still stuck"));
    driver.failOn("destroy", 1, new Error("cannot destroy"));
    const harness = await stalled({ clock, driver });
    const claimedAt: boolean[] = [];
    harness.bus.subscribe("device.quarantine-stranded", () =>
      claimedAt.push(harness.claims.isClaimed(harness.target.id)),
    );

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    harness.clock.advance(2_000);
    await flush();

    expect(claimedAt).toEqual([false]);
  });

  it("frees the claim when a registry write throws during the retry", async () => {
    const harness = await stalled();
    vi.spyOn(harness.registry, "recoverFromQuarantine").mockRejectedValue(new Error("disk full"));

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.claims.isClaimed(harness.target.id)).toBe(false);
  });
});

describe("QuarantineCoordinator and enrollment of a quarantined physical device (ADR 0022 §2)", () => {
  const FIRST = "00008110-001A2B3C4D5E";
  const SECOND = "00008110-00FF00FF00FF";
  const DEVICES: readonly FakePhysicalDevice[] = [
    { apps: [], ids: [FIRST], model: "iPhone 15 Pro", osVersion: "18.4" },
    { apps: [], ids: [SECOND], model: "iPhone 15 Pro", osVersion: "18.4" },
  ];

  async function build() {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ clock, physicalDevices: DEVICES, platform: "ios" });
    for (const id of [FIRST, SECOND]) driver.setPhysicalPresence(id, true);
    const filesystem = new MemoryFilesystem();
    const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
    let next = 1;
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: { generate: () => `${next++}` },
    });
    const config = await loadConfig({ filesystem, systemStats });
    const core = createCore({
      clock,
      config,
      drivers: [driver],
      eventBus,
      registry,
      systemStats,
      ...testComponentWiring({ clock, drivers: [driver], eventBus, registry }),
    });
    return { clock, config, core, driver, registry };
  }

  type Harness = Awaited<ReturnType<typeof build>>;

  async function enrollQuarantined(harness: Harness, driverId: string): Promise<string> {
    const { device } = await harness.core.enrollment.add("ios", driverId);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 61_000,
      ttlMs: 60_000,
    });
    await harness.registry.beginRelease(lease.id);
    await harness.core.quarantine.enterFromStalledTransition(device.id, "reclaiming");
    return device.id;
  }

  function reclaimedIds(harness: Harness): unknown[] {
    return harness.driver.calls
      .filter((call) => call.operation === "reclaim")
      .map((call) => (call.arguments[0] as { deviceId: string }).deviceId);
  }

  function record(harness: Harness, id: string): PhysicalDevice | undefined {
    return harness.registry.snapshot.devices.find(
      (device): device is PhysicalDevice => device.physical && device.id === id,
    );
  }

  it("makes a re-enrolled quarantined physical device ready with no quarantine fields, and no driver reclaim call when its next retry falls due", async () => {
    const harness = await build();
    const enrolled = await enrollQuarantined(harness, FIRST);
    await enrollQuarantined(harness, SECOND);
    const backoff = harness.config.warmPool.quarantine.retryBackoffMs;

    await harness.core.enrollment.add("ios", FIRST);
    harness.clock.advance(backoff);
    await flush();

    expect(record(harness, enrolled)).toMatchObject({ id: enrolled, state: "ready" });
    expect(record(harness, enrolled)).not.toHaveProperty("quarantineNextRetryAt");
    expect(reclaimedIds(harness)).toEqual([SECOND]);
  });

  it("makes a removed quarantined physical device deleted, and no driver call when its next retry falls due", async () => {
    const harness = await build();
    const removed = await enrollQuarantined(harness, FIRST);
    await enrollQuarantined(harness, SECOND);
    const backoff = harness.config.warmPool.quarantine.retryBackoffMs;

    await harness.core.enrollment.remove(FIRST);
    harness.clock.advance(backoff);
    await flush();

    expect(record(harness, removed)?.state).toBe("deleted");
    expect(reclaimedIds(harness)).toEqual([SECOND]);
    expect(
      harness.driver.calls.filter(
        (call) =>
          call.operation !== "inspectPhysical" &&
          (call.arguments[0] as { deviceId?: string } | undefined)?.deviceId === FIRST,
      ),
    ).toEqual([]);
  });

  it.each(["add", "remove"] as const)(
    "answers DEVICE_BUSY reclaiming to %s of a physical device whose quarantine retry is inside its driver reclaim",
    async (operation) => {
      const harness = await build();
      await enrollQuarantined(harness, FIRST);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = vi.fn();
      vi.spyOn(harness.driver, "reclaim").mockImplementation(async () => {
        reached();
        await gate;
        return { state: "ready", strategy: "uninstall" };
      });

      harness.clock.advance(harness.config.warmPool.quarantine.retryBackoffMs);
      await flush();
      expect(reached).toHaveBeenCalledTimes(1);

      const attempt =
        operation === "add"
          ? harness.core.enrollment.add("ios", FIRST)
          : harness.core.enrollment.remove(FIRST);
      await expect(attempt).rejects.toMatchObject({
        name: "DeviceBusyError",
        reason: "reclaiming",
      });
      release();
      await flush();
    },
  );

  it("makes no driver call when a physical quarantine retry falls due while an add holds the claim, keeps its attempt count, and runs one retryBackoffMs later when the add was refused", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness, FIRST);
    const backoff = harness.config.warmPool.quarantine.retryBackoffMs;
    const original = harness.driver.inspectPhysical.bind(harness.driver);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = vi.fn();
    vi.spyOn(harness.driver, "inspectPhysical").mockImplementation(async (identifier) => {
      reads += 1;
      if (reads < 2) return original(identifier);
      held();
      await gate;
      return { enrollable: false, message: "locked: unlock it", reason: "locked" };
    });
    const adding = harness.core.enrollment.add("ios", FIRST);
    const refused = expect(adding).rejects.toMatchObject({ name: "DeviceNotEnrollableError" });
    await vi.waitFor(() => expect(held).toHaveBeenCalled());

    harness.clock.advance(backoff);
    await flush();

    expect(reclaimedIds(harness)).toEqual([]);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 0, state: "quarantined" });
    release();
    await refused;
    harness.clock.advance(backoff - 1);
    await flush();
    expect(reclaimedIds(harness)).toEqual([]);
    harness.clock.advance(1);
    await flush();

    expect(reclaimedIds(harness)).toEqual([FIRST]);
  });
});

describe("QuarantineCoordinator retry of a physical device that is not present (ADR 0022 §2)", () => {
  const FIRST = "00008110-001A2B3C4D5E";
  const PROBE_INTERVAL_MS = 7_000;
  const DEVICES: readonly FakePhysicalDevice[] = [
    { apps: [], ids: [FIRST], model: "iPhone 15 Pro", osVersion: "18.4" },
  ];

  async function build(logger?: Logger) {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ clock, physicalDevices: DEVICES, platform: "ios" });
    const filesystem = new MemoryFilesystem();
    const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
    let next = 1;
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: { generate: () => `${next++}` },
    });
    const config = await loadConfig({
      filesystem,
      overrides: { health: { probeIntervalMs: PROBE_INTERVAL_MS } },
      systemStats,
    });
    const core = createCore({
      clock,
      config,
      drivers: [driver],
      eventBus,
      ...(logger === undefined ? {} : { logger }),
      registry,
      systemStats,
      ...testComponentWiring({ clock, drivers: [driver], eventBus, registry }),
    });
    return { clock, config, core, driver, eventBus, registry };
  }

  type Harness = Awaited<ReturnType<typeof build>>;

  async function enrollQuarantined(harness: Harness): Promise<string> {
    const { device } = await harness.core.enrollment.add("ios", FIRST);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 61_000,
      ttlMs: 60_000,
    });
    await harness.registry.beginRelease(lease.id);
    await harness.core.quarantine.enterFromStalledTransition(device.id, "reclaiming");
    return device.id;
  }

  async function advance(harness: Harness, ms: number): Promise<void> {
    harness.clock.advance(ms);
    for (let round = 0; round < 5; round += 1) await flush();
  }

  function record(harness: Harness, id: string): PhysicalDevice | undefined {
    return harness.registry.snapshot.devices.find(
      (device): device is PhysicalDevice => device.physical && device.id === id,
    );
  }

  function verbCalls(harness: Harness, operation: "reclaim" | "destroy"): unknown[] {
    return harness.driver.calls.filter((call) => call.operation === operation);
  }

  it("a physical retry while not present makes no reclaim or destroy call, keeps quarantineAttempts, writes quarantineNextRetryAt as now plus health.probeIntervalMs, and re-arms for that time; a virtual retry is unchanged", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness);
    const backoff = harness.config.warmPool.quarantine.retryBackoffMs;
    harness.driver.setPhysicalPresence(FIRST, false, { reason: "locked" });

    await advance(harness, backoff);

    expect(verbCalls(harness, "reclaim")).toEqual([]);
    expect(verbCalls(harness, "destroy")).toEqual([]);
    expect(record(harness, id)).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 1_000 + backoff + PROBE_INTERVAL_MS,
      state: "quarantined",
    });
    await advance(harness, PROBE_INTERVAL_MS - 1);
    expect(verbCalls(harness, "reclaim")).toEqual([]);
    harness.driver.setPhysicalPresence(FIRST, true);
    await advance(harness, 1);
    expect(verbCalls(harness, "reclaim")).toHaveLength(1);
    expect(record(harness, id)?.state).toBe("ready");

    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const virtual = await createHarness({ clock, driver, target: { state: "reclaiming" } });
    await virtual.coordinator.enterFromStalledTransition(virtual.target.id, "reclaiming");
    virtual.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    expect(virtual.driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(1);
    expect(virtual.driver.calls.map((call) => call.operation)).not.toContain("listPresentPhysical");
    expect(virtual.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
  });

  it("a physical retry that runs while present and fails counts one attempt", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness);
    harness.driver.failOn("reclaim", 1, new Error("uninstall exploded"));
    harness.driver.setPhysicalPresence(FIRST, false);
    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 0, state: "quarantined" });
    expect(verbCalls(harness, "reclaim")).toEqual([]);

    harness.driver.setPhysicalPresence(FIRST, true);
    await advance(harness, PROBE_INTERVAL_MS);

    expect(verbCalls(harness, "reclaim")).toHaveLength(1);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 1, state: "quarantined" });
  });

  it("a physical retry that fails while present, then finds the device gone, keeps the one attempt it counted", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness);
    harness.driver.failOn("reclaim", 1, new Error("uninstall exploded"));
    harness.driver.setPhysicalPresence(FIRST, true);
    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 1, state: "quarantined" });

    harness.driver.setPhysicalPresence(FIRST, false);
    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs * 2);

    expect(verbCalls(harness, "reclaim")).toHaveLength(1);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 1, state: "quarantined" });
  });

  it("a physical retry whose presence read rejects logs a warning naming the device, the presence step and the error", async () => {
    const sink = new MemoryLogSink();
    const harness = await build(new JsonLinesLogger({ clock: new FakeClock(1_000), sink }));
    const id = await enrollQuarantined(harness);
    harness.driver.setPhysicalPresence(FIRST, true);
    vi.spyOn(harness.driver, "listPresentPhysical").mockRejectedValueOnce(new Error("link down"));

    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs);

    expect(sink.records.filter((entry) => entry.level === "warn")).toEqual([
      expect.objectContaining({
        message: "quarantine presence read failed",
        fields: { deviceId: id, error: "Error: link down", step: "presence" },
      }),
    ]);
  });

  it("a physical retry whose presence read rejects makes no reclaim or destroy call, keeps quarantineAttempts, and re-arms after health.probeIntervalMs", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness);
    harness.driver.setPhysicalPresence(FIRST, true);
    const read = vi
      .spyOn(harness.driver, "listPresentPhysical")
      .mockRejectedValueOnce(new Error("link down"));

    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs);

    expect(read).toHaveBeenCalledTimes(1);
    expect(verbCalls(harness, "reclaim")).toEqual([]);
    expect(verbCalls(harness, "destroy")).toEqual([]);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 0, state: "quarantined" });
    await advance(harness, PROBE_INTERVAL_MS - 1);
    expect(verbCalls(harness, "reclaim")).toEqual([]);
    await advance(harness, 1);
    expect(verbCalls(harness, "reclaim")).toHaveLength(1);
    expect(record(harness, id)?.state).toBe("ready");
  });
});

describe("QuarantineCoordinator enterFromStalledTransition under the device's reclaim claim (ADR 0022 §8)", () => {
  type StalledEntry = (deviceId: string, findingState: string) => Promise<boolean>;

  async function reclaimingHarness() {
    const harness = await createHarness();
    harness.registry.forceState(harness.target.id, "reclaiming");
    const enter: StalledEntry = (deviceId, findingState) =>
      (
        harness.coordinator as unknown as { enterFromStalledTransition: StalledEntry }
      ).enterFromStalledTransition(deviceId, findingState);
    return { ...harness, enter };
  }

  it("enterFromStalledTransition checks the state of the device it was given, not of another, answers no and writes nothing for an id the registry does not hold, and answers yes when it enters", async () => {
    const bystander: VirtualDevice = { ...device("dev_other", "other-driver-id"), state: "ready" };
    const harness = await createHarness({ others: [bystander] });
    harness.registry.forceState(harness.target.id, "reclaiming");
    const enter = (deviceId: string) =>
      harness.coordinator.enterFromStalledTransition(deviceId, "reclaiming");

    await expect(enter("dev_missing")).resolves.toBe(false);
    expect(eventsOf(harness.bus)).toEqual([]);

    await expect(enter(harness.target.id)).resolves.toBe(true);

    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual(["device.quarantined"]);
    expect(
      harness.registry.snapshot.virtualDevices.map((entry) => [entry.id, entry.state]),
    ).toEqual([
      ["dev_other", "ready"],
      [harness.target.id, "quarantined"],
    ]);
  });

  it("enterFromStalledTransition of a claimed device, or of one no longer in the finding's state, writes nothing and arms no retry; otherwise it holds the device's reclaim claim while it writes and releases it after, also when the write throws", async () => {
    const claimed = await reclaimingHarness();
    const held = claimed.claims.tryClaim(claimed.target.id, "boot");
    await expect(claimed.enter(claimed.target.id, "reclaiming")).resolves.toBe(false);
    expect(claimed.registry.snapshot.virtualDevices[0]?.state).toBe("reclaiming");
    expect(eventsOf(claimed.bus)).toEqual([]);
    expect(claimed.clock.pendingTimerCount).toBe(0);
    expect(claimed.claims.operationFor(claimed.target.id)).toBe("boot");
    held?.release();

    const moved = await reclaimingHarness();
    moved.registry.forceState(moved.target.id, "ready");
    await expect(moved.enter(moved.target.id, "reclaiming")).resolves.toBe(false);
    expect(moved.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
    expect(eventsOf(moved.bus)).toEqual([]);
    expect(moved.clock.pendingTimerCount).toBe(0);

    const written = await reclaimingHarness();
    const heldDuringWrite: unknown[] = [];
    const original = written.registry.enterQuarantine.bind(written.registry);
    vi.spyOn(written.registry, "enterQuarantine").mockImplementation(async (...args) => {
      heldDuringWrite.push(written.claims.operationFor(written.target.id));
      return original(...args);
    });
    await expect(written.enter(written.target.id, "reclaiming")).resolves.toBe(true);
    expect(heldDuringWrite).toEqual(["reclaim"]);
    expect(written.claims.isClaimed(written.target.id)).toBe(false);
    expect(written.registry.snapshot.virtualDevices[0]?.state).toBe("quarantined");
    expect(eventsOf(written.bus).map((event) => event.event)).toEqual(["device.quarantined"]);
    expect(written.clock.pendingTimerCount).toBe(1);

    const failing = await reclaimingHarness();
    const heldDuringFailure: unknown[] = [];
    vi.spyOn(failing.registry, "enterQuarantine").mockImplementation(async () => {
      heldDuringFailure.push(failing.claims.operationFor(failing.target.id));
      throw new Error("disk full");
    });
    await failing.enter(failing.target.id, "reclaiming").catch(() => undefined);
    expect(heldDuringFailure).toEqual(["reclaim"]);
    expect(failing.claims.isClaimed(failing.target.id)).toBe(false);
  });
});

describe("QuarantineCoordinator quarantine cause", () => {
  const androidSpec: VirtualSpec = {
    physical: false,
    model: "Pixel 8",
    osVersion: "35",
    platform: "android",
  };
  const PHYSICAL_ID = "00008110-001A2B3C4D5E";

  type StartState = "provisioning" | "reclaiming" | "shutdown";

  async function build(
    options: {
      readonly physical?: boolean;
      readonly platform?: "ios" | "android";
      readonly state?: StartState;
      readonly fresh?: boolean;
    } = {},
  ) {
    const platform = options.platform ?? "ios";
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const driver = new FakeDriver({ clock, platform, reclaimResult: "ready" });
    const state = options.state ?? "reclaiming";
    const testState = await openTestState();
    const seeding = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => (options.physical === true ? "physical" : "virtual") },
      state: testState,
    });
    let id: string;
    if (options.physical === true) {
      driver.setPhysicalPresence(PHYSICAL_ID, true);
      id = "dev_physical";
      await seeding.enrollPhysical({
        apps: [],
        class: "phone",
        driverDeviceId: PHYSICAL_ID,
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        platform: "ios",
      });
      testState.database
        .prepare(
          "UPDATE devices SET created_at = 600, last_lease_ended_at = 700, ready_at = NULL, state = ?",
        )
        .run(state);
    } else {
      const virtualSpec = platform === "android" ? androidSpec : spec;
      const provisioned = await driver.provision(virtualSpec);
      id = "dev_virtual";
      await seeding.registerDevice({
        driverData: provisioned.driverData,
        driverDeviceId: provisioned.deviceId,
        provisionDuration: 0,
        spec: virtualSpec,
      });
      testState.database.prepare("UPDATE devices SET created_at = 1, state = ?").run(state);
      if (options.fresh === true) {
        testState.database
          .prepare("UPDATE devices SET last_lease_ended_at = 900, lease_identity = 'fresh'")
          .run();
      }
    }
    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator: { generate: () => "id" },
      state: testState,
    });
    const claims = new DeviceOperationClaims();
    const coordinator = new QuarantineCoordinator({
      claims,
      clock,
      config: retryConfig,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus: bus,
      notifyAvailability: vi.fn(),
      registry,
    });
    const device = () => registry.snapshot.devices.find((candidate) => candidate.id === id);
    const quarantinedPayload = () =>
      bus.replay().find((event) => event.event === "device.quarantined")?.payload;
    return { bus, claims, clock, coordinator, device, driver, id, quarantinedPayload, registry };
  }

  function failure(
    id: string,
    kind: "purge-failed" | "shutdown-failed" | "delete-failed",
    error: string,
  ) {
    return {
      attemptedStrategy: kind === "purge-failed" ? ("wipe" as const) : ("delete" as const),
      deviceId: id,
      duration: 5,
      error,
      kind,
      leaseId: "lease-1",
    };
  }

  it.each(["ios", "android"] as const)(
    "device.quarantine-recovered, device.quarantine-abandoned and device.quarantine-stranded carry the device's own platform, for an %s device",
    async (platform) => {
      const recovered = await build({ platform });
      await recovered.coordinator.enter(failure(recovered.id, "purge-failed", "boom"));
      recovered.clock.advance(retryConfig.retryBackoffMs);
      await flush();

      const abandoned = await build({ platform });
      abandoned.driver.failOn("reclaim", 1, new Error("still stuck"));
      abandoned.driver.failOn("reclaim", 2, new Error("still stuck"));
      await abandoned.coordinator.enter(failure(abandoned.id, "purge-failed", "boom"));
      abandoned.clock.advance(retryConfig.retryBackoffMs);
      await flush();
      abandoned.clock.advance(2_000);
      await flush();

      const stranded = await build({ platform });
      stranded.driver.failOn("reclaim", 1, new Error("still stuck"));
      stranded.driver.failOn("reclaim", 2, new Error("still stuck"));
      stranded.driver.failOn("destroy", 1, new Error("destroy blew up"));
      await stranded.coordinator.enter(failure(stranded.id, "purge-failed", "boom"));
      stranded.clock.advance(retryConfig.retryBackoffMs);
      await flush();
      stranded.clock.advance(2_000);
      await flush();

      const payloadOf = (harness: { readonly bus: EventBus }, name: string) =>
        harness.bus.replay().find((event) => event.event === name)?.payload;
      expect([
        payloadOf(recovered, "device.quarantine-recovered"),
        payloadOf(abandoned, "device.quarantine-abandoned"),
        payloadOf(stranded, "device.quarantine-stranded"),
      ]).toMatchObject([{ platform }, { platform }, { platform }]);
    },
  );

  it.each([
    ["purge-failed", "reclaiming"],
    ["shutdown-failed", "reclaiming"],
    ["delete-failed", "shutdown"],
  ] as const)(
    "enter writes quarantineCause kind %s and its message on the record and on device.quarantined",
    async (kind, state) => {
      const harness = await build({ fresh: kind !== "purge-failed", state });

      await harness.coordinator.enter(failure(harness.id, kind, "DriverCrashError: it broke"));

      expect(harness.device()).toMatchObject({ state: "quarantined" });
      expect(harness.device()?.quarantineCause).toEqual({
        kind,
        message: "DriverCrashError: it broke",
      });
      expect(harness.quarantinedPayload()).toMatchObject({
        kind,
        message: "DriverCrashError: it broke",
      });
      expect(harness.quarantinedPayload()).not.toHaveProperty("stalledState");
    },
  );

  it("cleans the message: control characters become spaces, it is trimmed, cut at 300 with a final ellipsis, and left out when empty; device.purge-failed keeps the full text", async () => {
    const long = (length: number) => `Error: ${"x".repeat(length - 7)}`;
    const cases: readonly (readonly [string, string, string | undefined])[] = [
      ["control characters", "\n Error: a\r\nb\u0000c d \t", "Error: a  b c d"],
      ["300 characters", long(300), long(300)],
      ["301 characters", long(301), `${long(301).slice(0, 299)}…`],
      ["a high surrogate at 299", `${"x".repeat(298)}😀yyy`, `${"x".repeat(298)}…`],
      ["only whitespace and controls", " \n\t\u0007 ", undefined],
    ];

    for (const [name, error, expected] of cases) {
      const harness = await build();

      await harness.coordinator.enter(failure(harness.id, "purge-failed", error));

      const cause = harness.device()?.quarantineCause;
      expect(cause, name).toBeDefined();
      expect(cause?.message, name).toBe(expected);
      if (expected === undefined) expect(cause, name).toEqual({ kind: "purge-failed" });
      else expect(expected.length, name).toBeLessThanOrEqual(300);
      expect(harness.quarantinedPayload(), name).toMatchObject({ kind: "purge-failed" });
      expect((harness.quarantinedPayload() as { message?: string }).message, name).toBe(expected);
      const purgeFailed = harness.bus
        .replay()
        .find((event) => event.event === "device.purge-failed");
      expect(purgeFailed?.payload, name).toMatchObject({ error });
    }
  });

  it.each([
    ["provisioning", false],
    ["reclaiming", false],
    ["reclaiming", true],
  ] as const)(
    "enterFromStalledTransition of a device stalled %s (physical %s) writes kind stalled with its stalledState and no message, on the record and on the event",
    async (stalledState, physical) => {
      const harness = await build({ physical, state: stalledState });

      await harness.coordinator.enterFromStalledTransition(harness.id, stalledState);

      expect(harness.device()?.state).toBe("quarantined");
      expect(harness.device()?.quarantineCause).toEqual({ kind: "stalled", stalledState });
      expect(harness.quarantinedPayload()).toMatchObject({ kind: "stalled", stalledState });
      expect(harness.quarantinedPayload()).not.toHaveProperty("message");
    },
  );

  it("enterFromStalledTransition of a device in another state, the lease engine's hand-over after a failed destroy, writes kind delete-failed", async () => {
    const harness = await build({ physical: false, state: "shutdown" });

    const entered = await harness.coordinator.enterFromStalledTransition(harness.id, "shutdown");

    expect(entered).toBe(true);
    expect(harness.device()?.state).toBe("quarantined");
    expect(harness.device()?.quarantineCause).toEqual({ kind: "delete-failed" });
    expect(harness.quarantinedPayload()).toMatchObject({ kind: "delete-failed" });
  });

  it.each(["ios", "android"] as const)(
    "device.quarantined carries the %s device's platform from enter and from enterFromStalledTransition",
    async (platform) => {
      const entered = await build({ platform });
      await entered.coordinator.enter(failure(entered.id, "purge-failed", "Error: boom"));
      const stalled = await build({ platform });
      await stalled.coordinator.enterFromStalledTransition(stalled.id, "reclaiming");

      expect(entered.quarantinedPayload()).toMatchObject({ platform });
      expect(stalled.quarantinedPayload()).toMatchObject({ platform });
    },
  );

  it("a stalled entry that writes nothing, because the device is claimed or has moved on, leaves no cause", async () => {
    const claimed = await build();
    const held = claimed.claims.tryClaim(claimed.id, "boot");
    await claimed.coordinator.enterFromStalledTransition(claimed.id, "reclaiming");
    held?.release();
    const moved = await build({ state: "provisioning" });
    await moved.coordinator.enterFromStalledTransition(moved.id, "reclaiming");

    for (const harness of [claimed, moved]) {
      expect(harness.device()?.state).not.toBe("quarantined");
      expect(harness.device()).not.toHaveProperty("quarantineCause");
      expect(harness.bus.replay()).toEqual([]);
    }
  });

  it("a failed reclaim retry keeps the cause written at entry", async () => {
    const harness = await build();
    harness.driver.failOn("reclaim", 1, new Error("still stuck"));
    await harness.coordinator.enter(failure(harness.id, "purge-failed", "Error: first"));

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.device()).toMatchObject({ quarantineAttempts: 1, state: "quarantined" });
    expect(harness.device()?.quarantineCause).toEqual({
      kind: "purge-failed",
      message: "Error: first",
    });
  });

  it("a failed delete retry keeps the cause written at entry", async () => {
    const harness = await build({ fresh: true, state: "shutdown" });
    harness.driver.failOn("destroy", 1, new Error("still stuck"));
    await harness.coordinator.enter(failure(harness.id, "delete-failed", "Error: first"));

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.device()).toMatchObject({ quarantineAttempts: 1, state: "quarantined" });
    expect(harness.device()?.quarantineCause).toEqual({
      kind: "delete-failed",
      message: "Error: first",
    });
  });

  it("a physical retry that waits for the device to be present keeps the cause written at entry", async () => {
    const harness = await build({ physical: true });
    await harness.coordinator.enter(failure(harness.id, "purge-failed", "Error: first"));
    harness.driver.setPhysicalPresence(PHYSICAL_ID, false);

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.device()).toMatchObject({ quarantineAttempts: 0, state: "quarantined" });
    expect(harness.device()?.quarantineCause).toEqual({
      kind: "purge-failed",
      message: "Error: first",
    });
  });

  it("a stranded give-up keeps the cause written at entry", async () => {
    const harness = await build();
    harness.driver.failOn("reclaim", 1, new Error("still stuck"));
    harness.driver.failOn("reclaim", 2, new Error("still stuck"));
    harness.driver.failOn("destroy", 1, new Error("cannot destroy"));
    await harness.coordinator.enter(failure(harness.id, "purge-failed", "Error: first"));

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    harness.clock.advance(2_000);
    await flush();

    expect(harness.bus.replay().map((event) => event.event)).toContain(
      "device.quarantine-stranded",
    );
    expect(harness.device()).toMatchObject({ quarantineAttempts: 2, state: "quarantined" });
    expect(harness.device()?.quarantineCause).toEqual({
      kind: "purge-failed",
      message: "Error: first",
    });
  });
});
