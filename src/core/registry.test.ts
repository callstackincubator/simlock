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
} from "./index.js";
import { spec } from "./test-registry.js";
import { loadAfterCorruptingDevice } from "./test-registry-corrupt-row.js";

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

  it("a state.db at registry version 4 with deleted rows migrates, keeps them for one retention period after the first start, then drops them", async () => {
    const MINUTE = 60_000;
    const directory = await mkdtemp(join(tmpdir(), "simlock-registry-"));
    try {
      // why: created_at 5 is two hours old at the first start, so a stamp taken from it would drop the rows at once.
      const clock = new FakeClock(120 * MINUTE);
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
      const loadRegistry = async () => {
        const state = await openState(registryOwner);
        const registry = await Registry.load({
          clock,
          deviceData,
          eventBus: new EventBus(clock),
          idGenerator: { generate: () => "id" },
          state,
        });
        const ids = registry.snapshot.devices.map((device) => device.id);
        state.close();
        return ids;
      };
      const old = await openState({
        ...registryOwner,
        migrations: registryOwner.migrations.slice(0, 4),
        version: 4,
      });
      for (const id of ["dev_gone_1", "dev_gone_2"]) {
        old.database
          .prepare(
            "INSERT INTO devices (id, platform, physical, driver_device_id, state, model, os_version, mode, created_at) VALUES (?, 'ios', 0, ?, 'deleted', 'iPhone 16', '18.0', 'full', 5)",
          )
          .run(id, `drv-${id}`);
        fakeDeviceDataTable.write(old.database, id, { fakeDeviceId: id });
      }
      old.close();

      expect(await loadRegistry()).toEqual(["dev_gone_1", "dev_gone_2"]);
      clock.advance(59 * MINUTE);
      expect(await loadRegistry()).toEqual(["dev_gone_1", "dev_gone_2"]);
      clock.advance(2 * MINUTE);
      expect(await loadRegistry()).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("a state.db at registry version 6 migrates to 7, loads its physical rows with no hardware serial, and then stores one", async () => {
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
          idGenerator: { generate: () => "new" },
          state,
        });
      const old = await openState({
        ...registryOwner,
        migrations: registryOwner.migrations.slice(0, 6),
        version: 6,
      });
      old.database
        .prepare(
          "INSERT INTO devices (id, platform, physical, driver_device_id, state, model, os_version, class, created_at) VALUES ('dev_old', 'android', 1, 'R58Y61A60HN', 'ready', 'Pixel 8', '15', 'phone', 5)",
        )
        .run();
      old.close();

      const migrated = await openState(registryOwner);
      const registry = await loadRegistry(migrated);
      expect(registry.snapshot.devices.map((device) => [device.id, device.physical])).toEqual([
        ["dev_old", true],
      ]);
      expect(registry.snapshot.devices[0]).not.toHaveProperty("hardwareSerial");
      await registry.enrollPhysical({
        apps: [],
        class: "phone",
        driverDeviceId: "192.168.1.5:5555",
        hardwareSerial: "R58Y61A60HN2",
        model: "Pixel 8",
        osVersion: "15",
        platform: "android",
      });
      migrated.close();

      const reopened = await loadRegistry(await openState(registryOwner));
      expect(
        reopened.snapshot.devices.map((device) => device.physical && device.hardwareSerial),
      ).toEqual([undefined, "R58Y61A60HN2"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("a state.db at registry version 8 migrates to 9, loads its leases with no label, and then keeps the label of a labelled lease across a reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-registry-"));
    try {
      const clock = new FakeClock(1_000);
      let next = 0;
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
          idGenerator: { generate: () => String((next += 1)) },
          state,
        });
      const old = await openState({
        ...registryOwner,
        migrations: registryOwner.migrations.slice(0, 8),
        version: 8,
      });
      old.database
        .prepare(
          "INSERT INTO devices (id, platform, physical, driver_device_id, state, model, os_version, class, created_at) VALUES ('dev_old', 'android', 1, 'R58Y61A60HN', 'leased', 'Pixel 8', '15', 'phone', 5)",
        )
        .run();
      old.database
        .prepare(
          "INSERT INTO leases (id, device_id, requester_id, owner_id, granted_at, ttl_ms, ttl_deadline, last_renewed_at, id_chosen_by_requester, run_id) VALUES ('lse_old', 'dev_old', 'r', 'o', 5, 10, 15, 5, 0, '7-1')",
        )
        .run();
      old.close();

      const migrated = await openState(registryOwner);
      const registry = await loadRegistry(migrated);
      expect(registry.snapshot.leases.map((lease) => lease.id)).toEqual(["lse_old"]);
      expect(registry.snapshot.leases[0]).not.toHaveProperty("label");
      expect(registry.snapshot.leases[0]).toMatchObject({ runId: "7-1" });

      const timing = {
        estimatedBootMs: 2,
        estimatedProvisionMs: 1,
        estimatedReadyMs: 4,
        estimatedReclaimMs: 3,
      };
      const lease = async (name: string, label: string | undefined) => {
        const device = await registry.registerDevice({
          driverData: { fakeDeviceId: name },
          driverDeviceId: name,
          provisionDuration: 5,
          spec,
        });
        await registry.transitionDevice(device.id, "ready", {
          event: "device.ready",
          payload: { bootDuration: 7, deviceId: device.id },
        });
        const labelOption = label === undefined ? {} : { label };
        await registry.createLeaseRequest({
          id: `req_${name}`,
          ownerId: "o",
          request: { platform: "ios" },
          requesterId: name,
          ...labelOption,
        });
        return registry.createLease({
          deviceId: device.id,
          ownerId: "o",
          request: { environment: {}, id: `req_${name}`, timing },
          requesterId: name,
          ttlDeadline: 2_000,
          ttlMs: 1_000,
          ...labelOption,
        });
      };
      const labelled = await lease("labelled", "feature-x");
      const plain = await lease("plain", undefined);
      migrated.close();

      const reopened = await loadRegistry(await openState(registryOwner));
      const byId = (id: string) =>
        reopened.snapshot.leases.find((candidate) => candidate.id === id);
      expect(byId(labelled.id)).toMatchObject({ label: "feature-x" });
      expect(byId(plain.id)).not.toHaveProperty("label");
      expect(byId("lse_old")).not.toHaveProperty("label");
      const stored = (id: string) =>
        reopened.leaseRequests().find((record) => record.id === `req_${id}`);
      expect(stored("labelled")).toMatchObject({
        label: "feature-x",
        grant: { lease: { label: "feature-x" } },
      });
      expect(stored("plain")?.grant?.lease).not.toHaveProperty("label");
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
});
