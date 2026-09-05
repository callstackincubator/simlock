import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { type DeviceSpec, Registry, RegistryEventError, UnknownDeviceError } from "./index.js";

const statePath = "/home/agent/.simlock/state.json";
const spec: DeviceSpec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" };

class ObservingFilesystem extends MemoryFilesystem {
  readonly operations: string[] = [];

  override async writeFileAtomic(path: string, contents: string): Promise<void> {
    this.operations.push("save");
    await super.writeFileAtomic(path, contents);
  }
}

describe("Registry", () => {
  it("loads an empty registry when no state file exists", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });

    expect(registry.snapshot).toEqual({ devices: [], leases: [] });
  });

  it("atomically persists a registered device before emitting device.provisioned", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new ObservingFilesystem();
    const bus = new EventBus(clock);
    bus.subscribe("device.provisioned", () => filesystem.operations.push("event"));
    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    });

    await registry.registerDevice({
      driverData: { driverOnly: "value" },
      driverDeviceId: "driver_test",
      provisionDuration: 25,
      spec,
    });

    expect(filesystem.operations).toEqual(["save", "event"]);
    await expect(filesystem.readFile(statePath)).resolves.toMatch(/"id":"dev_test"/);
    expect(registry.snapshot.devices).toEqual([
      {
        createdAt: 1_000,
        driverData: { driverOnly: "value" },
        driverDeviceId: "driver_test",
        id: "dev_test",
        spec,
        state: "provisioning",
      },
    ]);
  });

  it("restores persisted device records after a reload", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    };
    const registry = await Registry.load(options);
    await registry.registerDevice({
      driverData: { driverOnly: "value" },
      driverDeviceId: "driver_test",
      provisionDuration: 25,
      spec,
    });

    const reloaded = await Registry.load(options);

    expect(reloaded.snapshot).toEqual(registry.snapshot);
  });

  it("loads a legacy warm record as busy reclaiming rather than eligible ready inventory", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 500,
            driverData: {},
            driverDeviceId: "driver_legacy",
            id: "dev_legacy",
            lastLeaseEndedAt: 900,
            spec,
            state: "warm",
          },
        ],
        leases: [],
      }),
    );

    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "new" },
      statePath,
    });

    expect(registry.snapshot.devices).toMatchObject([{ id: "dev_legacy", state: "reclaiming" }]);
  });

  it("preserves unknown persisted fields when saving a later mutation", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 500,
            driverData: { driverOnly: "existing" },
            driverDeviceId: "driver_existing",
            futureDeviceField: "keep me",
            id: "dev_existing",
            spec,
            state: "provisioning",
          },
        ],
        futureTopLevelField: { version: 2 },
        leases: [],
      }),
    );
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "new" },
      statePath,
    });

    await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_new",
      provisionDuration: 0,
      spec,
    });

    const saved = JSON.parse(await filesystem.readFile(statePath)) as {
      readonly devices: Array<Record<string, unknown>>;
      readonly futureTopLevelField: unknown;
    };
    expect(saved.futureTopLevelField).toEqual({ version: 2 });
    expect(saved.devices[0]).toMatchObject({ futureDeviceField: "keep me" });
  });

  it("persists a transition before emitting its device.ready fact", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new ObservingFilesystem();
    const bus = new EventBus(clock);
    bus.subscribe("device.ready", () => filesystem.operations.push("event"));
    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    filesystem.operations.length = 0;

    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 50, deviceId: device.id },
    });

    expect(filesystem.operations).toEqual(["save", "event"]);
    expect(registry.snapshot.devices[0]?.state).toBe("ready");
  });

  it("rejects a device event whose payload identifies another device", async () => {
    const clock = new FakeClock();
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });

    await expect(
      registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: "dev_someone_else" },
      }),
    ).rejects.toThrow(RegistryEventError);
    expect(registry.snapshot.devices[0]?.state).toBe("provisioning");
  });

  it("round-trips leases and never deletes a device with an active lease", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const suffixes = ["device", "lease"];
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => suffixes.shift() ?? "unexpected" },
      statePath,
    };
    const registry = await Registry.load(options);
    const device = await registry.registerDevice({
      driverData: {},
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
    const reloaded = await Registry.load(options);

    expect(lease).toMatchObject({ deviceId: device.id, id: "lse_lease", grantedAt: 1_000 });
    expect(reloaded.snapshot).toEqual(registry.snapshot);

    await registry.transitionDevice(device.id, "reclaiming");
    await registry.transitionDevice(device.id, "shutdown", {
      event: "device.reclaimed",
      payload: { deviceId: device.id, duration: 1, strategy: "erase" },
    });
    await expect(
      registry.transitionDevice(device.id, "deleted", {
        event: "device.deleted",
        payload: { deviceId: device.id, initiator: "test" },
      }),
    ).rejects.toThrow(RegistryEventError);
  });

  it("enters quarantine from reclaiming, tracking attempts and the next retry deadline", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
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

    const quarantined = await registry.enterQuarantine(device.id, 5_000);

    expect(quarantined).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 5_000,
      quarantinedAt: 1_000,
      state: "quarantined",
    });
    await expect(registry.enterQuarantine(device.id, 6_000)).rejects.toThrow(RegistryEventError);
  });

  it("enters quarantine from provisioning, its stalled-transition entry point", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });

    const quarantined = await registry.enterQuarantine(device.id, 5_000);

    expect(quarantined).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 5_000,
      quarantinedAt: 1_000,
      state: "quarantined",
    });
  });

  it("refuses to quarantine a device that is still leased", async () => {
    // Quarantine is a post-release disposition: it is only ever entered from `reclaiming`, which
    // a device reaches by having its lease released. A leased device reaching it would mean
    // pulling a device out from under its holder -- the one thing safety rule 2 forbids outright.
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
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

    await expect(registry.enterQuarantine(device.id, 5_000)).rejects.toThrow(RegistryEventError);
    expect(registry.snapshot.devices[0]?.state).toBe("leased");
  });

  it("records a quarantine retry failure without leaving quarantined", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
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
    await registry.enterQuarantine(device.id, 5_000);

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
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
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
    await registry.enterQuarantine(device.id, 5_000);

    const recovered = await registry.recoverFromQuarantine(device.id, "ready");

    expect(recovered).toEqual({
      createdAt: 1_000,
      driverData: {},
      driverDeviceId: "driver_test",
      id: device.id,
      lastLeaseEndedAt: 1_000,
      spec,
      state: "ready",
    });
    await expect(registry.recoverFromQuarantine(device.id, "ready")).rejects.toThrow(
      RegistryEventError,
    );
  });

  it("abandons a quarantined device to deleted and emits device.deleted", async () => {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const events: string[] = [];
    bus.subscribe("device.deleted", (envelope) => events.push(envelope.event));
    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
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
    await registry.enterQuarantine(device.id, 5_000);

    const abandoned = await registry.abandonQuarantine(device.id);

    expect(abandoned.state).toBe("deleted");
    expect(events).toEqual(["device.deleted"]);
  });

  it("rejects mutations for a device that is not registered", async () => {
    const clock = new FakeClock();
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
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

  it("records the first recovery attempt's start time and count", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });

    const updated = await registry.markRecoveryAttempt(device.id, 1_500);

    expect(updated).toMatchObject({ recoveringSince: 1_500, recoveryAttempts: 1 });
  });

  it("keeps the original recoveringSince and increments the attempt count on retry", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.markRecoveryAttempt(device.id, 1_500);

    const updated = await registry.markRecoveryAttempt(device.id, 2_000);

    expect(updated).toMatchObject({ recoveringSince: 1_500, recoveryAttempts: 2 });
  });

  it("clears both recovery markers", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.markRecoveryAttempt(device.id, 1_500);

    const cleared = await registry.clearRecovery(device.id);

    expect(cleared.recoveringSince).toBeUndefined();
    expect(cleared.recoveryAttempts).toBeUndefined();
  });

  it("survives a save/reload round-trip with recovery markers set", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    };
    const registry = await Registry.load(options);
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.markRecoveryAttempt(device.id, 1_500);

    const reloaded = await Registry.load(options);

    expect(reloaded.snapshot).toEqual(registry.snapshot);
    expect(reloaded.snapshot.devices[0]).toMatchObject({
      recoveringSince: 1_500,
      recoveryAttempts: 1,
    });
  });

  it("rejects non-numeric recovery markers when loading persisted state", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 500,
            driverData: {},
            driverDeviceId: "driver_bad",
            id: "dev_bad",
            recoveringSince: "not-a-number",
            spec,
            state: "leased",
          },
        ],
        leases: [],
      }),
    );

    await expect(
      Registry.load({
        clock,
        eventBus: new EventBus(clock),
        filesystem,
        idGenerator: { generate: () => "new" },
        statePath,
      }),
    ).rejects.toThrow("Invalid device record in registry state");
  });

  it("survives a save/reload round-trip with featureProfile set", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    };
    const registry = await Registry.load(options);
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(
      device.id,
      "ready",
      { event: "device.ready", payload: { bootDuration: 5, deviceId: device.id } },
      { featureProfile: "reduced" },
    );

    const reloaded = await Registry.load(options);

    expect(reloaded.snapshot).toEqual(registry.snapshot);
    expect(reloaded.snapshot.devices[0]).toMatchObject({ featureProfile: "reduced" });
  });

  it("leaves featureProfile absent when the persisted record never set it", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 500,
            driverData: {},
            driverDeviceId: "driver_no_profile",
            id: "dev_no_profile",
            spec,
            state: "ready",
          },
        ],
        leases: [],
      }),
    );

    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "new" },
      statePath,
    });

    expect(registry.snapshot.devices[0]).not.toHaveProperty("featureProfile");
  });

  it("drops a garbage featureProfile rather than failing the whole registry load", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 500,
            driverData: {},
            driverDeviceId: "driver_garbage",
            featureProfile: "not-a-real-profile",
            id: "dev_garbage",
            spec,
            state: "ready",
          },
        ],
        leases: [],
      }),
    );

    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "new" },
      statePath,
    });

    expect(registry.snapshot.devices[0]).not.toHaveProperty("featureProfile");
  });

  it("clears recovery markers as part of the same commit that ends a lease", async () => {
    const clock = new FakeClock(1_000);
    const suffixes = ["device", "lease"];
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => suffixes.shift() ?? "unexpected" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
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
  });

  it("loads a lease record written before ownerId existed with ownerId defaulted to requesterId (ADR 0003 §4)", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            id: "dev_1",
            driverDeviceId: "driver_device",
            spec,
            state: "leased",
            driverData: {},
            createdAt: 1_000,
          },
        ],
        leases: [
          {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "agent-1",
            grantedAt: 1_000,
            lastRenewedAt: 1_000,
            ttlMs: 60_000,
            ttlDeadline: 2_000,
            // No `ownerId` -- exactly what a pre-ADR-0003 daemon wrote.
          },
        ],
      }),
    );

    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "unexpected" },
      statePath,
    });

    expect(registry.snapshot.leases).toEqual([
      {
        id: "lse_1",
        deviceId: "dev_1",
        requesterId: "agent-1",
        ownerId: "agent-1",
        grantedAt: 1_000,
        lastRenewedAt: 1_000,
        ttlMs: 60_000,
        ttlDeadline: 2_000,
      },
    ]);

    // The migrated default round-trips through a further save/reload unchanged, and the
    // written file now carries `ownerId` explicitly (it is no longer an "unknown field"
    // preserved verbatim -- see `#unknownLeaseFields` -- but the registry's own understanding
    // of the record).
    await registry.renewLease("lse_1", 3_000, 60_000);
    const reloaded = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "unexpected" },
      statePath,
    });
    expect(reloaded.snapshot.leases).toEqual(registry.snapshot.leases);
    expect(reloaded.snapshot.leases[0]?.ownerId).toBe("agent-1");
  });

  it("migrates a lease record written before ADR 0004's ttlMs/lastRenewedAt, dropping mode", async () => {
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock(5_000);
    await filesystem.mkdirp("/home/agent/.simlock");
    // Exactly what a pre-ADR-0004 daemon persisted: a `mode`, and neither of the two fields a
    // record carries now. Neither is recoverable from what is on disk -- `ttlDeadline -
    // grantedAt` is the grant-time width only until the first renewal moved the deadline -- so
    // each takes its documented default rather than a guess dressed up as arithmetic.
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 0,
            driverData: {},
            driverDeviceId: "driver_1",
            id: "dev_1",
            spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
            state: "leased",
          },
        ],
        leases: [
          {
            deviceId: "dev_1",
            grantedAt: 1_000,
            id: "lse_1",
            mode: "held",
            ownerId: "agent-1",
            requesterId: "agent-1",
            ttlDeadline: 2_000,
          },
        ],
      }),
    );

    const registry = await Registry.load({
      clock,
      defaultTtlMs: 900_000,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "unexpected" },
      statePath,
    });

    expect(registry.snapshot.leases).toEqual([
      {
        id: "lse_1",
        deviceId: "dev_1",
        requesterId: "agent-1",
        ownerId: "agent-1",
        grantedAt: 1_000,
        // `lease.defaultTtlMs`, which the daemon passes in from its own config.
        ttlMs: 900_000,
        ttlDeadline: 2_000,
        // A lease that has never been renewed reports the moment it was granted.
        lastRenewedAt: 1_000,
      },
    ]);

    // `mode` is a retired concept, not a field from a newer schema, so the next write drops it
    // rather than preserving it through the unknown-field forward-compatibility path.
    await registry.renewLease("lse_1", 9_000, 7_000);
    const written = JSON.parse(await filesystem.readFile(statePath)) as {
      leases: Record<string, unknown>[];
    };
    expect(written.leases[0]).toEqual({
      deviceId: "dev_1",
      grantedAt: 1_000,
      id: "lse_1",
      lastRenewedAt: 5_000,
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlDeadline: 9_000,
      ttlMs: 7_000,
    });
  });

  it("rejects a lease record whose ownerId is present but not a string", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [],
        leases: [
          {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "agent-1",
            ownerId: 42,
            grantedAt: 1_000,
            lastRenewedAt: 1_000,
            ttlMs: 60_000,
            ttlDeadline: 2_000,
          },
        ],
      }),
    );

    await expect(
      Registry.load({
        clock,
        eventBus: new EventBus(clock),
        filesystem,
        idGenerator: { generate: () => "unexpected" },
        statePath,
      }),
    ).rejects.toThrow(/Invalid lease record/);
  });
});
