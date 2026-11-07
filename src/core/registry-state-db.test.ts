import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import { fakeDeviceDataTable, loadTestRegistry, openTestState } from "./testing.js";
import { type DeviceDataTable, type Platform, Registry, RegistryLoadError } from "./index.js";
import { spec, totalChanges } from "./test-registry.js";

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
    // why: Fallow reads a binding's type only from an annotation in this file, not from an imported
    // helper's return type; without it Fallow reports `Registry.renewLease` as never referenced.
    const registry: Registry = await open({ generate: () => String((next += 1)) });
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

    const committed: string[] = [];
    registry.onCommit(() => committed.push("commit"));
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
    expect(committed).toEqual([]);

    failWrites = false;
    await registry.createLease({
      deviceId: device.id,
      ownerId: "agent-1",
      request: { environment: {}, id: "req_grant", timing },
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

    const grant = (registry: Registry, deviceId: string, id: string) =>
      registry.createLease({
        deviceId,
        ownerId: "agent-1",
        request: {
          environment: { SIMLOCK_UDID: "abc", OTHER: "x" },
          id,
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

    const aged = await world({ leaseRequestLimits: { maxRecords: 10, retentionMs: 1_000 } });
    const device = await aged.readyDevice("fk-aged");
    await ask(aged.registry, "req_old");
    await grant(aged.registry, device.id, "req_old");
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
    const cappedDevice = await capped.readyDevice("fk-capped");
    await ask(capped.registry, "req_a");
    await grant(capped.registry, cappedDevice.id, "req_a");
    expect(counts(capped.state)).toEqual([1, 1, 2]);
    await ask(capped.registry, "req_b");
    await ask(capped.registry, "req_c");
    expect(counts(capped.state)).toEqual([2, 0, 0]);
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

  // why: #1410 — the proposed bound. A deleted record stays in state.db (core manual), but memory
  // and `status.get`, which answers `snapshot.devices`, keep only the 100 most recently deleted.
  it("the snapshot holds every live device and only the 100 most recently deleted ones, while state.db keeps every deleted row, before and after a restart", async () => {
    const { open, readyDevice, registry, state } = await world();
    const firstLive = await readyDevice("live-1");
    const deletedLast = await readyDevice("deleted-last");
    const bulk = [];
    for (let index = 0; index < 102; index += 1) {
      const device = await readyDevice(`bulk-${String(index)}`);
      await registry.markDeviceMissing(device.id, "doctor");
      bulk.push(device.id);
    }
    await registry.markDeviceMissing(deletedLast.id, "doctor");
    const lastLive = await readyDevice("live-2");

    const deletedIds = (view: Registry) =>
      view.snapshot.devices
        .filter((device) => device.state === "deleted")
        .map((device) => device.id);
    const liveIds = (view: Registry) =>
      view.snapshot.devices
        .filter((device) => device.state !== "deleted")
        .map((device) => device.id);

    expect(liveIds(registry)).toEqual([firstLive.id, lastLive.id]);
    expect([...deletedIds(registry)].sort()).toEqual([...bulk.slice(3), deletedLast.id].sort());
    expect(
      state.database.prepare("SELECT COUNT(*) AS n FROM devices WHERE state = 'deleted'").get()?.n,
    ).toBe(103);

    const restarted = await open({ generate: () => "unused" });
    expect(liveIds(restarted)).toEqual([firstLive.id, lastLive.id]);
    expect(deletedIds(restarted)).toHaveLength(100);
    expect(
      state.database.prepare("SELECT COUNT(*) AS n FROM devices WHERE state = 'deleted'").get()?.n,
    ).toBe(103);
  });
});
