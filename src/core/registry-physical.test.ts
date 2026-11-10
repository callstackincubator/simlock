import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import { loadTestRegistry } from "./testing.js";
import { type DeviceRecord, Registry, RegistryEventError, transitionEnteredAt } from "./index.js";
import { physicalInput, seededWorld, spec, totalChanges } from "./test-registry.js";

const physicalSpec = {
  class: "phone",
  model: "iPhone 15 Pro",
  osVersion: "18.4",
  physical: true,
  platform: "ios",
};

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
          initiator: "operator",
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

    const reenrolLeased = registry.reenrollPhysical(device.id, input);
    await expect(reenrolLeased).rejects.toThrow(RegistryEventError);
    await expect(reenrolLeased).rejects.toThrow(`Cannot re-enrol device: ${device.id}`);
    const unenrolLeased = registry.unenrollPhysical(device.id);
    await expect(unenrolLeased).rejects.toThrow(RegistryEventError);
    await expect(unenrolLeased).rejects.toThrow(`Cannot unenrol device: ${device.id}`);
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

  it("absent -> reclaiming writes the new osVersion, stamps reclaimingSince, removes absentReason, keeps lastLeaseEndedAt", async () => {
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
    expect(registry.snapshot.devices.find((entry) => entry.id === "dev_physical")).toMatchObject({
      lastLeaseEndedAt: 1_000,
      state: "reclaiming",
    });
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
