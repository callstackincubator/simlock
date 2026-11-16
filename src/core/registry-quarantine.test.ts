import { describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { loadTestRegistry, openTestState } from "./testing.js";
import { RegistryEventError, RegistryLoadError, UnknownDeviceError } from "./index.js";
import { spec } from "./test-registry.js";
import { loadAfterCorruptingDevice } from "./test-registry-corrupt-row.js";

describe("Registry", () => {
  it("enters quarantine from reclaiming, tracking attempts and the next retry deadline", async () => {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      requesterId: "agent-1",
      ownerId: "agent-1",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });
    await registry.beginRelease(lease.id);

    const quarantined = await registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" });

    expect(quarantined).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 5_000,
      quarantinedAt: 1_000,
      state: "quarantined",
    });
    await expect(
      registry.enterQuarantine(device.id, 6_000, { kind: "purge-failed" }),
    ).rejects.toThrow(RegistryEventError);
  });

  it("enters quarantine from provisioning, its stalled-transition entry point", async () => {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });

    const quarantined = await registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" });

    expect(quarantined).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 5_000,
      quarantinedAt: 1_000,
      state: "quarantined",
    });
  });

  it("enters quarantine from shutdown, a spent fresh device's failed-delete entry point", async () => {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
      leaseIdentity: { android: "reusable", ios: "fresh" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      requesterId: "agent-1",
      ownerId: "agent-1",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });
    await registry.beginRelease(lease.id);
    clock.advance(7_000);
    const shutDown = await registry.completeReclaimWithoutPurge(device.id);
    // Every path into `shutdown` stamps it, the reclaim's own included.
    expect(shutDown.shutdownAt).toBe(8_000);

    const quarantined = await registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" });

    expect(quarantined).toMatchObject({ quarantineNextRetryAt: 5_000, state: "quarantined" });
  });

  it("refuses to quarantine a device that is still leased", async () => {
    // Quarantine is a post-release disposition: it is only ever entered from `reclaiming`, which
    // a device reaches by having its lease released. A leased device reaching it would mean
    // pulling a device out from under its holder -- the one thing safety rule 2 forbids outright.
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    await registry.createLease({
      deviceId: device.id,
      requesterId: "agent-1",
      ownerId: "agent-1",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });

    await expect(
      registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" }),
    ).rejects.toThrow(RegistryEventError);
    expect(registry.snapshot.devices[0]?.state).toBe("leased");
  });

  it("records a quarantine retry failure without leaving quarantined", async () => {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      requesterId: "agent-1",
      ownerId: "agent-1",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });
    await registry.beginRelease(lease.id);
    await registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" });

    const retried = await registry.recordQuarantineRetryFailure(device.id, 1, 15_000);

    expect(retried).toMatchObject({
      quarantineAttempts: 1,
      quarantineNextRetryAt: 15_000,
      state: "quarantined",
    });
    await expect(registry.recordQuarantineRetryFailure("dev_missing", 1, 15_000)).rejects.toThrow(
      UnknownDeviceError,
    );
  });

  it("recovers a quarantined device and clears its quarantine bookkeeping", async () => {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      requesterId: "agent-1",
      ownerId: "agent-1",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });
    await registry.beginRelease(lease.id);
    await registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" });

    const recovered = await registry.recoverFromQuarantine(device.id, "ready");

    expect(recovered).toEqual({
      physical: false,
      createdAt: 1_000,
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      id: device.id,
      lastLeaseEndedAt: 1_000,
      leaseIdentity: "reusable",
      readyAt: 1_000,
      spec,
      mode: "full",
      state: "ready",
    });
    await expect(registry.recoverFromQuarantine(device.id, "ready")).rejects.toThrow(
      RegistryEventError,
    );
  });

  it("deletes a quarantined device and emits device.deleted with the caller's initiator", async () => {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const events: unknown[] = [];
    bus.subscribe("device.deleted", (envelope) => events.push(envelope.payload));
    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator: { generate: () => "test" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      requesterId: "agent-1",
      ownerId: "agent-1",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });
    await registry.beginRelease(lease.id);
    await registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" });

    const deleted = await registry.deleteQuarantined(device.id, "lease-end");

    expect(deleted.state).toBe("deleted");
    expect(events).toEqual([{ deviceId: device.id, initiator: "lease-end", physical: false }]);
  });

  it("rejects mutations for a device that is not registered", async () => {
    const clock = new FakeClock();
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });

    await expect(registry.transitionDevice("dev_missing", "ready")).rejects.toThrow(
      UnknownDeviceError,
    );
    await expect(
      registry.transitionDevice("dev_missing", "deleted", {
        event: "device.deleted",
        payload: { deviceId: "dev_missing", initiator: "test" },
      }),
    ).rejects.toThrow(UnknownDeviceError);
  });

  it("records the first recovery attempt, then keeps its recoveringSince and increments the count on retry", async () => {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    const first = await registry.markRecoveryAttempt(device.id, 1_500);
    expect(first).toMatchObject({ recoveringSince: 1_500, recoveryAttempts: 1 });

    const updated = await registry.markRecoveryAttempt(device.id, 2_000);

    expect(updated).toMatchObject({ recoveringSince: 1_500, recoveryAttempts: 2 });
  });

  it("clears both recovery markers", async () => {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.markRecoveryAttempt(device.id, 1_500);

    const cleared = await registry.clearRecovery(device.id);

    expect(cleared.recoveringSince).toBeUndefined();
    expect(cleared.recoveryAttempts).toBeUndefined();
  });

  it("persists readyAt and shutdownAt across a reload", async () => {
    const clock = new FakeClock(1_000);
    const state = await openTestState();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
      state,
    };
    const registry = await loadTestRegistry(options);
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 5, deviceId: device.id },
    });

    clock.advance(5_000);
    await registry.transitionDevice(device.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: device.id, initiator: "test" },
    });
    const reloaded = await loadTestRegistry(options);

    expect(reloaded.snapshot.devices[0]?.readyAt).toBe(1_000);
    expect(reloaded.snapshot.devices[0]?.shutdownAt).toBe(6_000);
  });

  it.each(["mode", "spec_mode"])(
    "fails the load when a stored %s is neither slim nor full",
    async (column) => {
      await expect(loadAfterCorruptingDevice(`${column} = 'reduced'`)).rejects.toThrow(
        RegistryLoadError,
      );
    },
  );

  it.each([
    ["no mode", spec],
    ["a slim mode", { ...spec, mode: "slim" as const }],
  ])("registers a new device as full, whether its spec carries %s", async (_label, deviceSpec) => {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });

    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec: deviceSpec,
    });

    expect(device.spec).toEqual(deviceSpec);
    expect(device.mode).toBe("full");
  });

  it("clears recovery markers when a lease ends", async () => {
    const clock = new FakeClock(1_000);
    const suffixes = ["device", "lease"];
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => suffixes.shift() ?? "unexpected" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_device",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      requesterId: "agent-1",
      ownerId: "agent-1",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });
    await registry.markRecoveryAttempt(device.id, 1_200);

    const released = await registry.beginRelease(lease.id);

    expect(released.device.recoveringSince).toBeUndefined();
    expect(released.device.recoveryAttempts).toBeUndefined();
    expect(released.device.state).toBe("reclaiming");
    expect(registry.snapshot.devices[0]?.recoveringSince).toBeUndefined();
    expect(registry.snapshot.devices[0]?.recoveryAttempts).toBeUndefined();
  });

  describe("a reclaim put off at a daemon start", () => {
    async function leased() {
      const clock = new FakeClock(1_000);
      const state = await openTestState();
      const options = {
        clock,
        eventBus: new EventBus(clock),
        idGenerator: { generate: () => "test" },
        state,
      };
      const registry = await loadTestRegistry(options);
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "fake-1" },
        driverDeviceId: "driver_test",
        provisionDuration: 0,
        spec,
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      const lease = await registry.createLease({
        deviceId: device.id,
        requesterId: "agent-1",
        ownerId: "agent-1",
        ttlMs: 60_000,
        ttlDeadline: 2_000,
      });
      return { device, lease, options, registry };
    }

    it("names the lease on the reclaiming device when the release defers it, and the name survives a reload", async () => {
      const { lease, options, registry } = await leased();

      const released = await registry.beginRelease(lease.id, { deferReclaim: true });

      expect(released.device).toMatchObject({
        deferredReclaimLeaseId: lease.id,
        state: "reclaiming",
      });
      expect((await loadTestRegistry(options)).snapshot.devices[0]).toMatchObject({
        deferredReclaimLeaseId: lease.id,
      });
    });

    it("names no lease on a release that does not defer", async () => {
      const { lease, registry } = await leased();

      const released = await registry.beginRelease(lease.id);

      expect(released.device).not.toHaveProperty("deferredReclaimLeaseId");
    });

    it.each([
      ["completeReclaimWithoutPurge", "shutdown"],
      ["markDeviceMissing", "deleted"],
    ] as const)(
      "drops the name when %s takes the device out of reclaiming",
      async (exit, expected) => {
        const { device, lease, registry } = await leased();
        await registry.beginRelease(lease.id, { deferReclaim: true });

        if (exit === "markDeviceMissing") await registry.markDeviceMissing(device.id, "doctor");
        else await registry.completeReclaimWithoutPurge(device.id);

        expect(registry.snapshot.devices[0]).toMatchObject({ state: expected });
        expect(registry.snapshot.devices[0]).not.toHaveProperty("deferredReclaimLeaseId");
      },
    );
  });
});
