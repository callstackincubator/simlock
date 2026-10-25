import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { type FakePhysicalDevice } from "./fake-driver.js";
import type { PhysicalDevice } from "./domain.js";
import { createCore, loadConfig } from "./index.js";
import { PhysicalEnrollment } from "./physical-enrollment.js";
import { FakeDriver, loadTestRegistry, testComponentWiring, testStateOf } from "./testing.js";

const UDID = "00008110-001A2B3C4D5E";
const ALIAS = "7A1C0E52-6B7D-4F1E-9C1A-2D3E4F5A6B7C";

const IPHONE: FakePhysicalDevice = {
  apps: ["com.example.one", "com.example.two"],
  class: "phone",
  ids: [UDID, ALIAS],
  model: "iPhone 15 Pro",
  osVersion: "18.4",
};

async function build(physicalDevices: readonly FakePhysicalDevice[] = [IPHONE]) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const driver = new FakeDriver({ clock, physicalDevices, platform: "ios" });
  const filesystem = new MemoryFilesystem();
  const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
  let next = 1;
  const registry = await loadTestRegistry({
    clock,
    eventBus,
    idGenerator: { generate: () => `${next++}` },
  });
  const core = createCore({
    clock,
    config: await loadConfig({ filesystem, systemStats }),
    drivers: [driver],
    eventBus,
    registry,
    state: testStateOf(registry),
    systemStats,
    ...testComponentWiring({ clock, drivers: [driver], eventBus, registry }),
  });
  return { clock, core, driver, eventBus, registry };
}

type Harness = Awaited<ReturnType<typeof build>>;

function physicalRecords(harness: Harness): PhysicalDevice[] {
  return harness.registry.snapshot.devices.filter(
    (device): device is PhysicalDevice => device.physical,
  );
}

function live(harness: Harness): PhysicalDevice[] {
  return physicalRecords(harness).filter((device) => device.state !== "deleted");
}

function enrolledEvents(harness: Harness) {
  return harness.eventBus.replay().filter((entry) => entry.event === "device.enrolled");
}

async function quarantine(harness: Harness, deviceId: string): Promise<void> {
  const lease = await harness.registry.createLease({
    deviceId,
    ownerId: "agent",
    requesterId: "agent",
    ttlDeadline: 61_000,
    ttlMs: 60_000,
  });
  await harness.registry.beginRelease(lease.id);
  await harness.registry.enterQuarantine(deviceId, 9_000, { kind: "purge-failed" });
}

function holdInspection(driver: FakeDriver, callNumber: number) {
  const original = driver.inspectPhysical.bind(driver);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const reached = vi.fn();
  vi.spyOn(driver, "inspectPhysical").mockImplementation(async (id) => {
    calls += 1;
    if (calls === callNumber) {
      reached();
      await gate;
    }
    return original(id);
  });
  return { reached, release };
}

describe("PhysicalEnrollment", () => {
  it("records the apps the driver lists as the record's enrolledApps", async () => {
    const harness = await build();

    const { device, reenrolled } = await harness.core.enrollment.add("ios", UDID);

    expect(reenrolled).toBe(false);
    expect(device.enrolledApps).toEqual(["com.example.one", "com.example.two"]);
    expect(live(harness)[0]?.enrolledApps).toEqual(["com.example.one", "com.example.two"]);
    expect(live(harness)[0]?.driverDeviceId).toBe(UDID);
  });

  it("re-enrolls with the model, OS version, class and apps the fake now reports, and the same registry ID", async () => {
    const harness = await build();
    const first = await harness.core.enrollment.add("ios", UDID);
    harness.driver.setPhysicalDevices([
      {
        apps: ["com.example.three"],
        class: "tablet",
        ids: [UDID, ALIAS],
        model: "iPad Pro",
        osVersion: "18.5",
      },
    ]);

    const again = await harness.core.enrollment.add("ios", ALIAS);

    expect(again.reenrolled).toBe(true);
    expect(again.device.id).toBe(first.device.id);
    expect(live(harness)).toHaveLength(1);
    expect(live(harness)[0]).toMatchObject({
      enrolledApps: ["com.example.three"],
      id: first.device.id,
      spec: { class: "tablet", model: "iPad Pro", osVersion: "18.5" },
      state: "ready",
    });
    expect(enrolledEvents(harness).map((entry) => entry.payload)).toMatchObject([
      { appCount: 2, reenrolled: false },
      { appCount: 1, class: "tablet", reenrolled: true },
    ]);
  });

  it("reads the device under the claim by its canonical ID, whatever ID the operator typed", async () => {
    const harness = await build();
    await harness.core.enrollment.add("ios", UDID);

    await harness.core.enrollment.add("ios", ALIAS);

    const reads = harness.driver.calls
      .filter((call) => call.operation === "inspectPhysical")
      .map((call) => call.arguments[0]);
    expect(reads).toEqual([UDID, ALIAS, UDID]);
  });

  it("leaves one non-deleted record and two device.enrolled for two adds of one new device at once, the second reenrolled", async () => {
    const harness = await build();

    const results = await Promise.all([
      harness.core.enrollment.add("ios", UDID),
      harness.core.enrollment.add("ios", ALIAS),
    ]);

    expect(live(harness)).toHaveLength(1);
    expect(results.map((result) => result.reenrolled)).toEqual([false, true]);
    expect(enrolledEvents(harness).map((entry) => entry.payload)).toMatchObject([
      { reenrolled: false },
      { reenrolled: true },
    ]);
  });

  it("makes a quarantined physical device ready with no quarantine fields and the same registry ID when it is re-enrolled", async () => {
    const harness = await build();
    const { device } = await harness.core.enrollment.add("ios", UDID);
    await quarantine(harness, device.id);
    expect(live(harness)[0]).toMatchObject({
      quarantinedAt: expect.any(Number),
      state: "quarantined",
    });

    await harness.core.enrollment.add("ios", UDID);

    const record = live(harness)[0];
    expect(record).toMatchObject({ id: device.id, state: "ready" });
    expect(record).not.toHaveProperty("quarantinedAt");
    expect(record).not.toHaveProperty("quarantineAttempts");
    expect(record).not.toHaveProperty("quarantineNextRetryAt");
  });

  it("makes a quarantined physical device deleted when it is removed", async () => {
    const harness = await build();
    const { device } = await harness.core.enrollment.add("ios", UDID);
    await quarantine(harness, device.id);

    await harness.core.enrollment.remove(UDID);

    expect(physicalRecords(harness)[0]).toMatchObject({ id: device.id, state: "deleted" });
    expect(physicalRecords(harness)[0]).not.toHaveProperty("quarantinedAt");
  });

  it("answers DEVICE_BUSY leased to add and remove of a leased device, and changes nothing", async () => {
    const harness = await build();
    const { device } = await harness.core.enrollment.add("ios", UDID);
    await harness.registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 61_000,
      ttlMs: 60_000,
    });
    const before = JSON.stringify(harness.registry.snapshot.devices);

    await expect(harness.core.enrollment.add("ios", UDID)).rejects.toMatchObject({
      name: "DeviceBusyError",
      reason: "leased",
    });
    await expect(harness.core.enrollment.remove(UDID)).rejects.toMatchObject({
      name: "DeviceBusyError",
      reason: "leased",
    });

    expect(JSON.stringify(harness.registry.snapshot.devices)).toBe(before);
  });

  it("answers DEVICE_BUSY reclaiming to add and remove of a reclaiming device, and of a ready one whose reclaim claim is held", async () => {
    const harness = await build();
    const { device } = await harness.core.enrollment.add("ios", UDID);
    const claim = harness.core.claims.tryClaim(device.id, "reclaim");
    expect(claim).toBeDefined();
    for (const attempt of [
      () => harness.core.enrollment.add("ios", UDID),
      () => harness.core.enrollment.remove(UDID),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        name: "DeviceBusyError",
        reason: "reclaiming",
      });
    }
    claim?.release();

    const lease = await harness.registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 61_000,
      ttlMs: 60_000,
    });
    await harness.registry.beginRelease(lease.id);
    expect(live(harness)[0]?.state).toBe("reclaiming");
    for (const attempt of [
      () => harness.core.enrollment.add("ios", UDID),
      () => harness.core.enrollment.remove(UDID),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        name: "DeviceBusyError",
        reason: "reclaiming",
      });
    }
  });

  it("answers DEVICE_BUSY busy to another add and to a remove while an add waits on its second inspection", async () => {
    const harness = await build();
    await harness.core.enrollment.add("ios", UDID);
    // The second `add` reads once before it takes the claim, and again under it: hold that read.
    const held = holdInspection(harness.driver, 2);
    const waiting = harness.core.enrollment.add("ios", UDID);
    await vi.waitFor(() => expect(held.reached).toHaveBeenCalled());

    await expect(harness.core.enrollment.add("ios", ALIAS)).rejects.toMatchObject({
      name: "DeviceBusyError",
      reason: "busy",
    });
    await expect(harness.core.enrollment.remove(UDID)).rejects.toMatchObject({
      name: "DeviceBusyError",
      reason: "busy",
    });
    held.release();
    await expect(waiting).resolves.toMatchObject({ reenrolled: true });
    await expect(harness.core.enrollment.remove(UDID)).resolves.toMatchObject({
      state: "deleted",
    });
  });

  it.each([
    ["is refused", "refuse"],
    ["throws", "throw"],
  ] as const)(
    "leaves the record as it was when the second inspection %s, and a remove right after it succeeds",
    async (_case, how) => {
      const harness = await build();
      await harness.core.enrollment.add("ios", UDID);
      const before = JSON.stringify(live(harness));
      const original = harness.driver.inspectPhysical.bind(harness.driver);
      let calls = 0;
      vi.spyOn(harness.driver, "inspectPhysical").mockImplementation(async (id) => {
        calls += 1;
        if (calls < 2) return original(id);
        if (how === "throw") throw new Error("usbmuxd went away");
        return { enrollable: false, message: "locked: unlock it and try again", reason: "locked" };
      });

      const failed = harness.core.enrollment.add("ios", UDID);

      await expect(failed).rejects.toMatchObject(
        how === "throw"
          ? { name: "PhysicalInspectionError" }
          : { canonicalId: UDID, name: "DeviceNotEnrollableError", reason: "locked" },
      );
      expect(JSON.stringify(live(harness))).toBe(before);
      await expect(harness.core.enrollment.remove(UDID)).resolves.toMatchObject({
        state: "deleted",
      });
    },
  );

  it("rejects with a PhysicalInspectionError, not a refusal, and writes nothing when the first inspection throws", async () => {
    const harness = await build();
    harness.driver.failOn("inspectPhysical", 1, new Error("usbmuxd went away"));

    await expect(harness.core.enrollment.add("ios", UDID)).rejects.toMatchObject({
      name: "PhysicalInspectionError",
    });

    expect(physicalRecords(harness)).toEqual([]);
    expect(enrolledEvents(harness)).toEqual([]);
  });

  it("rejects with a PhysicalInspectionError and writes nothing when the second inspection names another canonical ID, and a remove right after it succeeds", async () => {
    const harness = await build();
    await harness.core.enrollment.add("ios", UDID);
    const before = JSON.stringify(live(harness));
    const original = harness.driver.inspectPhysical.bind(harness.driver);
    let calls = 0;
    vi.spyOn(harness.driver, "inspectPhysical").mockImplementation(async (id) => {
      calls += 1;
      const read = await original(id);
      return calls < 2 || !read.enrollable ? read : { ...read, driverDeviceId: "SOMEONE-ELSE" };
    });

    await expect(harness.core.enrollment.add("ios", UDID)).rejects.toMatchObject({
      name: "PhysicalInspectionError",
    });

    expect(JSON.stringify(live(harness))).toBe(before);
    expect(enrolledEvents(harness)).toHaveLength(1);
    await expect(harness.core.enrollment.remove(UDID)).resolves.toMatchObject({ state: "deleted" });
  });

  it("re-enrolls a second time after a re-enrollment succeeded, and a remove right after that succeeds", async () => {
    const harness = await build();
    await harness.core.enrollment.add("ios", UDID);
    await harness.core.enrollment.add("ios", UDID);

    await expect(harness.core.enrollment.add("ios", ALIAS)).resolves.toMatchObject({
      reenrolled: true,
    });
    await expect(harness.core.enrollment.remove(UDID)).resolves.toMatchObject({ state: "deleted" });

    expect(live(harness)).toEqual([]);
    expect(enrolledEvents(harness)).toHaveLength(3);
  });

  it("refuses a Simlock simulator by its driverDeviceId or address as virtual-device, before any driver call", async () => {
    const harness = await build();
    const provisioned = await harness.driver.provision({
      model: "iPhone 16",
      osVersion: "1",
      physical: false,
      platform: "ios",
    });
    const registered = await harness.registry.registerDevice({
      driverData: provisioned.driverData,
      driverDeviceId: provisioned.deviceId,
      provisionDuration: 0,
      spec: { model: "iPhone 16", osVersion: "1", physical: false, platform: "ios" },
    });
    await harness.registry.transitionDevice(
      registered.id,
      "ready",
      {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: registered.id },
      },
      { address: "emulator-5554" },
    );
    const asked = vi.spyOn(harness.driver, "inspectPhysical");

    for (const id of [provisioned.deviceId, "emulator-5554"]) {
      await expect(harness.core.enrollment.add("ios", id)).rejects.toMatchObject({
        id,
        name: "DeviceNotEnrollableError",
        reason: "virtual-device",
      });
    }

    expect(asked).not.toHaveBeenCalled();
  });

  it("answers enrolled-on-other-platform with the canonical ID when the device is enrolled on the other platform", async () => {
    const harness = await build();
    const android = new FakeDriver({
      clock: harness.clock,
      physicalDevices: [{ ids: [UDID] }],
      platform: "android",
    });
    const second = createCore({
      clock: harness.clock,
      config: await loadConfig({
        filesystem: new MemoryFilesystem(),
        systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 }),
      }),
      drivers: [harness.driver, android],
      eventBus: harness.eventBus,
      registry: harness.registry,
      state: testStateOf(harness.registry),
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 }),
      ...testComponentWiring({
        clock: harness.clock,
        drivers: [harness.driver, android],
        eventBus: harness.eventBus,
        registry: harness.registry,
      }),
    });
    await second.enrollment.add("ios", UDID);

    await expect(second.enrollment.add("android", UDID)).rejects.toThrow(
      `${UDID} is enrolled as a ios device`,
    );
    await expect(second.enrollment.add("android", UDID)).rejects.toMatchObject({
      canonicalId: UDID,
      name: "DeviceNotEnrollableError",
      reason: "enrolled-on-other-platform",
    });
    expect(live(harness)).toHaveLength(1);
  });

  it("answers DEVICE_BUSY busy to add and remove of a record in a state that is none of ready, quarantined, leased or reclaiming", async () => {
    const harness = await build();
    await harness.core.enrollment.add("ios", UDID);
    const real = harness.registry.snapshot;
    vi.spyOn(harness.registry, "snapshot", "get").mockReturnValue({
      ...real,
      devices: real.devices.map((device) => ({ ...device, state: "shutdown" }) as never),
    });

    for (const attempt of [
      () => harness.core.enrollment.add("ios", UDID),
      () => harness.core.enrollment.remove(UDID),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ name: "DeviceBusyError", reason: "busy" });
    }
  });

  it("re-enrolls an absent physical device to ready with the same registry ID, and removes it", async () => {
    const harness = await build();
    const { device } = await harness.core.enrollment.add("ios", UDID);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 61_000,
      ttlMs: 60_000,
    });
    await harness.registry.endLeaseAndMarkDeviceAbsent(lease.id, "not-present", () => undefined);
    expect(live(harness)[0]?.state).toBe("absent");

    const again = await harness.core.enrollment.add("ios", UDID);

    expect(again).toMatchObject({ reenrolled: true, device: { id: device.id, state: "ready" } });
    await harness.registry.endLeaseAndMarkDeviceAbsent(
      (
        await harness.registry.createLease({
          deviceId: device.id,
          ownerId: "agent",
          requesterId: "agent",
          ttlDeadline: 61_000,
          ttlMs: 60_000,
        })
      ).id,
      "locked",
      () => undefined,
    );
    expect(live(harness)[0]?.state).toBe("absent");

    await harness.core.enrollment.remove(UDID);

    expect(physicalRecords(harness)[0]).toMatchObject({ id: device.id, state: "deleted" });
  });

  it("enrolls and re-enrolls without a readiness callback, and calls a given one with the registry ID after an enrollment and after a re-enrollment", async () => {
    const harness = await build();
    const bare = new PhysicalEnrollment({
      claims: harness.core.claims,
      decisions: { run: (operation) => Promise.resolve().then(operation) },
      drivers: { get: () => harness.driver },
      registry: harness.registry,
    });
    const ready = vi.fn();
    const watched = new PhysicalEnrollment({
      claims: harness.core.claims,
      decisions: { run: (operation) => Promise.resolve().then(operation) },
      drivers: { get: () => harness.driver },
      physicalDeviceReady: ready,
      registry: harness.registry,
    });

    const first = await bare.add("ios", UDID);
    const second = await bare.add("ios", UDID);
    expect([first.reenrolled, second.reenrolled]).toEqual([false, true]);
    await watched.add("ios", UDID);

    expect(ready).toHaveBeenCalledExactlyOnceWith(first.device.id);
    ready.mockClear();
    await harness.core.enrollment.remove(UDID);
    const created = await watched.add("ios", UDID);
    expect(ready).toHaveBeenCalledExactlyOnceWith(created.device.id);
    expect(created.reenrolled).toBe(false);
  });

  it("words a busy device as leased, reclaiming or busy with another operation", async () => {
    const harness = await build();
    const { device } = await harness.core.enrollment.add("ios", UDID);
    const claim = harness.core.claims.tryClaim(device.id, "reclaim");
    await expect(harness.core.enrollment.remove(UDID)).rejects.toThrow(
      `${UDID} is being reclaimed: try again when it finishes`,
    );
    claim?.release();
    const enrolling = harness.core.claims.tryClaim(device.id, "enrollment");
    await expect(harness.core.enrollment.remove(UDID)).rejects.toThrow(
      `${UDID} is busy with another operation: try again in a moment`,
    );
    enrolling?.release();
    await harness.registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 61_000,
      ttlMs: 60_000,
    });
    await expect(harness.core.enrollment.add("ios", UDID)).rejects.toThrow(
      `${UDID} is leased: release it first`,
    );
  });

  it("answers UNKNOWN_DEVICE, naming the ID, to a remove of an ID with no record and of a deleted one", async () => {
    const harness = await build();

    await expect(harness.core.enrollment.remove(UDID)).rejects.toMatchObject({
      id: UDID,
      message: `${UDID} is not an enrolled device`,
      name: "UnknownEnrolledDeviceError",
    });
    await harness.core.enrollment.add("ios", UDID);
    await harness.core.enrollment.remove(UDID);
    await expect(harness.core.enrollment.remove(UDID)).rejects.toMatchObject({
      name: "UnknownEnrolledDeviceError",
    });
  });

  it("writes a new record, not a re-enrollment, for a device whose earlier record is deleted", async () => {
    const harness = await build();
    const first = await harness.core.enrollment.add("ios", UDID);
    await harness.core.enrollment.remove(UDID);

    const again = await harness.core.enrollment.add("ios", ALIAS);

    expect(again.reenrolled).toBe(false);
    expect(again.device.id).not.toBe(first.device.id);
    expect(live(harness)).toHaveLength(1);
    expect(physicalRecords(harness)).toHaveLength(2);
  });

  it("names the device in its error when the second read names another device or a read fails", async () => {
    const harness = await build();
    await harness.core.enrollment.add("ios", UDID);
    const original = harness.driver.inspectPhysical.bind(harness.driver);
    let calls = 0;
    vi.spyOn(harness.driver, "inspectPhysical").mockImplementation(async (id) => {
      calls += 1;
      const read = await original(id);
      return calls === 1 || !read.enrollable ? read : { ...read, driverDeviceId: "SOMEONE-ELSE" };
    });

    await expect(harness.core.enrollment.add("ios", ALIAS)).rejects.toThrow(
      `${UDID} was read again as SOMEONE-ELSE`,
    );
    vi.spyOn(harness.driver, "inspectPhysical").mockRejectedValue(new Error("usbmuxd went away"));
    await expect(harness.core.enrollment.add("ios", ALIAS)).rejects.toThrow(
      `Reading ${ALIAS} failed: usbmuxd went away`,
    );
    vi.spyOn(harness.driver, "inspectPhysical").mockRejectedValue("a bare string");
    await expect(harness.core.enrollment.add("ios", ALIAS)).rejects.toThrow(
      `Reading ${ALIAS} failed: a bare string`,
    );
  });

  it("does not mistake a simulator with the canonical ID for the enrolled record, and remove forgets only the physical one", async () => {
    const harness = await build();
    const provisioned = await harness.driver.provision({
      model: "iPhone 16",
      osVersion: "1",
      physical: false,
      platform: "ios",
    });
    const registered = await harness.registry.registerDevice({
      driverData: provisioned.driverData,
      driverDeviceId: UDID,
      provisionDuration: 0,
      spec: { model: "iPhone 16", osVersion: "1", physical: false, platform: "ios" },
    });
    await harness.registry.transitionDevice(
      registered.id,
      "ready",
      { event: "device.ready", payload: { bootDuration: 0, deviceId: registered.id } },
      { address: "emulator-5554" },
    );
    await expect(harness.core.enrollment.add("ios", ALIAS)).resolves.toMatchObject({
      reenrolled: false,
    });
    await expect(harness.core.enrollment.add("ios", UDID)).rejects.toMatchObject({
      reason: "virtual-device",
      message: `${UDID} is a simulator or emulator Simlock manages`,
    });
    await expect(harness.core.enrollment.remove(UDID)).resolves.toMatchObject({
      physical: true,
      state: "deleted",
    });
    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
  });

  it("enrols a device whose ID a deleted simulator once had", async () => {
    const harness = await build();
    const provisioned = await harness.driver.provision({
      model: "iPhone 16",
      osVersion: "1",
      physical: false,
      platform: "ios",
    });
    const registered = await harness.registry.registerDevice({
      driverData: provisioned.driverData,
      driverDeviceId: UDID,
      provisionDuration: 0,
      spec: { model: "iPhone 16", osVersion: "1", physical: false, platform: "ios" },
    });
    await harness.registry.transitionDevice(registered.id, "deleted", {
      event: "device.deleted",
      payload: { deviceId: registered.id, initiator: "test" },
    });

    await expect(harness.core.enrollment.add("ios", UDID)).resolves.toMatchObject({
      reenrolled: false,
    });
  });
});
