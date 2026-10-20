import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, NodeFilesystem, NodeSqliteOpener, NoopLogger } from "../ports/index.js";
import { type StateDatabase, openStateDatabase } from "../state/index.js";
import { fakeDeviceDataTable, loadTestRegistry, openTestState } from "./testing.js";
import {
  type DeviceDataTable,
  type DeviceRecord,
  type DeviceTransitionUpdate,
  type Platform,
  type VirtualSpec,
  Registry,
  registryOwner,
  RegistryEventError,
  RegistryLoadError,
  UnknownDeviceError,
  UnknownLeaseError,
  transitionEnteredAt,
} from "./index.js";

const spec: VirtualSpec = {
  physical: false,
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
};

function totalChanges(state: StateDatabase): unknown {
  return state.database.prepare("SELECT total_changes() AS changes").get()?.changes;
}

async function loadAfterCorruptingDevice(assignment: string): Promise<Registry> {
  const clock = new FakeClock(1_000);
  const state = await openTestState();
  const registry = await loadTestRegistry({
    clock,
    eventBus: new EventBus(clock),
    idGenerator: { generate: () => "stored" },
    state,
  });
  await registry.registerDevice({
    driverData: { fakeDeviceId: "fake-1" },
    driverDeviceId: "driver_stored",
    provisionDuration: 0,
    spec,
  });
  state.database.prepare(`UPDATE devices SET ${assignment}`).run();
  return loadTestRegistry({
    clock,
    eventBus: new EventBus(clock),
    idGenerator: { generate: () => "new" },
    state,
  });
}

describe("Registry: component records", () => {
  async function load(state: StateDatabase) {
    const clock = new FakeClock(1_000);
    return loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
      state,
    });
  }

  it("keeps one record per platform and version, the latest install replacing the earlier one", async () => {
    const registry = await load(await openTestState());

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
    const state = await openTestState();
    const registry = await load(state);
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
    expect((await load(state)).snapshot.components).toEqual(kept);
  });
});

describe("Registry", () => {
  it("loads an empty registry from a new state.db", async () => {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
    });

    expect(registry.snapshot).toEqual({
      components: [],
      devices: [],
      leases: [],
      virtualDevices: [],
    });
  });

  it("persists a registered device before emitting device.provisioned", async () => {
    const clock = new FakeClock(1_000);
    const state = await openTestState();
    const bus = new EventBus(clock);
    const storedAtEvent: unknown[] = [];
    bus.subscribe("device.provisioned", () =>
      storedAtEvent.push(state.database.prepare("SELECT id FROM devices").all()),
    );
    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator: { generate: () => "test" },
      state,
    });

    await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 25,
      spec,
    });

    expect(storedAtEvent).toEqual([[{ id: "dev_test" }]]);
    expect(registry.snapshot.devices).toEqual([
      {
        physical: false,
        createdAt: 1_000,
        driverData: { fakeDeviceId: "fake-1" },
        driverDeviceId: "driver_test",
        id: "dev_test",
        leaseIdentity: "reusable",
        spec,
        mode: "full",
        state: "provisioning",
      },
    ]);
  });

  it("a registry restarted on the same state.db returns every record as committed, optional fields set and absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-registry-"));
    try {
      const clock = new FakeClock(1_000);
      let next = 0;
      const deviceData = new Map<Platform, DeviceDataTable>([
        ["android", fakeDeviceDataTable],
        ["ios", fakeDeviceDataTable],
      ]);
      const openState = () =>
        openStateDatabase({
          dataDirectory: directory,
          filesystem: new NodeFilesystem(),
          logger: new NoopLogger(),
          oldFiles: [],
          owners: [registryOwner, fakeDeviceDataTable],
          sqlite: new NodeSqliteOpener(),
          upgradeStep: "remove it.",
        });
      const first = await openState();
      const registry = await Registry.load({
        clock,
        deviceData,
        eventBus: new EventBus(clock),
        idGenerator: { generate: () => String((next += 1)) },
        state: first,
      });
      const timing = {
        estimatedBootMs: 2,
        estimatedProvisionMs: 1,
        estimatedReadyMs: 4,
        estimatedReclaimMs: 3,
      };
      const register = (driverDeviceId: string, deviceSpec: VirtualSpec, fakeDeviceId: string) =>
        registry.registerDevice({
          driverData: { fakeDeviceId },
          driverDeviceId,
          provisionDuration: 5,
          spec: deviceSpec,
        });
      const ready = (id: string, update?: DeviceTransitionUpdate) =>
        registry.transitionDevice(
          id,
          "ready",
          { event: "device.ready", payload: { bootDuration: 7, deviceId: id } },
          update,
        );

      const plain = await register("drv-plain", spec, "fk-plain");
      const full = await register(
        "drv-full",
        { ...spec, imageTag: "default", mode: "slim" },
        "fk-full",
      );
      await ready(full.id, {
        address: "127.0.0.1:5554",
        driverData: { fakeDeviceId: "fk-full-booted" },
        mode: "slim",
      });
      clock.advance(10);
      await registry.markForeignStateDetected(full.id, 1_011);
      await registry.markForeignProvenanceDetected(full.id, 1_012);
      await registry.markRecoveryAttempt(full.id, 1_013);
      const stalled = await register("drv-stalled", spec, "fk-stalled");
      await registry.enterQuarantine(stalled.id, 9_000, {
        kind: "stalled",
        message: "stuck booting",
        stalledState: "provisioning",
      });
      const deferred = await register("drv-deferred", spec, "fk-deferred");
      await ready(deferred.id);
      const deferredLease = await registry.createLease({
        deviceId: deferred.id,
        ownerId: "agent-2",
        requesterId: "agent-2",
        ttlDeadline: 5_000,
        ttlMs: 4_000,
      });
      clock.advance(10);
      await registry.beginRelease(deferredLease.id, { deferReclaim: true });

      const apps = ["com.b", "com.a", "com.c"];
      const physicalInput = {
        apps,
        class: "tablet",
        driverDeviceId: "udid-1",
        model: "iPad",
        osVersion: "26.5",
        platform: "ios",
      } as const;
      const physical = await registry.enrollPhysical(physicalInput);
      const absent = await registry.enrollPhysical({ ...physicalInput, driverDeviceId: "udid-2" });
      await registry.transitionDevice(
        absent.id,
        "absent",
        {
          event: "device.absence-detected",
          payload: { absentReason: "locked", deviceId: absent.id, previousState: "ready" },
        },
        { absentReason: "locked" },
      );
      const returning = await registry.enrollPhysical({
        ...physicalInput,
        apps: [],
        driverDeviceId: "udid-3",
      });
      const returningLease = await registry.createLease({
        deviceId: returning.id,
        ownerId: "agent-3",
        requesterId: "agent-3",
        ttlDeadline: 5_000,
        ttlMs: 4_000,
      });
      await registry.beginRelease(returningLease.id);

      await registry.createLeaseRequest({
        ownerId: "agent-0",
        request: { platform: "ios" },
        requesterId: "agent-0",
      });
      await registry.createLeaseRequest({
        fleetRequestId: "fleet-1",
        id: "req_full",
        idempotencyKey: "key-1",
        leaseId: "lse_chosen",
        ownerId: "agent-1",
        request: {
          class: "phone",
          imageTag: "default",
          mode: "slim",
          model: "iPhone 16",
          osVersion: "26.5",
          physical: true,
          platform: "ios",
        },
        requesterId: "requester-1",
      });
      await registry.createLeaseRequest({
        id: "req_granted",
        ownerId: "agent-1",
        request: { platform: "ios" },
        requesterId: "agent-1",
      });
      const lease = await registry.createLease({
        deviceId: full.id,
        leaseId: "lse_chosen",
        ownerId: "agent-1",
        request: { environment: { SIMLOCK_UDID: "abc", OTHER: "x" }, id: "req_granted", timing },
        requesterId: "requester-1",
        ttlDeadline: 2_000,
        ttlMs: 60_000,
      });
      await registry.createLeaseRequest({
        id: "req_failed",
        ownerId: "agent-1",
        request: { platform: "android" },
        requesterId: "agent-1",
      });
      await registry.settleLeaseRequest("req_failed", {
        failure: { code: "no-capacity", message: "no room" },
        state: "failed",
      });
      await registry.createLeaseRequest({
        id: "req_cancelled",
        ownerId: "agent-1",
        request: { platform: "android" },
        requesterId: "agent-1",
      });
      await registry.settleLeaseRequest("req_cancelled", { state: "cancelled" });
      await registry.recordComponent({
        installedAt: 1_005,
        platform: "ios",
        receipt: { image: "IMG", stamp: "s1" },
        version: "26.5",
      });
      await registry.recordComponent({
        installedAt: 1_006,
        platform: "android",
        receipt: {},
        version: "35",
      });
      first.close();

      const second = await openState();
      const reloaded = await Registry.load({
        clock,
        deviceData,
        eventBus: new EventBus(clock),
        idGenerator: { generate: () => "unused" },
        state: second,
      });

      expect(reloaded.snapshot).toEqual(registry.snapshot);
      expect(reloaded.leaseRequests()).toEqual(registry.leaseRequests());
      expect(reloaded.snapshot.devices.find((device) => device.id === plain.id)).toEqual({
        createdAt: 1_000,
        driverData: { fakeDeviceId: "fk-plain" },
        driverDeviceId: "drv-plain",
        id: plain.id,
        leaseIdentity: "reusable",
        mode: "full",
        physical: false,
        spec,
        state: "provisioning",
      });
      expect(reloaded.snapshot.devices.find((device) => device.id === full.id)).toEqual({
        address: "127.0.0.1:5554",
        createdAt: 1_000,
        driverData: { fakeDeviceId: "fk-full-booted" },
        driverDeviceId: "drv-full",
        foreignProvenanceDetectedAt: 1_012,
        foreignStateDetectedAt: 1_011,
        id: full.id,
        leaseIdentity: "reusable",
        mode: "slim",
        physical: false,
        readyAt: 1_000,
        recoveringSince: 1_013,
        recoveryAttempts: 1,
        spec: { ...spec, imageTag: "default", mode: "slim" },
        state: "leased",
      });
      expect(reloaded.snapshot.devices.find((device) => device.id === physical.id)).toMatchObject({
        enrolledApps: apps,
        physical: true,
        spec: { class: "tablet", physical: true },
      });
      expect(reloaded.snapshot.leases).toContainEqual(lease);
      expect(reloaded.leaseRequests().find((request) => request.id === "req_full")).toEqual({
        createdAt: 1_020,
        fleetRequestId: "fleet-1",
        id: "req_full",
        idempotencyKey: "key-1",
        leaseId: "lse_chosen",
        ownerId: "agent-1",
        request: {
          class: "phone",
          imageTag: "default",
          mode: "slim",
          model: "iPhone 16",
          osVersion: "26.5",
          physical: true,
          platform: "ios",
        },
        requesterId: "requester-1",
        state: "open",
      });
      expect(reloaded.snapshot.components).toEqual([
        {
          installedAt: 1_005,
          platform: "ios",
          receipt: { image: "IMG", stamp: "s1" },
          version: "26.5",
        },
        { installedAt: 1_006, platform: "android", receipt: {}, version: "35" },
      ]);
      second.close();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("refuses to load a device row whose lease_identity is not a known policy", async () => {
    await expect(loadAfterCorruptingDevice("lease_identity = 'disposable'")).rejects.toThrow(
      RegistryLoadError,
    );
  });

  it("stamps each registered device with its own platform's policy and keeps it across a reload under another", async () => {
    const clock = new FakeClock(1_000);
    const state = await openTestState();
    let nextId = 1;
    const idGenerator = { generate: () => `${nextId++}` };
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator,
      leaseIdentity: { android: "reusable", ios: "fresh" },
      state,
    });
    const ios = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_ios",
      provisionDuration: 0,
      spec,
    });
    const android = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_android",
      provisionDuration: 0,
      spec: { physical: false, model: "Pixel 9", osVersion: "36", platform: "android" },
    });

    expect([ios.leaseIdentity, android.leaseIdentity]).toEqual(["fresh", "reusable"]);

    const reloaded = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator,
      leaseIdentity: { android: "fresh", ios: "reusable" },
      state,
    });
    expect(reloaded.snapshot.devices.map((device) => device.leaseIdentity)).toEqual([
      "fresh",
      "reusable",
    ]);
  });

  it("persists a transition before emitting its device.ready fact", async () => {
    const clock = new FakeClock(1_000);
    const state = await openTestState();
    const bus = new EventBus(clock);
    const storedAtEvent: unknown[] = [];
    bus.subscribe("device.ready", () =>
      storedAtEvent.push(state.database.prepare("SELECT state FROM devices").all()),
    );
    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator: { generate: () => "test" },
      state,
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });

    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 50, deviceId: device.id },
    });

    expect(storedAtEvent).toEqual([[{ state: "ready" }]]);
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
      const registry = await loadTestRegistry({
        clock,
        eventBus: bus,
        idGenerator: { generate: () => "test" },
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "fake-1" },
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
    const suffixes = ["device", "lease"];
    const state = await openTestState();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => suffixes.shift() ?? "unexpected" },
      state,
    };
    const registry = await loadTestRegistry(options);
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
    const reloaded = await loadTestRegistry(options);

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
    const suffixes = ["device", "lease"];
    const state = await openTestState();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => suffixes.shift() ?? "unexpected" },
      state,
    };
    const registry = await loadTestRegistry(options);
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
    const reloaded = await loadTestRegistry(options);

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
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "x" },
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

  it("records the first recovery attempt's start time and count", async () => {
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

    const updated = await registry.markRecoveryAttempt(device.id, 1_500);

    expect(updated).toMatchObject({ recoveringSince: 1_500, recoveryAttempts: 1 });
  });

  it("keeps the original recoveringSince and increments the attempt count on retry", async () => {
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

  it("registers a new device as full", async () => {
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

    expect(device.mode).toBe("full");
  });

  it.each(["mode", "spec_mode"])(
    "fails the load when a stored %s is neither slim nor full",
    async (column) => {
      await expect(loadAfterCorruptingDevice(`${column} = 'reduced'`)).rejects.toThrow(
        RegistryLoadError,
      );
    },
  );

  it("records the planned mode of a slim spec on the device it registers", async () => {
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
      spec: { ...spec, mode: "slim" },
    });

    expect(device.spec).toEqual({ ...spec, mode: "slim" });
    expect(device.mode).toBe("full");
  });

  it("clears recovery markers as part of the same commit that ends a lease", async () => {
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
  });

  it("writes a device the same way whether it is marked missing alone or together with its lease's end", async () => {
    const marked = async (viaLease: boolean) => {
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
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_test",
      id: "dev_test",
      leaseIdentity: "reusable",
      mode: "full",
      readyAt: 1_000,
      spec,
      state: "deleted",
    });
  });

  it("keeps idChosenByRequester true on the lease of a stored grant across a reload", async () => {
    const clock = new FakeClock(1_000);
    const state = await openTestState();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "x" },
      state,
    };
    const registry = await loadTestRegistry(options);
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

    const reloaded = await loadTestRegistry(options);

    expect(reloaded.leaseRequests()[0]?.grant?.lease).toMatchObject({
      id: "ad-7f3a",
      idChosenByRequester: true,
    });
  });

  it("writes idChosenByRequester true for a lease created with a leaseId, false without one, and keeps both across a reload", async () => {
    const clock = new FakeClock(1_000);
    let next = 0;
    const state = await openTestState();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => String((next += 1)) },
      state,
    };
    const registry = await loadTestRegistry(options);
    const ready = async (driverDeviceId: string) => {
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "fake-1" },
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
    const reloaded = await loadTestRegistry(options);
    expect(reloaded.snapshot.leases).toEqual([chosen, generated]);
  });

  it("removes a lease and marks its device deleted in one commit, announcing the lease before device.deleted, both after the commit", async () => {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const suffixes = ["device", "lease"];
    const state = await openTestState();
    const options = {
      clock,
      eventBus: bus,
      idGenerator: { generate: () => suffixes.shift() ?? "unexpected" },
      state,
    };
    const registry = await loadTestRegistry(options);
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
    await registry.markRecoveryAttempt(device.id, 1_500);
    const operations: string[] = [];
    const stored = () => {
      const row = state.database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM leases) AS leases, (SELECT state FROM devices) AS device",
        )
        .get();
      return `${String(row?.leases)} leases stored, device ${String(row?.device)}`;
    };
    bus.subscribe("device.deleted", () => operations.push(`device.deleted: ${stored()}`));

    const ended = await registry.endLeaseAndMarkDeviceMissing(lease.id, "doctor", () =>
      operations.push(`lease announced: ${stored()}`),
    );

    expect(operations).toEqual([
      "lease announced: 0 leases stored, device deleted",
      "device.deleted: 0 leases stored, device deleted",
    ]);
    expect(ended.lease).toEqual(lease);
    expect(ended.device).toMatchObject({ id: device.id, state: "deleted" });
    expect(ended.device).not.toHaveProperty("recoveryAttempts");
    expect(registry.snapshot.leases).toEqual([]);
    expect(registry.snapshot.devices).toEqual([ended.device]);
    expect((await loadTestRegistry(options)).snapshot).toEqual(registry.snapshot);
    expect(bus.replay().filter((entry) => entry.event === "device.deleted")).toMatchObject([
      { payload: { deviceId: device.id, initiator: "doctor" } },
    ]);
  });

  it("ends only the named lease and marks only its device deleted, leaving every other lease and device as they were, with the event's module registry", async () => {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    let next = 0;
    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator: { generate: () => String(next++) },
    });
    const leases = [];
    for (const name of ["one", "two"]) {
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "fake-1" },
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
    const state = await openTestState();
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
      state,
    });
    const changesBefore = totalChanges(state);
    let announced = false;

    await expect(
      registry.endLeaseAndMarkDeviceMissing("lse_nope", "doctor", () => {
        announced = true;
      }),
    ).rejects.toThrow(UnknownLeaseError);

    expect(announced).toBe(false);
    expect(totalChanges(state)).toBe(changesBefore);
  });
});

describe("Registry: the device event a transition carries", () => {
  async function provisioned() {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "x" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
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

const physicalInput = {
  apps: ["com.example.one", "com.example.two"],
  class: "phone",
  driverDeviceId: "00008110-001A2B3C4D5E" as string,
  model: "iPhone 15 Pro",
  osVersion: "18.4",
  platform: "ios",
} as const;

const physicalSpec = {
  class: "phone",
  model: "iPhone 15 Pro",
  osVersion: "18.4",
  physical: true,
  platform: "ios",
};

// why: a device id is "dev_" plus the next name pushed to `names`, so a test picks its ids.
async function seededWorld() {
  const clock = new FakeClock(1_000);
  const bus = new EventBus(clock);
  const state = await openTestState();
  const names: string[] = [];
  const registry = await loadTestRegistry({
    clock,
    eventBus: bus,
    idGenerator: { generate: () => names.shift() ?? "unexpected" },
    state,
  });
  const reload = () =>
    loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "unexpected" },
      state,
    });
  const enroll = (name: string, overrides: Partial<typeof physicalInput> = {}) => {
    names.push(name);
    return registry.enrollPhysical({ ...physicalInput, ...overrides });
  };
  const register = async (name: string) => {
    names.push(name);
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: `fake-${name}` },
      driverDeviceId: `driver_${name}`,
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    return device;
  };
  const lease = (deviceId: string, leaseId = `lse_${deviceId}`) =>
    registry.createLease({
      deviceId,
      leaseId,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 90_000,
      ttlMs: 60_000,
    });
  return { bus, clock, enroll, lease, register, registry, reload, state };
}

describe("Registry: physical devices (ADR 0022 §1)", () => {
  it("keeps a physical record's class and enrolled apps through a reload", async () => {
    const { enroll, registry, reload } = await seededWorld();
    await enroll("physical");
    await registry.markForeignStateDetected("dev_physical", 5);

    expect((await reload()).snapshot.devices).toEqual([
      expect.objectContaining({
        enrolledApps: ["com.example.one", "com.example.two"],
        foreignStateDetectedAt: 5,
        physical: true,
        spec: physicalSpec,
        state: "ready",
      }),
    ]);
  });

  it.each(["ready", "leased", "reclaiming", "quarantined", "deleted"] as const)(
    "reloads a physical record in the %s state",
    async (target) => {
      const { enroll, lease, registry, reload } = await seededWorld();
      await enroll("physical");
      if (target === "deleted") await registry.unenrollPhysical("dev_physical");
      if (target !== "ready" && target !== "deleted") await lease("dev_physical");
      if (target === "reclaiming" || target === "quarantined") {
        await registry.beginRelease("lse_dev_physical");
      }
      if (target === "quarantined") {
        await registry.enterQuarantine("dev_physical", 5_000, { kind: "purge-failed" });
      }

      expect((await reload()).snapshot.devices[0]).toMatchObject({
        physical: true,
        state: target,
      });
    },
  );

  it("lists every virtual record, and no physical one, in snapshot.virtualDevices, in the order of snapshot.devices", async () => {
    const { enroll, register, registry } = await seededWorld();
    await register("virtual");
    await register("virtual_2");
    await enroll("physical");

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

  it("lists a virtual device registered after a physical one before it", async () => {
    const { enroll, register, registry } = await seededWorld();
    await enroll("physical");
    await register("virtual");

    expect(registry.snapshot.devices.map((device) => device.physical)).toEqual([false, true]);
  });

  it("refuses to mark a physical device missing, whether the call is markDeviceMissing or endLeaseAndMarkDeviceMissing, and writes nothing", async () => {
    const { enroll, lease, registry, state } = await seededWorld();
    await enroll("physical");
    const idleChanges = totalChanges(state);

    await expect(registry.markDeviceMissing("dev_physical", "doctor")).rejects.toThrow(
      "Cannot mark a physical device missing",
    );

    expect(totalChanges(state)).toBe(idleChanges);
    expect(registry.snapshot.devices.map((device) => device.id)).toEqual(["dev_physical"]);

    await lease("dev_physical", "lse_physical");
    const leasedChanges = totalChanges(state);

    await expect(
      registry.endLeaseAndMarkDeviceMissing("lse_physical", "startup", () => undefined),
    ).rejects.toThrow("Cannot mark a physical device missing");

    expect(totalChanges(state)).toBe(leasedChanges);
    expect(registry.snapshot.leases.map((held) => held.id)).toEqual(["lse_physical"]);
  });

  it("keeps a grant of a physical device as it is, with no mode, across a reload", async () => {
    const { enroll, registry, reload } = await seededWorld();
    await enroll("physical");
    await registry.createLeaseRequest({
      id: "req_1",
      ownerId: "agent",
      request: { platform: "ios" },
      requesterId: "agent",
    });
    await registry.createLease({
      deviceId: "dev_physical",
      leaseId: "lse_physical",
      ownerId: "agent",
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
      requesterId: "agent",
      ttlDeadline: 90_000,
      ttlMs: 60_000,
    });

    const device = (await reload()).leaseRequests()[0]?.grant?.device;

    expect(device).toMatchObject({ physical: true, spec: { class: "phone", physical: true } });
    expect(device).not.toHaveProperty("mode");
  });

  it("moves a physical device to reclaiming when its lease is released and stamps lastLeaseEndedAt with the clock's time", async () => {
    const { enroll, lease, registry } = await seededWorld();
    await enroll("physical");
    await lease("dev_physical", "lse_physical");

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
    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator: { generate: () => `r${next++}` },
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
      driverData: { fakeDeviceId: "fake-1" },
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
  type Writer = (
    deviceId: string,
    to: string,
    event: { event: string; payload: Record<string, unknown> },
    update: Record<string, unknown>,
  ) => Promise<unknown>;

  const transitionAny = (registry: Registry): Writer =>
    registry.transitionDevice.bind(registry) as unknown as Writer;
  const goAbsent = (registry: Registry, deviceId: string, absentReason: string) =>
    transitionAny(registry)(
      deviceId,
      "absent",
      {
        event: "device.absence-detected",
        payload: { absentReason, deviceId, previousState: "ready" },
      },
      { absentReason },
    );
  const storedRows = (state: StateDatabase, columns: string) =>
    state.database.prepare(`SELECT ${columns} FROM devices ORDER BY rowid`).all();

  it("endLeaseAndMarkDeviceAbsent removes the lease, writes absent with its absentReason and stamps lastLeaseEndedAt in one commit, and calls announceLeaseEnd before emitting device.absence-detected", async () => {
    const { bus, enroll, lease, registry, state } = await seededWorld();
    await enroll("physical");
    await lease("dev_physical");
    const order: string[] = [];
    const payloads: unknown[] = [];
    bus.subscribeAll((envelope) => {
      order.push(envelope.event);
      payloads.push(envelope.payload);
    });

    await registry.endLeaseAndMarkDeviceAbsent("lse_dev_physical", "locked", () => {
      order.push("announce");
    });

    expect(registry.snapshot.leases).toEqual([]);
    expect(registry.snapshot.devices[0]).toMatchObject({
      absentReason: "locked",
      lastLeaseEndedAt: 1_000,
      state: "absent",
    });
    expect(state.database.prepare("SELECT COUNT(*) AS leases FROM leases").get()).toEqual({
      leases: 0,
    });
    expect(storedRows(state, "state, absent_reason, last_lease_ended_at")).toEqual([
      { absent_reason: "locked", last_lease_ended_at: 1_000, state: "absent" },
    ]);
    expect(order).toEqual(["announce", "device.absence-detected"]);
    expect(payloads[0]).toEqual({
      absentReason: "locked",
      deviceId: "dev_physical",
      previousState: "leased",
    });
  });

  it("absent -> reclaiming writes the new osVersion, stamps reclaimingSince, removes absentReason, keeps lastLeaseEndedAt, and transitionEnteredAt returns reclaimingSince", async () => {
    const { clock, enroll, lease, registry } = await seededWorld();
    await enroll("physical");
    await lease("dev_physical");
    await registry.endLeaseAndMarkDeviceAbsent("lse_dev_physical", "locked", () => undefined);
    clock.advance(500);

    await transitionAny(registry)(
      "dev_physical",
      "reclaiming",
      { event: "device.returned", payload: { deviceId: "dev_physical", osVersion: "18.5" } },
      { osVersion: "18.5" },
    );

    const stored = registry.snapshot.devices[0] as DeviceRecord & Record<string, unknown>;
    expect(stored).toMatchObject({
      lastLeaseEndedAt: 1_000,
      reclaimingSince: 1_500,
      spec: { osVersion: "18.5" },
      state: "reclaiming",
    });
    expect(stored).not.toHaveProperty("absentReason");
    expect(transitionEnteredAt(stored)).toBe(1_500);
  });

  it("beginRelease of a physical lease stamps reclaimingSince and lastLeaseEndedAt; of a virtual lease it stamps no reclaimingSince", async () => {
    const { enroll, lease, register, registry } = await seededWorld();
    await enroll("physical");
    await register("virtual");
    await lease("dev_physical");
    await lease("dev_virtual");

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
      createdAt: 600,
      driverData: {},
      driverDeviceId: "00008110-001A2B3C4D5E",
      enrolledApps: ["com.example.one"],
      id: "dev_physical",
      lastLeaseEndedAt: 2_000,
      physical: true,
      spec: physicalSpec,
      state: "reclaiming",
    } as unknown as DeviceRecord;

    expect(
      transitionEnteredAt({ ...reclaiming, reclaimingSince: 3_000 } as unknown as DeviceRecord),
    ).toBe(3_000);
    expect(transitionEnteredAt(reclaiming)).toBe(2_000);
  });

  it("a physical record with reclaimingSince and an absent one with absentReason survive a reload", async () => {
    const { enroll, lease, registry, reload } = await seededWorld();
    await enroll("a");
    await lease("dev_a");
    await registry.beginRelease("lse_dev_a");
    await registry.markForeignStateDetected("dev_a", 5);
    await enroll("b", { driverDeviceId: "other" });
    await goAbsent(registry, "dev_b", "untrusted");

    const reloaded = await reload();

    expect(reloaded.snapshot.devices).toEqual([
      expect.objectContaining({
        foreignStateDetectedAt: 5,
        id: "dev_a",
        lastLeaseEndedAt: 1_000,
        reclaimingSince: 1_000,
        state: "reclaiming",
      }),
      expect.objectContaining({ absentReason: "untrusted", id: "dev_b", state: "absent" }),
    ]);
  });

  it("absent -> ready (device add) and absent -> deleted (device remove) remove absentReason", async () => {
    const added = await seededWorld();
    await added.enroll("physical");
    await goAbsent(added.registry, "dev_physical", "not-present");
    const removed = await seededWorld();
    await removed.enroll("physical");
    await goAbsent(removed.registry, "dev_physical", "not-present");

    await added.registry.reenrollPhysical("dev_physical", {
      ...physicalInput,
      apps: ["com.example.one"],
    });
    await removed.registry.unenrollPhysical("dev_physical");

    expect(added.registry.snapshot.devices[0]).toMatchObject({ state: "ready" });
    expect(added.registry.snapshot.devices[0]).not.toHaveProperty("absentReason");
    expect(removed.registry.snapshot.devices[0]).toMatchObject({ state: "deleted" });
    expect(removed.registry.snapshot.devices[0]).not.toHaveProperty("absentReason");
    expect(storedRows(added.state, "absent_reason")).toEqual([{ absent_reason: null }]);
    expect(storedRows(removed.state, "absent_reason")).toEqual([{ absent_reason: null }]);
  });

  it("a transition into reclaiming stamps reclaimingSince on a physical device only, and a leased -> reclaiming move needs no device event", async () => {
    const { enroll, lease, register, registry } = await seededWorld();
    await enroll("physical");
    await register("virtual");
    await lease("dev_physical");
    await lease("dev_virtual");
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
    const { bus, enroll, registry } = await seededWorld();
    await enroll("physical");
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
    const { bus, enroll, registry } = await seededWorld();
    await enroll("physical");
    await goAbsent(registry, "dev_physical", "locked");
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
    const { bus, enroll, registry } = await seededWorld();
    await enroll("physical");
    const seen: string[] = [];
    bus.subscribeAll((envelope) => seen.push(envelope.event));

    await goAbsent(registry, "dev_physical", "locked");
    const absent = registry.snapshot.devices.find((entry) => entry.id === "dev_physical");
    const enrolled: unknown[] = [];
    bus.subscribe("device.enrolled", (envelope) => enrolled.push(envelope.payload));
    await registry.reenrollPhysical("dev_physical", { ...physicalInput, apps: [] });

    expect(absent).not.toHaveProperty("reclaimingSince");
    expect(seen).toEqual(["device.absence-detected", "device.enrolled"]);
    expect(enrolled).toMatchObject([{ deviceId: "dev_physical", reenrolled: true }]);
  });

  it("endLeaseAndMarkDeviceAbsent ends only the named lease, keeps every other device and lease, and emits from the registry", async () => {
    const { bus, enroll, lease, registry } = await seededWorld();
    await enroll("other", { driverDeviceId: "other" });
    await enroll("physical");
    await lease("dev_other");
    await lease("dev_physical");
    const modules: string[] = [];
    bus.subscribeAll((envelope) => modules.push(envelope.module));

    await registry.endLeaseAndMarkDeviceAbsent("lse_dev_physical", "locked", () => undefined);

    expect(registry.snapshot.leases.map((held) => held.id)).toEqual(["lse_dev_other"]);
    expect(registry.snapshot.devices.map((entry) => [entry.id, entry.state])).toEqual([
      ["dev_other", "leased"],
      ["dev_physical", "absent"],
    ]);
    expect(modules).toEqual(["registry"]);
  });

  it("endLeaseAndMarkDeviceAbsent of an unknown lease throws UnknownLeaseError and changes nothing", async () => {
    const { enroll, lease, registry } = await seededWorld();
    await enroll("physical");
    await lease("dev_physical");

    await expect(
      registry.endLeaseAndMarkDeviceAbsent("lse_missing", "locked", () => undefined),
    ).rejects.toBeInstanceOf(UnknownLeaseError);
    expect(registry.snapshot.devices[0]).toMatchObject({ state: "leased" });
    expect(registry.snapshot.leases).toHaveLength(1);
  });

  it("rewriteAbsentReason replaces the reason of an absent physical device and refuses a physical device that is not absent and a virtual one", async () => {
    const { enroll, register, registry, state } = await seededWorld();
    await register("virtual");
    await enroll("physical");
    await goAbsent(registry, "dev_physical", "not-present");
    await enroll("ready", { driverDeviceId: "r" });

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
      state.database.prepare("SELECT absent_reason FROM devices WHERE id = 'dev_physical'").get(),
    ).toEqual({ absent_reason: "locked" });
  });
});

describe("Registry: quarantineCause", () => {
  const purgeCause = {
    kind: "purge-failed" as const,
    message: "DriverCrashError: simctl erase exited 164",
  };

  async function reclaimingVirtual() {
    const world = await seededWorld();
    await world.register("virtual");
    await world.lease("dev_virtual", "lse_virtual");
    await world.registry.beginRelease("lse_virtual");
    return world;
  }

  async function quarantinedVirtual() {
    const world = await reclaimingVirtual();
    await world.registry.enterQuarantine("dev_virtual", 5_000, purgeCause);
    return world;
  }

  async function quarantinedPhysical() {
    const world = await seededWorld();
    await world.enroll("physical");
    await world.lease("dev_physical", "lse_physical");
    await world.registry.beginRelease("lse_physical");
    await world.registry.enterQuarantine("dev_physical", 5_000, purgeCause);
    return world;
  }

  const storedCauseKinds = (world: { state: StateDatabase }) =>
    world.state.database.prepare("SELECT quarantine_cause_kind FROM devices").all();

  it("a quarantined record with each kind, written by enterQuarantine and loaded by a new Registry, has its cause, with the clock short of quarantineNextRetryAt", async () => {
    const causes = [
      { kind: "purge-failed", message: "Error: purge exploded" },
      { kind: "shutdown-failed", message: "Error: shutdown exploded" },
      { kind: "delete-failed", message: "Error: delete exploded" },
      { kind: "stalled", stalledState: "provisioning" },
      { kind: "stalled", stalledState: "reclaiming" },
    ] as const;

    for (const cause of causes) {
      const { registry, reload } = await reclaimingVirtual();
      if (cause.kind === "delete-failed") {
        await registry.completeReclaimWithoutPurge("dev_virtual");
      }
      const entered = await registry.enterQuarantine("dev_virtual", 5_000, cause);
      expect(entered.quarantineCause, cause.kind).toEqual(cause);

      const reloaded = await reload();
      expect(reloaded.snapshot.devices[0], cause.kind).toMatchObject({
        quarantineCause: cause,
        state: "quarantined",
      });
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
      const world = await quarantinedVirtual();
      const { registry } = world;
      expect(registry.snapshot.devices[0]).toHaveProperty("quarantineCause");

      const result = await exit(registry);

      expect(result).not.toHaveProperty("quarantineCause");
      expect(registry.snapshot.devices[0]).not.toHaveProperty("quarantineCause");
      expect(storedCauseKinds(world)).toEqual([{ quarantine_cause_kind: null }]);
    });

    it.each([
      [
        "reenrollPhysical",
        (r: Registry) =>
          r.reenrollPhysical("dev_physical", { ...physicalInput, apps: ["com.example.one"] }),
      ],
      ["unenrollPhysical", (r: Registry) => r.unenrollPhysical("dev_physical")],
    ])("%s", async (_name, exit) => {
      const world = await quarantinedPhysical();
      const { registry } = world;
      expect(registry.snapshot.devices[0]).toHaveProperty("quarantineCause");

      const result = await exit(registry);

      expect(result).not.toHaveProperty("quarantineCause");
      expect(registry.snapshot.devices[0]).not.toHaveProperty("quarantineCause");
      expect(storedCauseKinds(world)).toEqual([{ quarantine_cause_kind: null }]);
    });
  });
});

describe("Registry: state.db rows", () => {
  async function world(
    options: { readonly leaseRequestLimits?: { maxRecords: number; retentionMs: number } } = {},
  ) {
    const clock = new FakeClock(1_000);
    const state = await openTestState();
    let next = 0;
    const open = (idGenerator: { generate: () => string }) =>
      loadTestRegistry({
        clock,
        eventBus: new EventBus(clock),
        idGenerator,
        state,
        ...options,
      });
    const registry = await open({ generate: () => String((next += 1)) });
    const readyDevice = async (fakeDeviceId: string) => {
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId },
        driverDeviceId: `drv-${fakeDeviceId}`,
        provisionDuration: 0,
        spec,
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      return device;
    };
    return { clock, open, readyDevice, registry, state };
  }

  it("a renew with 1,000 settled requests stored changes exactly one row", async () => {
    const { readyDevice, registry, state } = await world();
    const device = await readyDevice("fk-1");
    const lease = await registry.createLease({
      deviceId: device.id,
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlDeadline: 5_000,
      ttlMs: 4_000,
    });
    for (let index = 0; index < 1_000; index += 1) {
      await registry.createLeaseRequest({
        id: `req_${String(index)}`,
        ownerId: "agent-1",
        request: { platform: "ios" },
        requesterId: "agent-1",
      });
      await registry.settleLeaseRequest(`req_${String(index)}`, { state: "cancelled" });
    }
    expect(state.database.prepare("SELECT COUNT(*) AS n FROM lease_requests").get()?.n).toBe(1_000);

    const before = totalChanges(state);
    await registry.renewLease(lease.id, 9_000, 8_000);

    expect(Number(totalChanges(state)) - Number(before)).toBe(1);
    expect(state.database.prepare("SELECT ttl_deadline, ttl_ms FROM leases").all()).toEqual([
      { ttl_deadline: 9_000, ttl_ms: 8_000 },
    ]);
  });

  it("a renew with a fractional ttl is stored and read back unchanged", async () => {
    const { open, readyDevice, registry } = await world();
    const device = await readyDevice("fk-1");
    const lease = await registry.createLease({
      deviceId: device.id,
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlDeadline: 5_000.5,
      ttlMs: 4_000.5,
    });

    const renewed = await registry.renewLease(lease.id, 2_500.5, 1_500.5);

    expect(renewed).toMatchObject({ ttlDeadline: 2_500.5, ttlMs: 1_500.5 });
    const reloaded = await open({ generate: () => "unused" });
    expect(reloaded.snapshot.leases).toEqual([renewed]);
  });

  it("a grant with a fractional ttl is stored in lease_grants and read back unchanged", async () => {
    const { open, readyDevice, registry } = await world();
    const device = await readyDevice("fk-1");
    await registry.createLeaseRequest({
      id: "req_1",
      ownerId: "agent-1",
      request: { platform: "ios" },
      requesterId: "agent-1",
    });

    const lease = await registry.createLease({
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
      ttlDeadline: 5_000.5,
      ttlMs: 4_000.5,
    });

    expect(lease).toMatchObject({ ttlDeadline: 5_000.5, ttlMs: 4_000.5 });
    const reloaded = await open({ generate: () => "unused" });
    expect(reloaded.leaseRequests()).toEqual(registry.leaseRequests());
    expect(reloaded.snapshot.leases).toEqual([lease]);
  });

  it("a quarantine retry at a fractional time is stored and read back unchanged", async () => {
    const { open, readyDevice, registry } = await world();
    const device = await readyDevice("fk-1");
    const lease = await registry.createLease({
      deviceId: device.id,
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlDeadline: 2_000,
      ttlMs: 60_000,
    });
    await registry.beginRelease(lease.id);
    await registry.enterQuarantine(device.id, 5_000.5, { kind: "purge-failed" });

    const retried = await registry.recordQuarantineRetryFailure(
      device.id,
      1,
      50_700.000_000_000_01,
    );

    expect(retried.quarantineNextRetryAt).toBe(50_700.000_000_000_01);
    const reloaded = await open({ generate: () => "unused" });
    expect(reloaded.snapshot.devices).toEqual([retried]);
  });

  it("a grant writes the lease, the device's move to leased and the request's granted result in one transaction", async () => {
    const { clock, state } = await world();
    const timing = {
      estimatedBootMs: 2,
      estimatedProvisionMs: 1,
      estimatedReadyMs: 4,
      estimatedReclaimMs: 3,
    };
    let failWrites = false;
    const failing: DeviceDataTable = {
      ...fakeDeviceDataTable,
      write: (database, deviceId, driverData) => {
        if (failWrites) throw new Error("table refused the write");
        fakeDeviceDataTable.write(database, deviceId, driverData);
      },
    };
    const registry = await Registry.load({
      clock,
      deviceData: new Map([["ios", failing]]),
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "x" },
      state,
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fk-grant" },
      driverDeviceId: "drv-grant",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    await registry.createLeaseRequest({
      id: "req_grant",
      ownerId: "agent-1",
      request: { platform: "ios" },
      requesterId: "agent-1",
    });

    failWrites = true;
    await expect(
      registry.createLease({
        deviceId: device.id,
        ownerId: "agent-1",
        request: { environment: {}, id: "req_grant", timing },
        requesterId: "agent-1",
        ttlDeadline: 5_000,
        ttlMs: 4_000,
      }),
    ).rejects.toThrow("table refused the write");

    const restarted = await Registry.load({
      clock,
      deviceData: new Map([["ios", fakeDeviceDataTable]]),
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "y" },
      state,
    });
    for (const view of [registry, restarted]) {
      expect(view.snapshot.leases).toEqual([]);
      expect(view.snapshot.devices.map((record) => record.state)).toEqual(["ready"]);
      expect(view.leaseRequests().map((request) => request.state)).toEqual(["open"]);
    }
  });

  it("a commit that throws in SQLite leaves snapshot and the commit listeners as before the call, and the caller's promise rejects", async () => {
    const { readyDevice, registry, state } = await world();
    const device = await readyDevice("fk-throw");
    const committed: string[] = [];
    registry.onCommit(() => committed.push("commit"));
    const before = registry.snapshot;
    state.database.exec(
      "CREATE TRIGGER no_leases BEFORE INSERT ON leases BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );

    await expect(
      registry.createLease({
        deviceId: device.id,
        ownerId: "agent-1",
        requesterId: "agent-1",
        ttlDeadline: 5_000,
        ttlMs: 4_000,
      }),
    ).rejects.toThrow("disk full");

    expect(registry.snapshot).toEqual(before);
    expect(committed).toEqual([]);
    expect(state.database.prepare("SELECT state FROM devices").all()).toEqual([{ state: "ready" }]);
    state.database.exec("DROP TRIGGER no_leases");
    await registry.createLease({
      deviceId: device.id,
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlDeadline: 5_000,
      ttlMs: 4_000,
    });
    expect(committed).toEqual(["commit"]);
  });

  it("pruning deletes the rows of dropped requests and their grant and environment rows, past the retention and past the record cap", async () => {
    const counts = (state: StateDatabase) =>
      ["lease_requests", "lease_grants", "lease_grant_environment"].map(
        (table) => state.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      );
    const ask = (registry: Registry, id: string) =>
      registry.createLeaseRequest({
        id,
        ownerId: "agent-1",
        request: { platform: "ios" },
        requesterId: "agent-1",
      });

    const aged = await world({ leaseRequestLimits: { maxRecords: 10, retentionMs: 1_000 } });
    const device = await aged.readyDevice("fk-aged");
    await ask(aged.registry, "req_old");
    await aged.registry.createLease({
      deviceId: device.id,
      ownerId: "agent-1",
      request: {
        environment: { SIMLOCK_UDID: "abc", OTHER: "x" },
        id: "req_old",
        timing: {
          estimatedBootMs: 2,
          estimatedProvisionMs: 1,
          estimatedReadyMs: 4,
          estimatedReclaimMs: 3,
        },
      },
      requesterId: "agent-1",
      ttlDeadline: 5_000,
      ttlMs: 4_000,
    });
    expect(counts(aged.state)).toEqual([1, 1, 2]);
    aged.clock.advance(999);
    await ask(aged.registry, "req_new");
    expect(counts(aged.state)).toEqual([2, 1, 2]);
    aged.clock.advance(2);
    await ask(aged.registry, "req_newer");
    expect(counts(aged.state)).toEqual([2, 0, 0]);
    expect(
      aged.state.database.prepare("SELECT id FROM lease_requests ORDER BY rowid").all(),
    ).toEqual([{ id: "req_new" }, { id: "req_newer" }]);

    const capped = await world({ leaseRequestLimits: { maxRecords: 2, retentionMs: 1_000_000 } });
    await ask(capped.registry, "req_a");
    await capped.registry.settleLeaseRequest("req_a", { state: "cancelled" });
    await ask(capped.registry, "req_b");
    await ask(capped.registry, "req_c");
    expect(
      capped.state.database.prepare("SELECT id FROM lease_requests ORDER BY rowid").all(),
    ).toEqual([{ id: "req_b" }, { id: "req_c" }]);
  });

  it("a replayed answer's device is the current device record, before and after a restart, while its lease, environment and timing are as first granted", async () => {
    const { open, readyDevice, registry, state } = await world();
    const device = await readyDevice("fk-replay");
    await registry.createLeaseRequest({
      id: "req_replay",
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
      request: { environment: { SIMLOCK_UDID: "abc" }, id: "req_replay", timing },
      requesterId: "agent-1",
      ttlDeadline: 5_000,
      ttlMs: 4_000,
    });
    expect(registry.leaseRequests()[0]?.grant?.device.state).toBe("leased");
    await registry.beginRelease(lease.id);

    const restarted = await open({ generate: () => "after" });
    for (const view of [registry, restarted]) {
      const grant = view.leaseRequests()[0]?.grant;
      expect(grant?.device).toMatchObject({ id: device.id, state: "reclaiming" });
      expect(grant?.lease).toEqual(lease);
      expect(grant?.environment).toEqual({ SIMLOCK_UDID: "abc" });
      expect(grant?.timing).toEqual(timing);
    }
    expect(state.database.prepare("SELECT COUNT(*) AS n FROM lease_grants").get()?.n).toBe(1);
  });

  it("load refuses with RegistryLoadError naming the table and key for a virtual device with no device-data row, a device whose platform has no table, a grant naming a missing device and a state outside its type", async () => {
    const reload = (state: StateDatabase, platforms: readonly Platform[] = ["ios", "android"]) =>
      Registry.load({
        clock: new FakeClock(1_000),
        deviceData: new Map(platforms.map((platform) => [platform, fakeDeviceDataTable])),
        eventBus: new EventBus(new FakeClock(1_000)),
        idGenerator: { generate: () => "z" },
        state,
      });
    const grantedWorld = async () => {
      const built = await world();
      const device = await built.readyDevice("fk-load");
      await built.registry.createLeaseRequest({
        id: "req_load",
        ownerId: "agent-1",
        request: { platform: "ios" },
        requesterId: "agent-1",
      });
      await built.registry.createLease({
        deviceId: device.id,
        ownerId: "agent-1",
        request: {
          environment: {},
          id: "req_load",
          timing: {
            estimatedBootMs: 0,
            estimatedProvisionMs: 0,
            estimatedReadyMs: 0,
            estimatedReclaimMs: 0,
          },
        },
        requesterId: "agent-1",
        ttlDeadline: 5_000,
        ttlMs: 4_000,
      });
      return { ...built, deviceId: device.id };
    };

    const cases: {
      readonly corrupt: (state: StateDatabase, deviceId: string) => void;
      readonly platforms?: readonly Platform[];
      readonly message: (deviceId: string) => RegExp;
    }[] = [
      {
        corrupt: (state, deviceId) =>
          state.database.prepare("DELETE FROM fake_device_data WHERE device_id = ?").run(deviceId),
        message: (deviceId) => new RegExp(`devices row ${deviceId}`),
      },
      {
        corrupt: () => undefined,
        message: (deviceId) => new RegExp(`devices row ${deviceId}`),
        platforms: ["android"],
      },
      {
        corrupt: (state, deviceId) => {
          state.database.exec("PRAGMA foreign_keys=OFF");
          state.database.prepare("DELETE FROM fake_device_data WHERE device_id = ?").run(deviceId);
          state.database.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
        },
        message: () => /lease_grants row req_load/,
      },
      {
        corrupt: (state, deviceId) =>
          state.database.prepare("UPDATE devices SET state = 'warm' WHERE id = ?").run(deviceId),
        message: (deviceId) => new RegExp(`devices row ${deviceId}`),
      },
    ];
    for (const { corrupt, message, platforms } of cases) {
      const { deviceId, state } = await grantedWorld();
      await expect(reload(state)).resolves.toBeInstanceOf(Registry);
      corrupt(state, deviceId);
      const refusal = await reload(state, platforms).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(RegistryLoadError);
      expect((refusal as Error).message).toMatch(message(deviceId));
    }
  });

  it("a physical device loads with empty driver data and has no device-data row", async () => {
    const { open, readyDevice, registry, state } = await world();
    const virtual = await readyDevice("fk-virtual");
    const physical = await registry.enrollPhysical({
      apps: ["com.a"],
      class: "phone",
      driverDeviceId: "udid-1",
      model: "iPhone 15",
      osVersion: "18.4",
      platform: "ios",
    });

    const restarted = await open({ generate: () => "later" });

    expect(restarted.snapshot.devices.find((device) => device.id === physical.id)).toMatchObject({
      driverData: {},
      physical: true,
    });
    expect(state.database.prepare("SELECT device_id FROM fake_device_data").all()).toEqual([
      { device_id: virtual.id },
    ]);
  });

  it("two transitions of two devices started in one tick both persist, in memory and after a restart", async () => {
    const { open, readyDevice, registry } = await world();
    const first = await readyDevice("fk-first");
    const second = await readyDevice("fk-second");
    const shutdown = (id: string) =>
      registry.transitionDevice(id, "shutdown", {
        event: "device.shutdown",
        payload: { deviceId: id, initiator: "idle" },
      });

    await Promise.all([shutdown(first.id), shutdown(second.id)]);

    const restarted = await open({ generate: () => "later" });
    for (const view of [registry, restarted]) {
      expect(view.snapshot.devices.map((device) => device.state)).toEqual(["shutdown", "shutdown"]);
    }
  });
});
