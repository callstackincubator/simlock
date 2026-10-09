import { describe, expect, it, vi } from "vitest";
import {
  buildCapacityFigures,
  type ModelPreferences,
  BootTimeoutError,
  type ComponentInstaller,
  type Config,
  DriverCrashError,
  type DeviceSpec,
  type LeaseProgress,
  Registry,
  UnknownLeaseError,
} from "../core/index.js";
import { type CapacityLimits, type ResourceStrategyOptions } from "../core/testing.js";
import { capacityChangedPayload, testComponentWiring, FakeDriver } from "../core/testing.js";

import { EventBus, type EventMap } from "../bus/index.js";
import {
  FakeClock,
  FakeSystemStats,
  JsonLinesLogger,
  type Logger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { createLeasing } from "./create-leasing.js";
import { NoCapacityError } from "./lease-acquisition-coordinator.js";
import { LeaseHealthMonitor } from "./lease-health-monitor.js";
import { createTestEngine } from "./testing.js";
import { QueueTimeoutError, RequestCancelledError } from "./wait-queue.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";
const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function config(
  overrides: Partial<Config["lease"]> = {},
  warmPoolEnabled = true,
  idleShutdownAfterMs = 10_000,
  warmPool: Partial<Config["warmPool"]> = {},
): Config {
  return {
    mode: "worker",
    exec: { timeoutMs: 600_000 },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    gateway: {
      disconnectedRetentionMs: 24 * 60 * 60_000,
      execTimeoutMs: 11 * 60_000,
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: "warm-then-free" as const,
    },
    drivers: {},
    downloads: { acceptAndroidLicenses: false, policy: "on-request", timeoutMs: 1_200_000 },
    eventBuffer: { capacity: 100 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { defaultMode: "full", defaultModels: {}, slim: { bootTimeoutMs: 600_000 } },
    android: {
      defaultModels: {},
      emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
    },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: idleShutdownAfterMs },
    lease: {
      defaultTtlMs: 100,
      maxTtlMs: 14_400_000,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
      ...overrides,
    },
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
    eventLog: {
      rotateBytes: 5 * 1024 * 1024,
      retention: 7 * 24 * 60 * 60 * 1000,
      maxBytes: 256 * 1024 * 1024,
    },
    warmPool: {
      enabled: warmPoolEnabled,
      maxConcurrentBoots: 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
      ...warmPool,
    },
  };
}

/** Narrows the config's capacity block, which the harness always builds as `resource`. */
function resourceOptions(source: Config): ResourceStrategyOptions {
  if (source.capacity.strategy !== "resource") throw new Error("expected the resource strategy");
  return source.capacity.config;
}

/** The harness's resource options with whichever of `limits` and `ramBudget` a test replaces. */
function withCapacity(
  base: ResourceStrategyOptions,
  overrides: Partial<ResourceStrategyOptions>,
): ResourceStrategyOptions {
  return {
    limits: overrides.limits ?? base.limits,
    ramBudget: overrides.ramBudget ?? base.ramBudget,
  };
}

/** The harness's capacity block: the one a test names, or the resource strategy with overrides. */
function capacityConfig(
  base: Config,
  options: Partial<ResourceStrategyOptions> & { readonly capacity?: Config["capacity"] },
): Config["capacity"] {
  return (
    options.capacity ?? {
      strategy: "resource",
      config: withCapacity(resourceOptions(base), options),
    }
  );
}

// fallow-ignore-next-line complexity -- one test harness builder; each option is a plain pass-through to a collaborator.
async function createHarness(
  options: {
    /** Stands in for the installer, when a test needs to see whether it was reached at all. */
    readonly components?: Pick<ComponentInstaller, "claimProvision" | "install">;
    readonly driver?: FakeDriver;
    readonly drivers?: readonly FakeDriver[];
    /** The state directory of an earlier harness: loading it again is a daemon restart. */
    readonly filesystem?: MemoryFilesystem;
    readonly identity?: Config["lease"]["identity"];
    readonly lease?: Partial<Config["lease"]>;
    readonly capacity?: Config["capacity"];
    readonly defaultModes?: Parameters<typeof createTestEngine>[0]["defaultModes"];
    readonly limits?: CapacityLimits;
    readonly logger?: Logger;
    readonly modelPreferences?: ModelPreferences;
    readonly ramBudget?: ResourceStrategyOptions["ramBudget"];
    readonly totalRamBytes?: number;
    readonly warmPoolEnabled?: boolean;
    /** Replaces keys of the `warmPool` block, `targets` and `maxConcurrentBoots` among them. */
    readonly warmPool?: Partial<Config["warmPool"]>;
    /** `0` leaves no device recently released, so the pool boots none back unasked. */
    readonly idleShutdownAfterMs?: number;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const filesystem = options.filesystem ?? new MemoryFilesystem();
  const bus = new EventBus(clock);
  const driver =
    options.driver ?? new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  let nextId = options.filesystem === undefined ? 1 : 1_000;
  const registry = await Registry.load({
    clock,
    eventBus: bus,
    filesystem,
    idGenerator: { generate: () => `${nextId++}` },
    ...(options.identity === undefined ? {} : { leaseIdentity: options.identity }),
    statePath,
  });
  const baseConfig = config(
    {
      ...options.lease,
      ...(options.identity === undefined ? {} : { identity: options.identity }),
    },
    options.warmPoolEnabled ?? true,
    options.idleShutdownAfterMs,
    options.warmPool,
  );
  const engineConfig: Config = {
    ...baseConfig,
    capacity: capacityConfig(baseConfig, options),
  };
  const totalRamBytes = options.totalRamBytes ?? 32 * gibibyte;
  const drivers = options.drivers ?? [driver];
  const engine = createTestEngine({
    ...testComponentWiring({
      clock,
      components: options.components,
      drivers,
      eventBus: bus,
      registry,
    }),
    clock,
    config: engineConfig,
    drivers,
    ...(options.defaultModes === undefined ? {} : { defaultModes: options.defaultModes }),
    eventBus: bus,
    idGenerator: { generate: () => `request-${nextId++}` },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.modelPreferences === undefined
      ? {}
      : { modelPreferences: options.modelPreferences }),
    registry,
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes }),
  });

  return { bus, clock, driver, engine, filesystem, registry };
}

async function seedReady(
  harness: Awaited<ReturnType<typeof createHarness>>,
  spec: DeviceSpec = request,
) {
  const driverDevice = await harness.driver.provision(spec);
  // Running on the machine as well as ready in the registry, which is what a daemon start reads
  // of a leased device to keep its lease.
  await harness.driver.makeReady(driverDevice, { mode: "full", purpose: "prepare" });
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

/** The value or error `promise` settles with within a flush, or "still pending". */
async function settledOrPending(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise.catch((error: unknown) => error),
    flush().then(() => "still pending"),
  ]);
}

describe("createLeasing", () => {
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

  it("a release whose reclaim leaves the device ready, with running capacity over its limit, has the pool shut the least recently used idle device down", async () => {
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
    harness.clock.advance(5);

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    expect(harness.driver.calls.map((call) => call.operation)).toContain("reclaim");
    expect(
      harness.registry.snapshot.devices.find((item) => item.id === first.device.id)?.state,
    ).toBe("ready");
    expect(harness.registry.snapshot.devices.find((item) => item.id === excess.id)?.state).toBe(
      "shutdown",
    );
    expect(harness.bus.replay().filter((event) => event.event === "device.shutdown")).toMatchObject(
      [{ payload: { deviceId: excess.id, initiator: "warm-pool" } }],
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

  it("A purge failure logs nothing, because device.purge-failed carries the error.", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("reclaim", 1, new DriverCrashError("purge exploded"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      driver,
      logger: new JsonLinesLogger({ clock, level: "debug", sink }),
    });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    expect(
      harness.bus.replay().filter((event) => event.event === "device.purge-failed"),
    ).toMatchObject([
      {
        payload: {
          deviceId: first.device.id,
          error: "DriverCrashError: purge exploded",
          leaseId: first.lease.id,
        },
      },
    ]);
    // At `debug`, so a line at any level would be caught: nothing names the device or the error.
    expect(
      sink.records.filter((record) => {
        const line = JSON.stringify(record);
        return line.includes("purge exploded") || line.includes(first.device.id);
      }),
    ).toEqual([]);
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

  it("shuts down an unleased ready device over maxRunning at startup with initiator warm-pool, never a leased one, and is idempotent", async () => {
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
    await harness.engine.settle();
    await harness.engine.convergeRunningCapacity();
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: leasedDevice.id, state: "leased" },
      { id: unleasedDevice.id, state: "shutdown" },
    ]);
    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(1);
    expect(harness.engine.runningCapacity.global.overLimit).toBe(false);
    expect(harness.bus.replay().filter((event) => event.event === "device.shutdown")).toMatchObject(
      [{ payload: { deviceId: unleasedDevice.id, initiator: "warm-pool" } }],
    );
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
    expect(harness.driver.calls.slice(callsBefore).map((call) => call.operation)).toEqual([
      "listManaged",
    ]);
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
    const seededBoots = driver.calls.filter((call) => call.operation === "makeReady").length;
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

    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
      seededBoots + 1,
    );
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
    const harness = await createHarness({ driver, idleShutdownAfterMs: 0 });
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

  it("stamps queue.changed with the wait-queue module when a request queues and when it leaves", async () => {
    const harness = await createHarness();
    const modules: { depth: number; module: string }[] = [];
    harness.bus.subscribe("queue.changed", (envelope) =>
      modules.push({ depth: envelope.payload.depth, module: envelope.module }),
    );
    const holder = await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const queued = harness.engine.request(request, {
      ownerId: "queued",
      requesterId: "queued",
    });
    await flush();
    expect(modules).toEqual([{ depth: 1, module: "wait-queue" }]);

    await harness.engine.release(holder.lease.id, "explicit");
    await queued;
    expect(modules).toEqual([
      { depth: 1, module: "wait-queue" },
      { depth: 0, module: "wait-queue" },
    ]);
  });

  it("queues at capacity in FIFO order across three waiters", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    // Each waiter records its grant and hands the device straight back, so the queue drains in
    // whatever order it serves and the assertion below sees that order rather than hanging.
    const granted: string[] = [];
    const waiters = ["agent-2", "agent-3", "agent-4"].map((requesterId) =>
      harness.engine.request(request, { ownerId: requesterId, requesterId }).then(async (grant) => {
        granted.push(grant.lease.requesterId);
        await harness.engine.release(grant.lease.id, "explicit");
      }),
    );
    await flush();

    await harness.engine.release(first.lease.id, "explicit");
    await Promise.all(waiters);

    expect(granted).toEqual(["agent-2", "agent-3", "agent-4"]);
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

    // A no-wait request that queued instead would leave an await hanging; this names it.
    const outcome = await settledOrPending(
      harness.engine.request(request, { noWait: true, ownerId: "agent-2", requesterId: "agent-2" }),
    );

    expect(outcome).toBeInstanceOf(NoCapacityError);
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

    // Each outcome settles against a flush rather than an await, so a waiter left pending
    // fails the assertion that names it instead of hanging the test.
    harness.clock.advance(10);
    expect(await settledOrPending(timedOut)).toBeInstanceOf(QueueTimeoutError);
    expect(progress).toEqual(["queued"]);
    await harness.engine.release(first.lease.id, "explicit");

    expect(await settledOrPending(next)).toMatchObject({
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

    // A request that never retried would sit pending; settling against a flush names that.
    const grant = await settledOrPending(
      harness.engine.request(request, { ownerId: "agent-1", requesterId: "agent-1" }),
    );

    expect(grant).toMatchObject({ device: { state: "leased" } });
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

describe("createLeasing RAM budget by mode", () => {
  const slimRequest = { ...request, mode: "slim" } as const;
  const roomy: CapacityLimits = {
    android: { maxDevices: 4, maxRunning: 4 },
    ios: { maxDevices: 8, maxRunning: 8 },
    maxRunning: 12,
  };
  /** With 9 GiB of RAM the budget is 5 GiB: one full iOS device (3 GiB) and two slim ones fit. */
  const ramBudget = {
    androidBytesPerDevice: 4 * gibibyte,
    iosBytesPerDevice: 3 * gibibyte,
    iosSlimBytesPerDevice: gibibyte,
  };

  function operations(driver: FakeDriver, operation: string): number {
    return driver.calls.filter((call) => call.operation === operation).length;
  }

  it("refuses a full spec, which a slim request on a runtime that cannot be slimmed resolves to, before it is provisioned, and counts it full after it boots", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.4", "26.5"],
      clock,
      platform: "ios",
      slimmableOsVersions: ["26.4"],
    });
    const harness = await createHarness({
      driver,
      limits: roomy,
      ramBudget,
      totalRamBytes: 9 * gibibyte,
    });

    const unslimmable = await harness.engine.request(slimRequest, {
      ownerId: "unslimmable",
      requesterId: "unslimmable",
    });
    expect(unslimmable.device.mode).toBe("full");
    expect(harness.engine.ramBudget?.usedBytes).toBe(3 * gibibyte);

    // 3 GiB used of 5: the next device needs 3 more and is refused before any provision.
    const provisions = operations(driver, "provision");
    await expect(
      harness.engine.request(slimRequest, { noWait: true, ownerId: "next", requesterId: "next" }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(operations(driver, "provision")).toBe(provisions);

    // Control: had the first device come up slim, 1 GiB would be used and the next would fit.
    const control = await createHarness({
      driver: new FakeDriver({
        availableOsVersions: ["26.4"],
        clock: new FakeClock(1_000),
        platform: "ios",
        slimmableOsVersions: ["26.4"],
      }),
      limits: roomy,
      ramBudget,
      totalRamBytes: 9 * gibibyte,
    });
    const slimmable = { ...slimRequest, osVersion: "26.4" };
    await control.engine.request(slimmable, { ownerId: "first", requesterId: "first" });
    await expect(
      control.engine.request(slimmable, { noWait: true, ownerId: "next", requesterId: "next" }),
    ).resolves.toMatchObject({ device: { mode: "slim" } });
  });

  it("counts a slim-spec device quarantined from provisioning at the full size", async () => {
    const harness = await createHarness({ limits: roomy, ramBudget, totalRamBytes: 9 * gibibyte });
    const registered = await harness.registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver-stalled",
      provisionDuration: 0,
      spec: slimRequest,
    });
    // A stalled provision is quarantined before the device ever booted.
    const quarantined = await harness.registry.enterQuarantine(registered.id, 60_000);

    expect(quarantined.state).toBe("quarantined");
    expect(harness.engine.ramBudget?.usedBytes).toBe(ramBudget.iosBytesPerDevice);
  });

  it("keeps the lease of a device planned as slim whose driver reports full, shuts nothing down, and counts it full", async () => {
    const clock = new FakeClock(1_000);
    // A slimming driver whose slim pass never takes: every device it boots reports `full`.
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      mode: "full",
      platform: "ios",
      slimmableOsVersions: ["26.5"],
    });
    const harness = await createHarness({
      driver,
      limits: roomy,
      ramBudget,
      totalRamBytes: 9 * gibibyte,
    });

    const leased = await harness.engine.request(slimRequest, { ownerId: "a", requesterId: "a" });

    expect(leased.device.mode).toBe("full");
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([leased.lease.id]);
    expect(operations(driver, "shutdown")).toBe(0);
    expect(harness.engine.ramBudget).toEqual({
      limitBytes: 5 * gibibyte,
      overLimit: false,
      usedBytes: 3 * gibibyte,
    });
  });

  it("over its limit after a restart with larger sizes, creates no device in either mode and boots no shut-down slim device, but grants an idle one; a delete brings it back under", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.4", "26.5"],
      clock,
      platform: "ios",
      slimmableOsVersions: ["26.4", "26.5"],
    });
    const small = { ...ramBudget, iosSlimBytesPerDevice: 0.5 * gibibyte };
    const before = await createHarness({
      driver,
      idleShutdownAfterMs: 0,
      limits: roomy,
      ramBudget: small,
      totalRamBytes: 9 * gibibyte,
    });
    const idleSpec = { ...slimRequest, osVersion: "26.4" };
    const held = await before.engine.request(slimRequest, { ownerId: "held", requesterId: "held" });
    const toShutDown = await before.engine.request(slimRequest, { ownerId: "b", requesterId: "b" });
    const idle = await before.engine.request(idleSpec, { ownerId: "c", requesterId: "c" });
    for (const grant of [toShutDown, idle]) {
      await before.engine.release(grant.lease.id, "explicit");
    }
    await before.engine.settle();
    await before.engine.cleanup.execute({
      action: "shutdown",
      reason: "test",
      rule: "test",
      target: toShutDown.device.id,
    });
    expect(before.engine.ramBudget?.usedBytes).toBe(1.5 * gibibyte);

    // Restarted at 2 GiB slim: the three slim devices use 6 GiB of 5.
    const after = await createHarness({
      driver,
      filesystem: before.filesystem,
      idleShutdownAfterMs: 0,
      limits: roomy,
      ramBudget: { ...ramBudget, iosSlimBytesPerDevice: 2 * gibibyte },
      totalRamBytes: 9 * gibibyte,
    });
    await after.engine.convergeRunningCapacity();
    expect(after.engine.ramBudget).toEqual({
      limitBytes: 5 * gibibyte,
      overLimit: true,
      usedBytes: 6 * gibibyte,
    });

    const provisions = operations(driver, "provision");
    const boots = operations(driver, "makeReady");
    for (const [owner, wanted] of [
      ["new-full", request],
      ["new-slim", { ...slimRequest, model: "iPhone 16 Pro" }],
      ["boot-slim", slimRequest],
    ] as const) {
      await expect(
        after.engine.request(wanted, { noWait: true, ownerId: owner, requesterId: owner }),
      ).rejects.toBeInstanceOf(NoCapacityError);
    }
    expect(operations(driver, "provision")).toBe(provisions);
    expect(operations(driver, "makeReady")).toBe(boots);
    expect(after.registry.snapshot.devices.find((d) => d.id === toShutDown.device.id)?.state).toBe(
      "shutdown",
    );

    const reused = await after.engine.request(idleSpec, {
      noWait: true,
      ownerId: "reuse",
      requesterId: "reuse",
    });
    expect(reused.device.id).toBe(idle.device.id);
    expect(after.registry.snapshot.leases.map((lease) => lease.deviceId)).toContain(held.device.id);

    // A release lowers nothing; deleting both idle devices brings use to 2 GiB of 5, and a new
    // device's 3 GiB fits again.
    await after.engine.release(reused.lease.id, "explicit");
    await after.engine.settle();
    expect(after.engine.ramBudget?.overLimit).toBe(true);
    for (const [action, target] of [
      ["destroy", toShutDown.device.id],
      ["shutdown", idle.device.id],
      ["destroy", idle.device.id],
    ] as const) {
      await after.engine.cleanup.execute({ action, reason: "test", rule: "test", target });
    }
    expect(after.engine.ramBudget).toEqual({
      limitBytes: 5 * gibibyte,
      overLimit: false,
      usedBytes: 2 * gibibyte,
    });
    await after.engine.request(request, { noWait: true, ownerId: "new", requesterId: "new" });
    expect(operations(driver, "provision")).toBe(provisions + 1);
  });
});

// #43: startup convergence used to await each orphaned held lease's device reclaim
// inline (an erase measured ~34s for one simulator), so N orphaned leases cost N
// serial erases before any other request could be served. These cover the shape
// that replaced it: the lease is released registry-only on the convergence path,
// and its reclaim proceeds in the background.
describe("createLeasing startup reclaim backgrounding (#43)", () => {
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

  it("recovers a background reclaim interrupted by a daemon crash on the next start", async () => {
    const filesystem = new MemoryFilesystem();
    const restartStatePath = "/home/agent/.simlock/restart-state.json";
    let nextId = 1;
    const idGenerator = { generate: () => `${nextId++}` };
    const systemStats = () =>
      new FakeSystemStats({
        cpuCount: 8,
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
    const engine1 = createTestEngine({
      ...testComponentWiring({
        clock: clock1,
        drivers: [driver],
        eventBus: bus1,
        registry: registry1,
      }),
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
    const engine2 = createTestEngine({
      ...testComponentWiring({
        clock: clock2,
        drivers: [driver],
        eventBus: bus2,
        registry: registry2,
      }),
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

  it("deletes the device of a recovery-driven lease termination", async () => {
    const harness = await createHarness({
      identity: freshIos,
      lease: { defaultTtlMs: 14_400_000 },
    });
    const granted = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    // The device vanished from driver reality: recovery gives up and ends the lease as lost.
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
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    let nextId = 1;
    const idGenerator = { generate: () => `${nextId++}` };
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const systemStats = new FakeSystemStats({
      cpuCount: 8,
      totalRamBytes: 32 * gibibyte,
    });
    const beforeRegistry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator,
      leaseIdentity: freshIos,
      statePath,
    });
    const before = createTestEngine({
      clock,
      ...testComponentWiring({ clock, drivers: [driver], eventBus: bus, registry: beforeRegistry }),
      config: config({ identity: freshIos }),
      drivers: [driver],
      eventBus: bus,
      idGenerator,
      registry: beforeRegistry,
      systemStats,
    });
    const granted = await before.request(request, { ownerId: "a", requesterId: "a" });
    before.dispose();

    // The operator switches iOS back to reusable and restarts the daemon mid-lease.
    const reusable = { android: "reusable", ios: "reusable" } as const;
    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator,
      leaseIdentity: reusable,
      statePath,
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

  it("still reclaims a device created under reusable and returns it to the pool", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, { ownerId: "first", requesterId: "first" });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();
    const second = await harness.engine.request(request, {
      ownerId: "second",
      requesterId: "second",
    });

    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: first.device.id, leaseIdentity: "reusable", state: "leased" },
    ]);
    expect(second.device.id).toBe(first.device.id);
    const operations = harness.driver.calls.map((call) => call.operation);
    expect(operations.filter((operation) => operation === "reclaim")).toHaveLength(1);
    expect(operations).not.toContain("destroy");
  });

  /**
   * The persisted state a daemon leaves behind when it dies part-way through a fresh device's
   * lease end, built through the same registry calls that path makes, then read by a new process.
   */
  async function restartAfterCrash(crashedIn: "reclaiming" | "shutdown") {
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    let nextId = 1;
    const idGenerator = { generate: () => `${nextId++}` };
    // One driver across both processes: the simulator outlives the daemon.
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const crashed = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator,
      leaseIdentity: freshIos,
      statePath,
    });
    const driverDevice = await driver.makeReady(await driver.provision(request), {
      mode: "full",
      purpose: "prepare",
    });
    const device = await crashed.registerDevice({
      driverData: driverDevice.driverData,
      driverDeviceId: driverDevice.deviceId,
      provisionDuration: 0,
      spec: request,
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

    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator,
      leaseIdentity: freshIos,
      statePath,
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

  it("deletes a fresh device on the next start when the daemon crashed while it was reclaiming", async () => {
    const restarted = await restartAfterCrash("reclaiming");
    expect(restarted.registry.snapshot.devices).toMatchObject([{ state: "reclaiming" }]);

    await restarted.engine.convergeRunningCapacity();

    expect(restarted.registry.snapshot.devices).toMatchObject([
      { id: restarted.device.id, state: "deleted" },
    ]);
    expect(restarted.operationsSinceStart()).toEqual(["listManaged", "shutdown", "destroy"]);
  });

  it("deletes a fresh device on the next start when the daemon crashed after its shutdown commit and before its delete", async () => {
    const restarted = await restartAfterCrash("shutdown");
    expect(restarted.registry.snapshot.devices).toMatchObject([{ state: "shutdown" }]);

    await restarted.engine.convergeRunningCapacity();

    expect(restarted.registry.snapshot.devices).toMatchObject([
      { id: restarted.device.id, state: "deleted" },
    ]);
    expect(restarted.operationsSinceStart()).toEqual(["listManaged", "destroy"]);
  });
});

describe("createLeasing logger wiring", () => {
  function debugLogger(): { readonly logger: Logger; readonly sink: MemoryLogSink } {
    const sink = new MemoryLogSink();
    return { logger: new JsonLinesLogger({ clock: new FakeClock(0), level: "debug", sink }), sink };
  }

  it("createCore hands its logger to the quarantine coordinator: a failed retry is logged", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("reclaim", 1, new DriverCrashError("purge exploded"));
    driver.failOn("reclaim", 2, new DriverCrashError("retry exploded"));
    const { logger, sink } = debugLogger();
    const harness = await createHarness({ driver, logger });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });
    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("quarantined");

    harness.clock.advance(config().warmPool.quarantine.retryBackoffMs);
    await flush();

    expect(
      sink.records.filter((record) => record.message === "quarantine reclaim retry failed"),
    ).toMatchObject([
      {
        level: "warn",
        module: "daemon.quarantine-coordinator",
        fields: {
          attempts: 1,
          deviceId: first.device.id,
          error: "DriverCrashError: retry exploded",
          step: "reclaim",
        },
      },
    ]);
  });

  it("createCore hands its logger to the driver catalog: a platform left out of the catalog is logged", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["34"], clock, platform: "android" });
    android.failOn("listCatalog", 1, new DriverCrashError("~/.android is not readable"));
    const { logger, sink } = debugLogger();
    const harness = await createHarness({ driver: ios, drivers: [ios, android], logger });

    await harness.engine.listCatalog();

    expect(
      sink.records.filter((record) => record.message === "A driver could not read its catalog"),
    ).toMatchObject([
      {
        level: "warn",
        module: "daemon.driver-catalog",
        fields: { error: "DriverCrashError: ~/.android is not readable", platform: "android" },
      },
    ]);
  });

  it("createCore hands its logger to the device provisioner: a new device that fails to boot is logged", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("makeReady", 1, new DriverCrashError("first boot exploded"));
    const { logger, sink } = debugLogger();
    const harness = await createHarness({ driver, logger });

    await expect(
      harness.engine.request(request, { ownerId: "first", requesterId: "first" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    expect(
      sink.records.filter((record) => record.message === "new device failed to become ready"),
    ).toMatchObject([
      {
        level: "warn",
        module: "daemon.device-provisioner",
        fields: { error: "DriverCrashError: first boot exploded", step: "boot" },
      },
    ]);
  });

  it("createLeasing hands its logger to the lease expiry scheduler: an expiry that fails is logged", async () => {
    const { logger, sink } = debugLogger();
    const harness = await createHarness({ lease: { defaultTtlMs: 10 }, logger });
    const granted = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    // The expiry's release has to commit to the state file; a disk that refuses the write
    // makes the expiry throw out of the scheduler's timer.
    harness.filesystem.defineFailure(statePath, "EIO");

    harness.clock.advance(10);
    await flush();

    expect(sink.records.filter((record) => record.message === "lease expiry failed")).toMatchObject(
      [
        {
          level: "error",
          module: "daemon.lease-expiry-scheduler",
          fields: { leaseId: granted.lease.id, step: "expire" },
        },
      ],
    );
  });

  it("createLeasing hands its logger to the acquisition coordinator: a failed eviction is logged", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("shutdown", 1, new DriverCrashError("cannot stop victim"));
    const { logger, sink } = debugLogger();
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
      logger,
    });
    const victim = await seedReady(harness);

    await expect(
      harness.engine.request(
        { ...request, model: "iPhone SE" },
        { noWait: true, ownerId: "new-spec", requesterId: "new-spec" },
      ),
    ).rejects.toBeInstanceOf(NoCapacityError);

    expect(
      sink.records.filter((record) => record.message === "shutting down an eviction target failed"),
    ).toMatchObject([
      {
        level: "warn",
        module: "daemon.lease-acquisition-coordinator",
        fields: { deviceId: victim.id, requesterId: "new-spec", step: "shutdown" },
      },
    ]);
  });

  it("createLeasing hands its logger to the lease release coordinator: a background reclaim that cannot commit is logged", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { reclaim: 20 },
      platform: "ios",
    });
    const { logger, sink } = debugLogger();
    const harness = await createHarness({ driver, logger });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });
    await harness.engine.release(first.lease.id, "explicit");
    // The release has committed and the erase is still running. A disk that refuses the write
    // makes the reclaim's own commit throw, with no caller left to reject to.
    harness.filesystem.defineFailure(statePath, "EIO");

    clock.advance(20);
    await harness.engine.settle();

    expect(
      sink.records.filter((record) => record.message === "background reclaim failed"),
    ).toMatchObject([
      {
        level: "error",
        module: "daemon.lease-release-coordinator",
        fields: { deviceId: first.device.id, leaseId: first.lease.id },
      },
    ]);
  });
});

describe("createLeasing restart recovery of stored lease requests", () => {
  /** Leaves `agent`'s request queued behind the one device, then restarts on the same state. */
  async function restartWithAgentQueued(idempotencyKey?: string) {
    const before = await createHarness();
    await before.engine.request(request, { ownerId: "holder", requesterId: "holder" });
    void before.engine
      .request(request, {
        ownerId: "agent",
        requesterId: "agent",
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      })
      .catch(() => undefined);
    await expect
      .poll(() => before.registry.leaseRequests().find((record) => record.requesterId === "agent"))
      .toMatchObject({ state: "open" });

    const after = await createHarness({ filesystem: before.filesystem });
    await after.engine.convergeRunningCapacity();
    return after;
  }

  it("settles a request still open at a restart as failed and says the daemon restarted", async () => {
    const after = await restartWithAgentQueued("key-1");

    expect(
      after.registry.leaseRequests().find((record) => record.requesterId === "agent"),
    ).toMatchObject({
      failure: { code: "INTERNAL", message: expect.stringContaining("daemon restarted") },
      state: "failed",
    });
    expect(
      after.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload),
    ).toEqual([
      {
        reason: "daemon-restarted",
        requestId: expect.stringMatching(/^req_/),
        requester: "agent",
        requestSpec: request,
      },
    ]);
    await expect(
      after.engine.request(request, {
        idempotencyKey: "key-1",
        ownerId: "agent",
        requesterId: "agent",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("daemon restarted") });
  });

  it("settles a request that carried no idempotency key at a restart too", async () => {
    const after = await restartWithAgentQueued();

    expect(
      after.registry.leaseRequests().find((record) => record.requesterId === "agent"),
    ).toMatchObject({ state: "failed" });
  });
});

describe("createLeasing a grant and its request's result", () => {
  const asker = { idempotencyKey: "key-1", ownerId: "agent", requesterId: "agent" };

  it("answers a repeat under the same key with the lease after the daemon stopped between the grant and the request book's settle write", async () => {
    const before = await createHarness();
    await seedReady(before);
    vi.spyOn(before.registry, "settleLeaseRequest").mockRejectedValue(new Error("disk gone"));
    const grant = await before.engine.request(request, asker);
    await flush();

    const after = await createHarness({ driver: before.driver, filesystem: before.filesystem });
    await after.engine.convergeRunningCapacity();
    const repeat = await after.engine.request(request, asker);

    expect(repeat).toEqual(grant);
    expect(repeat.lease.id).toBe(grant.lease.id);
    expect(after.registry.leaseRequests()).toMatchObject([{ state: "granted" }]);
    expect(after.registry.snapshot.leases).toHaveLength(1);
  });

  it("answers a repeat under the same key in the same process with the lease after the request book's settle finds the request already granted", async () => {
    const harness = await createHarness();
    await seedReady(harness);
    const settle = vi.spyOn(harness.registry, "settleLeaseRequest");
    const grant = await harness.engine.request(request, asker);
    await flush();

    expect(settle).toHaveBeenCalledTimes(1);
    await expect(settle.mock.results[0]?.value).resolves.toBeUndefined();
    const repeat = await harness.engine.request(request, asker);
    expect(repeat).toEqual(grant);
    expect(repeat.lease.id).toBe(grant.lease.id);
    expect(harness.registry.leaseRequests()).toMatchObject([{ grant, state: "granted" }]);
  });

  it("answers a repeat of a granted request whose lease was released since with the grant as recorded, and a renew of that lease with UnknownLeaseError", async () => {
    const harness = await createHarness();
    await seedReady(harness);
    const grant = await harness.engine.request(request, asker);
    await flush();
    await harness.engine.release(grant.lease.id, "explicit");

    const repeat = await harness.engine.request(request, asker);

    expect(repeat.lease.id).toBe(grant.lease.id);
    expect(repeat).toEqual(grant);
    await expect(harness.engine.renew(grant.lease.id)).rejects.toBeInstanceOf(UnknownLeaseError);
  });
});

describe("createLeasing class requests", () => {
  it("creates the first model on the class's preference list the catalog lists, for a request naming a class", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      knownModels: ["iPhone 15", "iPhone 16"],
      modelClasses: { "iPhone 15": "phone", "iPhone 16": "phone" },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      modelPreferences: { ios: { phone: ["iPhone 17", "iPhone 16", "iPhone 15"] } },
    });

    const granted = await harness.engine.request(
      { class: "phone", platform: "ios" },
      { ownerId: "agent", requesterId: "agent" },
    );

    expect(granted.device.spec.model).toBe("iPhone 16");
  });

  it("creates the first listed model that pairs with the requested OS version, not one that pairs with another", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["18.4", "26.5"],
      clock: new FakeClock(1_000),
      knownModels: ["iPhone 16", "iPhone 17"],
      modelClasses: { "iPhone 16": "phone", "iPhone 17": "phone" },
      modelRuntimes: { "iPhone 16": ["18.4", "26.5"], "iPhone 17": ["26.5"] },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      modelPreferences: { ios: { phone: ["iPhone 17", "iPhone 16"] } },
    });

    const granted = await harness.engine.request(
      { class: "phone", osVersion: "18.4", platform: "ios" },
      { ownerId: "agent", requesterId: "agent" },
    );

    expect(granted.device.spec).toMatchObject({ model: "iPhone 16", osVersion: "18.4" });
  });

  it("refuses a class request naming an OS that is not installed as RUNTIME_MISSING without calling the installer, whatever allowDownload says", async () => {
    const asked: unknown[] = [];
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      knownModels: ["iPhone 17"],
      modelClasses: { "iPhone 17": "phone" },
      platform: "ios",
    });
    const harness = await createHarness({
      components: {
        claimProvision: () => () => undefined,
        install: async (call) => {
          asked.push(call);
          return { outcome: "installed", version: "18.4" };
        },
      },
      driver,
      modelPreferences: { ios: { phone: ["iPhone 17"] } },
    });

    await expect(
      harness.engine.request(
        { class: "phone", osVersion: "18.4", platform: "ios" },
        { allowDownload: true, ownerId: "agent", requesterId: "agent" },
      ),
    ).rejects.toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
    expect(asked).toEqual([]);
  });
});
describe("createLeasing: capacity.changed and queue.changed", () => {
  type CapacityEvent = EventMap["capacity.changed"];

  function capacityEvents(harness: Awaited<ReturnType<typeof createHarness>>): CapacityEvent[] {
    return harness.bus
      .replay()
      .filter((event) => event.event === "capacity.changed")
      .map((event) => event.payload as CapacityEvent);
  }

  function queueEvents(harness: Awaited<ReturnType<typeof createHarness>>): number[] {
    return harness.bus
      .replay()
      .filter((event) => event.event === "queue.changed")
      .map((event) => (event.payload as EventMap["queue.changed"]).depth);
  }

  function currentFigures(harness: Awaited<ReturnType<typeof createHarness>>): CapacityEvent {
    return capacityChangedPayload(
      buildCapacityFigures(harness.registry.snapshot.devices, harness.engine),
    );
  }

  it("emits capacity.changed and queue.changed once when the daemon has started, and none before", async () => {
    const harness = await createHarness();
    await seedReady(harness);
    expect([capacityEvents(harness), queueEvents(harness)]).toEqual([[], []]);

    await harness.engine.convergeRunningCapacity();

    expect(capacityEvents(harness)).toEqual([currentFigures(harness)]);
    expect(capacityEvents(harness)[0]).toMatchObject({ global: { warm: 1 }, ios: { warm: 1 } });
    expect(queueEvents(harness)).toEqual([0]);
  });

  it("emits capacity.changed after a provision commits, with the figures status.get reports at that moment", async () => {
    const harness = await createHarness();
    await harness.engine.convergeRunningCapacity();
    const before = capacityEvents(harness).length;
    const seen: Array<{ event: CapacityEvent; figures: CapacityEvent }> = [];
    harness.bus.subscribe("capacity.changed", (envelope) =>
      seen.push({ event: envelope.payload, figures: currentFigures(harness) }),
    );

    await harness.registry.registerDevice({
      driverData: {},
      driverDeviceId: "sim-1",
      provisionDuration: 0,
      spec: request,
    });

    expect(capacityEvents(harness)).toHaveLength(before + 1);
    expect(seen).toEqual([{ event: currentFigures(harness), figures: currentFigures(harness) }]);
    expect(seen[0]?.event.ramBudget?.usedBytes).toBeGreaterThan(0);
  });

  it("emits capacity.changed when a provisioning reservation is taken, before any registry commit, and when it is released", async () => {
    const harness = await createHarness();
    await harness.engine.convergeRunningCapacity();
    const seen: Array<{ reserved: number; devices: number }> = [];
    harness.bus.subscribe("capacity.changed", (envelope) =>
      seen.push({
        devices: harness.registry.snapshot.devices.length,
        reserved: envelope.payload.ios.reserved,
      }),
    );
    harness.driver.hangMakeReady();

    const pending = harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    await flush();
    expect(seen[0]).toEqual({ devices: 0, reserved: 1 });
    harness.driver.releaseMakeReady();
    await pending;
    await flush();

    expect(seen.at(-1)?.reserved).toBe(0);
    expect(capacityEvents(harness).at(-1)).toEqual(currentFigures(harness));
  });

  it("emits capacity.changed after a device is deleted and after a lease releases a warm device", async () => {
    const harness = await createHarness();
    const grant = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    await harness.engine.convergeRunningCapacity();
    expect(capacityEvents(harness).at(-1)).toMatchObject({ ios: { warm: 0, running: 1 } });

    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(capacityEvents(harness).at(-1)).toMatchObject({ ios: { warm: 1, running: 1 } });

    await harness.registry.markDeviceMissing(grant.device.id, "test");
    expect(capacityEvents(harness).at(-1)).toMatchObject({ ios: { warm: 0, running: 0 } });
    expect(capacityEvents(harness).at(-1)).toEqual(currentFigures(harness));
  });

  it("emits no capacity.changed when a commit leaves the capacity figures unchanged", async () => {
    const harness = await createHarness();
    await seedReady(harness);
    await harness.engine.convergeRunningCapacity();
    const before = capacityEvents(harness).length;

    await harness.registry.createLeaseRequest({
      ownerId: "a",
      request,
      requesterId: "a",
    });
    await harness.registry.markForeignStateDetected(harness.registry.snapshot.devices[0]!.id, 1);

    expect(capacityEvents(harness)).toHaveLength(before);
  });

  it("never emits two consecutive capacity.changed events with equal figures across a whole lease", async () => {
    const harness = await createHarness();
    await harness.engine.convergeRunningCapacity();
    const grant = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();

    const events = capacityEvents(harness);
    expect(events.length).toBeGreaterThan(3);
    events.slice(1).forEach((event, index) => expect(event).not.toEqual(events[index]));
  });

  it("carries ramBudget under the resource strategy and omits it under the fixed strategy", async () => {
    const resource = await createHarness();
    await resource.engine.convergeRunningCapacity();
    const fixed = await createHarness({
      capacity: { strategy: "fixed", config: { maxRunning: 2 } },
    });
    await fixed.engine.convergeRunningCapacity();

    expect(capacityEvents(resource)[0]?.ramBudget).toEqual({
      limitBytes: expect.any(Number),
      usedBytes: 0,
    });
    expect(capacityEvents(fixed)).toHaveLength(1);
    expect(capacityEvents(fixed)[0]).not.toHaveProperty("ramBudget");
  });

  it("emits queue.changed when a request joins the worker's queue and when it leaves, with the new depth", async () => {
    const harness = await createHarness();
    await harness.engine.convergeRunningCapacity();
    const first = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    const queued = harness.engine.request(request, { ownerId: "b", requesterId: "b" });
    await flush();
    expect(queueEvents(harness)).toEqual([0, 1]);

    await harness.engine.release(first.lease.id, "explicit");
    await queued;

    expect(queueEvents(harness)).toEqual([0, 1, 0]);
  });
});

describe("createLeasing: lease.rejected names its request", () => {
  type Reason = EventMap["lease.rejected"]["reason"];
  type Rejection = EventMap["lease.rejected"];
  type Harness = Awaited<ReturnType<typeof createHarness>>;

  /** What a case settles: the harness whose bus saw the rejection, and who it was for. */
  interface Outcome {
    readonly harness: Harness;
    readonly requester: string;
    /** The stored request's id, when the request was stored; refused requests never were. */
    readonly requestId?: string | undefined;
  }

  const holder = { ownerId: "holder", requesterId: "holder" };

  async function admittedId(harness: Harness, requesterId: string): Promise<string | undefined> {
    return harness.registry.leaseRequests().find((record) => record.requesterId === requesterId)
      ?.id;
  }

  /** One case per reason in `EventMap`, so a reason added there without a case fails typecheck. */
  const cases: Record<Reason, (() => Promise<Outcome>) | "gateway"> = {
    timeout: async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      const timedOut = harness.engine.request(request, {
        ownerId: "late",
        requesterId: "late",
        timeoutMs: 10,
      });
      await flush();
      harness.clock.advance(10);
      await settledOrPending(timedOut);
      return { harness, requestId: await admittedId(harness, "late"), requester: "late" };
    },
    "no-wait": async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      await settledOrPending(
        harness.engine.request(request, { noWait: true, ownerId: "now", requesterId: "now" }),
      );
      return { harness, requestId: await admittedId(harness, "now"), requester: "now" };
    },
    "unresolvable-spec": async () => {
      const harness = await createHarness();
      await settledOrPending(
        harness.engine.request(
          { ...request, osVersion: "1.0" },
          { ownerId: "odd", requesterId: "odd" },
        ),
      );
      return { harness, requestId: await admittedId(harness, "odd"), requester: "odd" };
    },
    "no-worker": "gateway",
    "worker-failed": "gateway",
    "already-leased": async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      await settledOrPending(harness.engine.request(request, holder));
      return { harness, requester: "holder" };
    },
    "lease-id-taken": async () => {
      const harness = await createHarness({
        limits: {
          android: { maxDevices: 2, maxRunning: 2 },
          ios: { maxDevices: 3, maxRunning: 3 },
          maxRunning: 4,
        },
      });
      await harness.engine.request(request, { ...holder, leaseId: "myid" });
      await settledOrPending(
        harness.engine.request(request, {
          leaseId: "myid",
          ownerId: "clash",
          requesterId: "clash",
        }),
      );
      return { harness, requester: "clash" };
    },
    "boot-timeout": async () => {
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
      });
      driver.failOn("makeReady", 1, new Error("boot failed"));
      const harness = await createHarness({ driver });
      await settledOrPending(
        harness.engine.request(request, { ownerId: "slow", requesterId: "slow" }),
      );
      return { harness, requestId: await admittedId(harness, "slow"), requester: "slow" };
    },
    killed: async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      const queued = harness.engine.request(request, { ownerId: "next", requesterId: "next" });
      void queued.catch(() => undefined);
      await flush();
      await harness.engine.nuke(false);
      return { harness, requestId: await admittedId(harness, "next"), requester: "next" };
    },
    cancelled: async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      void harness.engine
        .request(request, { ownerId: "next", requesterId: "next" })
        .catch(() => undefined);
      await flush();
      await harness.engine.cancelPending("next");
      return { harness, requestId: await admittedId(harness, "next"), requester: "next" };
    },
    "daemon-restarted": async () => {
      const before = await createHarness();
      await before.engine.request(request, holder);
      void before.engine
        .request(request, { ownerId: "agent", requesterId: "agent" })
        .catch(() => undefined);
      await expect.poll(() => admittedId(before, "agent")).toEqual(expect.stringMatching(/^req_/));
      const requestId = await admittedId(before, "agent");
      const harness = await createHarness({ filesystem: before.filesystem });
      await harness.engine.convergeRunningCapacity();
      return { harness, requestId, requester: "agent" };
    },
  };

  const workerReasons = (Object.keys(cases) as Reason[]).filter(
    (reason) => cases[reason] !== "gateway",
  );

  it.each(workerReasons)(
    "includes the request id and the requester when it rejects with %s",
    async (reason) => {
      const run = cases[reason];
      if (run === "gateway") throw new Error(`${reason} is the gateway's`);

      const { harness, requestId, requester } = await run();

      const rejections = harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload as Rejection)
        .filter((payload) => payload.reason === reason);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toMatchObject({
        requestId: requestId ?? expect.stringMatching(/^req_/),
        requester,
      });
    },
  );
});

describe("createLeasing queue timeout and failure storage", () => {
  const android = { model: "Pixel 9", osVersion: "35", platform: "android" } as const;

  it("emits lease.rejected for a timed-out waiter under the wait queue's module, then lets the request behind it through", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const droid = new FakeDriver({ availableOsVersions: ["35"], clock, platform: "android" });
    const harness = await createHarness({ driver: ios, drivers: [ios, droid] });
    await harness.engine.request(request, { ownerId: "holder", requesterId: "holder" });
    const blocking = harness.engine.request(request, {
      ownerId: "head",
      requesterId: "head",
      timeoutMs: 10,
    });
    const behind = harness.engine.request(android, { ownerId: "behind", requesterId: "behind" });
    await flush();
    // The android request could be served now, but it waits behind the iOS one at the head.
    expect(await settledOrPending(behind)).toBe("still pending");

    harness.clock.advance(10);

    expect(await settledOrPending(blocking)).toBeInstanceOf(QueueTimeoutError);
    expect(await settledOrPending(behind)).toMatchObject({ lease: { requesterId: "behind" } });
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => ({
          module: event.module,
          reason: (event.payload as { reason: string }).reason,
        })),
    ).toEqual([{ module: "wait-queue", reason: "timeout" }]);
  });

  it("stores a failed request as INTERNAL with the error's own message when no classifier was given", async () => {
    const harness = await createHarness();

    await expect(
      harness.engine.request(android, { ownerId: "agent", requesterId: "agent" }),
    ).rejects.toThrow("No driver registered for platform: android");

    expect(harness.registry.leaseRequests()).toMatchObject([
      {
        failure: { code: "INTERNAL", message: "No driver registered for platform: android" },
        state: "failed",
      },
    ]);
  });
});

describe("createLeasing wiring", () => {
  const components = {
    claimProvision: () => () => undefined,
    install: async () => ({ outcome: "installed" as const, version: "26.5" }),
  };

  it("wires the leased-device health monitor, and leaves it out when told to", async () => {
    const harness = await createHarness();
    const without = createLeasing({
      clock: harness.clock,
      components,
      config: config(),
      core: harness.engine.core,
      eventBus: harness.bus,
      healthMonitor: false,
      idGenerator: { generate: () => "1" },
    });

    expect(harness.engine.leasing.healthMonitor).toBeInstanceOf(LeaseHealthMonitor);
    expect(without.healthMonitor).toBeUndefined();
  });

  it("hands core a leaseExpirer that expires through leasing: doctor --fix ends a lease past its deadline", async () => {
    const harness = await createHarness();
    const grant = await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    // No timer may expire it first: only doctor's finding does.
    harness.engine.dispose();
    harness.clock.advance(10 * 60_000 * 60);

    await harness.engine.core.doctor.reconcile({ fix: true });

    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).not.toContain(grant.lease.id);
    expect(harness.bus.replay().map((event) => event.event)).toContain("lease.expired");
  });

  it("does not connect core itself: building a second leasing leaves the first one's ports in place", async () => {
    const harness = await createHarness();
    const connect = vi.spyOn(harness.engine.core, "connect");

    createLeasing({
      clock: harness.clock,
      components,
      config: config(),
      core: harness.engine.core,
      eventBus: harness.bus,
      idGenerator: { generate: () => "1" },
    });

    expect(connect).not.toHaveBeenCalled();
  });
});

describe("createLeasing warm pool", () => {
  const androidSpec = { model: "Pixel 9", osVersion: "36", platform: "android" } as const;

  it("shuts down one of three ready devices with initiator warm-pool after daemon.started when maxRunning is 2", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 3, maxRunning: 2 },
        maxRunning: 2,
      },
    });
    await seedReady(harness);
    await seedReady(harness);
    await seedReady(harness);

    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await harness.engine.settle();

    const states = harness.registry.snapshot.devices.map((item) => item.state);
    expect(states.filter((state) => state === "ready")).toHaveLength(2);
    expect(states.filter((state) => state === "shutdown")).toHaveLength(1);
    const shutdowns = harness.bus.replay().filter((event) => event.event === "device.shutdown");
    expect(shutdowns).toHaveLength(1);
    expect(shutdowns[0]).toMatchObject({ payload: { initiator: "warm-pool" } });
  });

  it("logs a warm pool shutdown that fails under the warm pool's own module and leaves the device ready", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    driver.failOn("shutdown", 1, new DriverCrashError("cannot stop it"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
      logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }),
    });
    await seedReady(harness);
    await seedReady(harness);

    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await harness.engine.settle();

    expect(sink.records.filter((record) => record.level === "warn")).toMatchObject([
      { fields: { step: "shutdown" }, module: expect.stringContaining("warm-pool") },
    ]);
    expect(harness.registry.snapshot.devices.map((item) => item.state)).toEqual(["ready", "ready"]);
  });

  it("a nuke that deletes devices is not undone by the warm pool booting a released device back", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });
    await harness.engine.request(request, { ownerId: "held", requesterId: "held" });

    await harness.engine.nuke(true);
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
  });

  it("starts the pool only once convergence has finished, so what convergence commits triggers no pass", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 3, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    await seedReady(harness);
    await seedReady(harness);

    harness.bus.emit("device.deleted", { deviceId: "x", initiator: "test" }, "test");
    await harness.engine.settle();
    expect(harness.registry.snapshot.devices.map((item) => item.state)).toEqual(["ready", "ready"]);

    await harness.engine.convergeRunningCapacity();
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices.map((item) => item.state).sort()).toEqual([
      "ready",
      "shutdown",
    ]);
  });

  it("cancels the pool's tick when the engine is disposed", async () => {
    const harness = await createHarness();
    await harness.engine.convergeRunningCapacity();
    expect(harness.clock.pendingTimerCount).toBe(1);

    harness.engine.dispose();

    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it("a nuke without --delete-devices leaves the released devices shut down, not booted back by the pool", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });
    await harness.engine.convergeRunningCapacity();
    const held = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });

    await harness.engine.nuke(false);
    await harness.engine.settle();
    // Still inside idle.shutdownAfterMs of the forced release, and a fact that triggers a pass.
    harness.bus.emit(
      "cleanup.executed",
      { action: "shutdown", reason: "test", ruleName: "test", target: held.device.id },
      "test",
    );
    await harness.engine.settle();

    expect(
      harness.registry.snapshot.devices.find((item) => item.id === held.device.id)?.state,
    ).toBe("shutdown");
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
  });

  it("accepts a new request again once a nuke has finished", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, { ownerId: "held", requesterId: "held" });

    await harness.engine.nuke(false);

    await expect(
      harness.engine.request(request, { ownerId: "after", requesterId: "after" }),
    ).resolves.toMatchObject({ lease: { requesterId: "after" } });
  });

  it("a nuke waits for a warm pool boot already in flight, then deletes the device", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { makeReady: 50 },
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });
    const granting = harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    await flush();
    clock.advance(50);
    const grant = await granting;
    await harness.engine.release(grant.lease.id, "explicit");
    // The reclaim commits `shutdown`; the pool then starts booting it back, held on the clock.
    await vi.waitFor(() =>
      expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2),
    );

    const nuking = harness.engine.nuke(true);
    await flush();
    clock.advance(50);
    await nuking;
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
  });

  describe("a request for a device on its way", () => {
    /** One released iOS device whose warm-pool boot is held on the clock, room for a second. */
    async function releasedDeviceBooting(failBoot = false) {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        latencyMs: { makeReady: 50 },
        platform: "ios",
        reclaimResult: "shutdown",
      });
      const harness = await createHarness({
        driver,
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 2, maxRunning: 2 },
          maxRunning: 2,
        },
      });
      const granting = harness.engine.request(request, { ownerId: "a", requesterId: "a" });
      await flush();
      clock.advance(50);
      const first = await granting;
      if (failBoot) driver.failOn("makeReady", 2, new Error("boom"));
      await harness.engine.release(first.lease.id, "explicit");
      await vi.waitFor(() =>
        expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2),
      );
      return { clock, driver, first, harness };
    }

    it("a request arriving during a warm-pool boot that serves it is granted that device when the boot settles, and device.provisioned does not fire", async () => {
      const { clock, driver, first, harness } = await releasedDeviceBooting();

      const second = harness.engine.request(request, { ownerId: "b", requesterId: "b" });
      await flush();
      expect(await settledOrPending(second)).toBe("still pending");
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);

      clock.advance(50);
      await flush();
      // The pool's kick after its boot woke the request: it is granted without another clock tick.
      expect(await settledOrPending(second)).not.toBe("still pending");
      const granted = await second;
      await harness.engine.settle();

      expect(granted.device.id).toBe(first.device.id);
      expect(
        harness.bus.replay().filter((event) => event.event === "device.provisioned"),
      ).toHaveLength(1);
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
      expect(harness.bus.replay().filter((event) => event.event === "device.ready")).toHaveLength(
        2,
      );
    });

    async function twoRoomsHarness(warmPoolEnabled: boolean) {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        latencyMs: { makeReady: 50 },
        platform: "ios",
        reclaimResult: "shutdown",
      });
      const harness = await createHarness({
        driver,
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 3, maxRunning: 3 },
          maxRunning: 3,
        },
        warmPoolEnabled,
      });
      return { clock, driver, harness };
    }

    it("a request arriving while another request is creating its own device provisions its own device rather than waiting for that one", async () => {
      const { clock, driver, harness } = await twoRoomsHarness(true);

      const first = harness.engine.request(request, { ownerId: "a", requesterId: "a" });
      await vi.waitFor(() =>
        expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1),
      );
      const second = harness.engine.request(request, { ownerId: "b", requesterId: "b" });
      await flush();
      // Before either boot ends: the second request did not wait for the first one's device.
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
      clock.advance(50);
      await flush();
      clock.advance(50);
      const granted = await Promise.all([first, second]);

      expect(granted[0].device.id).not.toBe(granted[1].device.id);
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    });

    it("a request arriving while another request is booting a shut-down device provisions its own device rather than waiting for that one", async () => {
      const { clock, driver, harness } = await twoRoomsHarness(false);
      const holder = harness.engine.request(request, { ownerId: "a", requesterId: "a" });
      await flush();
      clock.advance(50);
      const held = await holder;
      await harness.engine.release(held.lease.id, "explicit");
      await harness.engine.settle();
      expect(harness.registry.snapshot.devices).toMatchObject([{ state: "shutdown" }]);

      const booting = harness.engine.request(request, { ownerId: "b", requesterId: "b" });
      await vi.waitFor(() =>
        expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2),
      );
      const other = harness.engine.request(request, { ownerId: "c", requesterId: "c" });
      await flush();
      // Before either boot ends: the other request did not wait for the one booting.
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
      clock.advance(50);
      await flush();
      clock.advance(50);
      const granted = await Promise.all([booting, other]);

      expect(granted[0].device.id).toBe(held.device.id);
      expect(granted[1].device.id).not.toBe(held.device.id);
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    });

    it("under noWait a request arriving during a warm-pool boot provisions its own device", async () => {
      const { clock, driver, first, harness } = await releasedDeviceBooting();

      const second = harness.engine.request(request, {
        noWait: true,
        ownerId: "b",
        requesterId: "b",
      });
      await flush();
      clock.advance(50);
      const granted = await second;

      expect(granted.device.id).not.toBe(first.device.id);
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    });

    it("a request waiting on a warm-pool boot that fails re-plans on the kick and boots the device the failed boot left", async () => {
      const { clock, driver, first, harness } = await releasedDeviceBooting(true);

      const second = harness.engine.request(request, { ownerId: "b", requesterId: "b" });
      await flush();
      clock.advance(50);
      await flush();
      // The kick from the failed boot woke the request: it has started booting the device itself.
      expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(3);
      clock.advance(50);
      const granted = await second;
      await harness.engine.settle();

      // The failed boot left the device `shutdown` and unclaimed, so the request boots it itself.
      expect(granted.device.id).toBe(first.device.id);
      expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(3);
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    });
  });

  it("a release at the running cap with a class request waiting grants the released device and provisions nothing", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.0"],
      clock,
      knownModels: ["iPhone 15", "iPhone 17"],
      modelClasses: { "iPhone 15": "phone", "iPhone 17": "phone" },
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
      modelPreferences: { ios: { phone: ["iPhone 17", "iPhone 15"] } },
    });
    const iphone15 = await seedReady(harness, {
      model: "iPhone 15",
      osVersion: "26.0",
      platform: "ios",
    });
    const holder = await harness.engine.request(
      { model: "iPhone 15", osVersion: "26.0", platform: "ios" },
      { ownerId: "holder", requesterId: "holder" },
    );
    expect(holder.device.id).toBe(iphone15.id);
    const waiter = harness.engine.request(
      { class: "phone", platform: "ios" },
      { ownerId: "waiter", requesterId: "waiter" },
    );
    await flush();
    expect(harness.engine.queueDepth).toBe(1);

    await harness.engine.release(holder.lease.id, "explicit");
    const granted = await waiter;
    await harness.engine.settle();

    expect(granted.device.id).toBe(iphone15.id);
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "device.provisioned")
        .map((event) => event.payload.deviceId),
    ).toEqual([iphone15.id]);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
  });

  it("boots a released iOS device back to ready when the running limit has room", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    expect(
      harness.registry.snapshot.devices.find((item) => item.id === first.device.id)?.state,
    ).toBe("ready");
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2);
  });

  it("with warmPool disabled a released fake iOS device is shutdown and a released fake Android device is shutdown after its snapshot reclaim", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const android = new FakeDriver({
      availableOsVersions: ["36"],
      clock,
      platform: "android",
      reclaimResult: "ready",
      reclaimStrategy: "snapshot",
    });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: 2, maxRunning: 2 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 4,
      },
      warmPoolEnabled: false,
    });
    const iosLease = await harness.engine.request(request, { ownerId: "i", requesterId: "i" });
    const androidLease = await harness.engine.request(androidSpec, {
      ownerId: "a",
      requesterId: "a",
    });

    await harness.engine.release(iosLease.lease.id, "explicit");
    await harness.engine.release(androidLease.lease.id, "explicit");
    await harness.engine.settle();

    const state = (id: string) =>
      harness.registry.snapshot.devices.find((item) => item.id === id)?.state;
    expect(state(iosLease.device.id)).toBe("shutdown");
    expect(state(androidLease.device.id)).toBe("shutdown");
    const events = harness.bus.replay();
    const reclaimed = events.findIndex(
      (event) =>
        event.event === "device.reclaimed" &&
        event.payload.deviceId === androidLease.device.id &&
        event.payload.strategy === "snapshot",
    );
    const shutdown = events.findIndex(
      (event) =>
        event.event === "device.shutdown" &&
        event.payload.deviceId === androidLease.device.id &&
        event.payload.initiator === "warm-pool",
    );
    expect(reclaimed).toBeGreaterThanOrEqual(0);
    expect(shutdown).toBeGreaterThan(reclaimed);
  });
});

describe("createLeasing warm targets", () => {
  const target = { count: 2, model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
  const roomy = {
    android: { maxDevices: 1, maxRunning: 1 },
    ios: { maxDevices: 4, maxRunning: 4 },
    maxRunning: 4,
  };
  const eventsNamed = (harness: Awaited<ReturnType<typeof createHarness>>, name: string) =>
    harness.bus.replay().filter((event) => event.event === name);

  /** Lets the driver's scripted latency elapse, a step at a time, until the pool is quiet. */
  async function drain(
    harness: Awaited<ReturnType<typeof createHarness>>,
    driverClock?: FakeClock,
    stepMs = 50,
  ) {
    for (let round = 0; round < 40; round += 1) {
      await flush();
      harness.clock.advance(stepMs);
      driverClock?.advance(stepMs);
    }
    await flush();
    await harness.engine.settle();
  }

  it("after daemon.started with a target of two and no devices, creates two devices one after the other, the second only after the first is ready", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { makeReady: 50 },
      platform: "ios",
    });
    const harness = await createHarness({ driver, limits: roomy, warmPool: { targets: [target] } });
    await harness.engine.convergeRunningCapacity();

    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await flush();
    // The first is mid-boot: created, not yet ready, and no second one started.
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);
    expect(eventsNamed(harness, "device.ready")).toHaveLength(0);
    await drain(harness, clock);

    const order = harness.bus
      .replay()
      .map((event) => event.event)
      .filter((name) => name === "device.provisioned" || name === "device.ready");
    expect(order).toEqual([
      "device.provisioned",
      "device.ready",
      "device.provisioned",
      "device.ready",
    ]);
    expect(harness.registry.snapshot.devices.map((device) => device.state)).toEqual([
      "ready",
      "ready",
    ]);
  });

  it("on a graceful drain finishes the creation in flight and creates no further device for the target", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { makeReady: 50 },
      platform: "ios",
    });
    const harness = await createHarness({ driver, limits: roomy, warmPool: { targets: [target] } });
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await flush();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);

    const draining = harness.engine.core.drain();
    await drain(harness, clock);
    await draining;

    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);
    expect(harness.registry.snapshot.devices.map((device) => device.state)).toEqual(["ready"]);
  });

  it("creates no device for a target once the warm pool is closed for a stop", async () => {
    const harness = await createHarness({ limits: roomy, warmPool: { targets: [target] } });
    await harness.engine.convergeRunningCapacity();
    harness.engine.core.closeWarmPool();

    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);

    expect(eventsNamed(harness, "device.provisioned")).toEqual([]);
  });

  it("grants the first lease of the targeted kind from a ready device with no booting stage, then keeps the count by creating another", async () => {
    const harness = await createHarness({ limits: roomy, warmPool: { targets: [target] } });
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);
    const progress: LeaseProgress[] = [];

    const granted = await harness.engine.request(request, {
      onProgress: (update) => progress.push(update),
      ownerId: "agent",
      requesterId: "agent",
      ttlMs: 3_600_000,
    });
    await drain(harness);

    expect(progress.map((update) => update.stage)).not.toContain("booting");
    expect(progress.map((update) => update.stage)).not.toContain("provisioning");
    expect(eventsNamed(harness, "lease.granted")[0]).toMatchObject({ payload: { source: "warm" } });
    const states = harness.registry.snapshot.devices.map((device) => device.state).sort();
    expect(states).toEqual(["leased", "ready", "ready"]);
    expect(granted.device.spec).toMatchObject({ model: "iPhone 16", osVersion: "26.5" });
  });

  it("makes one creation attempt per allowed attempt when every boot fails, and recovers when one succeeds", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("makeReady", 1, new DriverCrashError("no boot"));
    driver.failOn("makeReady", 2, new DriverCrashError("no boot"));
    const harness = await createHarness({
      driver,
      limits: roomy,
      warmPool: { targets: [{ ...target, count: 1 }] },
    });
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);

    harness.clock.advance(60_000 - 1);
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);
    harness.clock.advance(1);
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(2);

    harness.clock.advance(2 * 60_000 - 1);
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(2);
    harness.clock.advance(1);
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(3);
    expect(
      harness.registry.snapshot.devices.filter((device) => device.state === "ready"),
    ).toHaveLength(1);
  });

  it("with a target naming an OS that is not installed, starts no install and logs the target short with runtime-missing", async () => {
    const sink = new MemoryLogSink();
    const install = vi.fn(async () => ({ outcome: "installed" as const, version: "27.0" }));
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    const harness = await createHarness({
      components: { claimProvision: () => () => undefined, install },
      driver,
      limits: roomy,
      logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }),
      warmPool: { targets: [{ ...target, osVersion: "27.0" }] },
    });
    await harness.engine.convergeRunningCapacity();

    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);

    expect(install).not.toHaveBeenCalled();
    expect(eventsNamed(harness, "component.install-started")).toEqual([]);
    expect(driver.calls.filter((call) => call.operation === "installComponent")).toEqual([]);
    expect(harness.registry.snapshot.devices).toEqual([]);
    expect(
      sink.records.filter((record) => record.message === "a warm pool target is short"),
    ).toMatchObject([{ fields: { short: "runtime-missing" } }]);
  });

  it("under fresh identity, creates a device before any lease, and after that lease ends and the spent device is deleted, creates the next", async () => {
    const harness = await createHarness({
      identity: { android: "reusable", ios: "fresh" },
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 2,
      },
      warmPool: { targets: [{ ...target, count: 1 }] },
    });
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);
    const [first] = harness.registry.snapshot.devices;
    expect(harness.registry.snapshot.devices).toHaveLength(1);
    expect(first).toMatchObject({ leaseIdentity: "fresh", state: "ready" });

    const granted = await harness.engine.request(request, {
      ownerId: "a",
      requesterId: "a",
      ttlMs: 3_600_000,
    });
    expect(granted.device.id).toBe(first?.id);
    await harness.engine.release(granted.lease.id, "explicit");
    await drain(harness);

    const devices = harness.registry.snapshot.devices.filter(
      (device) => device.state !== "deleted",
    );
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === first?.id),
    ).toMatchObject({ state: "deleted" });
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ leaseIdentity: "fresh", state: "ready" });
    expect(devices[0]?.id).not.toBe(first?.id);
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(2);
  });

  it("shuts a never-leased ready device no target counts down with initiator warm-pool once it has been idle past idle.shutdownAfterMs", async () => {
    const harness = await createHarness({ limits: roomy });
    const device = await seedReady(harness);
    await harness.engine.convergeRunningCapacity();

    harness.clock.advance(30_000);
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices.find((item) => item.id === device.id)?.state).toBe(
      "shutdown",
    );
    expect(eventsNamed(harness, "device.shutdown")).toMatchObject([
      { payload: { deviceId: device.id, initiator: "warm-pool" } },
    ]);
  });

  it("keeps a never-leased ready device a target counts past idle.shutdownAfterMs", async () => {
    const harness = await createHarness({
      limits: roomy,
      warmPool: { targets: [{ ...target, count: 1 }] },
    });
    const device = await seedReady(harness);
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);

    harness.clock.advance(5 * 60_000);
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices.find((item) => item.id === device.id)?.state).toBe(
      "ready",
    );
    expect(eventsNamed(harness, "device.shutdown")).toEqual([]);
    // The reaper reads the same set through the core, so it leaves the device alone too.
    expect([...(await harness.engine.core.targetedDevices())]).toEqual([device.id]);
  });
});

describe("createLeasing's port for the warm pool", () => {
  it("answers each platform's configured default mode, and full where none is configured", async () => {
    const { engine } = await createHarness({ defaultModes: { ios: "slim" } });

    const { defaultMode } = engine.leasing.corePorts.warmPoolDemand;

    expect([defaultMode("ios"), defaultMode("android")]).toEqual(["slim", "full"]);
  });
});

describe("createLeasing a lease ID chosen by the requester", () => {
  const roomy = {
    android: { maxDevices: 2, maxRunning: 2 },
    ios: { maxDevices: 3, maxRunning: 3 },
    maxRunning: 4,
  };

  /** What a caller that sends `leaseId` passes. */
  function asking(requesterId: string, leaseId?: string, more: Record<string, unknown> = {}) {
    return {
      ownerId: requesterId,
      requesterId,
      ...(leaseId === undefined ? {} : { leaseId }),
      ...more,
    };
  }

  /** Leaves `requesterId`'s request for `leaseId` waiting behind the one device. */
  async function withWaiting(requesterId: string, leaseId: string) {
    const harness = await createHarness();
    await harness.engine.request(request, asking("holder"));
    void harness.engine.request(request, asking(requesterId, leaseId)).catch(() => undefined);
    await expect
      .poll(() =>
        harness.registry.leaseRequests().find((record) => record.requesterId === requesterId),
      )
      .toMatchObject({ state: "open" });
    return harness;
  }

  it("a lease request with leaseId gets a lease with exactly that ID", async () => {
    const harness = await createHarness();

    const grant = await harness.engine.request(request, asking("agent-1", "ad-7f3a"));

    expect(grant.lease.id).toBe("ad-7f3a");
    expect(grant.lease).toMatchObject({ idChosenByRequester: true });
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual(["ad-7f3a"]);
  });

  it("a lease request without leaseId gets an lse_ ID as today", async () => {
    const harness = await createHarness();

    const grant = await harness.engine.request(request, asking("agent-1"));

    expect(grant.lease.id).toMatch(/^lse_/);
    expect(grant.lease).toMatchObject({ idChosenByRequester: false });
  });

  it("renew and release by a caller-chosen ID work", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, asking("agent-1", "ad-7f3a"));

    await expect(harness.engine.renew("ad-7f3a", 5_000)).resolves.toMatchObject({
      id: "ad-7f3a",
      ttlMs: 5_000,
    });
    await harness.engine.release("ad-7f3a", "explicit");

    expect(harness.registry.snapshot.leases).toEqual([]);
    expect(
      harness.bus.replay().find((event) => event.event === "lease.released")?.payload,
    ).toMatchObject({
      leaseId: "ad-7f3a",
    });
  });

  it("MyID and myid are two different IDs", async () => {
    const harness = await createHarness({ limits: roomy });

    const first = await harness.engine.request(request, asking("agent-1", "myid"));
    const second = await harness.engine.request(request, asking("agent-2", "MyID"));

    expect([first.lease.id, second.lease.id]).toEqual(["myid", "MyID"]);
  });

  it("a second request for an ID held by an active lease fails with LEASE_ID_TAKEN", async () => {
    const harness = await createHarness({ limits: roomy });
    await harness.engine.request(request, asking("agent-1", "myid"));

    await expect(harness.engine.request(request, asking("agent-2", "myid"))).rejects.toMatchObject({
      leaseId: "myid",
      message: "lease ID myid is already in use",
      name: "LeaseIdTakenError",
    });
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual(["myid"]);
  });

  it("a second request for an ID held by a waiting request fails with LEASE_ID_TAKEN", async () => {
    const harness = await withWaiting("agent-2", "myid");

    const clash = harness.engine.request(request, asking("agent-3", "myid"));
    void clash.catch(() => undefined);

    // Settled at once: a request that was let in would wait for the one device instead.
    await expect(settledOrPending(clash)).resolves.toMatchObject({
      leaseId: "myid",
      name: "LeaseIdTakenError",
    });
  });

  it("a requester that already holds a lease gets REQUESTER_ALREADY_LEASED, not LEASE_ID_TAKEN, even when it repeats its own lease ID", async () => {
    const harness = await createHarness({ limits: roomy });
    const first = await harness.engine.request(request, asking("agent-1", "myid"));

    await expect(harness.engine.request(request, asking("agent-1", "myid"))).rejects.toMatchObject({
      existingLeaseId: first.lease.id,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("a LEASE_ID_TAKEN refusal emits lease.rejected with reason lease-id-taken", async () => {
    const harness = await createHarness({ limits: roomy });
    await harness.engine.request(request, asking("agent-1", "myid"));

    await harness.engine.request(request, asking("agent-2", "myid")).catch(() => undefined);

    const rejected = harness.bus.replay().filter((event) => event.event === "lease.rejected");
    expect(rejected.map((event) => event.payload)).toEqual([
      {
        reason: "lease-id-taken",
        requestId: expect.stringMatching(/^req_/),
        requester: "agent-2",
        requestSpec: request,
      },
    ]);
    expect(rejected.map((event) => event.module)).toEqual(["lease-acquisition-coordinator"]);
  });

  it("lease.requested and lease.rejected requestSpec, and the status waiting spec, carry no leaseId", async () => {
    const harness = await withWaiting("agent-2", "myid");
    await settledOrPending(harness.engine.request(request, asking("agent-3", "myid")));

    const requested = harness.bus.replay().filter((event) => event.event === "lease.requested");
    const rejected = harness.bus.replay().filter((event) => event.event === "lease.rejected");
    expect(requested.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ requester: "agent-2", requestSpec: request }),
    );
    expect(
      rejected.map((event) => (event.payload as { requestSpec: unknown }).requestSpec),
    ).toEqual([request]);
    expect(harness.engine.waitingRequests().map((entry) => entry.spec)).toEqual([request]);
    expect(
      harness.registry.leaseRequests().find((record) => record.requesterId === "agent-2")?.request,
    ).toEqual(request);
  });

  it("a retry with the same idempotency key and the same leaseId replays the first answer", async () => {
    const harness = await createHarness();
    const asker = asking("agent-1", "myid", { idempotencyKey: "key-1" });
    const first = await harness.engine.request(request, asker);

    const retry = await harness.engine.request(request, asker);

    expect(retry).toEqual(first);
    expect(retry.lease.id).toBe("myid");
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });

  it.each([
    ["a different leaseId", "other"],
    ["no leaseId", undefined],
  ])(
    "a retry with the same idempotency key and %s fails with IDEMPOTENCY_CONFLICT",
    async (_name, retryId) => {
      const harness = await createHarness();
      await harness.engine.request(request, asking("agent-1", "myid", { idempotencyKey: "key-1" }));

      await expect(
        harness.engine.request(request, asking("agent-1", retryId, { idempotencyKey: "key-1" })),
      ).rejects.toMatchObject({ name: "IdempotencyConflictError" });
    },
  );

  it("a retry with the same idempotency key that adds a leaseId the first call did not have fails with IDEMPOTENCY_CONFLICT", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(
      request,
      asking("agent-1", undefined, { idempotencyKey: "key-1" }),
    );

    await expect(
      harness.engine.request(request, asking("agent-1", "myid", { idempotencyKey: "key-1" })),
    ).rejects.toMatchObject({ name: "IdempotencyConflictError" });
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([first.lease.id]);
  });

  it("after a daemon restart, an ID held only by a waiting request is accepted again", async () => {
    const before = await withWaiting("agent-2", "myid");
    // Started again with room to spare, so the only thing that could refuse "myid" is the ID.
    const after = await createHarness({ filesystem: before.filesystem, limits: roomy });
    await after.engine.convergeRunningCapacity();

    await expect(after.engine.request(request, asking("agent-3", "myid"))).resolves.toMatchObject({
      lease: { id: "myid" },
    });
  });
});

describe("createLeasing: a gateway dispatch is a probe (ADR 0021)", () => {
  type Harness = Awaited<ReturnType<typeof createHarness>>;

  const holder = { ownerId: "holder", requesterId: "holder" };
  const probeOf = (requesterId: string, extra: Record<string, unknown> = {}) => ({
    fleetRequestId: "req_gw1",
    noWait: true,
    ownerId: requesterId,
    requesterId,
    ...extra,
  });

  function payloads<
    Name extends
      | "lease.declined"
      | "lease.rejected"
      | "lease.requested"
      | "lease.queued"
      | "lease.granted",
  >(harness: Harness, name: Name): Array<EventMap[Name]> {
    return harness.bus
      .replay()
      .filter((event) => event.event === name)
      .map((event) => event.payload as EventMap[Name]);
  }

  async function admittedId(harness: Harness, requesterId: string): Promise<string | undefined> {
    return harness.registry.leaseRequests().find((record) => record.requesterId === requesterId)
      ?.id;
  }

  it("emits lease.declined with reason no-wait and its fleetRequestId, and no lease.rejected, for a probe refused for no capacity", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, holder);

    await expect(harness.engine.request(request, probeOf("gw:one"))).rejects.toBeInstanceOf(
      NoCapacityError,
    );

    expect(payloads(harness, "lease.declined")).toEqual([
      {
        fleetRequestId: "req_gw1",
        reason: "no-wait",
        requestId: await admittedId(harness, "gw:one"),
        requestSpec: request,
        requester: "gw:one",
      },
    ]);
    expect(payloads(harness, "lease.rejected")).toEqual([]);
  });

  it("emits lease.declined with reason unresolvable-spec for a probe naming a model the catalog lacks", async () => {
    const harness = await createHarness();
    const odd = { ...request, osVersion: "1.0" };

    await settledOrPending(harness.engine.request(odd, probeOf("gw:odd")));

    expect(payloads(harness, "lease.declined")).toEqual([
      expect.objectContaining({
        fleetRequestId: "req_gw1",
        reason: "unresolvable-spec",
        requestSpec: odd,
      }),
    ]);
    expect(payloads(harness, "lease.rejected")).toEqual([]);
  });

  it("emits lease.declined for a probe refused already-leased at admission, carrying its requestSpec", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, { ownerId: "gw:one", requesterId: "gw:one" });

    await settledOrPending(harness.engine.request(request, probeOf("gw:one")));

    expect(payloads(harness, "lease.declined")).toEqual([
      {
        fleetRequestId: "req_gw1",
        reason: "already-leased",
        requestId: expect.stringMatching(/^req_/),
        requestSpec: request,
        requester: "gw:one",
      },
    ]);
    expect(payloads(harness, "lease.rejected")).toEqual([]);
  });

  it("emits lease.declined for a probe refused lease-id-taken", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 2, maxRunning: 2 },
        ios: { maxDevices: 3, maxRunning: 3 },
        maxRunning: 4,
      },
    });
    await harness.engine.request(request, { ...holder, leaseId: "myid" });

    await settledOrPending(harness.engine.request(request, probeOf("gw:two", { leaseId: "myid" })));

    expect(payloads(harness, "lease.declined")).toEqual([
      expect.objectContaining({ fleetRequestId: "req_gw1", reason: "lease-id-taken" }),
    ]);
    expect(payloads(harness, "lease.rejected")).toEqual([]);
  });

  it("emits lease.declined for a probe whose boot times out after a progress push, with reason boot-timeout", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    driver.failOn("makeReady", 1, new Error("boot failed"));
    const harness = await createHarness({ driver });
    const stages: string[] = [];

    await settledOrPending(
      harness.engine.request(request, {
        ...probeOf("gw:slow"),
        onProgress: (progress) => stages.push(progress.stage),
      }),
    );

    expect(stages.length).toBeGreaterThan(0);
    expect(payloads(harness, "lease.declined")).toEqual([
      expect.objectContaining({ fleetRequestId: "req_gw1", reason: "boot-timeout" }),
    ]);
    expect(payloads(harness, "lease.rejected")).toEqual([]);
  });

  it("emits lease.declined daemon-restarted with its fleetRequestId at the next start, for a probe still open when the daemon stopped, after the registry is reloaded from disk", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    driver.hangMakeReady();
    const before = await createHarness({ driver });
    void before.engine.request(request, probeOf("gw:open")).catch(() => undefined);
    await expect
      .poll(() =>
        before.registry.leaseRequests().find((record) => record.requesterId === "gw:open"),
      )
      .toMatchObject({ fleetRequestId: "req_gw1", state: "open" });
    const requestId = await admittedId(before, "gw:open");

    const after = await createHarness({ filesystem: before.filesystem });
    await after.engine.convergeRunningCapacity();

    expect(payloads(after, "lease.declined")).toEqual([
      {
        fleetRequestId: "req_gw1",
        reason: "daemon-restarted",
        requestId,
        requestSpec: request,
        requester: "gw:open",
      },
    ]);
    expect(payloads(after, "lease.rejected")).toEqual([]);
  });

  it("still emits lease.rejected no-wait, and no lease.declined, for a local noWait request with no room", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, holder);

    await expect(
      harness.engine.request(request, { noWait: true, ownerId: "local", requesterId: "local" }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    expect(payloads(harness, "lease.rejected")).toEqual([
      expect.objectContaining({ reason: "no-wait", requester: "local" }),
    ]);
    expect(payloads(harness, "lease.declined")).toEqual([]);
  });

  it("carries a probe's fleetRequestId on its lease.requested and lease.granted, and none on a local request's", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 2,
      },
    });

    await harness.engine.request(request, probeOf("gw:one"));
    await harness.engine.request(request, { ownerId: "local", requesterId: "local" });

    expect(payloads(harness, "lease.requested")).toEqual([
      expect.objectContaining({ fleetRequestId: "req_gw1", requester: "gw:one" }),
      expect.not.objectContaining({ fleetRequestId: expect.anything() }),
    ]);
    expect(payloads(harness, "lease.granted")).toEqual([
      expect.objectContaining({ fleetRequestId: "req_gw1", requester: "gw:one" }),
      expect.not.objectContaining({ fleetRequestId: expect.anything() }),
    ]);
  });

  it("answers a declined probe with the error code it answered before, NO_CAPACITY for no room and the already-leased error for an existing lease", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, holder);

    await expect(harness.engine.request(request, probeOf("gw:one"))).rejects.toMatchObject({
      name: "NoCapacityError",
    });
    await expect(harness.engine.request(request, probeOf("holder"))).rejects.toMatchObject({
      existingLeaseId: first.lease.id,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("declines, rather than rejects, a request carrying fleetRequestId whose wait in the queue times out", async () => {
    // The dispatcher only lets a probe in with noWait, so none is ever queued; this reaches the
    // queue's timeout site directly, which applies the same rule as every other.
    const harness = await createHarness();
    await harness.engine.request(request, holder);
    const waiting = harness.engine.request(request, {
      ...probeOf("gw:late", { noWait: false }),
      timeoutMs: 10,
    });
    await flush();
    harness.clock.advance(10);

    expect(await settledOrPending(waiting)).toBeInstanceOf(QueueTimeoutError);

    expect(payloads(harness, "lease.declined")).toEqual([
      expect.objectContaining({ fleetRequestId: "req_gw1", reason: "timeout" }),
    ]);
    expect(payloads(harness, "lease.rejected")).toEqual([]);
  });

  describe("a provision that fails twice", () => {
    function failingTwice() {
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
      });
      driver.failOn("provision", 1, new DriverCrashError("simulator exited"));
      driver.failOn("provision", 2, new DriverCrashError("simulator exited again"));
      return driver;
    }

    it("declines a probe with reason no-wait, answers NO_CAPACITY, and emits no lease.queued", async () => {
      const harness = await createHarness({ driver: failingTwice() });

      const outcome = await settledOrPending(harness.engine.request(request, probeOf("gw:one")));

      expect(outcome).toBeInstanceOf(NoCapacityError);
      expect(payloads(harness, "lease.declined")).toEqual([
        expect.objectContaining({ fleetRequestId: "req_gw1", reason: "no-wait" }),
      ]);
      expect(payloads(harness, "lease.queued")).toEqual([]);
      expect(payloads(harness, "lease.rejected")).toEqual([]);
    });

    it("still queues a local request in the same case", async () => {
      const harness = await createHarness({ driver: failingTwice() });

      const outcome = await settledOrPending(
        harness.engine.request(request, { ownerId: "local", requesterId: "local" }),
      );

      expect(outcome).toBe("still pending");
      expect(payloads(harness, "lease.queued")).toEqual([expect.objectContaining({})]);
      expect(payloads(harness, "lease.declined")).toEqual([]);
    });
  });
});
