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
      devices: [{ deviceId: "pitlane-orphan", driverData: { fakeDeviceId: "pitlane-orphan" } }],
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

  it("fixes only attributable drift and is idempotent", async () => {
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
      devices: [{ deviceId: "pitlane-orphan", driverData: { fakeDeviceId: "pitlane-orphan" } }],
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
    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(1);

    await expect(doctor.reconcile({ fix: true })).resolves.toEqual({ findings: [] });
    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(1);
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
      devices: [{ deviceId: "live", driverData: { fakeDeviceId: "live" } }],
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

    await new Doctor({ clock, drivers: [driver], eventBus, leaseEngine, registry }).reconcile({
      fix: true,
    });

    expect(registry.snapshot.leases).toEqual([]);
    expect(eventBus.replay()).toContainEqual(expect.objectContaining({ event: "lease.expired" }));
  });
});

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function config(): Config {
  return {
    diskPressure: { freeBytesThreshold: 1 },
    eventBuffer: { capacity: 10 },
    idle: { deleteAfterMs: 10, shutdownAfterMs: 5 },
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000 },
    limits: {
      android: { maxDevices: 1, maxRunning: 1 },
      ios: { maxDevices: 1, maxRunning: 1 },
      maxRunning: 1 + 1,
    },
    ramBudget: { androidBytesPerDevice: 1, iosBytesPerDevice: 1 },
    warmPool: {},
  };
}
