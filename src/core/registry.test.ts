import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import {
  type DeviceSpec,
  Registry,
  RegistryEventError,
  UnknownDeviceError,
  UnknownLeaseError,
} from "./index.js";

const statePath = "/home/agent/.simlock/state.json";
const spec: DeviceSpec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" };

class ObservingFilesystem extends MemoryFilesystem {
  readonly operations: string[] = [];

  override async writeFileAtomic(path: string, contents: string): Promise<void> {
    this.operations.push("save");
    await super.writeFileAtomic(path, contents);
  }
}

describe("Registry: component records", () => {
  async function load(filesystem: MemoryFilesystem) {
    const clock = new FakeClock(1_000);
    return Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    });
  }

  it("keeps one record per platform and version, the latest install replacing the earlier one", async () => {
    const filesystem = new MemoryFilesystem();
    const registry = await load(filesystem);

    await registry.recordComponent({
      installedAt: 1,
      platform: "android",
      receipt: { stamp: "first" },
      version: "35",
    });
    await registry.recordComponent({
      installedAt: 2,
      platform: "ios",
      receipt: { image: "IMG" },
      version: "35",
    });
    await registry.recordComponent({
      installedAt: 3,
      platform: "android",
      receipt: { stamp: "second" },
      version: "35",
    });

    expect(registry.snapshot.components).toEqual([
      { installedAt: 2, platform: "ios", receipt: { image: "IMG" }, version: "35" },
      { installedAt: 3, platform: "android", receipt: { stamp: "second" }, version: "35" },
    ]);
  });

  it("deletes the record of one platform and version, keeps the others, and the deletion survives a reload", async () => {
    const filesystem = new MemoryFilesystem();
    const registry = await load(filesystem);
    for (const [platform, version] of [
      ["ios", "26.4"],
      ["ios", "27.0"],
      ["android", "26.4"],
    ] as const) {
      await registry.recordComponent({ installedAt: 1, platform, receipt: { version }, version });
    }

    await registry.deleteComponent("ios", "26.4");

    const kept = [
      { installedAt: 1, platform: "ios", receipt: { version: "27.0" }, version: "27.0" },
      { installedAt: 1, platform: "android", receipt: { version: "26.4" }, version: "26.4" },
    ];
    expect(registry.snapshot.components).toEqual(kept);
    expect((await load(filesystem)).snapshot.components).toEqual(kept);
  });

  it("drops a stored component record whose receipt is not all strings, and keeps the others", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        components: [
          { installedAt: 1, platform: "ios", receipt: { image: 7 }, version: "26.5" },
          { installedAt: 2, platform: "ios", receipt: { image: "IMG" }, version: "26.4" },
        ],
        devices: [],
        leases: [],
      }),
    );

    const registry = await load(filesystem);

    expect(registry.snapshot.components).toEqual([
      { installedAt: 2, platform: "ios", receipt: { image: "IMG" }, version: "26.4" },
    ]);
  });
});

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

    expect(registry.snapshot).toEqual({ components: [], devices: [], leases: [] });
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
        leaseIdentity: "reusable",
        spec,
        mode: "full",
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

  it("loads a registry written before leaseIdentity existed with every device reusable", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const legacy = (id: string, platform: "ios" | "android", state: string) => ({
      createdAt: 500,
      driverData: {},
      driverDeviceId: `driver_${id}`,
      id,
      lastLeaseEndedAt: 900,
      spec: { ...spec, platform },
      state,
    });
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [legacy("dev_ios", "ios", "shutdown"), legacy("dev_android", "android", "ready")],
        leases: [],
      }),
    );

    // Loaded under a config that says `fresh`: a record's policy comes from the record, and a
    // record with none was created under the only policy there was.
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "new" },
      leaseIdentity: { android: "fresh", ios: "fresh" },
      statePath,
    });

    expect(registry.snapshot.devices.map((device) => device.leaseIdentity)).toEqual([
      "reusable",
      "reusable",
    ]);
  });

  it("refuses to load a device record whose leaseIdentity is not a known policy", async () => {
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
            driverDeviceId: "driver_odd",
            id: "dev_odd",
            leaseIdentity: "disposable",
            spec,
            state: "ready",
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
    ).rejects.toThrow("Invalid device record");
  });

  it("stamps each registered device with its own platform's policy and keeps it across a reload under another", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    let nextId = 1;
    const idGenerator = { generate: () => `${nextId++}` };
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator,
      leaseIdentity: { android: "reusable", ios: "fresh" },
      statePath,
    });
    const ios = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_ios",
      provisionDuration: 0,
      spec,
    });
    const android = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_android",
      provisionDuration: 0,
      spec: { model: "Pixel 9", osVersion: "36", platform: "android" },
    });

    expect([ios.leaseIdentity, android.leaseIdentity]).toEqual(["fresh", "reusable"]);

    const reloaded = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator,
      leaseIdentity: { android: "fresh", ios: "reusable" },
      statePath,
    });
    expect(reloaded.snapshot.devices.map((device) => device.leaseIdentity)).toEqual([
      "fresh",
      "reusable",
    ]);
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

  it("reloads a lease written for a request with the request granted, holding the leased device, environment, lease and timing it was written with", async () => {
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
    await registry.createLeaseRequest({
      id: "req_1",
      ownerId: "agent-1",
      request: { platform: "ios" },
      requesterId: "agent-1",
    });
    const timing = {
      estimatedBootMs: 2,
      estimatedProvisionMs: 1,
      estimatedReadyMs: 4,
      estimatedReclaimMs: 3,
    };

    const lease = await registry.createLease({
      deviceId: device.id,
      ownerId: "agent-1",
      request: { environment: { SIMLOCK_UDID: "abc" }, id: "req_1", timing },
      requesterId: "agent-1",
      ttlDeadline: 2_000,
      ttlMs: 60_000,
    });
    const reloaded = await Registry.load(options);

    expect(reloaded.snapshot.leases).toEqual([lease]);
    expect(reloaded.leaseRequests()).toMatchObject([
      {
        grant: {
          device: reloaded.snapshot.devices[0],
          environment: { SIMLOCK_UDID: "abc" },
          lease,
          timing,
        },
        id: "req_1",
        state: "granted",
      },
    ]);
    expect(reloaded.snapshot.devices[0]).toMatchObject({ id: device.id, state: "leased" });
    expect(lease.id).toBe("lse_lease");
  });

  it("leaves a request already settled as it was when a lease is written for it", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "x" },
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
    await registry.createLeaseRequest({
      id: "req_1",
      ownerId: "agent-1",
      request: { platform: "ios" },
      requesterId: "agent-1",
    });
    await registry.settleLeaseRequest("req_1", {
      failure: { code: "INTERNAL", message: "gone" },
      state: "failed",
    });

    await registry.createLease({
      deviceId: device.id,
      ownerId: "agent-1",
      request: {
        environment: {},
        id: "req_1",
        timing: {
          estimatedBootMs: 0,
          estimatedProvisionMs: 0,
          estimatedReadyMs: 0,
          estimatedReclaimMs: 0,
        },
      },
      requesterId: "agent-1",
      ttlDeadline: 2_000,
      ttlMs: 60_000,
    });

    expect(registry.snapshot.leases).toHaveLength(1);
    expect(registry.leaseRequests()).toMatchObject([
      { failure: { code: "INTERNAL", message: "gone" }, id: "req_1", state: "failed" },
    ]);
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

  it("enters quarantine from shutdown, a spent fresh device's failed-delete entry point", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      leaseIdentity: { android: "reusable", ios: "fresh" },
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
    clock.advance(7_000);
    const shutDown = await registry.completeReclaimWithoutPurge(device.id);
    // Every path into `shutdown` stamps it, the reclaim's own included.
    expect(shutDown.shutdownAt).toBe(8_000);

    const quarantined = await registry.enterQuarantine(device.id, 5_000);

    expect(quarantined).toMatchObject({ quarantineNextRetryAt: 5_000, state: "quarantined" });
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

    const deleted = await registry.deleteQuarantined(device.id, "lease-end");

    expect(deleted.state).toBe("deleted");
    expect(events).toEqual([{ deviceId: device.id, initiator: "lease-end" }]);
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

  it("survives a save/reload round-trip with mode set to slim", async () => {
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
      { mode: "slim" },
    );

    const reloaded = await Registry.load(options);

    expect(reloaded.snapshot).toEqual(registry.snapshot);
    expect(reloaded.snapshot.devices[0]).toMatchObject({ mode: "slim" });
  });

  it("persists readyAt across a reload, and loads a record written before it without one", async () => {
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
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 5, deviceId: device.id },
    });

    clock.advance(5_000);
    await registry.transitionDevice(device.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: device.id, initiator: "test" },
    });
    const reloaded = await Registry.load(options);

    // Stamped on the move into `ready`, and left alone by a later move out of it.
    expect(reloaded.snapshot.devices[0]?.readyAt).toBe(1_000);
    expect(reloaded.snapshot.devices[0]?.shutdownAt).toBe(6_000);
    const state = JSON.parse(await filesystem.readFile(statePath)) as {
      devices: Record<string, unknown>[];
    };
    const [written] = state.devices;
    if (written === undefined) throw new Error("expected a written device");
    const { readyAt: _dropped, shutdownAt: _also, ...older } = written;
    await filesystem.writeFileAtomic(statePath, JSON.stringify({ ...state, devices: [older] }));
    const legacy = await Registry.load(options);
    expect(legacy.snapshot.devices[0]).not.toHaveProperty("readyAt");
    expect(legacy.snapshot.devices[0]).not.toHaveProperty("shutdownAt");
  });

  it("registers a new device as full", async () => {
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

    expect(device.mode).toBe("full");
  });

  // ADR 0007 §11: no mode is derived from the old key, whatever it said, and the old key is not
  // carried forward as an unknown field either.
  it.each([
    ["no featureProfile", {}],
    ['featureProfile "reduced"', { featureProfile: "reduced" }],
    ['featureProfile "full"', { featureProfile: "full" }],
  ])(
    "loads a record written before mode existed as full (%s) and does not write featureProfile back",
    async (_label, legacyFields) => {
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
              spec,
              state: "ready",
              ...legacyFields,
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

      expect(registry.snapshot.devices[0]?.mode).toBe("full");

      // Any commit rewrites the whole file, legacy record included.
      await registry.registerDevice({
        driverData: {},
        driverDeviceId: "driver_new",
        provisionDuration: 0,
        spec,
      });
      const written = JSON.parse(await filesystem.readFile(statePath)) as {
        devices: Record<string, unknown>[];
      };
      const legacy = written.devices.find((device) => device.id === "dev_legacy");
      expect(legacy).toMatchObject({ mode: "full" });
      expect(legacy).not.toHaveProperty("featureProfile");
    },
  );

  it("fails the load when a stored mode is neither slim nor full", async () => {
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
            id: "dev_garbage",
            mode: "reduced",
            spec,
            state: "ready",
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

  describe("a stored spec's mode", () => {
    async function loadDevice(storedSpec: Record<string, unknown>) {
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
              driverDeviceId: "driver_stored",
              id: "dev_stored",
              mode: "full",
              spec: storedSpec,
              state: "ready",
            },
          ],
          leases: [],
        }),
      );
      const load = () =>
        Registry.load({
          clock,
          eventBus: new EventBus(clock),
          filesystem,
          idGenerator: { generate: () => "new" },
          statePath,
        });
      return { filesystem, load };
    }

    it.each([true, false])(
      "ignores a stored spec.full of %s and does not write it back",
      async (full) => {
        const { filesystem, load } = await loadDevice({ ...spec, full });
        const registry = await load();

        expect(registry.snapshot.devices[0]?.spec).toEqual(spec);

        await registry.registerDevice({
          driverData: {},
          driverDeviceId: "driver_new",
          provisionDuration: 0,
          spec,
        });
        const written = JSON.parse(await filesystem.readFile(statePath)) as {
          devices: { id: string; spec: Record<string, unknown> }[];
        };
        expect(written.devices.find((device) => device.id === "dev_stored")?.spec).toEqual(spec);
      },
    );

    it("loads a stored slim spec as slim", async () => {
      const { load } = await loadDevice({ ...spec, mode: "slim" });

      expect((await load()).snapshot.devices[0]?.spec).toEqual({ ...spec, mode: "slim" });
    });

    it("loads a stored spec's image tag", async () => {
      const { load } = await loadDevice({ ...spec, imageTag: "google_apis_playstore" });

      expect((await load()).snapshot.devices[0]?.spec).toEqual({
        ...spec,
        imageTag: "google_apis_playstore",
      });
    });

    it("fails the load on a stored spec.imageTag that is not a string", async () => {
      const { load } = await loadDevice({ ...spec, imageTag: 7 });

      await expect(load()).rejects.toThrow("Invalid device record in registry state");
    });

    it.each(["full", "reduced"])("fails the load on a stored spec.mode of %s", async (mode) => {
      const { load } = await loadDevice({ ...spec, mode });

      await expect(load()).rejects.toThrow("Invalid device record in registry state");
    });
  });

  it("records the planned mode of a slim spec on the device it registers", async () => {
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
      spec: { ...spec, mode: "slim" },
    });

    expect(device.spec).toEqual({ ...spec, mode: "slim" });
    expect(device.mode).toBe("full");
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

  describe("a reclaim put off at a daemon start", () => {
    async function leased() {
      const clock = new FakeClock(1_000);
      const options = {
        clock,
        eventBus: new EventBus(clock),
        filesystem: new MemoryFilesystem(),
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
      expect((await Registry.load(options)).snapshot.devices[0]).toMatchObject({
        deferredReclaimLeaseId: lease.id,
      });
    });

    it("names no lease on a release that does not defer", async () => {
      const { lease, registry } = await leased();

      const released = await registry.beginRelease(lease.id);

      expect(released.device).not.toHaveProperty("deferredReclaimLeaseId");
    });

    it("drops the name when the device leaves reclaiming", async () => {
      const { device, lease, registry } = await leased();
      await registry.beginRelease(lease.id, { deferReclaim: true });

      await registry.completeReclaimWithoutPurge(device.id);

      expect(registry.snapshot.devices[0]).toMatchObject({ state: "shutdown" });
      expect(registry.snapshot.devices[0]).not.toHaveProperty("deferredReclaimLeaseId");
    });

    it("drops the name when doctor marks the waiting device missing", async () => {
      const { device, lease, registry } = await leased();
      await registry.beginRelease(lease.id, { deferReclaim: true });

      await registry.markDeviceMissing(device.id, "doctor");

      expect(registry.snapshot.devices[0]).toMatchObject({ state: "deleted" });
      expect(registry.snapshot.devices[0]).not.toHaveProperty("deferredReclaimLeaseId");
    });

    it("rejects a non-string name when loading persisted state", async () => {
      const clock = new FakeClock(1_000);
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(
        statePath,
        JSON.stringify({
          devices: [
            {
              createdAt: 500,
              deferredReclaimLeaseId: 7,
              driverData: {},
              driverDeviceId: "driver_bad",
              id: "dev_bad",
              spec,
              state: "reclaiming",
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

    it("rejects a non-string address when loading persisted state", async () => {
      const clock = new FakeClock(1_000);
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(
        statePath,
        JSON.stringify({
          devices: [
            {
              createdAt: 500,
              address: 7,
              driverData: {},
              driverDeviceId: "driver_bad",
              id: "dev_bad",
              spec,
              state: "reclaiming",
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
  });

  it("writes a device the same way whether it is marked missing alone or together with its lease's end", async () => {
    const marked = async (viaLease: boolean) => {
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
      await registry.markRecoveryAttempt(device.id, 1_500);
      if (viaLease) {
        const lease = await registry.createLease({
          deviceId: device.id,
          requesterId: "agent-1",
          ownerId: "agent-1",
          ttlMs: 60_000,
          ttlDeadline: 2_000,
        });
        await registry.endLeaseAndMarkDeviceMissing(lease.id, "doctor", () => undefined);
      } else {
        await registry.markDeviceMissing(device.id, "doctor");
      }
      return registry.snapshot.devices[0];
    };

    const viaLease = await marked(true);
    const alone = await marked(false);

    expect(alone).toEqual(viaLease);
    expect(viaLease).toEqual({
      createdAt: 1_000,
      driverData: {},
      driverDeviceId: "driver_test",
      id: "dev_test",
      leaseIdentity: "reusable",
      mode: "full",
      readyAt: 1_000,
      spec,
      state: "deleted",
    });
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

  it("a state file without idChosenByRequester loads every lease as false", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const lease = (id: string, deviceId: string) => ({
      deviceId,
      grantedAt: 1_000,
      id,
      lastRenewedAt: 1_000,
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlDeadline: 2_000,
      ttlMs: 60_000,
    });
    const device = (id: string) => ({
      createdAt: 1_000,
      driverData: {},
      driverDeviceId: `driver_${id}`,
      id,
      spec,
      state: "leased",
    });
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [device("dev_1"), device("dev_2")],
        leases: [lease("lse_1", "dev_1"), lease("ad-7f3a", "dev_2")],
      }),
    );

    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "unexpected" },
      statePath,
    });

    expect(registry.snapshot.leases.map((loaded) => [loaded.id, loaded])).toEqual([
      ["lse_1", expect.objectContaining({ idChosenByRequester: false })],
      ["ad-7f3a", expect.objectContaining({ idChosenByRequester: false })],
    ]);
  });

  it("writes idChosenByRequester true for a lease created with a leaseId, false without one, and keeps both across a reload", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    let next = 0;
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => String((next += 1)) },
      statePath,
    };
    const registry = await Registry.load(options);
    const ready = async (driverDeviceId: string) => {
      const device = await registry.registerDevice({
        driverData: {},
        driverDeviceId,
        provisionDuration: 0,
        spec,
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      return device.id;
    };
    const base = { ownerId: "agent-1", requesterId: "agent-1", ttlDeadline: 2_000, ttlMs: 60_000 };

    const chosen = await registry.createLease({
      ...base,
      deviceId: await ready("one"),
      leaseId: "ad-7f3a",
    } as Parameters<Registry["createLease"]>[0]);
    const generated = await registry.createLease({ ...base, deviceId: await ready("two") });

    expect(chosen).toMatchObject({ id: "ad-7f3a", idChosenByRequester: true });
    expect(generated).toMatchObject({
      id: expect.stringMatching(/^lse_/),
      idChosenByRequester: false,
    });
    const reloaded = await Registry.load(options);
    expect(reloaded.snapshot.leases).toEqual([chosen, generated]);
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

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["not a number", "soon"],
    ["not finite", Number.POSITIVE_INFINITY],
  ])("falls back to the default width for a %s ttlMs on disk", async (_label, stored) => {
    // A stored width has to be a positive, finite duration: `0` or a negative one would make
    // every renewal of this lease resolve to a deadline in the past, which the expiry
    // scheduler reads as "expire immediately". An unusable value takes the same default an
    // absent one does -- refusing the whole registry over one field would cost the operator
    // every device Simlock knows about.
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock(5_000);
    await filesystem.mkdirp("/home/agent/.simlock");
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
            lastRenewedAt: 1_500,
            ownerId: "agent-1",
            requesterId: "agent-1",
            ttlDeadline: 2_000,
            ttlMs: stored,
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

    expect(registry.snapshot.leases).toMatchObject([{ id: "lse_1", ttlMs: 900_000 }]);
    // A `lastRenewedAt` that is usable is kept as it is -- only the unusable field migrates.
    expect(registry.snapshot.leases[0]?.lastRenewedAt).toBe(1_500);
  });

  it("falls back to grantedAt for an unusable lastRenewedAt on disk", async () => {
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock(5_000);
    await filesystem.mkdirp("/home/agent/.simlock");
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
            lastRenewedAt: null,
            ownerId: "agent-1",
            requesterId: "agent-1",
            ttlDeadline: 2_000,
            ttlMs: 60_000,
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

    // Unlike a width, a timestamp of `0` is a legitimate answer, so only non-numbers and
    // non-finite values migrate -- and the stored width is untouched.
    expect(registry.snapshot.leases).toMatchObject([
      { id: "lse_1", lastRenewedAt: 1_000, ttlMs: 60_000 },
    ]);
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

  it("removes a lease and marks its device deleted in one write, announcing the lease before device.deleted, both after the commit", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new ObservingFilesystem();
    const bus = new EventBus(clock);
    const suffixes = ["device", "lease"];
    const options = {
      clock,
      eventBus: bus,
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
    await registry.markRecoveryAttempt(device.id, 1_500);
    bus.subscribe("device.deleted", () => filesystem.operations.push("device.deleted"));
    filesystem.operations.length = 0;

    const ended = await registry.endLeaseAndMarkDeviceMissing(lease.id, "doctor", () =>
      filesystem.operations.push("lease announced"),
    );

    expect(filesystem.operations).toEqual(["save", "lease announced", "device.deleted"]);
    expect(ended.lease).toEqual(lease);
    expect(ended.device).toMatchObject({ id: device.id, state: "deleted" });
    expect(ended.device).not.toHaveProperty("recoveryAttempts");
    expect(registry.snapshot.leases).toEqual([]);
    expect(registry.snapshot.devices).toEqual([ended.device]);
    expect((await Registry.load(options)).snapshot).toEqual(registry.snapshot);
    expect(bus.replay().filter((entry) => entry.event === "device.deleted")).toMatchObject([
      { payload: { deviceId: device.id, initiator: "doctor" } },
    ]);
  });

  it("ends only the named lease and marks only its device deleted, leaving every other lease and device as they were, with the event's module registry", async () => {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    let next = 0;
    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => String(next++) },
      statePath,
    });
    const leases = [];
    for (const name of ["one", "two"]) {
      const device = await registry.registerDevice({
        driverData: {},
        driverDeviceId: `driver_${name}`,
        provisionDuration: 0,
        spec,
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      leases.push(
        await registry.createLease({
          deviceId: device.id,
          requesterId: name,
          ownerId: name,
          ttlMs: 60_000,
          ttlDeadline: 2_000,
        }),
      );
    }
    const [first, second] = leases;
    if (first === undefined || second === undefined) throw new Error("leases not created");

    await registry.endLeaseAndMarkDeviceMissing(second.id, "doctor", () => undefined);

    expect(registry.snapshot.leases).toEqual([first]);
    expect(registry.snapshot.devices.map((device) => [device.id, device.state])).toEqual([
      [first.deviceId, "leased"],
      [second.deviceId, "deleted"],
    ]);
    expect(bus.replay().filter((entry) => entry.event === "device.deleted")).toMatchObject([
      { module: "registry", payload: { deviceId: second.deviceId, initiator: "doctor" } },
    ]);
  });

  it("refuses to end a lease it does not hold, writing nothing and announcing nothing", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new ObservingFilesystem();
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    });
    let announced = false;

    await expect(
      registry.endLeaseAndMarkDeviceMissing("lse_nope", "doctor", () => {
        announced = true;
      }),
    ).rejects.toThrow(UnknownLeaseError);

    expect(announced).toBe(false);
    expect(filesystem.operations).toEqual([]);
  });
});
