import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { Doctor } from "./doctor.js";
import { DriverCatalog } from "./driver-catalog.js";
import { FakeDriver } from "./fake-driver.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { type Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import { loadTestRegistry } from "./testing.js";
import { config, readyDevice, sequence } from "./test-doctor.js";

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

// why: pure logic with many cases: Doctor's drift, stall and finding classification, built
// directly over a fake driver and a test registry rather than a whole daemon.
describe("Doctor", () => {
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
    // why: A lease-path boot from `shutdown` runs `makeReady` while the committed record still
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
    const driver = new FakeDriver({ clock, platform: "ios" });
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
    const original = driver.destroy.bind(driver);
    vi.spyOn(driver, "destroy").mockImplementation(async (target) => {
      await gate;
      return original(target);
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

    // why: Post-commit: the registry mutations that resolved the drift are already committed
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
