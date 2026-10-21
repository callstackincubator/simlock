import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { FakeSystemStats } from "../ports/index.js";
import type { Config } from "./config.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import {
  Doctor,
  type DoctorFinding,
  type DoctorReport,
  isStalledTransition,
  type OptionalModuleFinding,
} from "./doctor.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { DriverRejection, PrerequisiteCheck } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import type { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import { StartupRead } from "./startup-read.js";
import { loadTestRegistry, openTestState, testComponentWiring, testStateOf } from "./testing.js";
import { createTestEngine } from "../leasing/testing.js";

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
      // Unreadable is not absent: an Android mark is only reachable over adb while
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
      // A mark finding says nothing of the run state, which matches the registry's.
      expect(registry.snapshot.devices[0]?.foreignStateDetectedAt).toBeUndefined();
      // Report-only: --fix must never touch a device over a mark finding.
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

  it("reports foreign-state-change for a device booted outside Simlock, on both platforms", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const iosDevice = await shutdownDevice(registry, "simlock-ios-1", "ios");
    const androidDevice = await shutdownDevice(registry, "simlock_android-1", "android");

    const iosDriver = new FakeDriver({ clock, platform: "ios" });
    iosDriver.setManagedReality({
      devices: [
        {
          address: "simlock-ios-1-address",
          deviceId: "simlock-ios-1",
          driverData: {},
          runState: "running",
        },
      ],
      processes: [],
    });
    const androidDriver = new FakeDriver({ clock, platform: "android" });
    androidDriver.setManagedReality({
      devices: [
        {
          address: "simlock_android-1-address",
          deviceId: "simlock_android-1",
          driverData: {},
          runState: "running",
        },
      ],
      processes: [],
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
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

  it("does not report foreign-state-change for a device this daemon holds an operation claim on", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    // A lease-path boot from `shutdown` runs `makeReady` while the committed record still
    // says `shutdown` -- observed reality goes `running` before that boot's own transition
    // commits. Claiming the device is what tells doctor this is in-flight work, not drift.
    const iosDevice = await shutdownDevice(registry, "simlock-ios-1", "ios");

    const iosDriver = new FakeDriver({ clock, platform: "ios" });
    iosDriver.setManagedReality({
      devices: [
        {
          address: "simlock-ios-1-address",
          deviceId: "simlock-ios-1",
          driverData: {},
          runState: "running",
        },
      ],
      processes: [],
    });

    const claims = new DeviceOperationClaims();
    const claim = claims.tryClaim(iosDevice.id, "boot");
    expect(claim).toBeDefined();

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      claims,
      clock,
      config: config(),
      drivers: [iosDriver],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings.filter((finding) => finding.kind === "foreign-state-change")).toEqual(
      [],
    );
  });

  it("reports foreign-state-change for a device shut down outside Simlock, on both platforms", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const iosDevice = await readyDevice(registry, "simlock-ios-2", "ios");
    const androidDevice = await readyDevice(registry, "simlock_android-2", "android");

    const iosDriver = new FakeDriver({ clock, platform: "ios" });
    iosDriver.setManagedReality({
      devices: [
        {
          address: "simlock-ios-2-address",
          deviceId: "simlock-ios-2",
          driverData: {},
          runState: "stopped",
        },
      ],
      processes: [],
    });
    const androidDriver = new FakeDriver({ clock, platform: "android" });
    androidDriver.setManagedReality({
      devices: [
        {
          address: "simlock_android-2-address",
          deviceId: "simlock_android-2",
          driverData: {},
          runState: "stopped",
        },
      ],
      processes: [],
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
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
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    await readyDevice(registry, "simlock-transition", "ios");

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-transition-address",
          deviceId: "simlock-transition",
          driverData: {},
          runState: "transitioning",
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

    expect(report.findings.filter((finding) => finding.kind === "foreign-state-change")).toEqual(
      [],
    );
  });

  it("never reports drift for provisioning or reclaiming registry devices", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    await registry.registerDevice({
      driverData: { fakeDeviceId: "simlock-provisioning" },
      driverDeviceId: "simlock-provisioning",
      provisionDuration: 0,
      spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
    });
    const reclaiming = await readyDevice(registry, "simlock-reclaiming", "ios");
    const lease = await registry.createLease({
      deviceId: reclaiming.id,
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60_000,
      ttlDeadline: 999_999,
    });
    await registry.beginRelease(lease.id);

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-provisioning-address",
          deviceId: "simlock-provisioning",
          driverData: {},
          runState: "stopped",
        },
        {
          address: "simlock-reclaiming-address",
          deviceId: "simlock-reclaiming",
          driverData: {},
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

    expect(report.findings.filter((finding) => finding.kind === "foreign-state-change")).toEqual(
      [],
    );
  });

  describe("stalled transitions", () => {
    it("isStalledTransition does not hold for a provisioning device whose platform has no driver", async () => {
      const clock = new FakeClock(10_000);
      const registry = await loadRegistry(clock, new EventBus(clock));
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });

      // No driver for the platform: nothing to measure against, so no stall.
      expect(
        isStalledTransition({
          claims: undefined,
          config: config().stalledTransition,
          device,
          driver: undefined,
          now: 10_000 + 9_001,
        }),
      ).toBe(false);
    });

    it("the doctor's stalled-transition finding is unchanged", async () => {
      // The finding a stalled provisioning device and a stalled reclaiming device produced
      // before the stall test became `isStalledTransition`, field for field, and none a moment
      // before each threshold.
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadRegistry(clock, eventBus);
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000, reclaim: 4_000 },
        platform: "ios",
      });
      const provisioning = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      const leased = await readyDevice(registry, "simlock-erasing", "ios");
      const lease = await registry.createLease({
        deviceId: leased.id,
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
        ttlDeadline: 999_999,
      });
      await registry.beginRelease(lease.id);
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      });
      const stalls = async () =>
        (await doctor.reconcile()).findings.filter(
          (finding) => finding.kind === "stalled-transition",
        );

      clock.advance(9_000);
      expect(await stalls()).toEqual([]);
      clock.advance(1);
      expect(await stalls()).toEqual([
        {
          ageMs: 9_001,
          deviceId: provisioning.id,
          enteredAt: 10_000,
          kind: "stalled-transition",
          platform: "ios",
          state: "provisioning",
          thresholdMs: 9_000,
        },
      ]);
      clock.advance(3_000);
      expect(await stalls()).toEqual([
        expect.objectContaining({ deviceId: provisioning.id }),
        {
          ageMs: 12_001,
          deviceId: leased.id,
          enteredAt: 10_000,
          kind: "stalled-transition",
          platform: "ios",
          state: "reclaiming",
          thresholdMs: 12_000,
        },
      ]);
    });

    it("does not report a stall for a device this daemon holds an operation claim on", async () => {
      // A backgrounded reclaim keeps its device in `reclaiming` for a full erase, which can
      // outlast the threshold. The claim, not the clock, says work is in progress; without it a
      // healthy reclaim is reported as a stall and `--fix` quarantines it.
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-claimed" },
        driverDeviceId: "simlock-claimed",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      const claims = new DeviceOperationClaims();
      const claim = claims.tryClaim(device.id, "reclaim");
      clock.advance(9_001);

      const claimed = await new Doctor({
        decisions: new SerializedDecision(),
        claims,
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(claimed.findings.filter((finding) => finding.kind === "stalled-transition")).toEqual(
        [],
      );

      // Releasing the claim is what a crash cannot do: the same device, same age, is a
      // stall once no live operation accounts for it.
      claim?.release();
      const unclaimed = await new Doctor({
        decisions: new SerializedDecision(),
        claims,
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(unclaimed.findings).toContainEqual(
        expect.objectContaining({ deviceId: device.id, kind: "stalled-transition" }),
      );
    });

    it("reports a stalled-transition finding for a reclaiming device whose emulator was killed out from under the daemon", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({ clock, estimateMs: { reclaim: 2_000 }, platform: "ios" });
      const device = await readyDevice(registry, "simlock-killed", "ios");
      const lease = await registry.createLease({
        deviceId: device.id,
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
        ttlDeadline: 999_999,
      });
      await registry.beginRelease(lease.id);
      // `kill -9` on the emulator leaves it absent from reality altogether, not `stopped`.
      driver.setManagedReality({ devices: [], processes: [] });
      clock.advance(6_001);

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings).toContainEqual(
        expect.objectContaining({
          deviceId: device.id,
          kind: "stalled-transition",
          state: "reclaiming",
        }),
      );
    });

    it("holds a reclaiming device to the slower clean level's estimate", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      // A record in `reclaiming` does not say which clean level started it, so the threshold
      // has to clear the slower of the two: pricing it at `standard` would call a healthy
      // `full` reclaim a stall.
      const driver = new FakeDriver({
        clock,
        estimateMs: { reclaim: 2_000 },
        fullCleanReclaimEstimateMs: 20_000,
        platform: "ios",
      });
      const device = await readyDevice(registry, "simlock-slow-clean", "ios");
      const lease = await registry.createLease({
        deviceId: device.id,
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
        ttlDeadline: 999_999,
      });
      await registry.beginRelease(lease.id);
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      });

      clock.advance(6_001);
      const early = await doctor.reconcile();
      expect(early.findings.filter((finding) => finding.kind === "stalled-transition")).toEqual([]);

      clock.advance(60_000);
      const late = await doctor.reconcile();
      expect(late.findings).toContainEqual(
        expect.objectContaining({
          deviceId: device.id,
          kind: "stalled-transition",
          state: "reclaiming",
          thresholdMs: 60_000,
        }),
      );
    });

    it("emits device.stalled-transition-detected from the doctor, once, for a stalled device and not for other findings", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      clock.advance(9_001);

      await driver.provision({ physical: false, model: "Phone", osVersion: "1", platform: "ios" });

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings.some((finding) => finding.kind !== "stalled-transition")).toBe(true);
      expect(
        eventBus.replay().filter((entry) => entry.event === "device.stalled-transition-detected"),
      ).toEqual([
        expect.objectContaining({
          module: "doctor",
          payload: expect.objectContaining({ deviceId: device.id, state: "provisioning" }),
        }),
      ]);
    });

    it("--fix quarantines a stalled provisioning device through QuarantineCoordinator", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      // Reality still shows the device (never actually booted) so the fix pass isn't
      // also chasing an unrelated registry-device-missing finding on the same device.
      driver.setManagedReality({
        devices: [
          {
            address: "simlock-stuck-address",
            deviceId: "simlock-stuck",
            driverData: {},
            runState: "stopped",
          },
        ],
        processes: [],
      });
      const quarantine = new QuarantineCoordinator({
        claims: new DeviceOperationClaims(),
        clock,
        config: {
          maxRetries: 3,
          maxRetryBackoffMs: 300_000,
          retryBackoffMs: 30_000,
          retryBackoffMultiplier: 2,
        },
        decisions: new SerializedDecision(),
        drivers: new DriverCatalog([driver]),
        eventBus,
        notifyAvailability: () => {},
        registry,
      });
      clock.advance(9_001);

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        quarantine,
        registry,
      }).reconcile({ fix: true });

      expect(report.findings).toContainEqual(
        expect.objectContaining({ deviceId: device.id, kind: "stalled-transition" }),
      );
      expect(registry.snapshot.devices[0]?.state).toBe("quarantined");
      expect(eventBus.replay().map((event) => event.event)).toContain("device.quarantined");
    });

    it("--fix never quarantines a device that (inconsistently) still carries a lease", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const state = await openTestState();
      let registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
        state,
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      const first = await registry.createLease({
        deviceId: device.id,
        ownerId: "agent",
        requesterId: "agent",
        ttlDeadline: 9_999_999,
        ttlMs: 60_000,
      });
      await registry.beginRelease(first.id);
      // why: the registry never grants a lease on a reclaiming device, so the inconsistent row goes in directly.
      state.database
        .prepare(
          "INSERT INTO leases (id, device_id, requester_id, owner_id, granted_at, ttl_ms, ttl_deadline, last_renewed_at, id_chosen_by_requester) VALUES ('lse_stray', ?, 'agent', 'agent', 1, 60000, 9999999, 1, 0)",
        )
        .run(device.id);
      registry = await loadTestRegistry({ clock, eventBus, idGenerator: sequence(), state });
      clock.advance(100_000);
      const driver = new FakeDriver({ clock, estimateMs: { reclaim: 2_000 }, platform: "ios" });
      const quarantine = { enterFromStalledTransition: vi.fn() };

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        quarantine,
        registry,
      }).reconcile({ fix: true });

      expect(report.findings).toContainEqual(
        expect.objectContaining({ deviceId: device.id, kind: "stalled-transition" }),
      );
      expect(quarantine.enterFromStalledTransition).not.toHaveBeenCalled();
      expect(registry.snapshot.devices[0]?.state).toBe("reclaiming");
    });
  });

  it("reports no live-drift finding for a quarantined simulator while its retry runs, and registry-device-missing once the fake no longer lists it", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const device = await readyDevice(registry, "simlock-quarantined", "ios");
    const lease = await registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 99_999,
      ttlMs: 60_000,
    });
    await registry.beginRelease(lease.id);
    await registry.enterQuarantine(device.id, 10_100, { kind: "purge-failed" });
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const listed = {
      devices: [
        {
          address: "simlock-quarantined-address",
          deviceId: "simlock-quarantined",
          driverData: {},
          runState: "running" as const,
        },
      ],
      processes: [],
    };
    driver.setManagedReality(listed);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = driver.reclaim.bind(driver);
    vi.spyOn(driver, "reclaim").mockImplementation(async (target, options) => {
      await gate;
      return original(target, options);
    });
    const claims = new DeviceOperationClaims();
    const quarantine = new QuarantineCoordinator({
      claims,
      clock,
      config: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus,
      notifyAvailability: () => {},
      registry,
    });
    quarantine.restore();
    clock.advance(100);
    await vi.waitFor(() => expect(claims.isClaimed(device.id)).toBe(true));
    const reconcile = () =>
      new Doctor({
        decisions: new SerializedDecision(),
        claims,
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      })
        .reconcile()
        .then((report) =>
          report.findings.filter(
            (finding) => "deviceId" in finding && finding.deviceId === device.id,
          ),
        );

    const whileListed = await reconcile();
    driver.setManagedReality({ devices: [], processes: [] });
    const whileGone = await reconcile();
    release();

    expect(whileListed).toEqual([]);
    expect(whileGone).toEqual([
      expect.objectContaining({ kind: "registry-device-missing", platform: "ios" }),
    ]);
    quarantine.dispose();
  });

  it("--fix reconciles an unleased device's state to observed reality in both directions", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const bootedOutside = await shutdownDevice(registry, "simlock-booted", "ios");
    const shutdownOutside = await readyDevice(registry, "simlock-shutdown", "ios");

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-booted-address",
          deviceId: "simlock-booted",
          driverData: {},
          runState: "running",
        },
        {
          address: "simlock-shutdown-address",
          deviceId: "simlock-shutdown",
          driverData: {},
          runState: "stopped",
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
    }).reconcile({
      fix: true,
    });

    const snapshot = registry.snapshot;
    const booted = snapshot.devices.find((device) => device.id === bootedOutside.id);
    const shutdown = snapshot.devices.find((device) => device.id === shutdownOutside.id);
    expect(booted?.state).toBe("ready");
    expect(booted?.foreignStateDetectedAt).toBeUndefined();
    expect(shutdown?.state).toBe("shutdown");
    expect(shutdown?.foreignStateDetectedAt).toBeUndefined();
  });

  it("--fix keeps a spent fresh device shutdown when it is observed running, so its delete still finds it", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
      leaseIdentity: { android: "reusable", ios: "fresh" },
    });
    const spent = await registry.registerDevice({
      driverData: { fakeDeviceId: "simlock-spent" },
      driverDeviceId: "simlock-spent",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    await registry.transitionDevice(spent.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: spent.id },
    });
    const lease = await registry.createLease({
      deviceId: spent.id,
      ownerId: "gone",
      requesterId: "gone",
      ttlDeadline: 60_000,
      ttlMs: 60_000,
    });
    await registry.beginRelease(lease.id);
    await registry.completeReclaimWithoutPurge(spent.id);

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "spent-address",
          deviceId: "simlock-spent",
          driverData: {},
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
    }).reconcile({ fix: true });

    expect(report.findings.map((finding) => finding.kind)).toContain("foreign-state-change");
    expect(registry.snapshot.devices.find((device) => device.id === spent.id)?.state).toBe(
      "shutdown",
    );
  });

  it("--fix leaves a leased device untouched while still reporting the finding", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const device = await readyDevice(registry, "simlock-leased", "ios");
    await registry.createLease({
      deviceId: device.id,
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60_000,
      ttlDeadline: 999_999,
    });

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-leased-address",
          deviceId: "simlock-leased",
          driverData: {},
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
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const bootedOutside = await shutdownDevice(registry, "simlock-booted", "ios");
    const shutdownOutside = await readyDevice(registry, "simlock-shutdown", "ios");

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-booted-address",
          deviceId: "simlock-booted",
          driverData: {},
          runState: "running",
        },
        {
          address: "simlock-shutdown-address",
          deviceId: "simlock-shutdown",
          driverData: {},
          runState: "stopped",
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
    }).reconcile({
      fix: true,
    });

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

  describe("a startup read", () => {
    async function setup() {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const registered = await registry.registerDevice({
        driverData: { fakeDeviceId: "gone" },
        driverDeviceId: "gone",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      await registry.transitionDevice(registered.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: registered.id },
      });
      const driver = new FakeDriver({ clock, platform: "ios" });
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      });
      return { doctor, driver, registered };
    }

    it("is reconciled against instead of calling listManaged again", async () => {
      const { doctor, driver, registered } = await setup();
      const read = new StartupRead(new Map([["ios", { devices: [], processes: [] }]]));

      const report = await doctor.reconcile({ read });

      expect(driver.calls.map((call) => call.operation)).not.toContain("listManaged");
      expect(report.findings).toEqual([
        { deviceId: registered.id, kind: "registry-device-missing", platform: "ios" },
      ]);
    });

    it("reports no drift for the devices of a platform it left out, as for one with no driver", async () => {
      const { doctor, driver } = await setup();

      const report = await doctor.reconcile({ read: new StartupRead() });

      expect(driver.calls.map((call) => call.operation)).not.toContain("listManaged");
      expect(report.findings).toEqual([]);
    });
  });

  it("reports a platform whose driver refused to start, with the reason it refused", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [],
      driverRejections: [rootRejection()],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings.map((finding) => finding.kind)).toEqual(["driver-unavailable"]);
    expect(report.findings[0]).toMatchObject({
      // Discovery happens once, at startup, so the finding has to say what actually
      // retries the platform -- otherwise repairing the root and re-running `doctor`
      // reports the identical line and reads as a repair that did not work.
      detail: expect.stringContaining(
        "Refusing the ios device root /Devices: it carries no marker",
      ),
      platform: "ios",
      reason: "missing-marker",
    });
    expect(report.findings[0]).toMatchObject({
      detail: expect.stringContaining("restart the daemon"),
    });
  });

  it("leaves a refused driver alone under --fix, since adopting it is the refusal's point", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [],
      driverRejections: [rootRejection()],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    expect(report.findings.map((finding) => finding.kind)).toEqual(["driver-unavailable"]);
    expect(registry.snapshot.devices).toEqual([]);
  });

  describe("driver advisories", () => {
    it("collects driver-advisory findings from a driver that implements advisories()", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = withAdvisories(new FakeDriver({ clock, platform: "ios" }), [
        { code: "slim-runtime-unsupported", message: "iOS 17.0 predates the 18.5 floor" },
      ]);

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings).toEqual([
        {
          code: "slim-runtime-unsupported",
          kind: "driver-advisory",
          message: "iOS 17.0 predates the 18.5 floor",
          platform: "ios",
        },
      ]);
    });

    it("contributes nothing from a driver that has no advisories() method", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({ clock, platform: "ios" });

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings.filter((finding) => finding.kind === "driver-advisory")).toEqual([]);
    });

    it("tolerates a rejecting advisories() without failing the rest of reconcile", async () => {
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
      const driver = Object.assign(new FakeDriver({ clock, platform: "ios" }), {
        advisories: () => Promise.reject(new Error("advisories boom")),
      });

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings.filter((finding) => finding.kind === "driver-advisory")).toEqual([]);
      expect(report.findings.map((finding) => finding.kind)).toContain("registry-device-missing");
    });

    it("--fix never acts on a driver-advisory finding", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = withAdvisories(new FakeDriver({ clock, platform: "ios" }), [
        { code: "slim-runtime-unsupported", message: "detail" },
      ]);

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile({ fix: true });

      expect(report.findings).toEqual([
        {
          code: "slim-runtime-unsupported",
          kind: "driver-advisory",
          message: "detail",
          platform: "ios",
        },
      ]);
      expect(driver.calls.map((call) => call.operation)).toEqual(["listManaged"]);
    });

    it("excludes driver-advisory findings from the doctor.reconciled event's driftFindings", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = withAdvisories(new FakeDriver({ clock, platform: "ios" }), [
        { code: "slim-runtime-unsupported", message: "detail" },
      ]);

      await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      const reconciled = eventBus.replay().find((event) => event.event === "doctor.reconciled");
      expect(reconciled).toBeDefined();
      const payload = reconciled!.payload as {
        readonly driftFindings: readonly { readonly kind: string }[];
      };
      expect(payload.driftFindings.some((finding) => finding.kind === "driver-advisory")).toBe(
        false,
      );
    });
  });

  describe("prerequisites", () => {
    const EMULATOR = {
      message: "The Android emulator package is not installed.",
      prerequisite: "android-emulator",
      remedy: "Run `sdkmanager --install emulator`.",
    };
    const RESTART = /restart the daemon/;

    /** A check that reports `missing` and counts its runs. */
    function prerequisiteCheck(
      platform: "ios" | "android",
      missing: readonly (typeof EMULATOR)[] = [],
    ): PrerequisiteCheck & { runs: number } {
      const check = {
        check: () => {
          check.runs += 1;
          return Promise.resolve(missing);
        },
        platform,
        runs: 0,
      };
      return check;
    }

    async function doctorWith(
      options: Partial<ConstructorParameters<typeof Doctor>[0]> = {},
    ): Promise<{ readonly doctor: Doctor; readonly eventBus: EventBus }> {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadRegistry(clock, eventBus);
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [
          new FakeDriver({ clock, platform: "ios" }),
          new FakeDriver({ clock, platform: "android" }),
        ],
        eventBus,
        registry,
        ...options,
      });
      return { doctor, eventBus };
    }

    function prerequisiteFindings(report: DoctorReport) {
      return report.findings.filter((finding) => finding.kind === "prerequisite-missing");
    }

    it("reports no prerequisite-missing finding with every prerequisite present and both platforms running", async () => {
      const checks = [prerequisiteCheck("ios"), prerequisiteCheck("android")];
      const { doctor } = await doctorWith({ prerequisiteChecks: checks });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(checks.map((check) => check.runs)).toEqual([1, 1]);
      expect(prerequisiteFindings(report)).toEqual([]);
    });

    it("reports what a running platform's check finds missing, carrying the driver's text unread", async () => {
      const { doctor } = await doctorWith({
        prerequisiteChecks: [prerequisiteCheck("android", [EMULATOR])],
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report)).toEqual([
        { kind: "prerequisite-missing", platform: "android", ...EMULATOR },
      ]);
    });

    it("yields no finding from a check that rejects, and does not fail the run", async () => {
      const failing: PrerequisiteCheck = {
        check: () => Promise.reject(new Error("xcodebuild timed out")),
        platform: "ios",
      };
      const { doctor } = await doctorWith({
        driverRejections: [rootRejection()],
        prerequisiteChecks: [failing, prerequisiteCheck("android", [EMULATOR])],
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report).map((finding) => finding.platform)).toEqual(["android"]);
      expect(report.findings.map((finding) => finding.kind)).toContain("driver-unavailable");
    });

    it("gives a platform with nothing missing and no running driver one daemon-restart finding", async () => {
      const { doctor } = await doctorWith({
        prerequisiteChecks: [prerequisiteCheck("ios"), prerequisiteCheck("android")],
        runningPlatforms: () => ["ios"],
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report)).toEqual([
        expect.objectContaining({
          platform: "android",
          prerequisite: "daemon-restart",
          remedy: expect.stringMatching(RESTART) as unknown,
        }),
      ]);
    });

    it("gives a platform with a driver rejection no daemon-restart finding", async () => {
      const { doctor } = await doctorWith({
        driverRejections: [rootRejection()],
        prerequisiteChecks: [prerequisiteCheck("ios"), prerequisiteCheck("android")],
        runningPlatforms: () => ["android"],
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report)).toEqual([]);
    });

    it("tells the operator to restart the daemon on a finding for a platform that is not running, and not on one that is", async () => {
      const { doctor } = await doctorWith({
        prerequisiteChecks: [
          prerequisiteCheck("ios", [{ ...EMULATOR, prerequisite: "xcode" }]),
          prerequisiteCheck("android", [EMULATOR]),
        ],
        runningPlatforms: () => ["ios"],
      });

      const report = await doctor.reconcile({ prerequisites: true });
      const [ios, android] = prerequisiteFindings(report) as Extract<
        DoctorFinding,
        { readonly kind: "prerequisite-missing" }
      >[];

      expect(ios?.remedy).toBe(EMULATOR.remedy);
      expect(android?.remedy.startsWith(EMULATOR.remedy)).toBe(true);
      expect(android?.remedy).toMatch(RESTART);
    });

    it("reports the same prerequisite findings with fix: true and asks the driver for nothing but listManaged", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const android = new FakeDriver({ clock, platform: "android" });
      const check = prerequisiteCheck("android", [EMULATOR]);
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [android],
        eventBus,
        prerequisiteChecks: [check],
        registry: await loadRegistry(clock, eventBus),
      });

      const plain = await doctor.reconcile({ prerequisites: true });
      const fixed = await doctor.reconcile({ fix: true, prerequisites: true });

      expect(prerequisiteFindings(fixed)).toEqual(prerequisiteFindings(plain));
      expect(prerequisiteFindings(fixed)).toHaveLength(1);
      expect(android.calls.map((call) => call.operation)).toEqual(["listManaged", "listManaged"]);
      expect(check.runs).toBe(2);
    });

    it("applies --fix before any prerequisite check runs, so a slow check never delays a fix", async () => {
      const { eventBus, registry } = await readyIosDevice();
      const deviceId = registry.snapshot.devices[0]!.id;
      await registry.createLease({
        deviceId,
        ownerId: "agent",
        requesterId: "agent",
        ttlDeadline: 9_000,
        ttlMs: 60_000,
      });
      const order: string[] = [];
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock: new FakeClock(10_000),
        config: config(),
        drivers: [],
        eventBus,
        leaseExpirer: {
          expire: (leaseId: string) => {
            order.push(`expire ${leaseId}`);
            return Promise.resolve();
          },
        },
        prerequisiteChecks: [
          {
            check: () => {
              order.push("check");
              return Promise.resolve([]);
            },
            platform: "android",
          },
        ],
        registry,
      });

      await doctor.reconcile({ fix: true, prerequisites: true });

      expect(order).toEqual([`expire ${registry.snapshot.leases[0]!.id}`, "check"]);
    });

    it("runs no prerequisite check when reconcile is not asked to", async () => {
      const check = prerequisiteCheck("android", [EMULATOR]);
      const { doctor } = await doctorWith({ prerequisiteChecks: [check] });

      const report = await doctor.reconcile();

      expect(check.runs).toBe(0);
      expect(prerequisiteFindings(report)).toEqual([]);
    });

    it("leaves prerequisite-missing findings out of doctor.reconciled", async () => {
      const { doctor, eventBus } = await doctorWith({
        prerequisiteChecks: [prerequisiteCheck("android", [EMULATOR])],
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report)).toHaveLength(1);
      const reconciled = eventBus.replay().find((event) => event.event === "doctor.reconciled");
      const payload = reconciled!.payload as {
        readonly driftFindings: readonly { readonly kind: string }[];
      };
      expect(payload.driftFindings).toEqual([]);
    });
  });
});

describe("Doctor with a platform it cannot observe", () => {
  it("never reports a registry device missing because no driver could look for it", async () => {
    const { eventBus, registry } = await readyIosDevice();

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock: new FakeClock(10_000),
      config: config(),
      drivers: [],
      driverRejections: [rootRejection()],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    // "I could not look" is not "the device is gone". Marking these `deleted` would strand
    // every simulator in the root behind a registry with no record of it -- the permanent
    // multi-gigabyte leak ADR 0001 exists to prevent, reachable with a `chmod`.
    expect(report.findings.map((finding) => finding.kind)).toEqual(["driver-unavailable"]);
    expect(registry.snapshot.devices[0]?.state).toBe("ready");
  });

  it("stays silent about a platform that simply has no driver on this host", async () => {
    const { eventBus, registry } = await readyIosDevice();

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock: new FakeClock(10_000),
      config: config(),
      drivers: [],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    // Same reasoning with no rejection to report: a missing Android SDK or a non-Mac host
    // is just as unobservable as a refused root.
    expect(report.findings).toEqual([]);
    expect(registry.snapshot.devices[0]?.state).toBe("ready");
  });

  it("destroys orphans only when the purge is asked for, and reports what it destroyed", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const driver = new FakeDriver({ clock, deviceRoot: "/roots/ios", platform: "ios" });
    driver.setManagedReality({
      devices: [observed("orphan-1", "running")],
      processes: [driverDevice("orphan-1")],
    });
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    });

    const reported = await doctor.reconcile({ fix: true });
    expect(reported.findings.map((finding) => finding.kind)).toEqual([
      "orphan-device",
      "orphan-process",
    ]);
    expect(driver.calls.filter((call) => call.operation === "destroy")).toEqual([]);

    const purged = await doctor.reconcile({ purgeOrphans: true });

    // The process is the device's: destroying the device covers it, so reporting the
    // process afterwards would name something that no longer exists.
    expect(purged.findings).toEqual([]);
    expect(eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "device.orphan-purged",
        payload: { deviceRoot: "/roots/ios", driverDeviceId: "orphan-1", platform: "ios" },
      }),
    );
  });

  it("re-proves the root before the first destroy of a purge", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({ devices: [observed("orphan-1", "stopped")], processes: [] });

    await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({
      purgeOrphans: true,
    });

    expect(driver.calls.map((call) => call.operation)).toEqual([
      "listManaged",
      "revalidateRoot",
      "destroy",
    ]);
  });

  it("destroys nothing at all when a root can no longer be proven", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const iosDriver = new FakeDriver({ clock, platform: "ios" });
    iosDriver.setManagedReality({ devices: [observed("ios-orphan", "stopped")], processes: [] });
    const androidDriver = new FakeDriver({ clock, platform: "android" });
    androidDriver.setManagedReality({
      devices: [observed("android-orphan", "stopped")],
      processes: [],
    });
    androidDriver.failOn("revalidateRoot", 1, new Error("Refusing the android device root"));

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [iosDriver, androidDriver],
      eventBus,
      registry,
    }).reconcile({ purgeOrphans: true });

    // A daemon that cannot prove one of its roots is not one to keep destroying on, and
    // the roots are proven before anything is destroyed -- so this costs a re-run, never a
    // half-purge.
    expect(
      [...iosDriver.calls, ...androidDriver.calls].filter((call) => call.operation === "destroy"),
    ).toEqual([]);
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "orphan-device",
      "orphan-device",
    ]);
    expect(eventBus.replay().some((event) => event.event === "device.orphan-purged")).toBe(false);
  });

  it("leaves an orphan it could not destroy standing and purges the rest", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [observed("stubborn", "stopped"), observed("orphan-2", "stopped")],
      processes: [],
    });
    driver.failOn("destroy", 1, new Error("simctl delete failed"));

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({ purgeOrphans: true });

    expect(report.findings).toEqual([
      {
        device: expect.objectContaining({ deviceId: "stubborn" }),
        kind: "orphan-device",
        platform: "ios",
      },
    ]);
    expect(
      eventBus.replay().filter((event) => event.event === "device.orphan-purged"),
    ).toHaveLength(1);
  });

  it("reports a device left in the pre-root location as legacy rather than missing", async () => {
    const { clock, driver, eventBus, registry } = await legacyDeviceSetup();

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings).toEqual([
      {
        device: expect.objectContaining({ deviceId: "stranded" }),
        deviceId: registry.snapshot.devices[0]?.id,
        kind: "legacy-device",
        path: "/Library/Devices/stranded",
        platform: "ios",
      },
    ]);
  });

  it("destroys a legacy device through its old path and then records it missing", async () => {
    const { clock, driver, eventBus, registry } = await legacyDeviceSetup();

    await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({
      fix: true,
    });

    expect(driver.calls.filter((call) => call.operation === "destroyLegacy")).toHaveLength(1);
    expect(registry.snapshot.devices[0]?.state).toBe("deleted");
  });

  it("never destroys a legacy device that a lease still references", async () => {
    const { clock, driver, eventBus, registry } = await legacyDeviceSetup();
    const device = registry.snapshot.devices[0]!;
    await registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlMs: 60_000,
      ttlDeadline: 90_000,
    });

    await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({
      fix: true,
    });

    expect(driver.calls.filter((call) => call.operation === "destroyLegacy")).toEqual([]);
    expect(registry.snapshot.devices[0]?.state).toBe("leased");
  });

  it("reports a missing device as missing when the legacy lookup itself fails", async () => {
    const { clock, driver, eventBus, registry } = await legacyDeviceSetup();
    driver.failOn("findLegacy", 1, new Error("simctl list failed"));

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    // "I could not look outside the root" is not "it is out there": the conservative
    // finding is the one whose fix only writes to the registry.
    expect(report.findings.map((finding) => finding.kind)).toEqual(["registry-device-missing"]);
    expect(driver.calls.filter((call) => call.operation === "destroyLegacy")).toEqual([]);
  });
});

describe("Doctor: optional module findings", () => {
  const unavailable: OptionalModuleFinding = {
    kind: "module-unavailable",
    module: "agent-device",
    message: "found 0.20.3, need 0.21.28 or later",
    remedy: "install agent-device 0.21.28 or later, then restart the daemon",
  };

  async function setup(
    options: {
      readonly optionalModules?: () => readonly OptionalModuleFinding[];
      readonly orphan?: boolean;
      readonly missing?: boolean;
      readonly sink?: MemoryLogSink;
    } = {},
  ) {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    if (options.missing === true) {
      await readyDevice(registry, "gone", "ios");
    }
    const driver = new FakeDriver({ clock, platform: "ios" });
    if (options.orphan === true) {
      driver.setManagedReality({
        devices: [
          {
            address: "simlock-orphan-address",
            deviceId: "simlock-orphan",
            driverData: { fakeDeviceId: "simlock-orphan" },
            runState: "running",
          },
        ],
        processes: [],
      });
    }
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
      ...(options.sink === undefined
        ? {}
        : { logger: new JsonLinesLogger({ clock, level: "debug", sink: options.sink }) }),
      ...(options.optionalModules === undefined
        ? {}
        : { optionalModules: options.optionalModules }),
    });
    return { doctor, driver, eventBus, registry };
  }

  it("returns each finding optionalModules gives, with its kind, message and remedy unchanged, after a warm-pool-target-unreachable finding returned by the same run", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: { ...config(), warmPool: { ...config().warmPool, enabled: true } },
      drivers: [new FakeDriver({ clock, platform: "ios" })],
      eventBus,
      optionalModules: () => [unavailable],
      registry: await loadRegistry(clock, eventBus),
      warmPool: {
        figures: () => ({
          enabled: true,
          reserveRunning: { android: 0, ios: 0 },
          targets: [
            {
              booting: 0,
              count: 1,
              mode: "full" as const,
              model: "iPhone 17",
              osVersion: "27.0",
              platform: "ios" as const,
              ready: 0,
              short: "runtime-missing" as const,
            },
          ],
        }),
        runningCapacity: () => ({
          android: { maxRunning: 10, overLimit: false, reserved: 0, running: 0 },
          global: { maxRunning: 20, overLimit: false, reserved: 0, running: 0 },
          ios: { maxRunning: 10, overLimit: false, reserved: 0, running: 0 },
        }),
      },
    } as ConstructorParameters<typeof Doctor>[0]);

    const report = await doctor.reconcile();

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "warm-pool-target-unreachable",
      "module-unavailable",
    ]);
    expect(report.findings.at(-1)).toStrictEqual(unavailable);
  });

  it("returns no module-unavailable finding when optionalModules is omitted or returns none", async () => {
    const omitted = await (await setup()).doctor.reconcile();
    const none = await (await setup({ optionalModules: () => [] })).doctor.reconcile();

    expect(omitted.findings).toEqual([]);
    expect(none.findings).toEqual([]);
  });

  it("reports the finding on a run where optionalModules returns it, and not on the next where it returns none", async () => {
    const answers: (readonly OptionalModuleFinding[])[] = [[unavailable], []];
    const { doctor } = await setup({ optionalModules: () => answers.shift() ?? [] });

    const first = await doctor.reconcile();
    const second = await doctor.reconcile();

    expect(first.findings).toStrictEqual([unavailable]);
    expect(second.findings).toEqual([]);
  });

  it("calls optionalModules only after fix and purge have run, with fix and purgeOrphans on, and reports its finding", async () => {
    let stateWhenCalled: string | undefined;
    let destroysWhenCalled: number | undefined;
    let registryRef: Awaited<ReturnType<typeof setup>>["registry"] | undefined;
    let driverRef: Awaited<ReturnType<typeof setup>>["driver"] | undefined;
    const harness = await setup({
      missing: true,
      optionalModules: () => {
        stateWhenCalled = registryRef?.snapshot.devices[0]?.state;
        destroysWhenCalled = driverRef?.calls.filter((call) => call.operation === "destroy").length;
        return [unavailable];
      },
      orphan: true,
    });
    registryRef = harness.registry;
    driverRef = harness.driver;

    const report = await harness.doctor.reconcile({ fix: true, purgeOrphans: true });

    expect(stateWhenCalled).toBe("deleted");
    // why: the purge destroys the orphan, so a call made before it would count no destroy.
    expect(destroysWhenCalled).toBe(1);
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "registry-device-missing",
      "module-unavailable",
    ]);
  });

  it("leaves the finding out of doctor.reconciled's driftFindings and emits no other event for it", async () => {
    const withModule = await setup({ optionalModules: () => [unavailable], orphan: true });
    const without = await setup({ orphan: true });

    const report = await withModule.doctor.reconcile();
    await without.doctor.reconcile();

    expect(report.findings).toContainEqual(unavailable);

    const reconciled = withModule.eventBus
      .replay()
      .find((event) => event.event === "doctor.reconciled");
    expect(reconciled?.payload).toMatchObject({ driftFindings: [{ kind: "orphan-device" }] });
    expect(reconciled?.payload).toHaveProperty("driftFindings.length", 1);
    expect(withModule.eventBus.replay().map((event) => event.event)).toEqual(
      without.eventBus.replay().map((event) => event.event),
    );
  });

  it("logs a warning naming the error when optionalModules throws, contributes nothing, and still returns the other findings", async () => {
    const sink = new MemoryLogSink();
    const { doctor } = await setup({
      optionalModules: () => {
        throw new Error("supervisor exploded");
      },
      orphan: true,
      sink,
    });

    const report = await doctor.reconcile();

    expect(report.findings.map((finding) => finding.kind)).toEqual(["orphan-device"]);
    const warning = sink.records.find(
      (record) => record.message === "Could not read optional module findings",
    );
    expect(warning?.level).toBe("warn");
    expect(JSON.stringify(warning?.fields)).toContain("supervisor exploded");
  });
});

async function legacyDeviceSetup() {
  const clock = new FakeClock(10_000);
  const eventBus = new EventBus(clock);
  const registry = await loadRegistry(clock, eventBus);
  await readyDevice(registry, "stranded", "ios");
  const driver = new FakeDriver({
    clock,
    legacyDevices: {
      stranded: { device: driverDevice("stranded"), path: "/Library/Devices/stranded" },
    },
    platform: "ios",
  });
  driver.setManagedReality({ devices: [], processes: [] });
  return { clock, driver, eventBus, registry };
}

function loadRegistry(clock: FakeClock, eventBus: EventBus): Promise<Registry> {
  return loadTestRegistry({
    clock,
    eventBus,
    idGenerator: sequence(),
  });
}

function driverDevice(deviceId: string) {
  return {
    physical: false,
    address: `${deviceId}-address`,
    deviceId,
    driverData: { fakeDeviceId: deviceId },
  };
}

function observed(deviceId: string, runState: "running" | "stopped") {
  return { ...driverDevice(deviceId), runState };
}

/** One `ready` iOS device in an otherwise empty registry. */
async function readyIosDevice() {
  const clock = new FakeClock(10_000);
  const eventBus = new EventBus(clock);
  const registry = await loadTestRegistry({
    clock,
    eventBus,
    idGenerator: sequence(),
  });
  const registered = await registry.registerDevice({
    driverData: { fakeDeviceId: "device-1" },
    driverDeviceId: "device-1",
    provisionDuration: 0,
    spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
  });
  await registry.transitionDevice(registered.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: registered.id },
  });
  return { eventBus, registry };
}

function rootRejection(): DriverRejection {
  return {
    event: "driver.root-rejected",
    payload: { platform: "ios", reason: "missing-marker", root: "/Devices" },
    platform: "ios",
    reason: "missing-marker",
    summary: "Refusing the ios device root /Devices: it carries no marker",
  };
}

async function readyDevice(
  registry: Registry,
  driverDeviceId: string,
  platform: "ios" | "android",
) {
  const device = await registry.registerDevice({
    driverData: { fakeDeviceId: driverDeviceId },
    driverDeviceId,
    provisionDuration: 0,
    spec: { physical: false, model: "Phone", osVersion: "1", platform },
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

describe("Doctor and physical devices (ADR 0022 §4)", () => {
  async function physicalHarness(states: readonly ("ready" | "leased" | "reclaiming")[]) {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    for (const state of states) {
      const device = await registry.enrollPhysical({
        apps: [],
        class: "phone",
        driverDeviceId: `00008110-${state}`,
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        platform: "ios",
      });
      if (state === "ready") continue;
      const lease = await registry.createLease({
        deviceId: device.id,
        ownerId: "agent",
        requesterId: "agent",
        ttlDeadline: 10_000_000,
        ttlMs: 60_000,
      });
      if (state === "reclaiming") await registry.beginRelease(lease.id);
    }
    clock.advance(99_000);
    const driver = new FakeDriver({
      clock,
      estimateMs: { boot: 2_000, provision: 1_000, reclaim: 1_000 },
      platform: "ios",
    });
    driver.setManagedReality({ devices: [], processes: [] });
    return { clock, driver, eventBus, registry };
  }

  it("raises no drift finding for a ready or a leased physical record that no root holds, and --fix leaves both as they are", async () => {
    const { clock, driver, eventBus, registry } = await physicalHarness(["ready", "leased"]);
    const destroy = vi.spyOn(driver, "destroy");
    const shutdown = vi.spyOn(driver, "shutdown");

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    expect(report.findings).toEqual([]);
    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["ready", "leased"]);
    expect(destroy).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("does not report as an orphan the ID a physical record holds, and a purge destroys only the orphan, as a virtual driver device", async () => {
    const { clock, driver, eventBus, registry } = await physicalHarness(["ready"]);
    driver.setManagedReality({
      devices: [
        {
          address: "a",
          deviceId: "00008110-ready",
          driverData: {},
          runState: "running",
        },
        { address: "b", deviceId: "simlock-orphan", driverData: {}, runState: "running" },
      ],
      processes: [],
    });
    const destroy = vi.spyOn(driver, "destroy");

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({ purgeOrphans: true });

    expect(report.findings).toEqual([]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "simlock-orphan", physical: false }),
    );
  });

  it("reports stalled-transition for a reclaiming physical record past its threshold, priced at the physical reclaim estimate, and --fix quarantines it", async () => {
    const { clock, driver, eventBus, registry } = await physicalHarness(["reclaiming"]);
    const quarantine = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus,
      notifyAvailability: () => {},
      registry,
    });
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config({ minimumThresholdMs: 0, thresholdMultiplier: 1 }),
      drivers: [driver],
      eventBus,
      quarantine,
      registry,
    });

    const report = await doctor.reconcile({ fix: true });

    expect(report.findings).toEqual([
      expect.objectContaining({
        deviceId: registry.snapshot.devices[0]?.id,
        kind: "stalled-transition",
        thresholdMs: 90_000,
      }),
    ]);
    expect(registry.snapshot.devices[0]?.state).toBe("quarantined");
    quarantine.dispose();
  });
});

describe("Doctor and a physical reclaim in flight (ADR 0022 §7, §8)", () => {
  async function harness() {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const driver = new FakeDriver({
      clock,
      estimateMs: { boot: 2_000, provision: 1_000, reclaim: 1_000 },
      platform: "ios",
    });
    driver.setManagedReality({ devices: [], processes: [] });
    const claims = new DeviceOperationClaims();
    const quarantine = new QuarantineCoordinator({
      claims,
      clock,
      config: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus,
      notifyAvailability: () => {},
      registry,
    });
    const doctor = new Doctor({
      claims,
      decisions: new SerializedDecision(),
      clock,
      config: config({ minimumThresholdMs: 0, thresholdMultiplier: 1 }),
      drivers: [driver],
      eventBus,
      quarantine,
      registry,
    });
    return { claims, clock, doctor, eventBus, quarantine, registry };
  }

  async function enrollReclaiming(registry: Registry, name: string) {
    const device = await registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: `00008110-${name}`,
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 10_000_000,
      ttlMs: 60_000,
    });
    await registry.beginRelease(lease.id);
    return device;
  }

  it("a physical reclaim interrupted by a killed daemon is aged from reclaimingSince by stalled-transition", async () => {
    const { clock, doctor, quarantine, registry } = await harness();
    const oldStart = await enrollReclaiming(registry, "old_start");
    const newStart = await enrollReclaiming(registry, "new_start");
    await registry.transitionDevice(
      newStart.id,
      "absent",
      {
        event: "device.absence-detected",
        payload: { absentReason: "locked", deviceId: newStart.id, previousState: "reclaiming" },
      },
      { absentReason: "locked" },
    );
    clock.advance(98_000);
    await registry.transitionDevice(newStart.id, "reclaiming", {
      event: "device.returned",
      payload: { deviceId: newStart.id, osVersion: "18.4" },
    });
    clock.advance(1_000);

    const report = await doctor.reconcile();

    expect(
      report.findings
        .filter((finding) => finding.kind === "stalled-transition")
        .map((finding) => finding.deviceId),
    ).toEqual([oldStart.id]);
    quarantine.dispose();
  });

  it("doctor --fix on a stalled reclaiming device that is claimed by the time the fix runs writes nothing, emits no device.quarantined and arms no retry", async () => {
    const { claims, clock, doctor, eventBus, quarantine, registry } = await harness();
    const stalled = await enrollReclaiming(registry, "stalled");
    clock.advance(99_000);
    let commits = 0;
    registry.onCommit(() => {
      commits += 1;
    });
    let claimTaken = false;
    eventBus.subscribe("device.stalled-transition-detected", () => {
      claimTaken = claims.tryClaim(stalled.id, "reclaim") !== undefined;
    });

    const report = await doctor.reconcile({ fix: true });

    expect(report.findings).toContainEqual(
      expect.objectContaining({ deviceId: stalled.id, kind: "stalled-transition" }),
    );
    expect(claimTaken).toBe(true);
    expect(registry.snapshot.devices[0]?.state).toBe("reclaiming");
    expect(commits).toBe(0);
    expect(eventBus.replay().filter((event) => event.event === "device.quarantined")).toEqual([]);
    expect(clock.pendingTimerCount).toBe(0);
    quarantine.dispose();
  });
});

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function withAdvisories(
  driver: FakeDriver,
  advisories: readonly { readonly code: string; readonly message: string }[],
): FakeDriver {
  return Object.assign(driver, { advisories: () => Promise.resolve(advisories) });
}

function config(stalledTransitionOverrides: Partial<Config["stalledTransition"]> = {}): Config {
  return {
    capabilities: {},
    mode: "worker",
    exec: { timeoutMs: 600_000 },
    diskPressure: { freeBytesThreshold: 1 },
    gateway: {
      disconnectedRetentionMs: 24 * 60 * 60_000,
      execTimeoutMs: 11 * 60_000,
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: "warm-then-free" as const,
      alerts: { destinations: [] },
    },
    drivers: {},
    eventBuffer: { capacity: 10 },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    idle: { deleteAfterMs: 10, shutdownAfterMs: 5 },
    lease: {
      defaultTtlMs: 60_000,
      maxTtlMs: 3_600_000,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
      maxPerRequester: 1,
      endWaitMs: 600_000,
    },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 1 + 1,
        },
        ramBudget: { androidBytesPerDevice: 1, iosBytesPerDevice: 1 },
      },
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    eventLog: {
      retention: 7 * 24 * 60 * 60 * 1000,
      maxBytes: 256 * 1024 * 1024,
    },
    metrics: { retention: 90 * 24 * 60 * 60 * 1000 },
    warmPool: {
      enabled: true,
      maxConcurrentBoots: 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
    stalledTransition: {
      thresholdMultiplier: 3,
      minimumThresholdMs: 1_000,
      ...stalledTransitionOverrides,
    },
    downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { defaultMode: "full", defaultModels: {}, slim: { bootTimeoutMs: 600_000 } },
    android: {
      defaultModels: {},
      emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
    },
  };
}

describe("Doctor: warm pool targets", () => {
  const entry = (maxRunning: number) => ({
    maxRunning,
    overLimit: false,
    reserved: 0,
    running: 0,
  });
  const limits = (limit: { ios?: number; android?: number; global?: number }) => ({
    android: entry(limit.android ?? 10),
    global: entry(limit.global ?? 20),
    ios: entry(limit.ios ?? 10),
  });
  const figuresOf = (
    targets: readonly {
      model: string;
      osVersion?: string;
      platform?: "ios" | "android";
      short?: "runtime-missing" | "unknown-model" | "ram-budget";
    }[],
  ) => ({
    enabled: true,
    reserveRunning: { android: 0, ios: 0 },
    targets: targets.map((target) => ({
      booting: 0,
      count: 1,
      mode: "full" as const,
      platform: "ios" as const,
      ready: 0,
      ...target,
    })),
  });

  async function findings(options: {
    readonly targets?: Config["warmPool"]["targets"];
    readonly reserve?: { ios: number; android: number };
    readonly enabled?: boolean;
    readonly limit?: { ios?: number; android?: number; global?: number };
    readonly figures?: ReturnType<typeof figuresOf>;
    readonly driver?: Omit<ConstructorParameters<typeof FakeDriver>[0], "clock">;
  }): Promise<DoctorFinding[]> {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const base = config();
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: {
        ...base,
        warmPool: {
          ...base.warmPool,
          enabled: options.enabled ?? true,
          reserveRunning: options.reserve ?? { android: 0, ios: 0 },
          targets: options.targets ?? [],
        },
      },
      drivers: [new FakeDriver({ clock, platform: "ios", ...options.driver })],
      eventBus,
      registry,
      warmPool: {
        figures: () => options.figures ?? figuresOf([]),
        runningCapacity: () => limits(options.limit ?? {}),
      },
    });
    const report = await doctor.reconcile();
    return report.findings.filter((finding) => finding.kind === "warm-pool-target-unreachable");
  }

  it("reports a target short with runtime-missing as unreachable, naming the install command", async () => {
    const found = await findings({
      figures: figuresOf([
        { model: "iPhone 17", osVersion: "26.0" },
        { model: "iPhone 17", osVersion: "27.0", short: "runtime-missing" },
      ]),
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message: "iOS 27.0 is not installed",
        platform: "ios",
        reason: "runtime-missing",
        remedy: "run simlock component install ios 27.0",
        target: "iPhone 17 / 27.0 / full",
      },
    ]);
  });

  it.each([
    ["ios", "iOS", "iPhone 17", ["18.0", "26.0"], "26.0"],
    ["android", "Android", "Television (1080p)", ["34", "35"], "35"],
  ] as const)(
    "names simlock catalog, not component install, for an installed %s version the target's model does not pair with",
    async (platform, name, model, runtimes, unpaired) => {
      const found = await findings({
        driver: {
          availableOsVersions: [...runtimes],
          knownModels: [model],
          modelRuntimes: { [model]: runtimes.filter((runtime) => runtime !== unpaired) },
          platform,
        },
        figures: figuresOf([{ model, osVersion: unpaired, platform, short: "runtime-missing" }]),
      });

      expect(found).toStrictEqual([
        {
          kind: "warm-pool-target-unreachable",
          message: `${model} does not pair with ${name} ${unpaired}`,
          platform,
          reason: "runtime-missing",
          remedy: `run simlock catalog --platform ${platform}`,
          target: `${model} / ${unpaired} / full`,
        },
      ]);
    },
  );

  it("keeps the install text for a version the platform's catalog does not list", async () => {
    const found = await findings({
      driver: {
        availableOsVersions: ["26.0"],
        knownModels: ["iPhone 17"],
        platform: "ios",
      },
      figures: figuresOf([{ model: "iPhone 17", osVersion: "27.0", short: "runtime-missing" }]),
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message: "iOS 27.0 is not installed",
        remedy: "run simlock component install ios 27.0",
      }),
    ]);
  });

  it("reports a target short with unknown-model as unreachable", async () => {
    const found = await findings({
      figures: figuresOf([{ model: "iPhone 99", osVersion: "26.0", short: "unknown-model" }]),
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        kind: "warm-pool-target-unreachable",
        platform: "ios",
        reason: "unknown-model",
        target: "iPhone 99 / 26.0 / full",
      }),
    ]);
  });

  it("reports one finding for two iOS targets of 2 on a running limit of 3, naming the sum and the limit", async () => {
    const found = await findings({
      limit: { ios: 3 },
      targets: [
        { count: 2, model: "iPhone 17", platform: "ios" },
        { count: 2, model: "iPhone 16", platform: "ios" },
      ],
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message:
          "the ios targets want 4 running devices, and the ios running limit is 3, leaving room for 3",
        platform: "ios",
        reason: "over-limit",
        remedy: "lower the counts of the ios warmPool.targets, or raise the ios running limit",
        target: "ios targets",
      },
    ]);
  });

  it("names the reserve a platform's limit holds back, and offers lowering it", async () => {
    const found = await findings({
      limit: { ios: 3 },
      reserve: { android: 0, ios: 1 },
      targets: [{ count: 3, model: "iPhone 17", platform: "ios" }],
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message:
          "the ios targets want 3 running devices, and the ios running limit is 3, of which warmPool.reserveRunning holds 1, leaving room for 2",
        remedy:
          "lower the counts of the ios warmPool.targets, raise the ios running limit, or lower warmPool.reserveRunning",
      }),
    ]);
  });

  it("names the summed reserves in the machine's finding", async () => {
    const found = await findings({
      limit: { android: 5, global: 4, ios: 5 },
      reserve: { android: 1, ios: 1 },
      targets: [
        { count: 2, model: "iPhone 17", platform: "ios" },
        { count: 1, model: "Pixel 8", platform: "android" },
      ],
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message:
          "the targets want 3 running devices, and the running limit is 4, of which warmPool.reserveRunning holds 2, leaving room for 2",
        target: "all targets",
      }),
    ]);
  });

  it("caps a platform's reserve at its running limit, so a platform with no targets is not over it", async () => {
    const noTargets = await findings({
      limit: { global: 5, ios: 2 },
      reserve: { android: 0, ios: 4 },
    });
    expect(noTargets).toEqual([]);
    expect(
      await findings({
        limit: { global: 5, ios: 2 },
        reserve: { android: 0, ios: 4 },
        targets: [{ count: 1, model: "iPhone 17", platform: "ios" }],
      }),
    ).toEqual([
      expect.objectContaining({
        message:
          "the ios targets want 1 running devices, and the ios running limit is 2, of which warmPool.reserveRunning holds 2, leaving room for 0",
        platform: "ios",
      }),
    ]);
  });

  it("reports nothing for reserves that add up past the machine's limit when no target is configured", async () => {
    const limit = { android: 5, global: 4, ios: 5 };
    const reserve = { android: 2, ios: 3 };

    expect(await findings({ limit, reserve })).toEqual([]);
  });

  it("caps the machine's reserve at its running limit, so a target past it leaves room for zero and never below", async () => {
    const found = await findings({
      limit: { android: 5, global: 4, ios: 5 },
      reserve: { android: 2, ios: 3 },
      targets: [{ count: 1, model: "iPhone 17", platform: "ios" }],
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message:
          "the targets want 1 running devices, and the running limit is 4, of which warmPool.reserveRunning holds 4, leaving room for 0",
        target: "all targets",
      }),
    ]);
  });

  it("prints no install command for a target whose OS is a range, which names no version to install", async () => {
    const found = await findings({
      figures: figuresOf([{ model: "iPhone 17", osVersion: ">=27", short: "runtime-missing" }]),
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message: "no installed iOS runtime satisfies >=27",
        platform: "ios",
        reason: "runtime-missing",
        remedy:
          "run simlock component list --platform ios to see the versions, then simlock component install ios <version> for one inside >=27",
        target: "iPhone 17 / >=27 / full",
      },
    ]);
  });

  it("takes the platform's reserve off the room its targets have", async () => {
    const targets = [{ count: 3, model: "iPhone 17", platform: "ios" as const }];

    expect(await findings({ limit: { ios: 3 }, reserve: { android: 0, ios: 1 }, targets })).toEqual(
      [expect.objectContaining({ platform: "ios", reason: "over-limit" })],
    );
    expect(await findings({ limit: { ios: 3 }, targets })).toEqual([]);
  });

  it("reports one finding for targets that fit each platform but not the machine's running limit together", async () => {
    const found = await findings({
      limit: { android: 5, global: 3, ios: 5 },
      targets: [
        { count: 2, model: "iPhone 17", platform: "ios" },
        { count: 2, model: "Pixel 8", platform: "android" },
      ],
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message:
          "the targets want 4 running devices, and the running limit is 3, leaving room for 3",
        reason: "over-limit",
        remedy: "lower the counts of the warmPool.targets, or raise the running limit",
        target: "all targets",
      },
    ]);
  });

  it("pins the unknown-model message and remedy, naming the model and the platform", async () => {
    const found = await findings({
      figures: figuresOf([
        {
          model: "Pixel 99",
          osVersion: "35",
          platform: "android",
          short: "unknown-model",
        },
      ]),
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message: "Pixel 99 is not a known Android model",
        platform: "android",
        reason: "unknown-model",
        remedy: "run simlock catalog --platform android to list the models",
        target: "Pixel 99 / 35 / full",
      },
    ]);
  });

  it("names an Android runtime as Android, and a target that names no OS without one", async () => {
    const found = await findings({
      figures: figuresOf([
        {
          model: "Pixel 8",
          osVersion: "35",
          platform: "android",
          short: "runtime-missing",
        },
        { model: "iPhone 17", short: "runtime-missing" },
        { model: "iPhone 99", short: "unknown-model" },
      ]),
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message: "Android 35 is not installed",
        remedy: "run simlock component install android 35",
      }),
      {
        kind: "warm-pool-target-unreachable",
        message: "iOS runtime is not installed",
        platform: "ios",
        reason: "runtime-missing",
        remedy:
          "run simlock component list --platform ios to see the versions, then simlock component install ios <version>",
        target: "iPhone 17 / full",
      },
      expect.objectContaining({ target: "iPhone 99 / full" }),
    ]);
  });

  it("takes both reserves off the machine's room, and reports nothing for targets that exactly fill what is left", async () => {
    const reserve = { android: 1, ios: 1 };
    const targets = (ios: number) => [
      { count: ios, model: "iPhone 17", platform: "ios" as const },
      { count: 1, model: "Pixel 8", platform: "android" as const },
    ];
    const limit = { android: 5, global: 4, ios: 5 };

    expect(await findings({ limit, reserve, targets: targets(2) })).toEqual([
      expect.objectContaining({ reason: "over-limit", target: "all targets" }),
    ]);
    expect(await findings({ limit, reserve, targets: targets(1) })).toEqual([]);
    expect(
      await findings({
        limit: { ios: 3 },
        targets: [{ count: 3, model: "iPhone 17", platform: "ios" }],
      }),
    ).toEqual([]);
  });

  it("does not report a target short for ram-budget, or one that fits", async () => {
    const found = await findings({
      figures: figuresOf([{ model: "iPhone 17", osVersion: "26.0", short: "ram-budget" }]),
      targets: [{ count: 1, model: "iPhone 17", platform: "ios" }],
    });

    expect(found).toEqual([]);
  });

  it("reports nothing with the pool off", async () => {
    const found = await findings({
      enabled: false,
      figures: figuresOf([{ model: "iPhone 17", osVersion: "27.0", short: "runtime-missing" }]),
      limit: { ios: 1 },
      targets: [{ count: 5, model: "iPhone 17", platform: "ios" }],
    });

    expect(found).toEqual([]);
  });

  it("leaves the finding out of the doctor.reconciled event's driftFindings, which keeps the drift beside it", async () => {
    const clock = new FakeClock(10_000);
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
      processes: [],
    });
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const base = config();
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: base,
      drivers: [driver],
      eventBus,
      registry,
      warmPool: {
        figures: () =>
          figuresOf([{ model: "iPhone 17", osVersion: "27.0", short: "runtime-missing" }]),
        runningCapacity: () => limits({}),
      },
    });

    const report = await doctor.reconcile();

    const reconciled = eventBus.replay().find((event) => event.event === "doctor.reconciled");
    expect(report.findings.map((finding) => finding.kind).sort()).toEqual([
      "orphan-device",
      "warm-pool-target-unreachable",
    ]);
    expect(reconciled?.payload).toMatchObject({ driftFindings: [{ kind: "orphan-device" }] });
    expect(reconciled?.payload).toHaveProperty("driftFindings.length", 1);
  });
});
