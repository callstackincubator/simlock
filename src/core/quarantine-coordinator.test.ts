import { describe, expect, it, vi } from "vitest";
import { EventBus, type EventEnvelope } from "../bus/index.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { VirtualDevice } from "./domain.js";
import { FakeDriver, loadTestRegistry, openTestState } from "./testing.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { SerializedDecision } from "./serialized-decision.js";
import {
  spec,
  retryConfig,
  FakeRegistry,
  device,
  createHarness,
  flush,
} from "./test-quarantine-coordinator.js";

function eventsOf(bus: EventBus): readonly EventEnvelope[] {
  return bus.replay();
}

// why: index.ts does not export the coordinator, so its retry timers, claims and give-up order are an ordering the surface cannot force.
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

  it("hands the driver's retried destroy a device marked virtual", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    const harness = await createHarness({
      clock,
      driver,
      target: { state: "provisioning" as const },
    });

    await harness.coordinator.enterFromStalledTransition(harness.target.id, "provisioning");
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    const destroys = driver.calls.filter((call) => call.operation === "destroy");
    expect(destroys.map((call) => call.arguments[0])).toEqual([
      expect.objectContaining({ physical: false }),
    ]);
  });

  it("a virtual device's retry does not tell the physical-ready port", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
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

    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
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

  it("retries a stalled-transition entry by deleting the device, exactly like a purge-failure one", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    const harness = await createHarness({
      clock,
      driver,
      target: { state: "provisioning" as const },
    });

    await harness.coordinator.enterFromStalledTransition(harness.target.id, "provisioning");
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
    expect(harness.registry.deletions).toEqual(["lease-engine"]);
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual(["device.quarantined"]);
    expect(harness.notifyAvailability).toHaveBeenCalledTimes(1);
  });

  it("grows the backoff after each failed retry, capped at maxRetryBackoffMs, then gives up and destroys", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    // why: a virtual device is retried by destroy, so the third destroy is the give-up one.
    driver.failOn("destroy", 1, new Error("still stuck"));
    driver.failOn("destroy", 2, new Error("still stuck"));
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
    driver.failOn("destroy", 1, new Error("still stuck"));
    driver.failOn("destroy", 2, new Error("still stuck"));
    driver.failOn("destroy", 3, new Error("destroy blew up"));
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

  it.each([
    [
      "a spent fresh device",
      { lastLeaseEndedAt: 900, leaseIdentity: "fresh" as const },
      "lease-end",
    ],
    [
      "a spent reusable device",
      { lastLeaseEndedAt: 900, leaseIdentity: "reusable" as const },
      "lease-end",
    ],
    ["a device that never served a lease", {}, "lease-engine"],
  ])(
    "retries %s's delete rather than an erase, and a successful retry reaches deleted, never ready, with the initiator of its cause",
    async (_case, target, initiator) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ clock, platform: "ios" });
      const harness = await createHarness({ clock, driver, target });
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
      expect(harness.registry.deletions).toEqual([initiator]);
      expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
        "device.purge-failed",
        "device.quarantined",
      ]);
      expect(eventsOf(harness.bus)[0]).toMatchObject({ payload: { attemptedStrategy: "delete" } });
      expect(harness.notifyAvailability).toHaveBeenCalledOnce();
    },
  );

  it("keeps a virtual device quarantined and re-arms when its retried delete fails", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
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

    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("destroy");
    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("leased");
  });

  it("restores retry timers for devices still quarantined at startup", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
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

    expect(registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
    expect(notifyAvailability).toHaveBeenCalledOnce();
  });

  it("arms no retry for a quarantined device the include filter leaves out, even one already due", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
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

    expect(driver.calls.map((call) => call.operation)).not.toContain("destroy");
    expect(registry.snapshot.virtualDevices[0]?.state).toBe("quarantined");
  });

  it("arms no retry timer for a device that is not quarantined", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
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

describe("QuarantineCoordinator for a physical device (ADR 0022 §4)", () => {
  const physicalRecord = { driverDeviceId: "00008110-001A2B3C4D5E" };

  async function physicalHarness(stateName: "reclaiming" | "quarantined") {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const driver = new FakeDriver({ clock, platform: "ios" });
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

    expect(harness.driver.calls.filter((call) => call.operation === "destroy")).toEqual([]);
    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 0,
      state: "quarantined",
    });
    held?.release();
    harness.clock.advance(retryConfig.retryBackoffMs - 1);
    await flush();
    expect(harness.driver.calls.filter((call) => call.operation === "destroy")).toEqual([]);
    harness.clock.advance(1);
    await flush();

    expect(harness.driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
  });

  it.each([
    ["succeeds", false],
    ["throws", true],
  ] as const)(
    "holds the reclaim claim while the driver's destroy runs, and frees it after the call %s",
    async (_case, throws) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ clock, platform: "ios" });
      if (throws) driver.failOn("destroy", 1, new Error("still stuck"));
      const harness = await stalled({ clock, driver });
      const original = driver.destroy.bind(driver);
      const duringCall: unknown[] = [];
      vi.spyOn(driver, "destroy").mockImplementation(async (device) => {
        duringCall.push(harness.claims.operationFor(harness.target.id));
        return original(device);
      });

      harness.clock.advance(retryConfig.retryBackoffMs);
      await flush();

      expect(duringCall).toEqual(["reclaim"]);
      expect(harness.claims.isClaimed(harness.target.id)).toBe(false);
      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe(
        throws ? "quarantined" : "deleted",
      );
    },
  );

  it("has freed the claim before it wakes availability when a retry deletes a virtual device", async () => {
    const harness = await stalled({ target: { lastLeaseEndedAt: 900 } });
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
    driver.failOn("destroy", 1, new Error("still stuck"));
    driver.failOn("destroy", 2, new Error("still stuck"));
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
    driver.failOn("destroy", 1, new Error("still stuck"));
    driver.failOn("destroy", 2, new Error("still stuck"));
    driver.failOn("destroy", 3, new Error("cannot destroy"));
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
    vi.spyOn(harness.registry, "deleteQuarantined").mockRejectedValue(new Error("disk full"));

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.claims.isClaimed(harness.target.id)).toBe(false);
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
