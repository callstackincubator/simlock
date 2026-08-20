import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { FakeSystemStats } from "../ports/index.js";
import type { Config } from "./config.js";
import { Doctor } from "./doctor.js";
import { FakeDriver } from "./fake-driver.js";
import { LeaseEngine } from "./lease-engine.js";
import { Registry } from "./registry.js";

describe("Doctor", () => {
  it("reports all reconciliation drift classes without changing state", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const registered = await registry.registerDevice({
      driverData: { fakeDeviceId: "missing" },
      driverDeviceId: "missing",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(registered.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: registered.id },
    });
    await registry.createLease({
      deviceId: registered.id,
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 9_000,
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          deviceId: "pitlane-orphan",
          driverData: { fakeDeviceId: "pitlane-orphan" },
          runState: "running",
        },
      ],
      processes: [{ deviceId: "pitlane-process", driverData: { fakeDeviceId: "pitlane-process" } }],
    });

    const report = await new Doctor({ clock, drivers: [driver], eventBus, registry }).reconcile();

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "registry-device-missing",
      "orphan-device",
      "orphan-process",
      "expired-live-lease",
    ]);
    expect(registry.snapshot.devices[0]?.state).toBe("leased");
    expect(eventBus.replay().at(-1)).toMatchObject({ event: "doctor.reconciled" });
  });

  it("reports but does not correct a leased-state device with no lease record", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const filesystem = new MemoryFilesystem();
    await filesystem.writeFileAtomic(
      "/state.json",
      JSON.stringify({
        devices: [
          {
            createdAt: 1,
            driverData: { fakeDeviceId: "pitlane-stale" },
            driverDeviceId: "pitlane-stale",
            id: "dev_1",
            spec: { model: "Phone", osVersion: "1", platform: "ios" },
            state: "leased",
          },
        ],
        leases: [],
      }),
    );
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem,
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          deviceId: "pitlane-stale",
          driverData: { fakeDeviceId: "pitlane-stale" },
          runState: "stopped",
        },
      ],
      processes: [],
    });

    const report = await new Doctor({ clock, drivers: [driver], eventBus, registry }).reconcile({
      fix: true,
    });

    expect(report.findings.map((finding) => finding.kind)).toContain("foreign-state-change");
    expect(registry.snapshot.devices[0]?.state).toBe("leased");
    expect(registry.snapshot.devices[0]?.foreignStateDetectedAt).toBe(10_000);
  });

  it("keeps the first-detected timestamp when drift persists across ticks", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "pitlane-drift" },
      driverDeviceId: "pitlane-drift",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    await registry.createLease({
      deviceId: device.id,
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 99_000,
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          deviceId: "pitlane-drift",
          driverData: { fakeDeviceId: "pitlane-drift" },
          runState: "stopped",
        },
      ],
      processes: [],
    });
    const doctor = new Doctor({ clock, drivers: [driver], eventBus, registry });

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
      // Unreadable is not absent: an Android mark is only reachable over adb while
      // the emulator runs, so a shut-down device must never read as erased.
      { detail: undefined, mark: { durable: "tok", erasable: undefined, erasableReadable: false } },
    ] as const;

    for (const { detail, mark } of cases) {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const device = await registry.registerDevice({
        driverData: {},
        driverDeviceId: "pitlane-marked",
        provisionDuration: 0,
        spec: { model: "Phone", osVersion: "1", platform: "ios" },
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      const driver = new FakeDriver({ clock, platform: "ios" });
      driver.setManagedReality({
        devices: [{ deviceId: "pitlane-marked", driverData: {}, mark, runState: "running" }],
        processes: [],
      });

      const report = await new Doctor({ clock, drivers: [driver], eventBus, registry }).reconcile({
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
      // Report-only: --fix must never touch a device over a mark finding.
      expect(registry.snapshot.devices[0]?.state).toBe("ready");
    }
  });

  it("ignores provenance marks while Pitlane is itself erasing the device", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "pitlane-reclaiming",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 99_000,
    });
    await registry.beginRelease(lease.id);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          deviceId: "pitlane-reclaiming",
          driverData: {},
          mark: { durable: "tok", erasable: undefined, erasableReadable: true },
          runState: "running",
        },
      ],
      processes: [],
    });

    const report = await new Doctor({ clock, drivers: [driver], eventBus, registry }).reconcile();

    expect(report.findings.map((finding) => finding.kind)).not.toContain(
      "foreign-provenance-change",
    );
  });

  it("fixes registry-attributable drift and leaves unregistered reality report-only", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const missing = await registry.registerDevice({
      driverData: { fakeDeviceId: "missing" },
      driverDeviceId: "missing",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(missing.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: missing.id },
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          deviceId: "pitlane-orphan",
          driverData: { fakeDeviceId: "pitlane-orphan" },
          runState: "running",
        },
      ],
      processes: [{ deviceId: "pitlane-process", driverData: { fakeDeviceId: "pitlane-process" } }],
    });
    const doctor = new Doctor({ clock, drivers: [driver], eventBus, registry });

    await expect(doctor.reconcile({ fix: true })).resolves.toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ kind: "registry-device-missing" }),
        expect.objectContaining({ kind: "orphan-device" }),
        expect.objectContaining({ kind: "orphan-process" }),
      ]),
    });
    expect(registry.snapshot.devices[0]?.state).toBe("deleted");
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

  it("expires an overdue live lease through the lease engine when fixing", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "live" },
      driverDeviceId: "live",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    await registry.createLease({
      deviceId: device.id,
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 9_000,
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [{ deviceId: "live", driverData: { fakeDeviceId: "live" }, runState: "running" }],
      processes: [],
    });
    const leaseEngine = new LeaseEngine({
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      idGenerator: sequence(),
      registry,
      systemStats: new FakeSystemStats({ cpuCount: 8, freeRamBytes: 32, totalRamBytes: 32 }),
    });

    await new Doctor({
      clock,
      drivers: [driver],
      eventBus,
      leaseExpirer: leaseEngine,
      registry,
    }).reconcile({ fix: true });

    expect(registry.snapshot.leases).toEqual([]);
    expect(eventBus.replay()).toContainEqual(expect.objectContaining({ event: "lease.expired" }));
  });

  it("reports foreign-state-change for a device booted outside Pitlane, on both platforms", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const iosDevice = await shutdownDevice(registry, "pitlane-ios-1", "ios");
    const androidDevice = await shutdownDevice(registry, "pitlane_android-1", "android");

    const iosDriver = new FakeDriver({ clock, platform: "ios" });
    iosDriver.setManagedReality({
      devices: [{ deviceId: "pitlane-ios-1", driverData: {}, runState: "running" }],
      processes: [],
    });
    const androidDriver = new FakeDriver({ clock, platform: "android" });
    androidDriver.setManagedReality({
      devices: [{ deviceId: "pitlane_android-1", driverData: {}, runState: "running" }],
      processes: [],
    });

    const report = await new Doctor({
      clock,
      drivers: [iosDriver, androidDriver],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings.filter((finding) => finding.kind === "foreign-state-change")).toEqual([
      {
        deviceId: iosDevice.id,
        expected: "stopped",
        kind: "foreign-state-change",
        observed: "running",
        platform: "ios",
      },
      {
        deviceId: androidDevice.id,
        expected: "stopped",
        kind: "foreign-state-change",
        observed: "running",
        platform: "android",
      },
    ]);
  });

  it("reports foreign-state-change for a device shut down outside Pitlane, on both platforms", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const iosDevice = await readyDevice(registry, "pitlane-ios-2", "ios");
    const androidDevice = await readyDevice(registry, "pitlane_android-2", "android");

    const iosDriver = new FakeDriver({ clock, platform: "ios" });
    iosDriver.setManagedReality({
      devices: [{ deviceId: "pitlane-ios-2", driverData: {}, runState: "stopped" }],
      processes: [],
    });
    const androidDriver = new FakeDriver({ clock, platform: "android" });
    androidDriver.setManagedReality({
      devices: [{ deviceId: "pitlane_android-2", driverData: {}, runState: "stopped" }],
      processes: [],
    });

    const report = await new Doctor({
      clock,
      drivers: [iosDriver, androidDriver],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings.filter((finding) => finding.kind === "foreign-state-change")).toEqual([
      {
        deviceId: iosDevice.id,
        expected: "running",
        kind: "foreign-state-change",
        observed: "stopped",
        platform: "ios",
      },
      {
        deviceId: androidDevice.id,
        expected: "running",
        kind: "foreign-state-change",
        observed: "stopped",
        platform: "android",
      },
    ]);
  });

  it("never reports drift when the observed state is transitioning", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    await readyDevice(registry, "pitlane-transition", "ios");

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [{ deviceId: "pitlane-transition", driverData: {}, runState: "transitioning" }],
      processes: [],
    });

    const report = await new Doctor({ clock, drivers: [driver], eventBus, registry }).reconcile();

    expect(report.findings.filter((finding) => finding.kind === "foreign-state-change")).toEqual(
      [],
    );
  });

  it("never reports drift for provisioning or reclaiming registry devices", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    await registry.registerDevice({
      driverData: {},
      driverDeviceId: "pitlane-provisioning",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
    });
    const reclaiming = await readyDevice(registry, "pitlane-reclaiming", "ios");
    const lease = await registry.createLease({
      deviceId: reclaiming.id,
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 999_999,
    });
    await registry.beginRelease(lease.id);

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        { deviceId: "pitlane-provisioning", driverData: {}, runState: "stopped" },
        { deviceId: "pitlane-reclaiming", driverData: {}, runState: "stopped" },
      ],
      processes: [],
    });

    const report = await new Doctor({ clock, drivers: [driver], eventBus, registry }).reconcile();

    expect(report.findings.filter((finding) => finding.kind === "foreign-state-change")).toEqual(
      [],
    );
  });

  it("--fix reconciles an unleased device's state to observed reality in both directions", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const bootedOutside = await shutdownDevice(registry, "pitlane-booted", "ios");
    const shutdownOutside = await readyDevice(registry, "pitlane-shutdown", "ios");

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        { deviceId: "pitlane-booted", driverData: {}, runState: "running" },
        { deviceId: "pitlane-shutdown", driverData: {}, runState: "stopped" },
      ],
      processes: [],
    });

    await new Doctor({ clock, drivers: [driver], eventBus, registry }).reconcile({ fix: true });

    const snapshot = registry.snapshot;
    const booted = snapshot.devices.find((device) => device.id === bootedOutside.id);
    const shutdown = snapshot.devices.find((device) => device.id === shutdownOutside.id);
    expect(booted?.state).toBe("ready");
    expect(booted?.foreignStateDetectedAt).toBeUndefined();
    expect(shutdown?.state).toBe("shutdown");
    expect(shutdown?.foreignStateDetectedAt).toBeUndefined();
  });

  it("--fix leaves a leased device untouched while still reporting the finding", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const device = await readyDevice(registry, "pitlane-leased", "ios");
    await registry.createLease({
      deviceId: device.id,
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 999_999,
    });

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [{ deviceId: "pitlane-leased", driverData: {}, runState: "stopped" }],
      processes: [],
    });

    const report = await new Doctor({ clock, drivers: [driver], eventBus, registry }).reconcile({
      fix: true,
    });

    expect(report.findings.filter((finding) => finding.kind === "foreign-state-change")).toEqual([
      {
        deviceId: device.id,
        expected: "running",
        kind: "foreign-state-change",
        observed: "stopped",
        platform: "ios",
      },
    ]);
    const snapshot = registry.snapshot;
    const stillLeased = snapshot.devices.find((candidate) => candidate.id === device.id);
    expect(stillLeased?.state).toBe("leased");
    expect(stillLeased?.foreignStateDetectedAt).toBeDefined();
  });

  it("emits device.foreign-state-detected once per finding, post-commit", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const bootedOutside = await shutdownDevice(registry, "pitlane-booted", "ios");
    const shutdownOutside = await readyDevice(registry, "pitlane-shutdown", "ios");

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        { deviceId: "pitlane-booted", driverData: {}, runState: "running" },
        { deviceId: "pitlane-shutdown", driverData: {}, runState: "stopped" },
      ],
      processes: [],
    });

    await new Doctor({ clock, drivers: [driver], eventBus, registry }).reconcile({ fix: true });

    const events = eventBus.replay();
    const foreignStateEvents = events.filter(
      (event) => event.event === "device.foreign-state-detected",
    );
    expect(foreignStateEvents).toHaveLength(2);
    expect(foreignStateEvents).toEqual([
      expect.objectContaining({
        payload: {
          deviceId: bootedOutside.id,
          expected: "stopped",
          observed: "running",
          platform: "ios",
        },
      }),
      expect.objectContaining({
        payload: {
          deviceId: shutdownOutside.id,
          expected: "running",
          observed: "stopped",
          platform: "ios",
        },
      }),
    ]);

    // Post-commit: the registry mutations that resolved the drift are already committed
    // by the time the fact is published, and doctor.reconciled is the final event.
    const commitEvents = events.filter(
      (event) => event.event === "device.ready" || event.event === "device.shutdown",
    );
    const lastCommitSeq = Math.max(...commitEvents.map((event) => event.seq));
    const firstForeignStateSeq = Math.min(...foreignStateEvents.map((event) => event.seq));
    expect(firstForeignStateSeq).toBeGreaterThan(lastCommitSeq);
    expect(events.at(-1)?.event).toBe("doctor.reconciled");
  });
});

async function readyDevice(
  registry: Registry,
  driverDeviceId: string,
  platform: "ios" | "android",
) {
  const device = await registry.registerDevice({
    driverData: {},
    driverDeviceId,
    provisionDuration: 0,
    spec: { model: "Phone", osVersion: "1", platform },
  });
  await registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
  return registry.snapshot.devices.find((candidate) => candidate.id === device.id)!;
}

async function shutdownDevice(
  registry: Registry,
  driverDeviceId: string,
  platform: "ios" | "android",
) {
  await readyDevice(registry, driverDeviceId, platform);
  const device = registry.snapshot.devices.find(
    (candidate) => candidate.driverDeviceId === driverDeviceId,
  )!;
  await registry.transitionDevice(device.id, "shutdown", {
    event: "device.shutdown",
    payload: { deviceId: device.id, initiator: "test" },
  });
  return registry.snapshot.devices.find((candidate) => candidate.id === device.id)!;
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function config(): Config {
  return {
    diskPressure: { freeBytesThreshold: 1 },
    eventBuffer: { capacity: 10 },
    idle: { deleteAfterMs: 10, shutdownAfterMs: 5 },
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000, heartbeatIntervalMs: 15_000 },
    limits: {
      android: { maxDevices: 1, maxRunning: 1 },
      ios: { maxDevices: 1, maxRunning: 1 },
      maxRunning: 1 + 1,
    },
    ramBudget: { androidBytesPerDevice: 1, iosBytesPerDevice: 1 },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
  };
}
