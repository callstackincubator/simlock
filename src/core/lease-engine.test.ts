import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import type { CapacityLimits, ResourceStrategyOptions } from "./capacity/index.js";
import {
  BootTimeoutError,
  type Config,
  DriverCrashError,
  FakeDriver,
  LeaseEngine,
  type LeaseProgress,
  NoCapacityError,
  QueueTimeoutError,
  Registry,
  RequestCancelledError,
} from "./index.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";
const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function config(overrides: Partial<Config["lease"]> = {}): Config {
  return {
    mode: "worker",
    exec: { timeoutMs: 600_000 },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    mode: "worker",
    gateway: { disconnectedRetentionMs: 24 * 60 * 60_000 },
    drivers: {},
    downloads: { acceptAndroidLicenses: false, policy: "on-request", timeoutMs: 1_200_000 },
    eventBuffer: { capacity: 100 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { defaultTtlMs: 100, maxTtlMs: 14_400_000, ...overrides },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 1 + 1,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
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
  };
}

/** Narrows the config's capacity block, which the harness always builds as `resource`. */
function resourceOptions(source: Config): ResourceStrategyOptions {
  if (source.capacity.strategy !== "resource") throw new Error("expected the resource strategy");
  return source.capacity.config;
}

async function createHarness(
  options: {
    readonly driver?: FakeDriver;
    readonly drivers?: readonly FakeDriver[];
    readonly lease?: Partial<Config["lease"]>;
    readonly limits?: CapacityLimits;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  const bus = new EventBus(clock);
  const driver =
    options.driver ?? new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  let nextId = 1;
  const registry = await Registry.load({
    clock,
    eventBus: bus,
    filesystem,
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const baseConfig = config(options.lease);
  const engineConfig: Config =
    options.limits === undefined
      ? baseConfig
      : {
          ...baseConfig,
          capacity: {
            strategy: "resource",
            config: { ...resourceOptions(baseConfig), limits: options.limits },
          },
        };
  const engine = new LeaseEngine({
    clock,
    config: engineConfig,
    drivers: options.drivers ?? [driver],
    eventBus: bus,
    idGenerator: { generate: () => `request-${nextId++}` },
    registry,
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
      totalRamBytes: 32 * gibibyte,
    }),
  });

  return { bus, clock, driver, engine, registry };
}

async function seedReady(
  harness: Awaited<ReturnType<typeof createHarness>>,
  spec: import("./index.js").DeviceSpec = request,
) {
  const driverDevice = await harness.driver.provision(spec);
  const device = await harness.registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec,
  });
  return harness.registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
}

async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    await Promise.resolve();
  }
}

describe("LeaseEngine", () => {
  it("hands the caller back before the purge, keeps the device reclaiming, then re-leases it without another boot", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { reclaim: 20 },
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });

    const release = harness.engine.release(first.lease.id, "explicit");
    const second = harness.engine.request(request, {
      ownerId: "second",
      requesterId: "second",
    });
    await flush();

    // The releasing caller (an agent's MCP/CLI release) is already free to move on
    // while the erase still has its full 20ms of driver latency ahead of it.
    await expect(release).resolves.toBeUndefined();
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "reclaiming" }]);
    expect(harness.engine.queueDepth).toBe(1);
    clock.advance(20);
    await harness.engine.settle();
    await expect(second).resolves.toMatchObject({ device: { id: first.device.id } });
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2);
  });

  it("tells a waiter queued behind a reclaim how long that reclaim runs", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { reclaim: 34_000 },
      latencyMs: { reclaim: 20 },
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });

    await harness.engine.release(first.lease.id, "explicit");
    const progress: LeaseProgress[] = [];
    const second = harness.engine.request(request, {
      onProgress: (update) => progress.push(update),
      requesterId: "second",
      ownerId: "second",
    });
    await flush();

    // A queue position on its own says nothing about the wait; the erase the waiter is
    // actually behind is what makes it tens of seconds rather than immediate (#56).
    expect(progress).toEqual([
      { queuePosition: 1, stage: "queued" },
      { etaMs: 34_000, stage: "reclaiming" },
    ]);
    clock.advance(20);
    await harness.engine.settle();
    await expect(second).resolves.toMatchObject({ device: { id: first.device.id } });
  });

  it("does not report a reclaim stage to a waiter queued behind something else", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { reclaim: 34_000 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const progress: LeaseProgress[] = [];
    void harness.engine.request(request, {
      onProgress: (update) => progress.push(update),
      requesterId: "queued",
      ownerId: "queued",
    });
    await flush();

    // The only matching device is leased, not reclaiming: nothing to quote.
    expect(progress).toEqual([{ queuePosition: 1, stage: "queued" }]);
  });

  it("purges then shuts down on release when the system is over its running limit", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });
    const excess = await seedReady(harness);

    await harness.engine.release(first.lease.id, "explicit");
    // Release commits registry-only and hands the purge off; settle() is the test's
    // stand-in for the graceful-shutdown drain that waits on it in production.
    await harness.engine.settle();

    expect(harness.driver.calls.map((call) => call.operation)).toContain("reclaim");
    expect(
      harness.registry.snapshot.devices.find((item) => item.id === first.device.id)?.state,
    ).toBe("shutdown");
    expect(harness.registry.snapshot.devices.find((item) => item.id === excess.id)?.state).toBe(
      "ready",
    );
  });

  it("evicts warm inventory for active new-spec demand, including no-wait", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const warm = await seedReady(harness);
    const different = { ...request, model: "iPhone SE" };

    const grant = await harness.engine.request(different, {
      noWait: true,
      requesterId: "new-spec",
      ownerId: "new-spec",
    });

    expect(grant.device.spec.model).toBe("iPhone SE");
    expect(harness.registry.snapshot.devices.find((item) => item.id === warm.id)?.state).toBe(
      "shutdown",
    );
    expect(harness.bus.replay().find((event) => event.event === "device.shutdown")).toMatchObject({
      payload: { initiator: "warm-pool-active-demand" },
    });
  });

  it("evicts the other platform's LRU warm device when only the global limit blocks demand", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const androidSpec = { model: "Pixel 9", osVersion: "36", platform: "android" } as const;
    const driverDevice = await android.provision(androidSpec);
    const registered = await harness.registry.registerDevice({
      driverData: driverDevice.driverData,
      driverDeviceId: driverDevice.deviceId,
      provisionDuration: 0,
      spec: androidSpec,
    });
    await harness.registry.transitionDevice(registered.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: registered.id },
    });

    await expect(
      harness.engine.request(request, {
        ownerId: "ios-demand",
        requesterId: "ios-demand",
      }),
    ).resolves.toMatchObject({ device: { spec: { platform: "ios" } } });
    expect(harness.registry.snapshot.devices.find((item) => item.id === registered.id)?.state).toBe(
      "shutdown",
    );
    expect(android.calls.map((call) => call.operation)).toContain("shutdown");
  });

  it("does not oversubscribe when eviction fails", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("shutdown", 1, new DriverCrashError("cannot stop victim"));
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    await seedReady(harness);

    await expect(
      harness.engine.request(
        { ...request, model: "iPhone SE" },
        {
          noWait: true,
          requesterId: "new-spec",
          ownerId: "new-spec",
        },
      ),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(harness.engine.runningCapacity.global.running).toBe(1);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
  });

  it("deletes managed LRU inventory at maxDevices before provisioning a new spec", async () => {
    const harness = await createHarness();
    const old = await seedReady(harness);
    await harness.registry.transitionDevice(old.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: old.id, initiator: "test" },
    });

    const grant = await harness.engine.request(
      { ...request, model: "iPhone SE" },
      {
        requesterId: "new-spec",
        ownerId: "new-spec",
      },
    );

    expect(grant.device.spec.model).toBe("iPhone SE");
    expect(harness.registry.snapshot.devices.find((item) => item.id === old.id)?.state).toBe(
      "deleted",
    );
    expect(harness.driver.calls.map((call) => call.operation)).toContain("destroy");
  });

  it("quarantines a release-time purge failure instead of keeping the device eligible", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("reclaim", 1, new DriverCrashError("purge exploded"));
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices[0]?.state).toBe("quarantined");
    expect(
      harness.bus.replay().filter((event) => event.event === "device.purge-failed"),
    ).toMatchObject([
      {
        payload: {
          attemptedStrategy: "wipe",
          deviceId: first.device.id,
          error: "DriverCrashError: purge exploded",
          leaseId: first.lease.id,
        },
      },
    ]);
    expect(
      harness.bus.replay().filter((event) => event.event === "device.quarantined"),
    ).toHaveLength(1);
    expect(harness.bus.replay().filter((event) => event.event === "device.reclaimed")).toEqual([]);
    // ios.maxDevices is 1 in this harness's config, and a quarantined device still
    // counts against it (see capacity.ts), so a second requester cannot provision a
    // fresh device either -- it must wait rather than silently inheriting the dirty
    // one, which is exactly the bug quarantine exists to prevent (#21).
    await expect(
      harness.engine.request(request, {
        noWait: true,
        ownerId: "second",
        requesterId: "second",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("never exposes a device as ready when post-purge readiness fails", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      reclaimResult: "shutdown",
    });
    driver.failOn("makeReady", 2, new Error("not ready"));
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
  });
  it("enforces global and platform limits together across drivers", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: 2, maxRunning: 2 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const holder = await harness.engine.request(request, {
      requesterId: "ios-holder",
      ownerId: "ios-holder",
    });
    const androidRequest = { model: "Pixel 9", osVersion: "36", platform: "android" } as const;

    await expect(
      harness.engine.request(androidRequest, {
        noWait: true,
        requesterId: "android-no-wait",
        ownerId: "android-no-wait",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(android.calls.filter((call) => call.operation === "provision")).toHaveLength(0);
    expect(android.calls.filter((call) => call.operation === "makeReady")).toHaveLength(0);

    await harness.engine.release(holder.lease.id, "explicit");
    await expect(
      harness.engine.request(androidRequest, {
        ownerId: "android",
        requesterId: "android",
      }),
    ).resolves.toMatchObject({ device: { spec: { platform: "android" } } });
  });

  it("converges startup excess through shutdown without touching leases and is idempotent", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 3, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const leasedDevice = await seedReady(harness);
    const unleasedDevice = await seedReady(harness);
    await harness.registry.createLease({
      deviceId: leasedDevice.id,
      requesterId: "active",
      ownerId: "active",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });

    await harness.engine.convergeRunningCapacity();
    await harness.engine.convergeRunningCapacity();

    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: leasedDevice.id, state: "leased" },
      { id: unleasedDevice.id, state: "shutdown" },
    ]);
    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(1);
    expect(harness.engine.runningCapacity.global.overLimit).toBe(false);
  });

  it("retains in-limit warm devices at startup and never boots shutdown inventory", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 2,
      },
    });
    const warm = await seedReady(harness);
    const shutdown = await seedReady(harness);
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    const callsBefore = harness.driver.calls.length;

    await harness.engine.convergeRunningCapacity();

    expect(harness.registry.snapshot.devices.find((item) => item.id === warm.id)?.state).toBe(
      "ready",
    );
    expect(harness.registry.snapshot.devices.find((item) => item.id === shutdown.id)?.state).toBe(
      "shutdown",
    );
    expect(harness.driver.calls).toHaveLength(callsBefore);
  });

  it("shuts an orphaned reclaiming or migrated legacy device down through its driver", async () => {
    const harness = await createHarness();
    const device = await seedReady(harness);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      requesterId: "former",
      ownerId: "former",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });
    await harness.registry.beginRelease(lease.id);

    await harness.engine.convergeRunningCapacity();

    expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
    expect(harness.driver.calls.map((call) => call.operation)).toContain("shutdown");
  });

  it("reports unavoidable leased running overage", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 3, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    for (const requesterId of ["one", "two"]) {
      const device = await seedReady(harness);
      await harness.registry.createLease({
        deviceId: device.id,
        ownerId: requesterId,
        requesterId,
        ttlMs: 60_000,
        ttlDeadline: 2_000,
      });
    }

    await harness.engine.convergeRunningCapacity();

    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(0);
    expect(harness.engine.runningCapacity.global.overLimit).toBe(true);
    await expect(
      harness.engine.request(request, {
        noWait: true,
        ownerId: "three",
        requesterId: "three",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("holds one running reservation across provision and readiness", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      reclaimResult: "shutdown",
    });
    driver.hangMakeReady();
    const harness = await createHarness({ driver });

    const first = harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const second = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
    expect(harness.engine.runningCapacity.global.reserved).toBe(1);
    expect(harness.engine.queueDepth).toBe(1);

    driver.releaseMakeReady();
    const grant = await first;
    await harness.engine.release(grant.lease.id, "explicit");
    await expect(second).resolves.toMatchObject({
      lease: { ownerId: "agent-2", requesterId: "agent-2" },
    });
  });

  it("starts exactly one of two existing shutdown devices at running capacity one", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const harness = await createHarness({ driver });
    for (let index = 0; index < 2; index += 1) {
      const device = await seedReady(harness);
      await harness.registry.transitionDevice(device.id, "shutdown", {
        event: "device.shutdown",
        payload: { deviceId: device.id, initiator: "test" },
      });
    }
    driver.hangMakeReady();

    void harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    void harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
    expect(harness.engine.queueDepth).toBe(1);
    driver.releaseMakeReady();
  });

  it("serializes simultaneous requests so one device of capacity starts exactly one provision", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { provision: 20 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });

    const first = harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const second = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    expect(driver.calls.filter((call) => call.operation === "resolveSpec")).toHaveLength(2);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    clock.advance(20);
    await first;
    await flush();
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);

    await harness.engine.release((await first).lease.id, "explicit");
    await expect(second).resolves.toMatchObject({
      lease: { ownerId: "agent-2", requesterId: "agent-2" },
    });
  });

  it("grants an existing matching ready device and does not match a different spec", async () => {
    const harness = await createHarness();
    const matching = await seedReady(harness);
    await seedReady(harness, { model: "iPhone SE", osVersion: "26.5", platform: "ios" });
    const progress: string[] = [];

    const grant = await harness.engine.request(request, {
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-1",
      ownerId: "agent-1",
    });

    expect(grant.device.id).toBe(matching.id);
    expect(progress).toEqual([]);
    expect(harness.driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
  });

  it("provisions and makes a device ready when capacity is available, returning progress estimates", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, provision: 10, reclaim: 34 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });

    const progress: string[] = [];
    const grant = await harness.engine.request(request, {
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-1",
      ownerId: "agent-1",
    });

    // `estimatedReclaimMs` is the one figure describing work still ahead of the holder --
    // what releasing this device will cost -- rather than work already done to grant it.
    expect(grant).toMatchObject({
      device: { spec: request, state: "leased" },
      timing: {
        estimatedBootMs: 20,
        estimatedProvisionMs: 10,
        estimatedReadyMs: 30,
        estimatedReclaimMs: 34,
      },
    });
    expect(driver.calls.map((call) => call.operation)).toEqual([
      "resolveSpec",
      "provision",
      "makeReady",
    ]);
  });

  it("prices the eventual reclaim even when a warm device is granted with no work at all", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, provision: 10, reclaim: 34 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    await seedReady(harness);

    const grant = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });

    expect(grant.timing).toEqual({
      estimatedBootMs: 0,
      estimatedProvisionMs: 0,
      estimatedReadyMs: 0,
      estimatedReclaimMs: 34,
    });
  });

  it("reports only the selected work as it begins", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, provision: 10, reclaim: 15 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    const provisioned: string[] = [];

    const provisionedGrant = await harness.engine.request(request, {
      onProgress: (progress) => provisioned.push(progress.stage),
      requesterId: "provisioned",
      ownerId: "provisioned",
    });
    expect(provisioned).toEqual(["provisioning", "booting"]);
    await harness.engine.release(provisionedGrant.lease.id, "explicit");
    await harness.engine.settle();

    const shutdown = harness.registry.snapshot.devices[0];
    if (shutdown === undefined) throw new Error("Expected provisioned device");
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    const booted: string[] = [];
    await harness.engine.request(request, {
      onProgress: (progress) => booted.push(progress.stage),
      requesterId: "shutdown",
      ownerId: "shutdown",
    });
    expect(booted).toEqual(["booting"]);
  });

  it("reports queue insertion without speculative work and isolates callback failures", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const harness = await createHarness({ driver });
    const holder = await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const progress: string[] = [];
    const queued = harness.engine.request(request, {
      onProgress: (update) => progress.push(update.stage),
      requesterId: "queued",
      ownerId: "queued",
    });
    await flush();
    expect(progress).toEqual(["queued"]);

    await expect(
      harness.engine.request(request, {
        noWait: true,
        onProgress: () => progress.push("unexpected"),
        requesterId: "no-wait",
        ownerId: "no-wait",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(progress).toEqual(["queued"]);

    await harness.engine.release(holder.lease.id, "explicit");
    await queued;

    const callbackFailure = await createHarness();
    await expect(
      callbackFailure.engine.request(request, {
        onProgress: () => {
          throw new Error("client disconnected");
        },
        requesterId: "throwing-callback",
        ownerId: "throwing-callback",
      }),
    ).resolves.toMatchObject({ device: { state: "leased" } });
    expect(callbackFailure.driver.calls.map((call) => call.operation)).toContain("makeReady");
  });

  it("detaches progress from a queued request without cancelling its lease", async () => {
    const harness = await createHarness();
    const holder = await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const progress: string[] = [];
    const queued = harness.engine.request(request, {
      onProgress: (update) => progress.push(update.stage),
      requesterId: "queued",
      ownerId: "queued",
    });
    await flush();

    await harness.engine.detachQueuedProgress("queued");
    await harness.engine.release(holder.lease.id, "explicit");
    await expect(queued).resolves.toMatchObject({
      lease: { ownerId: "queued", requesterId: "queued" },
    });
    expect(progress).toEqual(["queued"]);
  });

  it("cancels a queued request through the QueueControl facade and frees the requester for a later grant", async () => {
    const harness = await createHarness();
    const holder = await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const queued = harness.engine.request(request, {
      ownerId: "queued",
      requesterId: "queued",
    });
    await flush();

    await expect(harness.engine.cancelPending("nobody")).resolves.toBe("not-found");
    await expect(harness.engine.cancelPending("queued")).resolves.toBe("cancelled");
    await expect(queued).rejects.toBeInstanceOf(RequestCancelledError);

    await harness.engine.release(holder.lease.id, "explicit");
    await expect(
      harness.engine.request(request, { ownerId: "queued", requesterId: "queued" }),
    ).resolves.toMatchObject({ lease: { ownerId: "queued", requesterId: "queued" } });
  });

  it("queues at capacity in FIFO order across three waiters", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const second = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    const third = harness.engine.request(request, {
      ownerId: "agent-3",
      requesterId: "agent-3",
    });
    const fourth = harness.engine.request(request, {
      ownerId: "agent-4",
      requesterId: "agent-4",
    });
    await flush();

    await harness.engine.release(first.lease.id, "explicit");
    const secondGrant = await second;
    await harness.engine.release(secondGrant.lease.id, "explicit");
    const thirdGrant = await third;
    await harness.engine.release(thirdGrant.lease.id, "explicit");
    const fourthGrant = await fourth;

    expect([secondGrant, thirdGrant, fourthGrant].map((grant) => grant.lease.requesterId)).toEqual([
      "agent-2",
      "agent-3",
      "agent-4",
    ]);
  });

  it("wakes exactly the queue head on release and reuses its reclaimed ready device", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const second = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    const third = harness.engine.request(request, {
      ownerId: "agent-3",
      requesterId: "agent-3",
    });
    await flush();

    await harness.engine.release(first.lease.id, "explicit");
    const secondGrant = await second;
    await flush();

    expect(secondGrant.device.id).toBe(first.device.id);
    expect(harness.registry.snapshot.leases).toHaveLength(1);
    expect(harness.registry.snapshot.leases[0]?.requesterId).toBe("agent-2");
    expect(harness.driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    await harness.engine.release(secondGrant.lease.id, "explicit");
    await expect(third).resolves.toMatchObject({
      lease: { ownerId: "agent-3", requesterId: "agent-3" },
    });
  });

  it("boots a reclaimed shutdown device for the queue head instead of deadlocking at capacity", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const queued = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    await harness.engine.release(first.lease.id, "explicit");

    await expect(queued).resolves.toMatchObject({ device: { id: first.device.id } });
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2);
  });

  it("rejects a no-wait request at capacity with a typed error", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });

    await expect(
      harness.engine.request(request, {
        noWait: true,
        ownerId: "agent-2",
        requesterId: "agent-2",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("rejects a timed-out queue entry and skips it on a later release", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const progress: string[] = [];
    const timedOut = harness.engine.request(request, {
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-2",
      ownerId: "agent-2",
      timeoutMs: 10,
    });
    const next = harness.engine.request(request, {
      ownerId: "agent-3",
      requesterId: "agent-3",
    });
    await flush();

    harness.clock.advance(10);
    await expect(timedOut).rejects.toBeInstanceOf(QueueTimeoutError);
    expect(progress).toEqual(["queued"]);
    await harness.engine.release(first.lease.id, "explicit");

    await expect(next).resolves.toMatchObject({
      lease: { ownerId: "agent-3", requesterId: "agent-3" },
    });
  });

  it("expires an un-renewed lease at its deadline and serves the queue with its device", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 10 } });
    await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const queued = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    harness.clock.advance(10);
    await flush();
    await expect(queued).resolves.toMatchObject({
      lease: { ownerId: "agent-2", requesterId: "agent-2" },
    });
  });

  it("keeps a renewed lease past the deadline it was granted with", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 20 } });
    const granted = await harness.engine.request(request, {
      requesterId: "agent-3",
      ownerId: "agent-3",
    });
    const renewed = await harness.engine.renew(granted.lease.id, 30);
    harness.clock.advance(20);
    await flush();

    expect(renewed.ttlDeadline).toBe(1_030);
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });

  it("renews via the engine, re-arming the expiry timer at the new deadline", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 10 } });
    const granted = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });

    harness.clock.advance(6);
    const renewed = await harness.engine.renew(granted.lease.id, 20);
    expect(renewed.ttlDeadline).toBe(1_026);

    // The grant-time deadline (1_010) has now passed, but the renewal re-armed the expiry
    // timer at the new one, so the lease must still be alive.
    harness.clock.advance(4);
    await flush();
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    harness.clock.advance(16);
    await flush();
    expect(harness.registry.snapshot.leases).toHaveLength(0);
  });

  it("grants at the request's own ttlMs, and re-applies that width on a body-less renew", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 10 } });
    const granted = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlMs: 40,
    });
    expect(granted.lease).toMatchObject({ ttlMs: 40, ttlDeadline: 1_040 });

    harness.clock.advance(5);
    // No TTL named: the lease keeps its own 40ms width rather than snapping back to the
    // 10ms `lease.defaultTtlMs` (ADR 0004 §4).
    await expect(harness.engine.renew(granted.lease.id)).resolves.toMatchObject({
      ttlMs: 40,
      ttlDeadline: 1_045,
    });
  });

  it("enforces one active request or lease per requester, then permits another after release", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });

    await expect(
      harness.engine.request(request, { ownerId: "agent-1", requesterId: "agent-1" }),
    ).rejects.toMatchObject({
      existingLeaseId: first.lease.id,
      message: expect.stringContaining(first.lease.id),
      name: "RequesterAlreadyLeasedError",
    });
    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();
    expect(harness.clock.pendingTimerCount).toBe(0);
    await expect(
      harness.engine.request(request, { ownerId: "agent-1", requesterId: "agent-1" }),
    ).resolves.toMatchObject({ lease: { ownerId: "agent-1", requesterId: "agent-1" } });
  });

  it("retries after a provision failure without leaking capacity", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("provision", 1, new DriverCrashError("simulator exited"));
    const harness = await createHarness({ driver });

    const grant = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });

    expect(grant.device.state).toBe("leased");
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    expect(
      harness.registry.snapshot.devices.filter((device) => device.state !== "deleted"),
    ).toHaveLength(1);
  });

  it("destroys a registered device and returns BootTimeoutError when readiness fails", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("makeReady", 1, new Error("boot failed"));
    const harness = await createHarness({ driver });

    await expect(
      harness.engine.request(request, { ownerId: "agent-1", requesterId: "agent-1" }),
    ).rejects.toBeInstanceOf(BootTimeoutError);

    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(driver.calls.map((call) => call.operation)).toContain("destroy");
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it("emits committed happy-path facts in lifecycle order", async () => {
    const harness = await createHarness();

    await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });

    expect(harness.bus.replay().map((event) => event.event)).toEqual([
      "lease.requested",
      "device.provisioned",
      "device.ready",
      "lease.granted",
    ]);
  });
});

// #43: startup convergence used to await each orphaned held lease's device reclaim
// inline (an erase measured ~34s for one simulator), so N orphaned leases cost N
// serial erases before any other request could be served. These cover the shape
// that replaced it: the lease is released registry-only on the convergence path,
// and its reclaim proceeds in the background.
describe("LeaseEngine startup reclaim backgrounding (#43)", () => {
  it("converges without waiting for an in-flight reclaim, and a fresh request is served immediately after", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      // Matches the issue's measured single-simulator-erase cost -- the old inline
      // await would have forced convergence to sit through this.
      latencyMs: { reclaim: 34_000 },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 2,
      },
    });
    // Under ADR 0004 convergence itself releases nothing -- there is no orphan sweep left --
    // so the in-flight reclaim it must not block on is produced the way one actually arises:
    // a release commits the registry half and hands the 34s purge off to the background.
    const released = await harness.engine.request(request, {
      ownerId: "previous-holder",
      requesterId: "previous-holder",
    });
    await harness.engine.release(released.lease.id, "explicit");

    const convergeStartedAt = harness.clock.now();
    await harness.engine.convergeRunningCapacity();
    // The clock never had to move for convergence to finish: it did not sit through
    // the 34s reclaim above.
    expect(harness.clock.now()).toBe(convergeStartedAt);
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === released.device.id)?.state,
    ).toBe("reclaiming");
    expect(harness.registry.snapshot.leases).toEqual([]);

    // A fresh request is servable right away -- capacity allows a second device, and the
    // one still mid-reclaim never blocks it. Still 0ms elapsed.
    const granted = await harness.engine.request(request, {
      requesterId: "new-agent",
      ownerId: "new-agent",
    });
    expect(granted.device.id).not.toBe(released.device.id);
    expect(harness.clock.now()).toBe(convergeStartedAt);
  });

  it("never grants a device whose background reclaim is still in flight", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { reclaim: 34_000 },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const released = await harness.engine.request(request, {
      ownerId: "previous-holder",
      requesterId: "previous-holder",
    });
    await harness.engine.release(released.lease.id, "explicit");

    await harness.engine.convergeRunningCapacity();
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "reclaiming" }]);

    // AcquisitionPlanner only ever grants a `ready` device (or reboots a `shutdown`
    // one); `reclaiming` is neither. With maxDevices:1 there is also no room to
    // provision a second device, so the request is refused rather than handed the
    // one still mid-reclaim.
    await expect(
      harness.engine.request(request, {
        noWait: true,
        ownerId: "new-agent",
        requesterId: "new-agent",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    clock.advance(34_000);
    await flush();
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "ready" }]);

    // Once the reclaim genuinely finishes, the same device becomes grantable again.
    await expect(
      harness.engine.request(request, {
        ownerId: "new-agent",
        requesterId: "new-agent",
      }),
    ).resolves.toMatchObject({ device: { id: released.device.id } });
  });

  it("shuts down already-ready excess capacity during convergence without waiting on an in-flight reclaim, and the reclaim settles inside the same limit", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { reclaim: 34_000 },
      platform: "ios",
      // The reclaim itself leaves the device booted off; whether it comes back
      // `ready` is entirely up to WarmPoolCoordinator#mayRemainWarm's capacity
      // check at settle time -- which is exactly what this test is about.
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 3, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const released = await harness.engine.request(request, {
      ownerId: "previous-holder",
      requesterId: "previous-holder",
    });
    await harness.engine.release(released.lease.id, "explicit");
    const extraReady = await seedReady(harness);

    await harness.engine.convergeRunningCapacity();

    // Decision (open question 1, #43): the running-capacity sweep tolerates an
    // approximate, transient view rather than waiting for in-flight reclaims to
    // settle or re-running afterward. It can afford to: RUNNING_STATES already
    // counts `reclaiming` toward the running total, so the over-limit check itself
    // is not blind to the in-flight reclaim -- only its candidate *selection* is
    // (candidates must be `ready`), and that's fine because the already-ready
    // excess device below is a perfectly valid, sufficient candidate on its own.
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === extraReady.id)?.state,
    ).toBe("shutdown");
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === released.device.id)?.state,
    ).toBe("reclaiming");

    // The background reclaim settles afterward. Its own capacity check
    // (#mayRemainWarm, serialized against the shutdown above) sees the slot the
    // shutdown just freed and reboots the device back into the warm pool -- the
    // transient view above never let the pool overshoot the limit.
    clock.advance(34_000);
    await flush();
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === released.device.id)?.state,
    ).toBe("ready");
    expect(harness.engine.runningCapacity.ios.overLimit).toBe(false);
  });

  it("recovers a background reclaim interrupted by a daemon crash on the next start", async () => {
    const filesystem = new MemoryFilesystem();
    const restartStatePath = "/home/agent/.simlock/restart-state.json";
    let nextId = 1;
    const idGenerator = { generate: () => `${nextId++}` };
    const systemStats = () =>
      new FakeSystemStats({
        cpuCount: 8,
        freeRamBytes: 32 * gibibyte,
        totalRamBytes: 32 * gibibyte,
      });
    // The physical device survives a daemon restart even though the daemon's
    // in-memory state does not -- represented here by one FakeDriver instance
    // shared across both simulated processes below.
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      latencyMs: { reclaim: 34_000 },
      platform: "ios",
    });

    const clock1 = new FakeClock(1_000);
    const bus1 = new EventBus(clock1);
    const registry1 = await Registry.load({
      clock: clock1,
      eventBus: bus1,
      filesystem,
      idGenerator,
      statePath: restartStatePath,
    });
    const engine1 = new LeaseEngine({
      clock: clock1,
      config: config(),
      drivers: [driver],
      eventBus: bus1,
      idGenerator,
      registry: registry1,
      systemStats: systemStats(),
    });
    const granted = await engine1.request(request, {
      ownerId: "previous-holder",
      requesterId: "previous-holder",
    });
    // The holder released, so the purge behind it is running in the background...
    await engine1.release(granted.lease.id, "explicit");

    // ...convergence leaves it alone (it is claimed by this process)...
    await engine1.convergeRunningCapacity();
    expect(registry1.snapshot.devices).toMatchObject([
      { id: granted.device.id, state: "reclaiming" },
    ]);
    // ...and the process is abandoned before the driver's 34s reclaim resolves --
    // exactly like a crashed daemon. Nothing here ever settles that promise.

    // Next start: a fresh process reads the same persisted registry (state.json
    // survives the crash) and reconnects to the same physical driver, but its
    // in-memory claim tracking starts empty -- there is no live claim for this
    // device, because the process that held it is gone.
    const clock2 = new FakeClock(clock1.now());
    const bus2 = new EventBus(clock2);
    const registry2 = await Registry.load({
      clock: clock2,
      eventBus: bus2,
      filesystem,
      idGenerator,
      statePath: restartStatePath,
    });
    const engine2 = new LeaseEngine({
      clock: clock2,
      config: config(),
      drivers: [driver],
      eventBus: bus2,
      idGenerator,
      registry: registry2,
      systemStats: systemStats(),
    });

    await engine2.convergeRunningCapacity();

    // Recovered through the interrupted-reclaim path (a plain shutdown), not a
    // second full reclaim.
    expect(registry2.snapshot.devices).toMatchObject([
      { id: granted.device.id, state: "shutdown" },
    ]);
    expect(driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(1);
  });

  it("leaves no armed timer behind for a lease it is disposed with", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 900_000 } });
    await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    expect(harness.clock.pendingTimerCount).toBeGreaterThan(0);

    harness.engine.dispose();

    // A real `setTimeout` holds the event loop open, so a timer surviving disposal is a
    // daemon that has decided to stop and cannot: `daemon stop` used to hang for the whole
    // of an outstanding lease's TTL. Under ADR 0004 that is every lease, since a stop
    // releases none of them.
    expect(harness.clock.pendingTimerCount).toBe(0);
    // The lease itself is untouched -- disposal cancels a timer, it does not expire a
    // lease, which is what lets a lease survive the restart with its deadline intact.
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });
});
