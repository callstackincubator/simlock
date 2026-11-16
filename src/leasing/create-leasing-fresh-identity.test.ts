import { describe, expect, it } from "vitest";
import { DriverCrashError, type Registry } from "../core/index.js";
import { testStateOf } from "../core/testing.js";
import {
  FakeDriver,
  loadTestRegistry,
  openTestState,
  testComponentWiring,
} from "../core/testing.js";
import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats } from "../ports/index.js";
import { createTestEngine } from "./testing.js";
import { gibibyte, request, config, createHarness, flush } from "./test-create-leasing.js";

describe("createLeasing fresh lease identity (#75)", () => {
  const freshIos = { android: "reusable", ios: "fresh" } as const;

  function driverDeviceIdOf(
    harness: { readonly registry: Registry },
    deviceId: string,
  ): string | undefined {
    return harness.registry.snapshot.devices.find((device) => device.id === deviceId)
      ?.driverDeviceId;
  }

  function destroyedDriverDeviceIds(driver: FakeDriver): string[] {
    return driver.calls
      .filter((call) => call.operation === "destroy")
      .map((call) => (call.arguments[0] as { readonly deviceId: string }).deviceId);
  }

  it("gives two sequential fresh leases for one shape different driver device ids", async () => {
    const harness = await createHarness({ identity: freshIos });

    const first = await harness.engine.request(request, { ownerId: "first", requesterId: "first" });
    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();
    const second = await harness.engine.request(request, {
      ownerId: "second",
      requesterId: "second",
    });

    expect(second.device.id).not.toBe(first.device.id);
    expect(driverDeviceIdOf(harness, second.device.id)).not.toBe(
      driverDeviceIdOf(harness, first.device.id),
    );
    expect(harness.driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
  });

  it("takes a released fresh device to deleted and destroys its driver device, without an erase", async () => {
    const harness = await createHarness({ identity: freshIos });
    const granted = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    const driverDeviceId = driverDeviceIdOf(harness, granted.device.id);

    await harness.engine.release(granted.lease.id, "explicit");
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: granted.device.id, state: "deleted" },
    ]);
    expect(destroyedDriverDeviceIds(harness.driver)).toEqual([driverDeviceId]);
    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("reclaim");
    expect(harness.bus.replay().filter((event) => event.event === "device.deleted")).toMatchObject([
      { payload: { deviceId: granted.device.id, initiator: "lease-end" } },
    ]);
    expect(harness.bus.replay().map((event) => event.event)).not.toContain("device.reclaimed");
  });

  it("deletes the device of an expired fresh lease", async () => {
    const harness = await createHarness({ identity: freshIos, lease: { defaultTtlMs: 10 } });
    const granted = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });

    harness.clock.advance(10);
    await flush();
    await harness.engine.settle();

    expect(harness.bus.replay().map((event) => event.event)).toContain("lease.expired");
    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: granted.device.id, state: "deleted" },
    ]);
    expect(destroyedDriverDeviceIds(harness.driver)).toHaveLength(1);
  });

  it("the health monitor clears a device's recovery mark only once the decision section is free", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 14_400_000 } });
    const granted = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    await harness.registry.markRecoveryAttempt(granted.device.id, harness.clock.now());
    let open!: () => void;
    const held = harness.decisions.run(
      () =>
        new Promise<void>((resolve) => {
          open = resolve;
        }),
    );

    harness.engine.healthMonitor.start();
    harness.clock.advance(30_000);
    await flush();
    expect(harness.registry.snapshot.devices[0]?.recoveringSince).toBeDefined();
    open();
    await held;
    await flush();
    harness.engine.healthMonitor.dispose();

    expect(harness.registry.snapshot.devices[0]?.recoveringSince).toBeUndefined();
  });

  it("deletes the device of a recovery-driven lease termination", async () => {
    const harness = await createHarness({
      identity: freshIos,
      lease: { defaultTtlMs: 14_400_000 },
    });
    const granted = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    harness.driver.setManagedReality({ devices: [], processes: [] });

    harness.engine.healthMonitor.start();
    for (let tick = 0; tick < 3; tick += 1) {
      harness.clock.advance(30_000);
      await flush();
    }
    await harness.engine.settle();
    harness.engine.healthMonitor.dispose();

    expect(harness.bus.replay().filter((event) => event.event === "lease.released")).toMatchObject([
      { payload: { leaseId: granted.lease.id, reason: "device-lost" } },
    ]);
    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: granted.device.id, state: "deleted" },
    ]);
  });

  it("quarantines a fresh device whose delete fails, keeps it ungrantable, and reports strategy delete", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    driver.failOn("destroy", 1, new DriverCrashError("delete exploded"));
    const harness = await createHarness({
      driver,
      identity: freshIos,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 3,
      },
    });
    const first = await harness.engine.request(request, { ownerId: "first", requesterId: "first" });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: first.device.id, state: "quarantined" },
    ]);
    expect(
      harness.bus.replay().filter((event) => event.event === "device.purge-failed"),
    ).toMatchObject([
      {
        payload: {
          attemptedStrategy: "delete",
          deviceId: first.device.id,
          error: "DriverCrashError: delete exploded",
          leaseId: first.lease.id,
        },
      },
    ]);
    const second = await harness.engine.request(request, {
      noWait: true,
      ownerId: "second",
      requesterId: "second",
    });
    expect(second.device.id).not.toBe(first.device.id);
  });

  it("still deletes a device created under fresh after the configuration changes to reusable", async () => {
    const state = await openTestState();
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    let nextId = 1;
    const idGenerator = { generate: () => `${nextId++}` };
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const systemStats = new FakeSystemStats({
      cpuCount: 8,
      totalRamBytes: 32 * gibibyte,
    });
    const beforeRegistry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator,
      leaseIdentity: freshIos,
      state,
    });
    const before = createTestEngine({
      clock,
      ...testComponentWiring({ clock, drivers: [driver], eventBus: bus, registry: beforeRegistry }),
      config: config({ identity: freshIos }),
      drivers: [driver],
      eventBus: bus,
      idGenerator,
      registry: beforeRegistry,
      state: testStateOf(beforeRegistry),
      systemStats,
    });
    const granted = await before.request(request, { ownerId: "a", requesterId: "a" });
    before.dispose();

    const reusable = { android: "reusable", ios: "reusable" } as const;
    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator,
      leaseIdentity: reusable,
      state,
    });
    const after = createTestEngine({
      ...testComponentWiring({
        clock: clock,
        drivers: [driver],
        eventBus: bus,
        registry: registry,
      }),
      clock,
      config: config({ identity: reusable, defaultTtlMs: 14_400_000 }),
      drivers: [driver],
      eventBus: bus,
      idGenerator,
      registry,
      state: testStateOf(registry),
      systemStats,
    });
    await after.convergeRunningCapacity();
    await after.release(granted.lease.id, "explicit");
    await after.settle();
    after.dispose();

    expect(registry.snapshot.devices).toMatchObject([
      { id: granted.device.id, leaseIdentity: "fresh", state: "deleted" },
    ]);
    expect(driver.calls.map((call) => call.operation)).not.toContain("reclaim");
  });

  it("destroys a device created under reusable too, and grants the next requester a new device", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, { ownerId: "first", requesterId: "first" });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();
    const second = await harness.engine.request(request, {
      ownerId: "second",
      requesterId: "second",
    });

    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: first.device.id, leaseIdentity: "reusable", state: "deleted" },
      { id: second.device.id, leaseIdentity: "reusable", state: "leased" },
    ]);
    expect(second.device.id).not.toBe(first.device.id);
    const operations = harness.driver.calls.map((call) => call.operation);
    expect(operations).not.toContain("reclaim");
    expect(operations.filter((operation) => operation === "destroy")).toHaveLength(1);
  });

  async function restartAfterCrash(crashedIn: "reclaiming" | "shutdown") {
    const state = await openTestState();
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    let nextId = 1;
    const idGenerator = { generate: () => `${nextId++}` };
    // why: One driver across both processes: the simulator outlives the daemon.
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const crashed = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator,
      leaseIdentity: freshIos,
      state,
    });
    const driverDevice = await driver.makeReady(
      await driver.provision({ ...request, physical: false }),
      {
        mode: "full",
        purpose: "prepare",
      },
    );
    const device = await crashed.registerDevice({
      driverData: driverDevice.driverData,
      driverDeviceId: driverDevice.deviceId,
      provisionDuration: 0,
      spec: { ...request, physical: false },
    });
    await crashed.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await crashed.createLease({
      deviceId: device.id,
      ownerId: "gone",
      requesterId: "gone",
      ttlDeadline: 60_000,
      ttlMs: 60_000,
    });
    await crashed.beginRelease(lease.id);
    if (crashedIn === "shutdown") {
      await driver.shutdown(driverDevice);
      await crashed.completeReclaimWithoutPurge(device.id);
    }

    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator,
      leaseIdentity: freshIos,
      state,
    });
    const engine = createTestEngine({
      ...testComponentWiring({
        clock: clock,
        drivers: [driver],
        eventBus: bus,
        registry: registry,
      }),
      clock,
      config: config({ identity: freshIos }),
      drivers: [driver],
      eventBus: bus,
      idGenerator,
      registry,
      state: testStateOf(registry),
      systemStats: new FakeSystemStats({
        cpuCount: 8,
        totalRamBytes: 32 * gibibyte,
      }),
    });
    const operationsBeforeStart = driver.calls.length;
    return {
      device,
      driver,
      engine,
      operationsSinceStart: () =>
        driver.calls.slice(operationsBeforeStart).map((call) => call.operation),
      registry,
    };
  }

  it.each([
    {
      crashedIn: "reclaiming" as const,
      operations: ["listManaged", "shutdown", "destroy", "listSources"],
      title: "while it was reclaiming",
    },
    {
      crashedIn: "shutdown" as const,
      operations: ["listManaged", "destroy", "listSources"],
      title: "after its shutdown commit and before its delete",
    },
  ])(
    "deletes a fresh device on the next start when the daemon crashed $title",
    async ({ crashedIn, operations }) => {
      const restarted = await restartAfterCrash(crashedIn);
      expect(restarted.registry.snapshot.devices).toMatchObject([{ state: crashedIn }]);

      await restarted.engine.convergeRunningCapacity();

      expect(restarted.registry.snapshot.devices).toMatchObject([
        { id: restarted.device.id, state: "deleted" },
      ]);
      expect(restarted.operationsSinceStart()).toEqual(operations);
    },
  );
});
