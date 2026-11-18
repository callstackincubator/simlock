import { describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { loadTestRegistry, openTestState } from "./testing.js";
import { Registry, UnknownLeaseError } from "./index.js";
import { seededWorld, spec, totalChanges } from "./test-registry.js";

describe("Registry", () => {
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
      deletedAt: 1_000,
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
