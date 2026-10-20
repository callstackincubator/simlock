import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import {
  type DeviceRecord,
  type VirtualSpec,
  Registry,
  RegistryEventError,
  UnknownDeviceError,
  UnknownLeaseError,
  transitionEnteredAt,
} from "./index.js";

const statePath = "/home/agent/.simlock/state.json";
const spec: VirtualSpec = {
  physical: false,
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
};

class ObservingFilesystem extends MemoryFilesystem {
  readonly operations: string[] = [];

  override async writeFileAtomic(
    path: string,
    contents: string,
    options?: { mode?: number },
  ): Promise<void> {
    this.operations.push("save");
    await super.writeFileAtomic(path, contents, options);
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

    expect(registry.snapshot).toEqual({
      components: [],
      devices: [],
      leases: [],
      virtualDevices: [],
    });
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
        physical: false,
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

  it("writes state.json owner-only, mode 0o600, as the daemon's local-state guarantee says", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    });

    await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 25,
      spec,
    });

    expect((await filesystem.stat(statePath)).mode).toBe(0o600);
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
      physical: false,
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
      spec: { physical: false, model: "Pixel 9", osVersion: "36", platform: "android" },
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

  it.each([
    ["ios", spec],
    [
      "android",
      { physical: false, model: "Pixel 8", osVersion: "35", platform: "android" } as VirtualSpec,
    ],
  ] as const)(
    "emits device.ready with the device's own platform, for an %s device",
    async (platform, deviceSpec) => {
      const clock = new FakeClock(1_000);
      const bus = new EventBus(clock);
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
        spec: deviceSpec,
      });

      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 50, deviceId: device.id },
      });

      expect(bus.replay().find((event) => event.event === "device.ready")?.payload).toEqual({
        bootDuration: 50,
        deviceId: device.id,
        platform,
      });
    },
  );

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

    const quarantined = await registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" });

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

    await expect(
      registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" }),
    ).rejects.toThrow(RegistryEventError);
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
    await registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" });

    const recovered = await registry.recoverFromQuarantine(device.id, "ready");

    expect(recovered).toEqual({
      physical: false,
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
    await registry.enterQuarantine(device.id, 5_000, { kind: "purge-failed" });

    const deleted = await registry.deleteQuarantined(device.id, "lease-end");

    expect(deleted.state).toBe("deleted");
    expect(events).toEqual([{ deviceId: device.id, initiator: "lease-end", physical: false }]);
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
        const { physical: _physical, ...stored } = spec;
        expect(written.devices.find((device) => device.id === "dev_stored")?.spec).toEqual(stored);
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
      physical: false,
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
        idChosenByRequester: false,
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
      physical: false,
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

  it("keeps the leaseId a request stored across a reload, and loads a record without one as having none", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "unexpected" },
      statePath,
    };
    const registry = await Registry.load(options);
    await registry.createLeaseRequest({
      id: "req_1",
      ownerId: "agent-1",
      request: { platform: "ios" },
      requesterId: "agent-1",
      leaseId: "ad-7f3a",
    });
    await registry.createLeaseRequest({
      id: "req_2",
      ownerId: "agent-2",
      request: { platform: "ios" },
      requesterId: "agent-2",
    });

    const reloaded = await Registry.load(options);

    expect(reloaded.leaseRequests()).toMatchObject([
      { id: "req_1", leaseId: "ad-7f3a" },
      { id: "req_2" },
    ]);
    expect(reloaded.leaseRequests()[1]).not.toHaveProperty("leaseId");
  });

  it("keeps the fleetRequestId a request stored across a reload, and loads a record without one as having none", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "unexpected" },
      statePath,
    };
    const registry = await Registry.load(options);
    await registry.createLeaseRequest({
      fleetRequestId: "req_gw1",
      id: "req_1",
      ownerId: "agent-1",
      request: { platform: "ios" },
      requesterId: "agent-1",
    });
    await registry.createLeaseRequest({
      id: "req_2",
      ownerId: "agent-2",
      request: { platform: "ios" },
      requesterId: "agent-2",
    });

    const reloaded = await Registry.load(options);

    expect(reloaded.leaseRequests()).toMatchObject([
      { fleetRequestId: "req_gw1", id: "req_1" },
      { id: "req_2" },
    ]);
    expect(reloaded.leaseRequests()[1]).not.toHaveProperty("fleetRequestId");
  });

  it("drops a stored lease request whose fleetRequestId is not a string and keeps the others", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const open = (id: string, extra: Record<string, unknown>) => ({
      createdAt: 1_000,
      id,
      ownerId: "agent-1",
      request: { platform: "ios" },
      requesterId: "agent-1",
      state: "open",
      ...extra,
    });
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [],
        leaseRequests: [
          open("req_bad", { fleetRequestId: 7 }),
          open("req_ok", { fleetRequestId: "req_gw1" }),
        ],
        leases: [],
      }),
    );

    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "unexpected" },
      statePath,
    });

    expect(registry.leaseRequests().map((record) => record.id)).toEqual(["req_ok"]);
  });

  it("drops a stored lease request whose leaseId is not a string and keeps the others", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const open = (id: string, extra: Record<string, unknown>) => ({
      createdAt: 1_000,
      id,
      ownerId: "agent-1",
      request: { platform: "ios" },
      requesterId: "agent-1",
      state: "open",
      ...extra,
    });
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [],
        leaseRequests: [open("req_bad", { leaseId: 7 }), open("req_ok", { leaseId: "ad-7f3a" })],
        leases: [],
      }),
    );

    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "unexpected" },
      statePath,
    });

    expect(registry.leaseRequests().map((record) => record.id)).toEqual(["req_ok"]);
  });

  it("keeps idChosenByRequester true on the lease of a stored grant across a reload", async () => {
    const clock = new FakeClock(1_000);
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "x" },
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
      leaseId: "ad-7f3a",
      ownerId: "agent-1",
      request: { platform: "ios" },
      requesterId: "agent-1",
    });
    await registry.createLease({
      deviceId: device.id,
      leaseId: "ad-7f3a",
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

    const reloaded = await Registry.load(options);

    expect(reloaded.leaseRequests()[0]?.grant?.lease).toMatchObject({
      id: "ad-7f3a",
      idChosenByRequester: true,
    });
  });

  it("loads the lease of a stored grant written before idChosenByRequester as one simlock named", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const lease = {
      deviceId: "dev_1",
      grantedAt: 1_000,
      id: "lse_1",
      lastRenewedAt: 1_000,
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlDeadline: 2_000,
      ttlMs: 60_000,
    };
    const device = {
      physical: false,
      createdAt: 1_000,
      driverData: {},
      driverDeviceId: "driver_dev_1",
      id: "dev_1",
      spec,
      state: "leased",
    };
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [device],
        leaseRequests: [
          {
            createdAt: 1_000,
            grant: { device, environment: {}, lease, timing: {} },
            id: "req_1",
            ownerId: "agent-1",
            request: { platform: "ios" },
            requesterId: "agent-1",
            settledAt: 1_000,
            state: "granted",
          },
        ],
        leases: [lease],
      }),
    );

    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "unexpected" },
      statePath,
    });

    expect(registry.leaseRequests()[0]?.grant?.lease).toMatchObject({
      id: "lse_1",
      idChosenByRequester: false,
    });
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
    });
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
        idChosenByRequester: false,
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
      idChosenByRequester: false,
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

describe("Registry: the device event a transition carries", () => {
  async function provisioned() {
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
      driverDeviceId: "driver_x",
      provisionDuration: 0,
      spec,
    });
    return { device, registry };
  }

  it("names the event a transition requires when it comes without one or with another", async () => {
    const { device, registry } = await provisioned();

    await expect(registry.transitionDevice(device.id, "ready")).rejects.toThrow(
      "Transition from provisioning to ready requires device.ready device event",
    );
    await expect(
      registry.transitionDevice(device.id, "ready", {
        event: "device.shutdown",
        payload: { deviceId: device.id, initiator: "test" },
      }),
    ).rejects.toThrow("requires device.ready device event");
    expect(registry.snapshot.devices[0]?.state).toBe("provisioning");
  });

  it("says a transition requires no event when it comes with one", async () => {
    const { device, registry } = await provisioned();

    await expect(
      registry.transitionDevice(device.id, "quarantined", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      }),
    ).rejects.toThrow("Transition from provisioning to quarantined requires no device event");
  });

  it("refuses an event whose payload names another device", async () => {
    const { device, registry } = await provisioned();

    await expect(
      registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: "dev_other" },
      }),
    ).rejects.toThrow(`Device event payload does not match device: ${device.id}`);
  });
});

describe("Registry: physical devices (ADR 0022 §1)", () => {
  const virtualRecord = {
    createdAt: 500,
    driverData: {},
    driverDeviceId: "driver_virtual",
    id: "dev_virtual",
    mode: "full",
    spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    state: "ready",
  };
  const physicalSpec = {
    class: "phone",
    model: "iPhone 15 Pro",
    osVersion: "18.4",
    physical: true,
    platform: "ios",
  };
  const physicalRecord = {
    address: "00008110-001A2B3C4D5E",
    createdAt: 600,
    driverData: { note: "kept" },
    driverDeviceId: "00008110-001A2B3C4D5E",
    enrolledApps: ["com.example.one", "com.example.two"],
    id: "dev_physical",
    physical: true,
    spec: physicalSpec,
    state: "ready",
  };
  const lease = {
    deviceId: "dev_physical",
    grantedAt: 700,
    id: "lse_physical",
    idChosenByRequester: false,
    lastRenewedAt: 700,
    ownerId: "agent",
    requesterId: "agent",
    ttlDeadline: 90_000,
    ttlMs: 60_000,
  };

  async function stateFile(state: Record<string, unknown>) {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(statePath, JSON.stringify({ leases: [], ...state }));
    const load = () =>
      Registry.load({
        clock,
        eventBus: new EventBus(clock),
        filesystem,
        idGenerator: { generate: () => "new" },
        statePath,
      });
    const written = async () =>
      JSON.parse(await filesystem.readFile(statePath)) as Record<string, Record<string, unknown>[]>;
    return { filesystem, load, written };
  }

  const invalid = "Invalid device record in registry state";

  it("loads a record in devices with no physical as virtual, on the record and its spec, and writes it back with no physical key on either", async () => {
    const { load, written } = await stateFile({ devices: [virtualRecord] });
    const registry = await load();

    expect(registry.snapshot.devices[0]).toMatchObject({
      physical: false,
      spec: { physical: false },
    });
    await registry.markForeignStateDetected("dev_virtual", 5);

    const [stored] = (await written()).devices ?? [];
    expect(stored).toMatchObject({ foreignStateDetectedAt: 5, id: "dev_virtual" });
    expect(stored).not.toHaveProperty("physical");
    expect(stored?.spec).not.toHaveProperty("physical");
  });

  it.each([
    ["the record says physical true", { physical: true }],
    ["the record says physical as a string", { physical: "false" }],
    ["its spec says physical true", { spec: { ...virtualRecord.spec, physical: true } }],
    ["its spec says physical as a string", { spec: { ...virtualRecord.spec, physical: "no" } }],
    ["its spec carries a class", { spec: { ...virtualRecord.spec, class: "phone" } }],
  ])(
    "fails the load when a record in devices breaks the virtual rule: %s",
    async (_why, change) => {
      const { load } = await stateFile({ devices: [{ ...virtualRecord, ...change }] });

      await expect(load()).rejects.toThrow(invalid);
    },
  );

  it("keeps a physical record's class, enrolled apps and address through a save and a load", async () => {
    const { load, written } = await stateFile({
      devices: [],
      leases: [lease],
      physicalDevices: [physicalRecord],
    });
    const registry = await load();
    await registry.markForeignStateDetected("dev_physical", 5);

    expect((await written()).physicalDevices).toEqual([
      { ...physicalRecord, foreignStateDetectedAt: 5 },
    ]);
    expect((await load()).snapshot.devices).toEqual([
      expect.objectContaining({
        address: "00008110-001A2B3C4D5E",
        enrolledApps: ["com.example.one", "com.example.two"],
        physical: true,
        spec: physicalSpec,
        state: "ready",
      }),
    ]);
  });

  it.each([
    ["physical is missing on the record", { physical: undefined }],
    ["physical is false on the record", { physical: false }],
    ["physical is missing on the spec", { spec: { ...physicalSpec, physical: undefined } }],
    ["physical is false on the spec", { spec: { ...physicalSpec, physical: false } }],
    ["its class is missing", { spec: { ...physicalSpec, class: undefined } }],
    ["its class is watch", { spec: { ...physicalSpec, class: "watch" } }],
    ["its state is shutdown", { state: "shutdown" }],
    ["its state is provisioning", { state: "provisioning" }],
    ["its spec has a mode", { spec: { ...physicalSpec, mode: "slim" } }],
    ["its spec has an imageTag", { spec: { ...physicalSpec, imageTag: "default" } }],
    ["the record has a mode", { mode: "full" }],
    ["the record has a leaseIdentity", { leaseIdentity: "reusable" }],
    ["enrolledApps is missing", { enrolledApps: undefined }],
    ["enrolledApps is a string", { enrolledApps: "com.example.one" }],
    ["enrolledApps holds a number", { enrolledApps: ["com.example.one", 7] }],
  ])(
    "fails the load when a record in physicalDevices breaks the physical rule: %s",
    async (_why, change) => {
      const { load } = await stateFile({
        devices: [],
        physicalDevices: [{ ...physicalRecord, ...change }],
      });

      await expect(load()).rejects.toThrow(invalid);
    },
  );

  it.each(["ready", "leased", "reclaiming", "quarantined", "deleted"] as const)(
    "loads a physical record in the %s state",
    async (state) => {
      const { load } = await stateFile({
        devices: [],
        physicalDevices: [{ ...physicalRecord, state }],
      });

      expect((await load()).snapshot.devices[0]).toMatchObject({ physical: true, state });
    },
  );

  it.each([
    ["its state is unknown", { state: "absent" }],
    ["its spec is not an object", { spec: "iPhone 15 Pro" }],
    ["its model is missing", { spec: { ...physicalSpec, model: undefined } }],
    ["its model is a number", { spec: { ...physicalSpec, model: 15 } }],
    ["its OS version is missing", { spec: { ...physicalSpec, osVersion: undefined } }],
    ["its OS version is a number", { spec: { ...physicalSpec, osVersion: 18 } }],
    ["its platform is unknown", { spec: { ...physicalSpec, platform: "tizen" } }],
  ])("fails the load when a physical record breaks the shape: %s", async (_why, change) => {
    const { load } = await stateFile({
      devices: [],
      physicalDevices: [{ ...physicalRecord, ...change }],
    });

    await expect(load()).rejects.toThrow(invalid);
  });

  it("fails the load when a record in devices has a state no device has, or a spec that is not an object", async () => {
    for (const change of [{ state: "absent" }, { spec: "iPhone 16" }]) {
      const { load } = await stateFile({ devices: [{ ...virtualRecord, ...change }] });

      await expect(load()).rejects.toThrow(invalid);
    }
  });

  it("loads a file with no physicalDevices with no physical record, and fails one whose physicalDevices is a string", async () => {
    const without = await stateFile({ devices: [virtualRecord] });
    expect((await without.load()).snapshot.devices.map((device) => device.physical)).toEqual([
      false,
    ]);

    const broken = await stateFile({ devices: [], physicalDevices: "none" });
    await expect(broken.load()).rejects.toThrow("Invalid registry state");
  });

  it("writes a virtual and a physical record to separate lists, so a reader of devices alone, as an older Simlock, finds no physical record", async () => {
    const { load, written } = await stateFile({
      devices: [virtualRecord],
      physicalDevices: [physicalRecord],
    });
    const registry = await load();
    await registry.markForeignStateDetected("dev_virtual", 5);

    const file = await written();
    expect(file.devices?.map((device) => device.id)).toEqual(["dev_virtual"]);
    expect(file.physicalDevices?.map((device) => device.id)).toEqual(["dev_physical"]);
    expect(file.devices?.some((device) => device.physical === true)).toBe(false);
  });

  it("keeps a top-level key it does not know, and does not keep physicalDevices twice", async () => {
    const { load, written } = await stateFile({
      devices: [],
      futureKey: { kept: true },
      physicalDevices: [physicalRecord],
    });
    const registry = await load();
    await registry.markForeignStateDetected("dev_physical", 5);

    const file = await written();
    expect(file.futureKey).toEqual({ kept: true });
    expect(file.physicalDevices).toHaveLength(1);
  });

  it("lists every virtual record, and no physical one, in snapshot.virtualDevices, in the order of snapshot.devices", async () => {
    const { load } = await stateFile({
      devices: [virtualRecord, { ...virtualRecord, id: "dev_virtual_2" }],
      physicalDevices: [physicalRecord],
    });
    const registry = await load();

    expect(registry.snapshot.devices.map((device) => device.id)).toEqual([
      "dev_virtual",
      "dev_virtual_2",
      "dev_physical",
    ]);
    expect(registry.snapshot.virtualDevices.map((device) => device.id)).toEqual([
      "dev_virtual",
      "dev_virtual_2",
    ]);
  });

  it("lists a virtual device registered after a physical one before it, as the file's two lists are read", async () => {
    const { load } = await stateFile({ devices: [], physicalDevices: [physicalRecord] });
    const registry = await load();
    await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_new",
      provisionDuration: 0,
      spec,
    });

    expect(registry.snapshot.devices.map((device) => device.physical)).toEqual([false, true]);
  });

  it("refuses to mark a physical device missing, whether the call is markDeviceMissing or endLeaseAndMarkDeviceMissing, and writes nothing", async () => {
    const idle = await stateFile({ devices: [], physicalDevices: [physicalRecord] });
    const idleRegistry = await idle.load();
    const idleBefore = await idle.filesystem.readFile(statePath);

    await expect(idleRegistry.markDeviceMissing("dev_physical", "doctor")).rejects.toThrow(
      "Cannot mark a physical device missing",
    );

    expect(await idle.filesystem.readFile(statePath)).toBe(idleBefore);
    expect(idleRegistry.snapshot.devices.map((device) => device.id)).toEqual(["dev_physical"]);

    const { filesystem, load } = await stateFile({
      devices: [],
      leases: [lease],
      physicalDevices: [{ ...physicalRecord, state: "leased" }],
    });
    const registry = await load();
    const before = await filesystem.readFile(statePath);

    await expect(
      registry.endLeaseAndMarkDeviceMissing("lse_physical", "startup", () => undefined),
    ).rejects.toThrow("Cannot mark a physical device missing");

    expect(await filesystem.readFile(statePath)).toBe(before);
    expect(registry.snapshot.leases.map((held) => held.id)).toEqual(["lse_physical"]);
  });

  describe("a stored grant's device", () => {
    const grantOf = (device: Record<string, unknown>) => ({
      createdAt: 1_000,
      grant: { device, environment: {}, lease, timing: {} },
      id: "req_1",
      ownerId: "agent",
      request: { platform: "ios" },
      requesterId: "agent",
      settledAt: 1_000,
      state: "granted",
    });

    it("loads a grant written before physical devices existed as a grant of a virtual device, on its device and its spec", async () => {
      const { load } = await stateFile({
        devices: [{ ...virtualRecord, state: "leased" }],
        leaseRequests: [grantOf({ ...virtualRecord, state: "leased" })],
      });

      const device = (await load()).leaseRequests()[0]?.grant?.device;

      expect(device).toMatchObject({ mode: "full", physical: false, spec: { physical: false } });
    });

    it("keeps a grant of a physical device as it is, with no mode", async () => {
      const { load } = await stateFile({
        devices: [],
        leaseRequests: [grantOf({ ...physicalRecord, state: "leased" })],
        physicalDevices: [{ ...physicalRecord, state: "leased" }],
      });

      const device = (await load()).leaseRequests()[0]?.grant?.device;

      expect(device).toMatchObject({ physical: true, spec: { class: "phone", physical: true } });
      expect(device).not.toHaveProperty("mode");
    });

    it("loads a stored grant whose device has no spec without failing the load", async () => {
      const { spec: _spec, ...withoutSpec } = { ...virtualRecord, state: "leased" };
      const { load } = await stateFile({
        devices: [{ ...virtualRecord, state: "leased" }],
        leaseRequests: [grantOf(withoutSpec)],
      });

      expect((await load()).leaseRequests()).toHaveLength(1);
    });

    it("drops a stored grant that gives a physical device a mode, as it drops one with an unknown mode", async () => {
      const { load } = await stateFile({
        devices: [],
        leaseRequests: [grantOf({ ...physicalRecord, mode: "full", state: "leased" })],
        physicalDevices: [{ ...physicalRecord, state: "leased" }],
      });

      expect((await load()).leaseRequests()).toEqual([]);
    });
  });

  it("moves a physical device to reclaiming when its lease is released and stamps lastLeaseEndedAt with the clock's time", async () => {
    const { load } = await stateFile({
      devices: [],
      leases: [lease],
      physicalDevices: [{ ...physicalRecord, state: "leased" }],
    });
    const registry = await load();

    const released = await registry.beginRelease("lse_physical");

    expect(released.device).toMatchObject({
      lastLeaseEndedAt: 1_000,
      physical: true,
      state: "reclaiming",
    });
    expect(registry.snapshot.devices[0]).toMatchObject({
      lastLeaseEndedAt: 1_000,
      state: "reclaiming",
    });
  });
});

describe("Registry: device.deleted carries physical, and enrollment writes (ADR 0022 §2)", () => {
  async function load() {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    let next = 1;
    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => `r${next++}` },
      statePath,
    });
    const deleted: unknown[] = [];
    const modules: string[] = [];
    bus.subscribe("device.deleted", (envelope) => {
      deleted.push(envelope.payload);
      modules.push(envelope.module);
    });
    return { bus, deleted, modules, registry };
  }

  async function readyVirtual(registry: Registry, driverDeviceId: string) {
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
    return device;
  }

  const input = {
    apps: ["com.example.one"],
    class: "phone",
    driverDeviceId: "00008110-001A2B3C4D5E",
    model: "iPhone 15 Pro",
    osVersion: "18.4",
    platform: "ios",
  } as const;

  it("carries physical false from deleteQuarantined, markDeviceMissing, endLeaseAndMarkDeviceMissing and a transitionDevice of a virtual record", async () => {
    const { deleted, modules, registry } = await load();
    const quarantined = await readyVirtual(registry, "d1");
    const lease = await registry.createLease({
      deviceId: quarantined.id,
      ownerId: "a",
      requesterId: "a",
      ttlDeadline: 9_000,
      ttlMs: 8_000,
    });
    await registry.beginRelease(lease.id);
    await registry.enterQuarantine(quarantined.id, 5_000, { kind: "purge-failed" });
    await registry.deleteQuarantined(quarantined.id, "lease-end");
    const missing = await readyVirtual(registry, "d2");
    await registry.markDeviceMissing(missing.id, "doctor");
    const leased = await readyVirtual(registry, "d3");
    const held = await registry.createLease({
      deviceId: leased.id,
      ownerId: "a",
      requesterId: "a",
      ttlDeadline: 9_000,
      ttlMs: 8_000,
    });
    await registry.endLeaseAndMarkDeviceMissing(held.id, "doctor", () => {});
    const plain = await readyVirtual(registry, "d4");
    await registry.transitionDevice(plain.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: plain.id, initiator: "idle" },
    });
    await registry.transitionDevice(plain.id, "deleted", {
      event: "device.deleted",
      payload: { deviceId: plain.id, initiator: "idle" },
    });

    expect(deleted).toEqual([
      { deviceId: quarantined.id, initiator: "lease-end", physical: false },
      { deviceId: missing.id, initiator: "doctor", physical: false },
      { deviceId: leased.id, initiator: "doctor", physical: false },
      { deviceId: plain.id, initiator: "idle", physical: false },
    ]);
    expect(modules).toEqual(["registry", "registry", "registry", "registry"]);
  });

  it("carries physical true and initiator operator from unenroll, after the commit", async () => {
    const { bus, deleted, modules, registry } = await load();
    const device = await registry.enrollPhysical(input);
    const stateAtEmit: string[] = [];
    bus.subscribe("device.deleted", () => {
      stateAtEmit.push(registry.snapshot.devices[0]?.state ?? "none");
    });

    await registry.unenrollPhysical(device.id);

    expect(stateAtEmit).toEqual(["deleted"]);
    expect(deleted).toEqual([{ deviceId: device.id, initiator: "operator", physical: true }]);
    expect(modules).toEqual(["registry"]);
    expect(registry.snapshot.devices[0]).toMatchObject({ id: device.id, state: "deleted" });
  });

  it("emits device.enrolled after the commit, reenrolled false for a new record and true for a rewrite", async () => {
    const { bus, registry } = await load();
    const seen: unknown[] = [];
    const modules: string[] = [];
    bus.subscribe("device.enrolled", (envelope) => {
      const stored = registry.snapshot.devices[0] as { enrolledApps: string[] } | undefined;
      seen.push({ payload: envelope.payload, stored: stored?.enrolledApps.length ?? 0 });
      modules.push(envelope.module);
    });

    const device = await registry.enrollPhysical(input);
    await registry.reenrollPhysical(device.id, { ...input, apps: ["a", "b"], model: "iPhone 16" });

    expect(seen).toEqual([
      {
        payload: {
          appCount: 1,
          class: "phone",
          deviceId: device.id,
          driverDeviceId: input.driverDeviceId,
          model: "iPhone 15 Pro",
          osVersion: "18.4",
          platform: "ios",
          reenrolled: false,
        },
        stored: 1,
      },
      {
        payload: expect.objectContaining({ appCount: 2, model: "iPhone 16", reenrolled: true }),
        stored: 2,
      },
    ]);
    expect(modules).toEqual(["registry", "registry"]);
    expect(device.id).toBe("dev_r1");
  });

  it("writes the record a new enrollment makes: ready now, the driver's read, no apps beyond the list, and a rewrite keeps the ID and replaces the read", async () => {
    const { registry } = await load();

    const device = await registry.enrollPhysical(input);
    const rewritten = await registry.reenrollPhysical(device.id, {
      ...input,
      apps: [],
      class: "tablet",
      osVersion: "18.5",
    });

    expect(device).toEqual({
      createdAt: 1_000,
      driverData: {},
      driverDeviceId: input.driverDeviceId,
      enrolledApps: ["com.example.one"],
      id: "dev_r1",
      physical: true,
      readyAt: 1_000,
      spec: {
        class: "phone",
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        physical: true,
        platform: "ios",
      },
      state: "ready",
    });
    expect(rewritten).toMatchObject({
      enrolledApps: [],
      id: "dev_r1",
      spec: { class: "tablet", osVersion: "18.5", physical: true, platform: "ios" },
    });
  });

  it("keeps every other record when it rewrites or forgets one", async () => {
    const { registry } = await load();
    const other = await registry.enrollPhysical({ ...input, driverDeviceId: "OTHER" });
    const device = await registry.enrollPhysical(input);

    await registry.reenrollPhysical(device.id, { ...input, model: "iPhone 16" });
    await registry.unenrollPhysical(device.id);

    expect(registry.snapshot.devices.map((record) => [record.id, record.state])).toEqual([
      [other.id, "ready"],
      [device.id, "deleted"],
    ]);
  });

  it("refuses to re-enrol or unenrol a leased physical record, and a virtual one", async () => {
    const { registry } = await load();
    const device = await registry.enrollPhysical(input);
    await registry.createLease({
      deviceId: device.id,
      ownerId: "a",
      requesterId: "a",
      ttlDeadline: 9_000,
      ttlMs: 8_000,
    });
    const virtual = await readyVirtual(registry, "d1");

    await expect(registry.reenrollPhysical(device.id, input)).rejects.toThrow(RegistryEventError);
    await expect(registry.unenrollPhysical(device.id)).rejects.toThrow(RegistryEventError);
    await expect(registry.unenrollPhysical(virtual.id)).rejects.toThrow(
      `Cannot unenrol device: ${virtual.id}`,
    );
    const stopped = await readyVirtual(registry, "d2");
    await registry.transitionDevice(stopped.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: stopped.id, initiator: "test" },
    });
    await expect(registry.unenrollPhysical(stopped.id)).rejects.toThrow(
      `Cannot unenrol device: ${stopped.id}`,
    );
    expect(registry.snapshot.devices.find((entry) => entry.id === stopped.id)?.state).toBe(
      "shutdown",
    );
    await expect(registry.reenrollPhysical(virtual.id, input)).rejects.toThrow(
      `Cannot re-enrol device: ${virtual.id}`,
    );
    await expect(registry.reenrollPhysical(device.id, input)).rejects.toThrow(
      `Cannot re-enrol device: ${device.id}`,
    );
    await expect(registry.unenrollPhysical(device.id)).rejects.toThrow(
      `Cannot unenrol device: ${device.id}`,
    );
  });
});

describe("Registry: absent physical devices (ADR 0022 §2, §8)", () => {
  const physicalSpec = {
    class: "phone",
    model: "iPhone 15 Pro",
    osVersion: "18.4",
    physical: true,
    platform: "ios",
  };
  const physicalRecord = {
    address: "00008110-001A2B3C4D5E",
    createdAt: 600,
    driverData: {},
    driverDeviceId: "00008110-001A2B3C4D5E",
    enrolledApps: ["com.example.one"],
    id: "dev_physical",
    physical: true,
    spec: physicalSpec,
    state: "ready",
  };
  const virtualRecord = {
    createdAt: 500,
    driverData: {},
    driverDeviceId: "driver_virtual",
    id: "dev_virtual",
    mode: "full",
    spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    state: "leased",
  };
  const leaseOf = (deviceId: string) => ({
    deviceId,
    grantedAt: 700,
    id: `lse_${deviceId}`,
    idChosenByRequester: false,
    lastRenewedAt: 700,
    ownerId: "agent",
    requesterId: "agent",
    ttlDeadline: 90_000,
    ttlMs: 60_000,
  });
  const invalid = "Invalid device record in registry state";

  interface AbsentWrites {
    endLeaseAndMarkDeviceAbsent(
      leaseId: string,
      absentReason: string,
      announceLeaseEnd: (ended: unknown) => void,
    ): Promise<unknown>;
  }
  type Writer = (
    deviceId: string,
    to: string,
    event: { event: string; payload: Record<string, unknown> },
    update: Record<string, unknown>,
  ) => Promise<unknown>;

  async function stateFile(state: Record<string, unknown>) {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const filesystem = new ObservingFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({ devices: [], leases: [], ...state }),
    );
    filesystem.operations.length = 0;
    const load = () =>
      Registry.load({
        clock,
        eventBus: bus,
        filesystem,
        idGenerator: { generate: () => "new" },
        statePath,
      });
    const loaded = async () => {
      const registry = await load().catch((error: unknown) => error);
      expect(registry).toBeInstanceOf(Registry);
      return registry as Registry;
    };
    const written = async () =>
      JSON.parse(await filesystem.readFile(statePath)) as Record<string, Record<string, unknown>[]>;
    const transitionAny = (registry: Registry): Writer =>
      registry.transitionDevice.bind(registry) as unknown as Writer;
    return { bus, filesystem, load, loaded, transitionAny, written };
  }

  it("endLeaseAndMarkDeviceAbsent removes the lease, writes absent with its absentReason and stamps lastLeaseEndedAt in one commit, and calls announceLeaseEnd before emitting device.absence-detected", async () => {
    const { bus, filesystem, loaded, written } = await stateFile({
      leases: [leaseOf("dev_physical")],
      physicalDevices: [{ ...physicalRecord, state: "leased" }],
    });
    const registry = await loaded();
    const order: string[] = [];
    const payloads: unknown[] = [];
    bus.subscribeAll((envelope) => {
      order.push(envelope.event);
      payloads.push(envelope.payload);
    });
    const end = (registry as unknown as Partial<AbsentWrites>).endLeaseAndMarkDeviceAbsent;
    expect(end).toBeTypeOf("function");

    await end?.call(registry, "lse_dev_physical", "locked", () => {
      order.push("announce");
    });

    expect(registry.snapshot.leases).toEqual([]);
    expect(registry.snapshot.devices[0]).toMatchObject({
      absentReason: "locked",
      lastLeaseEndedAt: 1_000,
      state: "absent",
    });
    expect(filesystem.operations).toEqual(["save"]);
    const file = await written();
    expect(file.leases).toEqual([]);
    expect(file.physicalDevices?.[0]).toMatchObject({
      absentReason: "locked",
      lastLeaseEndedAt: 1_000,
      state: "absent",
    });
    expect(order).toEqual(["announce", "device.absence-detected"]);
    expect(payloads[0]).toEqual({
      absentReason: "locked",
      deviceId: "dev_physical",
      previousState: "leased",
    });
  });

  it("absent -> reclaiming writes the new osVersion, stamps reclaimingSince, removes absentReason, keeps lastLeaseEndedAt, and transitionEnteredAt returns reclaimingSince", async () => {
    const { loaded, transitionAny } = await stateFile({
      physicalDevices: [
        { ...physicalRecord, absentReason: "locked", lastLeaseEndedAt: 500, state: "absent" },
      ],
    });
    const registry = await loaded();

    await transitionAny(registry)(
      "dev_physical",
      "reclaiming",
      { event: "device.returned", payload: { deviceId: "dev_physical", osVersion: "18.5" } },
      { osVersion: "18.5" },
    );

    const stored = registry.snapshot.devices[0] as DeviceRecord & Record<string, unknown>;
    expect(stored).toMatchObject({
      lastLeaseEndedAt: 500,
      reclaimingSince: 1_000,
      spec: { osVersion: "18.5" },
      state: "reclaiming",
    });
    expect(stored).not.toHaveProperty("absentReason");
    expect(transitionEnteredAt(stored)).toBe(1_000);
  });

  it("beginRelease of a physical lease stamps reclaimingSince and lastLeaseEndedAt; of a virtual lease it stamps no reclaimingSince", async () => {
    const { loaded } = await stateFile({
      devices: [virtualRecord],
      leases: [leaseOf("dev_physical"), leaseOf("dev_virtual")],
      physicalDevices: [{ ...physicalRecord, state: "leased" }],
    });
    const registry = await loaded();

    const physical = await registry.beginRelease("lse_dev_physical");
    const virtual = await registry.beginRelease("lse_dev_virtual");

    expect(physical.device).toMatchObject({
      lastLeaseEndedAt: 1_000,
      reclaimingSince: 1_000,
      state: "reclaiming",
    });
    expect(virtual.device).toMatchObject({ lastLeaseEndedAt: 1_000, state: "reclaiming" });
    expect(virtual.device).not.toHaveProperty("reclaimingSince");
  });

  it("transitionEnteredAt of a reclaiming physical record with no reclaimingSince is its lastLeaseEndedAt", () => {
    const reclaiming = {
      ...physicalRecord,
      lastLeaseEndedAt: 2_000,
      state: "reclaiming",
    } as unknown as DeviceRecord;

    expect(
      transitionEnteredAt({ ...reclaiming, reclaimingSince: 3_000 } as unknown as DeviceRecord),
    ).toBe(3_000);
    expect(transitionEnteredAt(reclaiming)).toBe(2_000);
  });

  it("a physical record with reclaimingSince and an absent one with absentReason survive a save and a load; an absentReason on a record that is not absent, or with another value, an absent record without one, and a reclaimingSince that is not a number, fail the load", async () => {
    const reclaiming = {
      ...physicalRecord,
      id: "dev_a",
      lastLeaseEndedAt: 400,
      reclaimingSince: 450,
      state: "reclaiming",
    };
    const absent = { ...physicalRecord, absentReason: "untrusted", id: "dev_b", state: "absent" };
    const { loaded, written } = await stateFile({ physicalDevices: [reclaiming, absent] });
    const registry = await loaded();
    await registry.markForeignStateDetected("dev_a", 5);

    expect((await written()).physicalDevices).toEqual([
      { ...reclaiming, foreignStateDetectedAt: 5 },
      absent,
    ]);
    expect(
      (await stateFile({ physicalDevices: [absent] }).then((file) => file.loaded())).snapshot
        .devices[0],
    ).toMatchObject({
      absentReason: "untrusted",
      state: "absent",
    });

    const broken = [
      ["absentReason on a ready record", { absentReason: "locked", state: "ready" }],
      ["absentReason on a reclaiming record", { absentReason: "locked", state: "reclaiming" }],
      ["another absentReason", { absentReason: "asleep", state: "absent" }],
      ["no absentReason", { state: "absent" }],
      ["a reclaimingSince that is a string", { reclaimingSince: "450", state: "reclaiming" }],
    ] as const;
    for (const [why, change] of broken) {
      const { load } = await stateFile({ physicalDevices: [{ ...physicalRecord, ...change }] });

      await expect(load(), why).rejects.toThrow(invalid);
    }
  });

  it("absent -> ready (device add) and absent -> deleted (device remove) remove absentReason", async () => {
    const absent = { ...physicalRecord, absentReason: "not-present", state: "absent" };
    const added = await stateFile({ physicalDevices: [absent] });
    const addRegistry = await added.loaded();
    const removed = await stateFile({ physicalDevices: [absent] });
    const removeRegistry = await removed.loaded();

    await addRegistry.reenrollPhysical("dev_physical", {
      apps: ["com.example.one"],
      class: "phone",
      driverDeviceId: physicalRecord.driverDeviceId,
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    await removeRegistry.unenrollPhysical("dev_physical");

    expect(addRegistry.snapshot.devices[0]).toMatchObject({ state: "ready" });
    expect(addRegistry.snapshot.devices[0]).not.toHaveProperty("absentReason");
    expect(removeRegistry.snapshot.devices[0]).toMatchObject({ state: "deleted" });
    expect(removeRegistry.snapshot.devices[0]).not.toHaveProperty("absentReason");
    expect((await added.written()).physicalDevices?.[0]).not.toHaveProperty("absentReason");
    expect((await removed.written()).physicalDevices?.[0]).not.toHaveProperty("absentReason");
  });

  it("a transition into reclaiming stamps reclaimingSince on a physical device only, and a leased -> reclaiming move needs no device event", async () => {
    const { loaded } = await stateFile({
      devices: [virtualRecord],
      physicalDevices: [{ ...physicalRecord, state: "leased" }],
    });
    const registry = await loaded();
    const moveToReclaiming = (id: string) =>
      (registry.transitionDevice as unknown as (id: string, to: string) => Promise<unknown>).call(
        registry,
        id,
        "reclaiming",
      );

    await moveToReclaiming("dev_physical");
    await moveToReclaiming("dev_virtual");

    const [virtual, physical] = ["dev_virtual", "dev_physical"].map((id) =>
      registry.snapshot.devices.find((entry) => entry.id === id),
    );
    expect(physical).toMatchObject({ reclaimingSince: 1_000, state: "reclaiming" });
    expect(virtual).toMatchObject({ state: "reclaiming" });
    expect(virtual).not.toHaveProperty("reclaimingSince");
  });

  it("transitions to and from absent emit device.absence-detected and device.returned, each from the registry", async () => {
    const { bus, loaded, transitionAny } = await stateFile({
      physicalDevices: [{ ...physicalRecord, state: "ready" }],
    });
    const registry = await loaded();
    const seen: { event: string; module: string; payload: unknown }[] = [];
    bus.subscribeAll((envelope) =>
      seen.push({ event: envelope.event, module: envelope.module, payload: envelope.payload }),
    );
    const absencePayload = {
      absentReason: "locked",
      deviceId: "dev_physical",
      previousState: "ready",
    };
    const returnedPayload = { deviceId: "dev_physical", osVersion: "18.5" };

    await transitionAny(registry)(
      "dev_physical",
      "absent",
      { event: "device.absence-detected", payload: absencePayload },
      { absentReason: "locked" },
    );
    await transitionAny(registry)(
      "dev_physical",
      "reclaiming",
      { event: "device.returned", payload: returnedPayload },
      { osVersion: "18.5" },
    );

    expect(seen).toEqual([
      { event: "device.absence-detected", module: "registry", payload: absencePayload },
      { event: "device.returned", module: "registry", payload: returnedPayload },
    ]);
  });

  it("an absent device moves to ready with a device.ready event and to deleted with a device.deleted event, and either is refused with device.returned", async () => {
    const absent = { ...physicalRecord, absentReason: "locked", state: "absent" };
    const { bus, loaded, transitionAny } = await stateFile({ physicalDevices: [absent] });
    const registry = await loaded();
    const seen: string[] = [];
    bus.subscribeAll((envelope) => seen.push(envelope.event));
    const returned = { event: "device.returned", payload: { deviceId: "dev_physical" } };

    await expect(transitionAny(registry)("dev_physical", "ready", returned, {})).rejects.toThrow(
      "Transition from absent to ready requires device.ready device event",
    );
    await expect(transitionAny(registry)("dev_physical", "deleted", returned, {})).rejects.toThrow(
      "Transition from absent to deleted requires device.deleted device event",
    );
    await transitionAny(registry)(
      "dev_physical",
      "ready",
      { event: "device.ready", payload: { deviceId: "dev_physical" } },
      {},
    );

    expect(seen).toEqual(["device.ready"]);
  });

  it("a ready physical device that goes absent is not stamped reclaimingSince, and device add re-enrolling it emits device.enrolled with reenrolled true, not device.ready", async () => {
    const { bus, loaded, transitionAny } = await stateFile({
      physicalDevices: [{ ...physicalRecord, state: "ready" }],
    });
    const registry = await loaded();
    const seen: string[] = [];
    bus.subscribeAll((envelope) => seen.push(envelope.event));

    await transitionAny(registry)(
      "dev_physical",
      "absent",
      {
        event: "device.absence-detected",
        payload: { absentReason: "locked", deviceId: "dev_physical", previousState: "ready" },
      },
      { absentReason: "locked" },
    );
    const absent = registry.snapshot.devices.find((entry) => entry.id === "dev_physical");
    const enrolled: unknown[] = [];
    bus.subscribe("device.enrolled", (envelope) => enrolled.push(envelope.payload));
    await registry.reenrollPhysical("dev_physical", {
      apps: [],
      class: "phone",
      driverDeviceId: physicalRecord.driverDeviceId,
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });

    expect(absent).not.toHaveProperty("reclaimingSince");
    expect(seen).toEqual(["device.absence-detected", "device.enrolled"]);
    expect(enrolled).toMatchObject([{ deviceId: "dev_physical", reenrolled: true }]);
  });

  it("endLeaseAndMarkDeviceAbsent ends only the named lease, keeps every other device and lease, and emits from the registry", async () => {
    const { bus, loaded } = await stateFile({
      leases: [leaseOf("dev_other"), leaseOf("dev_physical")],
      physicalDevices: [
        {
          ...physicalRecord,
          id: "dev_other",
          driverDeviceId: "other",
          address: "other",
          state: "leased",
        },
        { ...physicalRecord, state: "leased" },
      ],
    });
    const registry = await loaded();
    const modules: string[] = [];
    bus.subscribeAll((envelope) => modules.push(envelope.module));

    await registry.endLeaseAndMarkDeviceAbsent("lse_dev_physical", "locked", () => undefined);

    expect(registry.snapshot.leases.map((lease) => lease.id)).toEqual(["lse_dev_other"]);
    expect(registry.snapshot.devices.map((entry) => [entry.id, entry.state])).toEqual([
      ["dev_other", "leased"],
      ["dev_physical", "absent"],
    ]);
    expect(modules).toEqual(["registry"]);
  });

  it("endLeaseAndMarkDeviceAbsent of an unknown lease throws UnknownLeaseError and changes nothing", async () => {
    const { loaded } = await stateFile({
      leases: [leaseOf("dev_physical")],
      physicalDevices: [{ ...physicalRecord, state: "leased" }],
    });
    const registry = await loaded();

    await expect(
      registry.endLeaseAndMarkDeviceAbsent("lse_missing", "locked", () => undefined),
    ).rejects.toBeInstanceOf(UnknownLeaseError);
    expect(registry.snapshot.devices[0]).toMatchObject({ state: "leased" });
    expect(registry.snapshot.leases).toHaveLength(1);
  });

  it("rewriteAbsentReason replaces the reason of an absent physical device and refuses a physical device that is not absent and a virtual one", async () => {
    const { loaded, written } = await stateFile({
      devices: [virtualRecord],
      physicalDevices: [
        { ...physicalRecord, absentReason: "not-present", state: "absent" },
        { ...physicalRecord, id: "dev_ready", driverDeviceId: "r", address: "r", state: "ready" },
      ],
    });
    const registry = await loaded();

    await expect(registry.rewriteAbsentReason("dev_ready", "locked")).rejects.toThrow(
      "Device is not absent: dev_ready",
    );
    await expect(registry.rewriteAbsentReason("dev_virtual", "locked")).rejects.toThrow(
      "Device is not absent: dev_virtual",
    );
    await registry.rewriteAbsentReason("dev_physical", "locked");

    expect(registry.snapshot.devices.find((entry) => entry.id === "dev_physical")).toMatchObject({
      absentReason: "locked",
      state: "absent",
    });
    expect(
      (await written()).physicalDevices?.find((entry) => entry.id === "dev_physical"),
    ).toMatchObject({ absentReason: "locked" });
  });

  it("a loaded ready physical record written without the marks carries neither reclaimingSince nor absentReason", async () => {
    const { loaded } = await stateFile({
      physicalDevices: [{ ...physicalRecord, state: "ready" }],
    });
    const registry = await loaded();

    expect(registry.snapshot.devices[0]).not.toHaveProperty("reclaimingSince");
    expect(registry.snapshot.devices[0]).not.toHaveProperty("absentReason");
  });

  it("a record in physicalDevices in absent loads; a record in devices in absent fails to load as corrupt", async () => {
    const { loaded } = await stateFile({
      physicalDevices: [{ ...physicalRecord, absentReason: "locked", state: "absent" }],
    });
    const registry = await loaded();
    const { load } = await stateFile({
      devices: [{ ...virtualRecord, state: "absent" }],
    });

    expect(registry.snapshot.devices[0]).toMatchObject({ physical: true, state: "absent" });
    await expect(load()).rejects.toThrow(invalid);
  });
});

describe("Registry: quarantineCause", () => {
  const virtualRecord = {
    createdAt: 500,
    driverData: {},
    driverDeviceId: "driver_virtual",
    id: "dev_virtual",
    mode: "full",
    physical: false,
    spec,
    state: "reclaiming",
  };
  const physicalRecord = {
    createdAt: 600,
    driverData: {},
    driverDeviceId: "00008110-001A2B3C4D5E",
    enrolledApps: ["com.example.one"],
    id: "dev_physical",
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
  const quarantineFields = {
    quarantineAttempts: 0,
    quarantineNextRetryAt: 5_000,
    quarantinedAt: 900,
  };
  const purgeCause = { kind: "purge-failed", message: "DriverCrashError: simctl erase exited 164" };
  const invalid = "Invalid device record in registry state";

  async function stateFile(state: Record<string, unknown>) {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(statePath, JSON.stringify({ leases: [], ...state }));
    const load = () =>
      Registry.load({
        clock,
        eventBus: new EventBus(clock),
        filesystem,
        idGenerator: { generate: () => "new" },
        statePath,
      });
    const written = async () =>
      JSON.parse(await filesystem.readFile(statePath)) as Record<string, Record<string, unknown>[]>;
    return { filesystem, load, written };
  }

  const quarantinedVirtual = (cause: unknown) => ({
    ...virtualRecord,
    ...quarantineFields,
    quarantineCause: cause,
    state: "quarantined",
  });
  const quarantinedPhysical = (cause: unknown) => ({
    ...physicalRecord,
    ...quarantineFields,
    quarantineCause: cause,
    state: "quarantined",
  });

  it("a quarantined record with each kind, written by enterQuarantine and loaded by a new Registry, has its cause, with the clock short of quarantineNextRetryAt", async () => {
    const causes = [
      { kind: "purge-failed", message: "Error: purge exploded" },
      { kind: "shutdown-failed", message: "Error: shutdown exploded" },
      { kind: "delete-failed", message: "Error: delete exploded" },
      { kind: "stalled", stalledState: "provisioning" },
      { kind: "stalled", stalledState: "reclaiming" },
    ] as const;

    for (const cause of causes) {
      const { load } = await stateFile({
        devices: [
          { ...virtualRecord, state: cause.kind === "delete-failed" ? "shutdown" : "reclaiming" },
        ],
      });
      const registry = await load();
      const entered = await registry.enterQuarantine("dev_virtual", 5_000, cause);
      expect(entered.quarantineCause, cause.kind).toEqual(cause);

      const reloaded = await load();
      expect(reloaded.snapshot.devices[0], cause.kind).toMatchObject({
        quarantineCause: cause,
        state: "quarantined",
      });
    }
  });

  it("a quarantined record with a cause from an earlier entry loads as is, and a record with no cause loads with none", async () => {
    const withCause = await stateFile({ devices: [quarantinedVirtual(purgeCause)] });
    const without = await stateFile({
      devices: [{ ...virtualRecord, ...quarantineFields, state: "quarantined" }],
    });

    expect((await withCause.load()).snapshot.devices[0]?.quarantineCause).toEqual(purgeCause);
    expect((await without.load()).snapshot.devices[0]).not.toHaveProperty("quarantineCause");
  });

  it("a record that is not quarantined loads without its cause, well-formed or malformed, with no RegistryLoadError, and the next write does not carry it", async () => {
    const causes = [purgeCause, { kind: "bogus", message: 7 }, "not an object"];
    for (const state of ["ready", "reclaiming"] as const) {
      for (const cause of causes) {
        const { load, written } = await stateFile({
          devices: [{ ...virtualRecord, quarantineCause: cause, state }],
        });

        const registry = await load();
        const why = `${state} ${JSON.stringify(cause)}`;
        expect(registry.snapshot.devices[0], `loaded ${why}`).not.toHaveProperty("quarantineCause");
        await registry.markForeignStateDetected("dev_virtual", 5);

        expect(registry.snapshot.devices[0], why).toMatchObject({ state });
        expect(registry.snapshot.devices[0], why).not.toHaveProperty("quarantineCause");
        expect((await written()).devices?.[0], why).not.toHaveProperty("quarantineCause");
      }
    }
    const physical = await stateFile({
      devices: [],
      physicalDevices: [{ ...physicalRecord, quarantineCause: purgeCause, state: "ready" }],
    });
    const registry = await physical.load();
    expect(registry.snapshot.devices[0]).not.toHaveProperty("quarantineCause");
    await registry.markForeignStateDetected("dev_physical", 5);
    expect(registry.snapshot.devices[0]).not.toHaveProperty("quarantineCause");
    expect((await physical.written()).physicalDevices?.[0]).not.toHaveProperty("quarantineCause");
  });

  it("a quarantined record whose cause has an unknown kind, stalled without stalledState, stalledState on another kind, a message on stalled, a non-string, empty or 301-character message, or a control character fails the load", async () => {
    const accepted = await stateFile({ devices: [quarantinedVirtual(purgeCause)] });
    await expect((await accepted.load()).snapshot.devices[0]?.quarantineCause).toEqual(purgeCause);
    const bad: readonly (readonly [string, unknown])[] = [
      ["an unknown kind", { kind: "exploded", message: "Error: x" }],
      ["stalled without stalledState", { kind: "stalled" }],
      [
        "stalledState on another kind",
        { kind: "purge-failed", message: "Error: x", stalledState: "reclaiming" },
      ],
      [
        "a message on stalled",
        { kind: "stalled", message: "Error: x", stalledState: "reclaiming" },
      ],
      [
        "a stalledState that is not provisioning or reclaiming",
        { kind: "stalled", stalledState: "ready" },
      ],
      ["a non-string message", { kind: "purge-failed", message: 7 }],
      ["an empty message", { kind: "purge-failed", message: "" }],
      ["a 301-character message", { kind: "purge-failed", message: "x".repeat(301) }],
      ["a control character", { kind: "purge-failed", message: "Error: a\nb" }],
      ["a cause that is not an object", "purge-failed"],
    ];

    for (const [why, cause] of bad) {
      const { load } = await stateFile({ devices: [quarantinedVirtual(cause)] });
      await expect(load(), why).rejects.toThrow(invalid);
      const physical = await stateFile({
        devices: [],
        physicalDevices: [quarantinedPhysical(cause)],
      });
      await expect(physical.load(), `${why} (physical)`).rejects.toThrow(invalid);
    }
  });

  describe("every exit from quarantined removes it", () => {
    const readyEvent = (id: string) => ({
      event: "device.ready" as const,
      payload: { bootDuration: 0, deviceId: id },
    });
    const exits: readonly (readonly [string, (registry: Registry) => Promise<unknown>])[] = [
      ["recoverFromQuarantine to ready", (r) => r.recoverFromQuarantine("dev_virtual", "ready")],
      [
        "recoverFromQuarantine to shutdown",
        (r) => r.recoverFromQuarantine("dev_virtual", "shutdown"),
      ],
      ["deleteQuarantined", (r) => r.deleteQuarantined("dev_virtual", "lease-end")],
      ["markDeviceMissing", (r) => r.markDeviceMissing("dev_virtual", "doctor")],
      [
        "transitionDevice to ready",
        (r) => r.transitionDevice("dev_virtual", "ready", readyEvent("dev_virtual")),
      ],
      [
        "transitionDevice to shutdown",
        (r) =>
          r.transitionDevice("dev_virtual", "shutdown", {
            event: "device.shutdown",
            payload: { deviceId: "dev_virtual", initiator: "idle" },
          }),
      ],
      [
        "transitionDevice to deleted",
        (r) =>
          r.transitionDevice("dev_virtual", "deleted", {
            event: "device.deleted",
            payload: { deviceId: "dev_virtual", initiator: "lease-end" },
          }),
      ],
    ];

    it.each(exits)("%s", async (_name, exit) => {
      const { load, written } = await stateFile({ devices: [quarantinedVirtual(purgeCause)] });
      const registry = await load();
      expect(registry.snapshot.devices[0]).toHaveProperty("quarantineCause");

      const result = await exit(registry);

      expect(result).not.toHaveProperty("quarantineCause");
      expect(registry.snapshot.devices[0]).not.toHaveProperty("quarantineCause");
      expect((await written()).devices?.[0]).not.toHaveProperty("quarantineCause");
    });

    it.each([
      [
        "reenrollPhysical",
        (r: Registry) =>
          r.reenrollPhysical("dev_physical", {
            apps: ["com.example.one"],
            class: "phone",
            driverDeviceId: "00008110-001A2B3C4D5E",
            model: "iPhone 15 Pro",
            osVersion: "18.4",
            platform: "ios",
          }),
      ],
      ["unenrollPhysical", (r: Registry) => r.unenrollPhysical("dev_physical")],
    ])("%s", async (_name, exit) => {
      const { load, written } = await stateFile({
        devices: [],
        physicalDevices: [quarantinedPhysical(purgeCause)],
      });
      const registry = await load();
      expect(registry.snapshot.devices[0]).toHaveProperty("quarantineCause");

      const result = await exit(registry);

      expect(result).not.toHaveProperty("quarantineCause");
      expect(registry.snapshot.devices[0]).not.toHaveProperty("quarantineCause");
      expect((await written()).physicalDevices?.[0]).not.toHaveProperty("quarantineCause");
    });
  });
});
