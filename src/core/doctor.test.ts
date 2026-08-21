import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { FakeSystemStats } from "../ports/index.js";
import type { Config } from "./config.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { Doctor } from "./doctor.js";
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
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 9_000,
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "pitlane-orphan-address",
          deviceId: "pitlane-orphan",
          driverData: { fakeDeviceId: "pitlane-orphan" },
          runState: "running",
        },
      ],
      processes: [
        {
          address: "pitlane-process-address",
          deviceId: "pitlane-process",
          driverData: { fakeDeviceId: "pitlane-process" },
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
          address: "pitlane-stale-address",
          deviceId: "pitlane-stale",
          driverData: { fakeDeviceId: "pitlane-stale" },
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
          address: "pitlane-drift-address",
          deviceId: "pitlane-drift",
          driverData: { fakeDeviceId: "pitlane-drift" },
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
        devices: [
          {
            address: "pitlane-marked-address",
            deviceId: "pitlane-marked",
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
          address: "pitlane-reclaiming-address",
          deviceId: "pitlane-reclaiming",
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
          address: "pitlane-orphan-address",
          deviceId: "pitlane-orphan",
          driverData: { fakeDeviceId: "pitlane-orphan" },
          runState: "running",
        },
      ],
      processes: [
        {
          address: "pitlane-process-address",
          deviceId: "pitlane-process",
          driverData: { fakeDeviceId: "pitlane-process" },
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
      mode: "held",
      requesterId: "agent",
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
      devices: [
        {
          address: "pitlane-ios-1-address",
          deviceId: "pitlane-ios-1",
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
          address: "pitlane_android-1-address",
          deviceId: "pitlane_android-1",
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
      devices: [
        {
          address: "pitlane-ios-2-address",
          deviceId: "pitlane-ios-2",
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
          address: "pitlane_android-2-address",
          deviceId: "pitlane_android-2",
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
    await readyDevice(registry, "pitlane-transition", "ios");

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "pitlane-transition-address",
          deviceId: "pitlane-transition",
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
        {
          address: "pitlane-provisioning-address",
          deviceId: "pitlane-provisioning",
          driverData: {},
          runState: "stopped",
        },
        {
          address: "pitlane-reclaiming-address",
          deviceId: "pitlane-reclaiming",
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
        driverDeviceId: "pitlane-stuck",
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
        driverDeviceId: "pitlane-claimed",
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
        driverDeviceId: "pitlane-slow",
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
      const device = await readyDevice(registry, "pitlane-killed", "ios");
      const lease = await registry.createLease({
        deviceId: device.id,
        mode: "held",
        requesterId: "agent",
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
        driverDeviceId: "pitlane-stuck",
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
        driverDeviceId: "pitlane-stuck",
        provisionDuration: 0,
        spec: { model: "Phone", osVersion: "1", platform: "ios" },
      });
      // Reality still shows the device (never actually booted) so the fix pass isn't
      // also chasing an unrelated registry-device-missing finding on the same device.
      driver.setManagedReality({
        devices: [
          {
            address: "pitlane-stuck-address",
            deviceId: "pitlane-stuck",
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
              driverDeviceId: "pitlane-stuck",
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
              mode: "held",
              requesterId: "agent",
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
    const bootedOutside = await shutdownDevice(registry, "pitlane-booted", "ios");
    const shutdownOutside = await readyDevice(registry, "pitlane-shutdown", "ios");

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "pitlane-booted-address",
          deviceId: "pitlane-booted",
          driverData: {},
          runState: "running",
        },
        {
          address: "pitlane-shutdown-address",
          deviceId: "pitlane-shutdown",
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
    const device = await readyDevice(registry, "pitlane-leased", "ios");
    await registry.createLease({
      deviceId: device.id,
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 999_999,
    });

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "pitlane-leased-address",
          deviceId: "pitlane-leased",
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
    const bootedOutside = await shutdownDevice(registry, "pitlane-booted", "ios");
    const shutdownOutside = await readyDevice(registry, "pitlane-shutdown", "ios");

    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "pitlane-booted-address",
          deviceId: "pitlane-booted",
          driverData: {},
          runState: "running",
        },
        {
          address: "pitlane-shutdown-address",
          deviceId: "pitlane-shutdown",
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

function config(stalledTransitionOverrides: Partial<Config["stalledTransition"]> = {}): Config {
  return {
    diskPressure: { freeBytesThreshold: 1 },
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
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000, heartbeatIntervalMs: 15_000 },
    limits: {
      android: { maxDevices: 1, maxRunning: 1 },
      ios: { maxDevices: 1, maxRunning: 1 },
      maxRunning: 1 + 1,
    },
    ramBudget: { androidBytesPerDevice: 1, iosBytesPerDevice: 1 },
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
  };
}
