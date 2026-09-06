import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { FakeSystemStats } from "../ports/index.js";
import type { Config } from "./config.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { Doctor } from "./doctor.js";
import type { DriverRejection } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { FakeDriver } from "./fake-driver.js";
import { LeaseEngine } from "./lease-engine.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

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
    const filesystem = new MemoryFilesystem();
    await filesystem.writeFileAtomic(
      "/state.json",
      JSON.stringify({
        devices: [
          {
            createdAt: 1,
            driverData: { fakeDeviceId: "simlock-stale" },
            driverDeviceId: "simlock-stale",
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
          address: "simlock-stale-address",
          deviceId: "simlock-stale",
          driverData: { fakeDeviceId: "simlock-stale" },
          runState: "stopped",
        },
      ],
      processes: [],
    });

    const report = await new Doctor({
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
      driverData: { fakeDeviceId: "simlock-drift" },
      driverDeviceId: "simlock-drift",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
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
    const doctor = new Doctor({ clock, config: config(), drivers: [driver], eventBus, registry });

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
        driverDeviceId: "simlock-marked",
        provisionDuration: 0,
        spec: { model: "Phone", osVersion: "1", platform: "ios" },
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
      // Report-only: --fix must never touch a device over a mark finding.
      expect(registry.snapshot.devices[0]?.state).toBe("ready");
    }
  });

  it("ignores provenance marks while Simlock is itself erasing the device", async () => {
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
      driverDeviceId: "simlock-reclaiming",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
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
    const doctor = new Doctor({ clock, config: config(), drivers: [driver], eventBus, registry });

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
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
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
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
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
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
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
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
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
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    await registry.registerDevice({
      driverData: {},
      driverDeviceId: "simlock-provisioning",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
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
    it("reports a stalled-transition finding for a provisioning device past its driver-derived threshold", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: {},
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { model: "Phone", osVersion: "1", platform: "ios" },
      });
      // threshold = (provision 1_000 + boot 2_000) * thresholdMultiplier 3 = 9_000
      clock.advance(9_001);

      const report = await new Doctor({
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings).toContainEqual({
        ageMs: 9_001,
        deviceId: device.id,
        enteredAt: 10_000,
        kind: "stalled-transition",
        platform: "ios",
        state: "provisioning",
        thresholdMs: 9_000,
      });
    });

    it("does not report a stall for a device this daemon holds an operation claim on", async () => {
      // A backgrounded orphaned-lease reclaim (#43) keeps its device in `reclaiming`
      // for a full erase -- ~34s measured, against a threshold that floors at 60s for
      // both real drivers, with several erases running at once contending for the same
      // disk. The claim, not the clock, is what says work is in progress; without this
      // exclusion a healthy reclaim is reported as a stall and `--fix` quarantines it.
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: {},
        driverDeviceId: "simlock-claimed",
        provisionDuration: 0,
        spec: { model: "Phone", osVersion: "1", platform: "ios" },
      });
      const claims = new DeviceOperationClaims();
      const claim = claims.tryClaim(device.id, "reclaim");
      clock.advance(9_001);

      const claimed = await new Doctor({
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

    it("does not report a stalled-transition finding for a device still legitimately in-flight", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      // A cold Android-shaped provision-plus-boot estimate can legitimately run well
      // past its raw estimate -- this stays under the multiplied threshold (9_000),
      // not the raw 3_000, and must not be flagged.
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      await registry.registerDevice({
        driverData: {},
        driverDeviceId: "simlock-slow",
        provisionDuration: 0,
        spec: { model: "Phone", osVersion: "1", platform: "ios" },
      });
      clock.advance(8_000);

      const report = await new Doctor({
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings.filter((finding) => finding.kind === "stalled-transition")).toEqual(
        [],
      );
    });

    it("reports a stalled-transition finding for a reclaiming device whose emulator was killed out from under the daemon", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
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
      // The emulator process is gone entirely -- not `stopped`, not `transitioning`,
      // absent from reality altogether -- exactly what `kill -9` on the process leaves
      // behind. The stall check never consults driver reality either way (see
      // `stalledTransitionFinding`): the registry's own clock is what bounds it.
      driver.setManagedReality({ devices: [], processes: [] });
      // threshold = reclaim 2_000 * thresholdMultiplier 3 = 6_000
      clock.advance(6_001);

      const report = await new Doctor({
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
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
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
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      });

      // Past the `standard` threshold (2_000 * 3) but inside the `full` one (20_000 * 3).
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

    it("emits device.stalled-transition-detected for a stalled device", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: {},
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { model: "Phone", osVersion: "1", platform: "ios" },
      });
      clock.advance(9_001);

      await new Doctor({
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(eventBus.replay()).toContainEqual(
        expect.objectContaining({
          event: "device.stalled-transition-detected",
          payload: expect.objectContaining({ deviceId: device.id, state: "provisioning" }),
        }),
      );
    });

    it("--fix quarantines a stalled provisioning device through QuarantineCoordinator", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: {},
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { model: "Phone", osVersion: "1", platform: "ios" },
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
      const filesystem = new MemoryFilesystem();
      await filesystem.writeFileAtomic(
        "/state.json",
        JSON.stringify({
          devices: [
            {
              createdAt: 1,
              driverData: {},
              driverDeviceId: "simlock-stuck",
              id: "dev_1",
              lastLeaseEndedAt: 1,
              spec: { model: "Phone", osVersion: "1", platform: "ios" },
              state: "reclaiming",
            },
          ],
          leases: [
            {
              deviceId: "dev_1",
              grantedAt: 1,
              id: "lse_1",
              requesterId: "agent",
              ownerId: "agent",
              ttlDeadline: 999_999,
            },
          ],
        }),
      );
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem,
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const driver = new FakeDriver({ clock, estimateMs: { reclaim: 2_000 }, platform: "ios" });
      const quarantine = { enterFromStalledTransition: vi.fn() };

      const report = await new Doctor({
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        quarantine,
        registry,
      }).reconcile({ fix: true });

      expect(report.findings).toContainEqual(
        expect.objectContaining({ deviceId: "dev_1", kind: "stalled-transition" }),
      );
      expect(quarantine.enterFromStalledTransition).not.toHaveBeenCalled();
      expect(registry.snapshot.devices[0]?.state).toBe("reclaiming");
    });
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

    await new Doctor({ clock, config: config(), drivers: [driver], eventBus, registry }).reconcile({
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
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
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

    await new Doctor({ clock, config: config(), drivers: [driver], eventBus, registry }).reconcile({
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

  it("reports a platform whose driver refused to start, with the reason it refused", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });

    const report = await new Doctor({
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
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });

    const report = await new Doctor({
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
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const driver = withAdvisories(new FakeDriver({ clock, platform: "ios" }), [
        { code: "slim-runtime-unsupported", message: "iOS 17.0 predates the 18.5 floor" },
      ]);

      const report = await new Doctor({
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
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const driver = new FakeDriver({ clock, platform: "ios" });

      const report = await new Doctor({
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
      const driver = Object.assign(new FakeDriver({ clock, platform: "ios" }), {
        advisories: () => Promise.reject(new Error("advisories boom")),
      });

      const report = await new Doctor({
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings.filter((finding) => finding.kind === "driver-advisory")).toEqual([]);
      // The rest of reconcile still ran: the missing device is still reported.
      expect(report.findings.map((finding) => finding.kind)).toContain("registry-device-missing");
    });

    it("--fix never acts on a driver-advisory finding", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const driver = withAdvisories(new FakeDriver({ clock, platform: "ios" }), [
        { code: "slim-runtime-unsupported", message: "detail" },
      ]);

      const report = await new Doctor({
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
      // Nothing in `--fix` touched the driver beyond the reconcile-time reads: no
      // provision/makeReady/reclaim/shutdown/destroy call was made for the advisory.
      expect(driver.calls.map((call) => call.operation)).toEqual(["listManaged"]);
    });

    it("excludes driver-advisory findings from the doctor.reconciled event's driftFindings", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await Registry.load({
        clock,
        eventBus,
        filesystem: new MemoryFilesystem(),
        idGenerator: sequence(),
        statePath: "/state.json",
      });
      const driver = withAdvisories(new FakeDriver({ clock, platform: "ios" }), [
        { code: "slim-runtime-unsupported", message: "detail" },
      ]);

      await new Doctor({
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
});

describe("Doctor with a platform it cannot observe", () => {
  it("never reports a registry device missing because no driver could look for it", async () => {
    const { eventBus, registry } = await readyIosDevice();

    const report = await new Doctor({
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
    const doctor = new Doctor({ clock, config: config(), drivers: [driver], eventBus, registry });

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

    await new Doctor({ clock, config: config(), drivers: [driver], eventBus, registry }).reconcile({
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

    await new Doctor({ clock, config: config(), drivers: [driver], eventBus, registry }).reconcile({
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

    await new Doctor({ clock, config: config(), drivers: [driver], eventBus, registry }).reconcile({
      fix: true,
    });

    expect(driver.calls.filter((call) => call.operation === "destroyLegacy")).toEqual([]);
    expect(registry.snapshot.devices[0]?.state).toBe("leased");
  });

  it("reports a missing device as missing when the legacy lookup itself fails", async () => {
    const { clock, driver, eventBus, registry } = await legacyDeviceSetup();
    driver.failOn("findLegacy", 1, new Error("simctl list failed"));

    const report = await new Doctor({
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

/** A registry device the root no longer holds, which the driver still finds outside it. */
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
  return Registry.load({
    clock,
    eventBus,
    filesystem: new MemoryFilesystem(),
    idGenerator: sequence(),
    statePath: "/state.json",
  });
}

function driverDevice(deviceId: string) {
  return { address: `${deviceId}-address`, deviceId, driverData: { fakeDeviceId: deviceId } };
}

function observed(deviceId: string, runState: "running" | "stopped") {
  return { ...driverDevice(deviceId), runState };
}

/** One `ready` iOS device in an otherwise empty registry. */
async function readyIosDevice() {
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
    driverData: { fakeDeviceId: "device-1" },
    driverDeviceId: "device-1",
    provisionDuration: 0,
    spec: { model: "Phone", osVersion: "1", platform: "ios" },
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

/** Attaches a fixed `advisories()` result to a `FakeDriver` instance -- `FakeDriver` itself
 * never implements the optional method, so tests that need a driver reporting advisories add it
 * ad hoc rather than growing the fake's own surface for a single test file's needs. */
function withAdvisories(
  driver: FakeDriver,
  advisories: readonly { readonly code: string; readonly message: string }[],
): FakeDriver {
  return Object.assign(driver, { advisories: () => Promise.resolve(advisories) });
}

function config(stalledTransitionOverrides: Partial<Config["stalledTransition"]> = {}): Config {
  return {
    exec: { timeoutMs: 600_000 },
    diskPressure: { freeBytesThreshold: 1 },
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
    lease: { defaultTtlMs: 60_000, maxTtlMs: 3_600_000 },
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
    warmPool: {
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
    ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
  };
}
