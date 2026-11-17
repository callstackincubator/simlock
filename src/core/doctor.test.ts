import { describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats } from "../ports/index.js";
import { Doctor } from "./doctor.js";
import { FakeDriver } from "./fake-driver.js";
import { SerializedDecision } from "./serialized-decision.js";
import { loadTestRegistry, testComponentWiring, testStateOf } from "./testing.js";
import { createTestEngine } from "../leasing/testing.js";
import { config, sequence } from "./test-doctor.js";

// why: pure logic with many cases: Doctor's drift, stall and finding classification, built
// directly over a fake driver and a test registry rather than a whole daemon.
describe("Doctor", () => {
  it("reports all reconciliation drift classes without changing state", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const registered = await registry.registerDevice({
      driverData: { fakeDeviceId: "missing" },
      driverDeviceId: "missing",
      provisionDuration: 0,
      spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(registered.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: registered.id },
    });
    await registry.createLease({
      deviceId: registered.id,
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60_000,
      ttlDeadline: 9_000,
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-orphan-address",
          deviceId: "simlock-orphan",
          driverData: { fakeDeviceId: "simlock-orphan" },
          runState: "running",
        },
      ],
      processes: [
        {
          address: "simlock-process-address",
          deviceId: "simlock-process",
          driverData: { fakeDeviceId: "simlock-process" },
        },
      ],
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "registry-device-missing",
      "orphan-device",
      "orphan-process",
      "expired-live-lease",
    ]);
    expect(registry.snapshot.devices[0]?.state).toBe("leased");
    expect(eventBus.replay().at(-1)).toMatchObject({ event: "doctor.reconciled" });
  });

  it("lists each driver's sources, a size only when it was counted and a stale reason when there is one, and a source is no finding", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({ clock, eventBus, idGenerator: sequence() });
    const driver = new FakeDriver({ clock, platform: "ios" });
    const androidDriver = new FakeDriver({ clock, platform: "android" });
    androidDriver.setSources([
      { id: "a1", kind: "seed", model: "Pixel 9", osVersion: "35", sizeBytes: 2 },
    ]);
    driver.setSources([
      { id: "s1", kind: "seed", model: "iPhone 17", osVersion: "27.0", sizeBytes: 4_000_000_000 },
      { id: "s2", kind: "seed", model: "iPad", osVersion: "27.0" },
      {
        id: "s3",
        kind: "seed",
        model: "iPhone 16",
        osVersion: "26.5",
        sizeBytes: 1,
        staleReason: "its runtime was removed",
      },
    ]);

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver, androidDriver],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings).toEqual([]);
    expect(report.sources).toEqual([
      {
        kind: "seed",
        model: "iPhone 17",
        osVersion: "27.0",
        platform: "ios",
        sizeBytes: 4_000_000_000,
      },
      { kind: "seed", model: "iPad", osVersion: "27.0", platform: "ios" },
      {
        kind: "seed",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
        sizeBytes: 1,
        staleReason: "its runtime was removed",
      },
      { kind: "seed", model: "Pixel 9", osVersion: "35", platform: "android", sizeBytes: 2 },
    ]);
  });

  it("lists no sources for a driver whose listSources fails, still returns the report, and keeps the sources of the drivers that answer", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({ clock, eventBus, idGenerator: sequence() });
    const failing = new FakeDriver({ clock, platform: "ios" });
    failing.failOn("listSources", 1, new Error("simctl is gone"));
    failing.setSources([{ id: "x", kind: "seed", model: "Hidden", osVersion: "1" }]);
    const ios = new FakeDriver({ clock, platform: "ios" });
    ios.setSources([{ id: "i1", kind: "seed", model: "iPhone 17", osVersion: "27.0" }]);
    const android = new FakeDriver({ clock, platform: "android" });
    android.setSources([{ id: "a1", kind: "seed", model: "Pixel 9", osVersion: "35" }]);

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [failing, ios, android],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings).toEqual([]);
    expect(report.sources).toEqual([
      { kind: "seed", model: "iPhone 17", osVersion: "27.0", platform: "ios" },
      { kind: "seed", model: "Pixel 9", osVersion: "35", platform: "android" },
    ]);
  });

  it("lists an orphan source and destroys it only when it purges orphans", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({ clock, eventBus, idGenerator: sequence() });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setSources([
      { id: "s1", kind: "seed", model: "iPhone 17", osVersion: "27.0" },
      { id: "o1", kind: "seed", model: "unknown", orphan: true, osVersion: "unknown" },
    ]);
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    });

    const listed = await doctor.reconcile();
    expect(listed.findings).toEqual([]);
    expect(listed.sources).toEqual([
      { kind: "seed", model: "iPhone 17", osVersion: "27.0", platform: "ios" },
      { kind: "seed", model: "unknown", orphan: true, osVersion: "unknown", platform: "ios" },
    ]);
    expect(await driver.listSources()).toHaveLength(2);

    const purged = await doctor.reconcile({ purgeOrphans: true });
    expect(purged.sources).toEqual([
      { kind: "seed", model: "iPhone 17", osVersion: "27.0", platform: "ios" },
    ]);
    expect((await driver.listSources()).map((source) => source.id)).toEqual(["s1"]);
  });

  it("reports but does not correct a leased-state device with no lease record", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const stale = await registry.registerDevice({
      driverData: { fakeDeviceId: "simlock-stale" },
      driverDeviceId: "simlock-stale",
      provisionDuration: 0,
      spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(stale.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: stale.id },
    });
    await registry.transitionDevice(stale.id, "leased");
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-stale-address",
          deviceId: "simlock-stale",
          driverData: { fakeDeviceId: "simlock-stale" },
          runState: "stopped",
        },
      ],
      processes: [],
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({
      fix: true,
    });

    expect(report.findings.map((finding) => finding.kind)).toContain("foreign-state-change");
    expect(registry.snapshot.devices[0]?.state).toBe("leased");
    expect(registry.snapshot.devices[0]?.foreignStateDetectedAt).toBe(10_000);
    expect(registry.snapshot.devices[0]?.foreignProvenanceDetectedAt).toBeUndefined();
  });

  it("keeps the first-detected timestamp when drift persists across ticks", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "simlock-drift" },
      driverDeviceId: "simlock-drift",
      provisionDuration: 0,
      spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    await registry.createLease({
      deviceId: device.id,
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60_000,
      ttlDeadline: 99_000,
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-drift-address",
          deviceId: "simlock-drift",
          driverData: { fakeDeviceId: "simlock-drift" },
          runState: "stopped",
        },
      ],
      processes: [],
    });
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    });

    await doctor.reconcile();
    clock.advance(60_000);
    await doctor.reconcile();

    expect(registry.snapshot.devices[0]?.foreignStateDetectedAt).toBe(10_000);
  });

  it("classifies provenance-mark drift and never repairs it", async () => {
    const cases = [
      { detail: "erased", mark: { durable: "tok", erasable: undefined, erasableReadable: true } },
      {
        detail: "mark-mismatch",
        mark: { durable: "tok", erasable: "other", erasableReadable: true },
      },
      {
        detail: "durable-mark-missing",
        mark: { durable: undefined, erasable: "tok", erasableReadable: true },
      },
      { detail: undefined, mark: { durable: "tok", erasable: "tok", erasableReadable: true } },
      // why: Unreadable is not absent: an Android mark is only reachable over adb while
      // the emulator runs, so a shut-down device must never read as erased.
      { detail: undefined, mark: { durable: "tok", erasable: undefined, erasableReadable: false } },
    ] as const;

    for (const { detail, mark } of cases) {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-marked" },
        driverDeviceId: "simlock-marked",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      const driver = new FakeDriver({ clock, platform: "ios" });
      driver.setManagedReality({
        devices: [
          {
            address: "simlock-marked-address",
            deviceId: "simlock-marked",
            driverData: {},
            mark,
            runState: "running",
          },
        ],
        processes: [],
      });

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile({
        fix: true,
      });

      const found = report.findings.filter(
        (finding) => finding.kind === "foreign-provenance-change",
      );
      if (detail === undefined) {
        expect(found).toEqual([]);
        expect(registry.snapshot.devices[0]?.foreignProvenanceDetectedAt).toBeUndefined();
      } else {
        expect(found).toEqual([
          { detail, deviceId: device.id, kind: "foreign-provenance-change", platform: "ios" },
        ]);
        expect(registry.snapshot.devices[0]?.foreignProvenanceDetectedAt).toBe(10_000);
        expect(
          eventBus.replay().some((entry) => entry.event === "device.foreign-provenance-detected"),
        ).toBe(true);
      }
      expect(registry.snapshot.devices[0]?.foreignStateDetectedAt).toBeUndefined();
      expect(registry.snapshot.devices[0]?.state).toBe("ready");
    }
  });

  it("flags both a foreign state change and a foreign provenance change on a device that shows both", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "simlock-both" },
      driverDeviceId: "simlock-both",
      provisionDuration: 0,
      spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-both-address",
          deviceId: "simlock-both",
          driverData: {},
          mark: { durable: "tok", erasable: undefined, erasableReadable: true },
          runState: "stopped",
        },
      ],
      processes: [],
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "foreign-state-change",
      "foreign-provenance-change",
    ]);
    expect(registry.snapshot.devices[0]).toMatchObject({
      foreignProvenanceDetectedAt: 10_000,
      foreignStateDetectedAt: 10_000,
    });
  });

  it("ignores provenance marks while Simlock is itself erasing the device", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "simlock-reclaiming" },
      driverDeviceId: "simlock-reclaiming",
      provisionDuration: 0,
      spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60_000,
      ttlDeadline: 99_000,
    });
    await registry.beginRelease(lease.id);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-reclaiming-address",
          deviceId: "simlock-reclaiming",
          driverData: {},
          mark: { durable: "tok", erasable: undefined, erasableReadable: true },
          runState: "running",
        },
      ],
      processes: [],
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings.map((finding) => finding.kind)).not.toContain(
      "foreign-provenance-change",
    );
  });

  it("fixes registry-attributable drift and leaves unregistered reality report-only", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const missing = await registry.registerDevice({
      driverData: { fakeDeviceId: "missing" },
      driverDeviceId: "missing",
      provisionDuration: 0,
      spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(missing.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: missing.id },
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-orphan-address",
          deviceId: "simlock-orphan",
          driverData: { fakeDeviceId: "simlock-orphan" },
          runState: "running",
        },
      ],
      processes: [
        {
          address: "simlock-process-address",
          deviceId: "simlock-process",
          driverData: { fakeDeviceId: "simlock-process" },
        },
      ],
    });
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    });

    await expect(doctor.reconcile({ fix: true })).resolves.toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ kind: "registry-device-missing" }),
        expect.objectContaining({ kind: "orphan-device" }),
        expect.objectContaining({ kind: "orphan-process" }),
      ]),
    });
    expect(registry.snapshot.devices[0]?.state).toBe("deleted");
    expect(eventBus.replay().filter((entry) => entry.event === "device.deleted")).toMatchObject([
      { payload: { initiator: "doctor" } },
    ]);
    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(0);
    expect(driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(0);

    await expect(doctor.reconcile({ fix: true })).resolves.toMatchObject({
      findings: [
        expect.objectContaining({ kind: "orphan-device" }),
        expect.objectContaining({ kind: "orphan-process" }),
      ],
    });
    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(0);
    expect(driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(0);
  });

  it("--fix marks a missing device deleted although another device holds a lease", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const spec = { physical: false, model: "Phone", osVersion: "1", platform: "ios" } as const;
    const ids: string[] = [];
    for (const name of ["live", "gone"]) {
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: name },
        driverDeviceId: name,
        provisionDuration: 0,
        spec,
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      ids.push(device.id);
    }
    await registry.createLease({
      deviceId: ids[0] ?? "",
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60_000,
      ttlDeadline: 90_000,
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "live-address",
          deviceId: "live",
          driverData: { fakeDeviceId: "live" },
          runState: "running",
        },
      ],
      processes: [],
    });

    await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["leased", "deleted"]);
  });

  it("expires an overdue live lease through leasing when fixing", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "live" },
      driverDeviceId: "live",
      provisionDuration: 0,
      spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    await registry.createLease({
      deviceId: device.id,
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60_000,
      ttlDeadline: 9_000,
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "live-address",
          deviceId: "live",
          driverData: { fakeDeviceId: "live" },
          runState: "running",
        },
      ],
      processes: [],
    });
    const leaseEngine = createTestEngine({
      ...testComponentWiring({
        clock: clock,
        drivers: [driver],
        eventBus: eventBus,
        registry: registry,
      }),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      idGenerator: sequence(),
      registry,
      state: testStateOf(registry),
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 }),
    });

    await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      leaseExpirer: leaseEngine,
      registry,
    }).reconcile({ fix: true });

    expect(registry.snapshot.leases).toEqual([]);
    expect(eventBus.replay()).toContainEqual(expect.objectContaining({ event: "lease.expired" }));
  });
});
