import { describe, expect, it, vi } from "vitest";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { DeviceRecord, DeviceSpec } from "./domain.js";
import { FakeDriver } from "./fake-driver.js";
import {
  QuarantineCoordinator,
  type QuarantineRegistry,
  type QuarantineRetryConfig,
} from "./quarantine-coordinator.js";
import { SerializedDecision } from "./serialized-decision.js";

const spec: DeviceSpec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" };

const retryConfig: QuarantineRetryConfig = {
  maxRetries: 2,
  retryBackoffMs: 1_000,
  retryBackoffMultiplier: 2,
  maxRetryBackoffMs: 5_000,
};

/** In-memory stand-in mirroring the four Registry methods QuarantineCoordinator calls. */
class FakeRegistry implements QuarantineRegistry {
  #devices: DeviceRecord[];

  constructor(devices: readonly DeviceRecord[]) {
    this.#devices = [...devices];
  }

  get snapshot(): { readonly devices: readonly DeviceRecord[] } {
    return { devices: this.#devices.map((device) => ({ ...device })) };
  }

  async enterQuarantine(deviceId: string, nextRetryAt: number): Promise<DeviceRecord> {
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
  ): Promise<DeviceRecord> {
    return this.#update(deviceId, (device) => ({
      ...device,
      quarantineAttempts: attempts,
      quarantineNextRetryAt: nextRetryAt,
    }));
  }

  async strandQuarantine(deviceId: string, attempts: number): Promise<DeviceRecord> {
    return this.#update(deviceId, (device) => {
      const { quarantineNextRetryAt: _quarantineNextRetryAt, ...rest } = device;
      return { ...rest, quarantineAttempts: attempts };
    });
  }

  async recoverFromQuarantine(deviceId: string, to: "ready" | "shutdown"): Promise<DeviceRecord> {
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

  async abandonQuarantine(deviceId: string): Promise<DeviceRecord> {
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
  forceState(deviceId: string, state: DeviceRecord["state"]): void {
    this.#update(deviceId, (device) => ({ ...device, state }));
  }

  #update(deviceId: string, apply: (device: DeviceRecord) => DeviceRecord): DeviceRecord {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    const current = this.#devices[index];
    if (index === -1 || current === undefined) throw new Error(`missing device: ${deviceId}`);
    const updated = apply(current);
    this.#devices[index] = updated;
    return { ...updated };
  }
}

function device(id: string, driverDeviceId: string): DeviceRecord {
  return { createdAt: 1, driverData: {}, driverDeviceId, id, spec, state: "quarantined" };
}

async function createHarness(
  options: {
    readonly clock?: FakeClock;
    readonly config?: QuarantineRetryConfig;
    readonly driver?: FakeDriver;
  } = {},
) {
  const clock = options.clock ?? new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver = options.driver ?? new FakeDriver({ clock, platform: "ios" });
  const driverDevice = await driver.provision(spec);
  const target = device("dev_1", driverDevice.deviceId);
  const registry = new FakeRegistry([target]);
  const notifyAvailability = vi.fn();
  const coordinator = new QuarantineCoordinator({
    clock,
    config: options.config ?? retryConfig,
    decisions: new SerializedDecision(),
    drivers: new DriverCatalog([driver]),
    eventBus: bus,
    notifyAvailability,
    registry,
  });
  return { bus, clock, coordinator, driver, notifyAvailability, registry, target };
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
      deviceId: harness.target.id,
      duration: 40,
      error: "Error: purge exploded",
      leaseId: "lease-1",
    });

    expect(harness.registry.snapshot.devices[0]).toMatchObject({
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
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("recovers on a successful retry, rejoins the pool, and wakes availability", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const harness = await createHarness({ clock, driver });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    expect(harness.registry.snapshot.devices[0]?.quarantineAttempts).toBeUndefined();
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
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    // First retry (attempt 1) fails; backoff grows to retryBackoffMs * multiplier^1 = 2_000.
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    expect(harness.registry.snapshot.devices[0]).toMatchObject({
      quarantineAttempts: 1,
      quarantineNextRetryAt: 4_000,
      state: "quarantined",
    });

    // Second retry (attempt 2) fails and hits maxRetries: give up and destroy.
    harness.clock.advance(2_000);
    await flush();

    expect(harness.driver.calls.map((call) => call.operation)).toContain("destroy");
    expect(harness.registry.snapshot.devices[0]?.state).toBe("deleted");
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
    expect(harness.registry.snapshot.devices[0]).toMatchObject({
      quarantineAttempts: 2,
      state: "quarantined",
    });
    // Nothing is armed any more, so the record must not advertise a retry deadline.
    expect(harness.registry.snapshot.devices[0]?.quarantineNextRetryAt).toBeUndefined();
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

  it("never touches a device that left quarantine before its retry timer fires", async () => {
    const harness = await createHarness();
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
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
    expect(harness.registry.snapshot.devices[0]?.state).toBe("leased");
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

    expect(registry.snapshot.devices[0]?.state).toBe("ready");
    expect(notifyAvailability).toHaveBeenCalledOnce();
  });
});

/** Lets the microtask queue (the fire-and-forget retry chain) settle after a timer fires. */
async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) await Promise.resolve();
}
