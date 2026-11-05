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
  type DeviceTransitionUpdate,
  type Platform,
  type VirtualSpec,
  Registry,
  registryOwner,
  RegistryEventError,
  RegistryLoadError,
  UnknownDeviceError,
  UnknownLeaseError,
} from "./index.js";
import { physicalInput, seededWorld, spec, totalChanges } from "./test-registry.js";

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

  it("a state.db at registry version 2 migrates to 3, keeps its requests, and then stores a request's baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-registry-"));
    try {
      const clock = new FakeClock(1_000);
      const deviceData = new Map<Platform, DeviceDataTable>([
        ["android", fakeDeviceDataTable],
        ["ios", fakeDeviceDataTable],
      ]);
      const openState = (owner: typeof registryOwner) =>
        openStateDatabase({
          dataDirectory: directory,
          filesystem: new NodeFilesystem(),
          logger: new NoopLogger(),
          oldFiles: [],
          owners: [owner, fakeDeviceDataTable],
          sqlite: new NodeSqliteOpener(),
          upgradeStep: "remove it.",
        });
      const loadRegistry = (state: StateDatabase) =>
        Registry.load({
          clock,
          deviceData,
          eventBus: new EventBus(clock),
          idGenerator: { generate: () => "id" },
          state,
        });
      const old = await openState({
        ...registryOwner,
        migrations: registryOwner.migrations.slice(0, 2),
        version: 2,
      });
      old.database
        .prepare(
          "INSERT INTO lease_requests (id, requester_id, owner_id, platform, model, created_at, state) VALUES ('req_old', 'agent', 'agent', 'ios', 'iPhone 16', 5, 'open')",
        )
        .run();
      old.close();

      const migrated = await openState(registryOwner);
      const registry = await loadRegistry(migrated);
      expect(registry.leaseRequests().map((record) => [record.id, record.request])).toEqual([
        ["req_old", { model: "iPhone 16", platform: "ios" }],
      ]);
      await registry.createLeaseRequest({
        id: "req_new",
        ownerId: "agent",
        request: { baseline: "checkout", platform: "ios" },
        requesterId: "agent",
      });
      migrated.close();

      const reopened = await loadRegistry(await openState(registryOwner));
      expect(reopened.leaseRequests().map((record) => record.request.baseline)).toEqual([
        undefined,
        "checkout",
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
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
        { ...spec, baseline: { name: "checkout", version: 2 }, imageTag: "default", mode: "slim" },
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
        spec: {
          ...spec,
          baseline: { name: "checkout", version: 2 },
          imageTag: "default",
          mode: "slim",
        },
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

    const refused = registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: "dev_someone_else" },
    });
    await expect(refused).rejects.toThrow(RegistryEventError);
    await expect(refused).rejects.toThrow(
      `Device event payload does not match device: ${device.id}`,
    );
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

  it.each([
    [
      "endLeaseAndMarkDeviceMissing",
      (registry: Registry, announce: () => void) =>
        registry.endLeaseAndMarkDeviceMissing("lse_nope", "doctor", announce),
    ],
    [
      "endLeaseAndMarkDeviceAbsent",
      (registry: Registry, announce: () => void) =>
        registry.endLeaseAndMarkDeviceAbsent("lse_nope", "locked", announce),
    ],
  ])(
    "%s refuses to end a lease it does not hold, writing nothing and announcing nothing",
    async (_method, endLease) => {
      const { enroll, lease, registry, state } = await seededWorld();
      await enroll("physical");
      await lease("dev_physical");
      const devicesBefore = structuredClone(registry.snapshot.devices);
      const leasesBefore = structuredClone(registry.snapshot.leases);
      const changesBefore = totalChanges(state);
      let announced = false;

      await expect(
        endLease(registry, () => {
          announced = true;
        }),
      ).rejects.toThrow(UnknownLeaseError);

      expect(announced).toBe(false);
      expect(totalChanges(state)).toBe(changesBefore);
      expect(registry.snapshot.devices).toEqual(devicesBefore);
      expect(registry.snapshot.leases).toEqual(leasesBefore);
    },
  );
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

  it("a quarantined record with each kind, written by enterQuarantine and loaded by a new Registry, has its cause", async () => {
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
