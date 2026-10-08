import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  FakeClock,
  FakeSystemStats,
  JsonLinesLogger,
  type Logger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";
import { AcquisitionPlanner } from "./acquisition-planner.js";
import {
  CapacityCoordinator,
  capacityDevice,
  capacityDevices,
  type Config,
  DeviceOperationClaims,
  DeviceProvisioner,
  ComponentInstaller,
  DriverCatalog,
  type ModelPreferences,
  DiskSpaceGuard,
  type Driver,
  DriverCrashError,
  RuntimeMissingError,
  UnsupportedRequestOptionError,
  type DeviceMode,
  type DeviceSpec,
  type Platform,
  specMode,
  type CatalogReader,
  ManagedDeviceLifecycle,
  Registry,
  SerializedDecision,
} from "../core/index.js";
import { createCapacityStrategy, readyTransitionUpdate } from "../core/testing.js";
import { FakeDriver } from "../core/testing.js";
import {
  LeaseAcquisitionCoordinator,
  type LeaseAcquisitionCoordinatorOptions,
  NoCapacityError,
} from "./lease-acquisition-coordinator.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import {
  IdempotencyConflictError,
  LeaseRequestBook,
  LeaseRequestForbiddenError,
} from "./lease-request-book.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { type LeaseRequestOptions, RequesterAlreadyLeasedError, WaitQueue } from "./wait-queue.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";
const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function config(maxDevices = 1, maxRunning = 1): Config {
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
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: {
      defaultTtlMs: 100,
      maxTtlMs: 100,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
    },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices, maxRunning },
          ios: { maxDevices, maxRunning },
          maxRunning,
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
  };
}

// fallow-ignore-next-line complexity -- one test harness builder; each option is a plain pass-through to a collaborator.
async function createHarness(
  options: {
    /** Stands in for the installer, when a test needs to see whether it was reached at all. */
    readonly components?: Pick<ComponentInstaller, "install">;
    readonly defaultModes?: Readonly<Partial<Record<Platform, DeviceMode>>>;
    readonly drivers?: readonly Driver[];
    /** Free disk the installer sees; unlimited unless a test says otherwise. */
    readonly freeDiskBytes?: number;
    /** Stands between the coordinator and the real lifecycle, when a test interleaves other work. */
    readonly lifecycle?: (
      lifecycle: ManagedDeviceLifecycle,
      collaborators: {
        readonly capacity: CapacityCoordinator;
        readonly claims: DeviceOperationClaims;
        readonly registry: Registry;
      },
    ) => LeaseAcquisitionCoordinatorOptions["lifecycle"];
    readonly logger?: Logger;
    readonly maxDevices?: number;
    readonly maxRunning?: number;
    /** The class preference lists the daemon would build from config and the drivers. */
    readonly preferences?: ModelPreferences;
    /** Stands in for the catalog reader a class request reads, when a test scripts it. */
    readonly catalogReader?: Pick<CatalogReader, "listCatalog">;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver =
    (options.drivers?.[0] as FakeDriver | undefined) ??
    new FakeDriver({ clock, platform: "ios", availableOsVersions: ["26.5"] });
  const drivers = options.drivers ?? [driver];
  let nextId = 0;
  const filesystem = new MemoryFilesystem();
  const registry = await Registry.load({
    clock,
    eventBus: bus,
    filesystem,
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const decisions = new SerializedDecision();
  const claims = new DeviceOperationClaims();
  const catalog = new DriverCatalog(drivers, { preferences: options.preferences ?? {} });
  const capacity = new CapacityCoordinator(
    createCapacityStrategy(
      config(options.maxDevices, options.maxRunning).capacity,
      new FakeSystemStats({
        cpuCount: 8,
        totalRamBytes: 32 * gibibyte,
      }),
    ),
  );
  const lifecycle = new ManagedDeviceLifecycle(catalog, registry, decisions, claims, clock);
  const provisioner = new DeviceProvisioner({
    catalog,
    claims,
    clock,
    // Never refuses: what a removal does to provisioning is `DeviceProvisioner`'s own test.
    components: { claimProvision: () => () => undefined },
    decisions,
    lifecycle,
    registry,
  });
  const expiry = new LeaseExpiryScheduler(clock, async () => undefined);
  const leases = new LeaseLifecycle({
    clock,
    eventBus: bus,
    expiryScheduler: expiry,
    registry,
    ttl: { defaultMs: 100 },
  });
  let coordinator: LeaseAcquisitionCoordinator | undefined;
  /** Every id minted for a request, in order. */
  const requestIds: string[] = [];
  const idGenerator = {
    generate: () => {
      const id = `request-${nextId++}`;
      requestIds.push(id);
      return id;
    },
  };
  const queue = new WaitQueue({
    clock,
    idGenerator,
    onTimeout: (waiter) => {
      bus.emit(
        "lease.rejected",
        {
          requestId: waiter.id,
          requester: waiter.options.requesterId,
          requestSpec: waiter.request,
          reason: "timeout",
        },
        "wait-queue",
      );
      coordinator?.kick();
    },
  });
  const components =
    options.components ??
    new ComponentInstaller({
      clock,
      decisions,
      diskSpace: new DiskSpaceGuard(),
      drivers: catalog,
      eventBus: bus,
      filesystem: new MemoryFilesystem(options.freeDiskBytes),
      registry,
      timeoutMs: 1_200_000,
    });
  coordinator = new LeaseAcquisitionCoordinator({
    catalog: options.catalogReader ?? catalog,
    claims,
    components,
    decisions,
    defaultModes: options.defaultModes ?? {},
    drivers: catalog,
    eventBus: bus,
    idGenerator,
    leases,
    lifecycle: options.lifecycle?.(lifecycle, { capacity, claims, registry }) ?? lifecycle,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    modelPreferences: options.preferences ?? {},
    planner: new AcquisitionPlanner(capacity, claims),
    provisioner,
    queue,
    registry,
    requests: new LeaseRequestBook({
      decisions,
      // The daemon's classifier, cut down to the codes these tests read back.
      describeFailure: (error) => ({
        code: error instanceof NoCapacityError ? "NO_CAPACITY" : "INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      }),
      store: registry,
    }),
  });
  return {
    bus,
    capacity,
    claims,
    clock,
    components,
    coordinator,
    driver,
    filesystem,
    queue,
    registry,
    requestIds,
  };
}

async function seedReady(
  harness: Awaited<ReturnType<typeof createHarness>>,
  spec: DeviceSpec = request,
) {
  const driverDevice = await harness.driver.provision(spec);
  const provisioned = await harness.registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec,
  });
  const ready = await harness.driver.makeReady(driverDevice, {
    mode: specMode(spec),
    purpose: "prepare",
  });
  return harness.registry.transitionDevice(
    provisioned.id,
    "ready",
    { event: "device.ready", payload: { bootDuration: 0, deviceId: provisioned.id } },
    readyTransitionUpdate(ready),
  );
}

async function flush(): Promise<void> {
  for (let count = 0; count < 50; count += 1) await Promise.resolve();
}

/** Lets fire-and-forget device work that crosses several registry writes run to rest. */
async function settle(): Promise<void> {
  for (let count = 0; count < 20; count += 1) await new Promise((resolve) => setImmediate(resolve));
}

function capturingLogger(): { readonly logger: Logger; readonly sink: MemoryLogSink } {
  const sink = new MemoryLogSink();
  return { logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }), sink };
}

async function seedShutdown(
  harness: Awaited<ReturnType<typeof createHarness>>,
  spec: DeviceSpec = request,
) {
  const ready = await seedReady(harness, spec);
  await harness.driver.shutdown({
    address: ready.address ?? "",
    deviceId: ready.driverDeviceId,
    driverData: ready.driverData,
  });
  return harness.registry.transitionDevice(ready.id, "shutdown", {
    event: "device.shutdown",
    payload: { deviceId: ready.id, initiator: "test" },
  });
}

function installs(driver: FakeDriver): readonly unknown[] {
  return driver.calls
    .filter((call) => call.operation === "installComponent")
    .map((call) => call.arguments[0]);
}

describe("LeaseAcquisitionCoordinator: missing runtimes", () => {
  it("installs once for two lease requests for the same missing runtime, and grants both", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });

    const first = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    const second = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "b",
      requesterId: "b",
    });
    await flush();
    driver.releaseInstalls();

    const grants = await Promise.all([first, second]);
    expect(grants.map((grant) => grant.device.spec.osVersion)).toEqual(["26.5", "26.5"]);
    expect(installs(driver)).toEqual(["26.5"]);
  });

  it("starts the install for a second missing runtime on the same platform only after the first one has ended", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });

    const first = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    const second = harness.coordinator.request(
      { ...request, osVersion: "27.0" },
      { allowDownload: true, ownerId: "b", requesterId: "b" },
    );
    await flush();
    expect(installs(driver)).toEqual(["26.5"]);

    driver.releaseInstalls();
    await first;
    await settle();
    expect(installs(driver)).toEqual(["26.5", "27.0"]);
    await expect(second).resolves.toMatchObject({ device: { spec: { osVersion: "27.0" } } });
  });

  it("starts no install for a request that waited behind an install which made its runtime available, and grants it", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });

    const byVersion = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    // No version: the fake names its word for newest, a different component that waits its turn.
    const newest = harness.coordinator.request(
      { model: "iPhone 16", platform: "ios" },
      { allowDownload: true, ownerId: "b", requesterId: "b" },
    );
    await flush();
    driver.releaseInstalls();

    await expect(byVersion).resolves.toMatchObject({ device: { spec: { osVersion: "26.5" } } });
    await expect(newest).resolves.toMatchObject({ device: { spec: { osVersion: "26.5" } } });
    expect(installs(driver)).toEqual(["26.5"]);
  });

  it("attributes the install a lease request starts to that request's requester", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ drivers: [driver] });
    const started: unknown[] = [];
    harness.bus.subscribe("component.install-started", (envelope) => {
      started.push(envelope.payload);
    });

    await harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "owner",
      requesterId: "agent-7",
    });

    expect(started).toEqual([{ componentId: "26.5", platform: "ios", requesterId: "agent-7" }]);
  });

  it("starts no install when resolving again fails some other way by the time the request reaches the front, and fails with that error", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const broken = new DriverCrashError("simctl list failed");
    // The first resolve finds the runtime missing; the check at the front of the queue breaks.
    driver.failOn("resolveSpec", 2, broken);
    driver.failOn("resolveSpec", 3, broken);
    const harness = await createHarness({ drivers: [driver] });

    await expect(
      harness.coordinator.request(request, { allowDownload: true, ownerId: "a", requesterId: "a" }),
    ).rejects.toBe(broken);
    expect(installs(driver)).toEqual([]);
  });

  it("fails a request without allowDownload for a missing runtime with RuntimeMissingError, and never calls the installer", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const asked: unknown[] = [];
    const harness = await createHarness({
      components: {
        install: async (call) => {
          asked.push(call);
          return { outcome: "installed", version: "26.5" };
        },
      },
      drivers: [driver],
    });

    await expect(
      harness.coordinator.request(request, { ownerId: "a", requesterId: "a" }),
    ).rejects.toMatchObject({ component: "26.5", name: "RuntimeMissingError" });
    expect(asked).toEqual([]);
  });

  it("fails the request with InsufficientDiskSpaceError when the install does not fit, and never calls installComponent", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: [],
      clock,
      componentFootprint: { bytes: 8 * gibibyte, path: "/" },
      platform: "ios",
    });
    const harness = await createHarness({ drivers: [driver], freeDiskBytes: gibibyte });

    await expect(
      harness.coordinator.request(request, { allowDownload: true, ownerId: "a", requesterId: "a" }),
    ).rejects.toMatchObject({ name: "InsufficientDiskSpaceError" });
    expect(installs(driver)).toEqual([]);
  });
});

describe("LeaseAcquisitionCoordinator: download progress", () => {
  type Progress = Parameters<NonNullable<LeaseRequestOptions["onProgress"]>>[0];

  function downloading(progress: readonly Progress[]): readonly Progress[] {
    return progress.filter((report) => report.stage === "downloading");
  }

  it("tells a request that starts a download downloading, naming the component and not waiting, before provisioning", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ drivers: [driver] });
    const progress: Progress[] = [];

    await harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => progress.push(report),
      ownerId: "a",
      requesterId: "a",
    });

    expect(progress[0]).toEqual({ component: "26.5", stage: "downloading", waiting: false });
    const provisioning = progress.findIndex((report) => report.stage === "provisioning");
    expect(provisioning).toBeGreaterThan(0);
    expect(progress.slice(provisioning).some((report) => report.stage === "downloading")).toBe(
      false,
    );
  });

  it("tells a request behind another download on its platform that it is waiting, then not waiting when its own install starts", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });
    const progress: Progress[] = [];

    const first = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    const second = harness.coordinator.request(
      { ...request, osVersion: "27.0" },
      {
        allowDownload: true,
        onProgress: (report) => progress.push(report),
        ownerId: "b",
        requesterId: "b",
      },
    );
    await flush();
    expect(progress).toEqual([{ component: "27.0", stage: "downloading", waiting: true }]);

    driver.releaseInstalls();
    await first;
    await settle();
    expect(installs(driver)).toEqual(["26.5", "27.0"]);
    expect(downloading(progress)).toEqual([
      { component: "27.0", stage: "downloading", waiting: true },
      { component: "27.0", stage: "downloading", waiting: false },
      { component: "27.0", percent: 100, stage: "downloading", waiting: false },
    ]);
    await expect(second).resolves.toMatchObject({ device: { spec: { osVersion: "27.0" } } });
  });

  it("tells a request that joins a download already running its latest percentage at once", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: [],
      clock,
      installProgress: [12, 41],
      platform: "ios",
    });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });
    const joined: Progress[] = [];

    const first = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    await flush();
    expect(installs(driver)).toEqual(["26.5"]);
    const second = harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => joined.push(report),
      ownerId: "b",
      requesterId: "b",
    });
    await flush();

    // The driver is still holding: this is the replay, not a later report.
    expect(joined).toEqual([
      { component: "26.5", percent: 41, stage: "downloading", waiting: false },
    ]);
    driver.releaseInstalls();
    await Promise.all([first, second]);
    expect(installs(driver)).toEqual(["26.5"]);
  });

  it("sends a percentage the driver reports twice to the requester once", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: [],
      clock,
      installProgress: [30, 30, 60],
      platform: "ios",
    });
    const harness = await createHarness({ drivers: [driver] });
    const progress: Progress[] = [];

    await harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => progress.push(report),
      ownerId: "a",
      requesterId: "a",
    });

    expect(downloading(progress)).toEqual([
      { component: "26.5", stage: "downloading", waiting: false },
      { component: "26.5", percent: 30, stage: "downloading", waiting: false },
      { component: "26.5", percent: 60, stage: "downloading", waiting: false },
      { component: "26.5", percent: 100, stage: "downloading", waiting: false },
    ]);
  });

  it("sends a request waiting on an install percent 100 once, before provisioning", async () => {
    const clock = new FakeClock(1_000);
    // An iOS download's last report before the runtime is mounted.
    const driver = new FakeDriver({
      availableOsVersions: [],
      clock,
      installProgress: [99.3],
      platform: "ios",
    });
    const harness = await createHarness({ drivers: [driver] });
    const progress: Progress[] = [];

    await harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => progress.push(report),
      ownerId: "a",
      requesterId: "a",
    });

    const complete = progress.filter(
      (report) => report.stage === "downloading" && report.percent === 100,
    );
    expect(complete).toEqual([
      { component: "26.5", percent: 100, stage: "downloading", waiting: false },
    ]);
    const provisioning = progress.findIndex((report) => report.stage === "provisioning");
    expect(provisioning).toBeGreaterThan(progress.indexOf(complete[0] as Progress));
    expect(progress.slice(provisioning).some((report) => report.stage === "downloading")).toBe(
      false,
    );
  });

  it("sends a percentage of 41.7 as 41, and one that rounds down to the last sent not at all", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: [],
      clock,
      installProgress: [41.7, 41.9],
      platform: "ios",
    });
    const harness = await createHarness({ drivers: [driver] });
    const progress: Progress[] = [];

    await harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => progress.push(report),
      ownerId: "a",
      requesterId: "a",
    });

    expect(downloading(progress)).toEqual([
      { component: "26.5", stage: "downloading", waiting: false },
      { component: "26.5", percent: 41, stage: "downloading", waiting: false },
      { component: "26.5", percent: 100, stage: "downloading", waiting: false },
    ]);
  });

  it("sends a driver's percentage outside 0 to 100 as the nearest bound, and one that is not a number as no percent", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: [],
      clock,
      installProgress: [10, Number.NaN, -5, 150],
      platform: "ios",
    });
    const harness = await createHarness({ drivers: [driver] });
    const progress: Progress[] = [];

    await harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => progress.push(report),
      ownerId: "a",
      requesterId: "a",
    });

    expect(downloading(progress)).toEqual([
      { component: "26.5", stage: "downloading", waiting: false },
      { component: "26.5", percent: 10, stage: "downloading", waiting: false },
      { component: "26.5", stage: "downloading", waiting: false },
      { component: "26.5", percent: 0, stage: "downloading", waiting: false },
      { component: "26.5", percent: 100, stage: "downloading", waiting: false },
    ]);
  });

  it("sends no downloading stage to a request whose runtime is installed", async () => {
    const harness = await createHarness();
    const progress: Progress[] = [];

    await harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => progress.push(report),
      ownerId: "a",
      requesterId: "a",
    });

    expect(progress.map((report) => report.stage)).toContain("provisioning");
    expect(downloading(progress)).toEqual([]);
  });

  it("sends no downloading stage to a request without allowDownload for a missing runtime", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ drivers: [driver] });
    const progress: Progress[] = [];

    await expect(
      harness.coordinator.request(request, {
        onProgress: (report) => progress.push(report),
        ownerId: "a",
        requesterId: "a",
      }),
    ).rejects.toMatchObject({ name: "RuntimeMissingError" });
    expect(progress).toEqual([]);
  });

  it("tells a request that waited and then needed no install that it was waiting, then provisioning, and never not waiting", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });
    const progress: Progress[] = [];

    const byVersion = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    // No version: the fake names its word for newest, a different component that waits its turn
    // and finds, at the front, that the first install made its runtime available.
    const newest = harness.coordinator.request(
      { model: "iPhone 16", platform: "ios" },
      {
        allowDownload: true,
        onProgress: (report) => progress.push(report),
        ownerId: "b",
        requesterId: "b",
      },
    );
    await flush();
    driver.releaseInstalls();
    await Promise.all([byVersion, newest]);

    expect(installs(driver)).toEqual(["26.5"]);
    expect(progress[0]).toMatchObject({ stage: "downloading", waiting: true });
    expect(
      downloading(progress).every((report) => report.stage === "downloading" && report.waiting),
    ).toBe(true);
    expect(progress[1]).toMatchObject({ stage: "provisioning" });
  });
});

describe("LeaseAcquisitionCoordinator", () => {
  it("rejects a second request from a requester whose first is still pending, with lease.rejected already-leased", async () => {
    // The one-lease-or-pending-request-per-requester rule is enforced here, inside the admission
    // decision, and nowhere below it: the queue keeps no check of its own. A requester holding a
    // lease is createLeasing's "enforces one active request or lease per requester" case.
    const harness = await createHarness({ maxDevices: 1, maxRunning: 1 });
    await harness.coordinator.request(request, { ownerId: "holder", requesterId: "holder" });
    const pending = harness.coordinator.request(request, {
      ownerId: "agent",
      requesterId: "agent",
    });
    pending.catch(() => undefined);
    await flush();
    expect(harness.queue.hasPendingRequester("agent")).toBe(true);
    const rejections: unknown[] = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejections.push(envelope.payload));

    const duplicate = harness.coordinator.request(request, {
      ownerId: "agent",
      requesterId: "agent",
    });
    const duplicateState = promiseState(duplicate);
    await flush();

    expect(duplicateState.state).toBe("rejected");
    await expect(duplicate).rejects.toMatchObject({
      existingLeaseId: undefined,
      name: "RequesterAlreadyLeasedError",
      requesterId: "agent",
    });
    expect(rejections).toEqual([
      {
        reason: "already-leased",
        requestId: expect.stringMatching(/^req_/),
        requester: "agent",
        requestSpec: request,
      },
    ]);
    expect(harness.queue.depth).toBe(1);
  });

  it.each([["provisioned"], ["ready"]] as const)(
    "hands the owning driver's lease environment to a %s device's grant",
    async (path) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        leaseEnvironment: { SIMLOCK_IOS_DEVICE_SET: "/home/agent/.simlock/devices/ios" },
        platform: "ios",
      });
      const harness = await createHarness({ drivers: [driver] });
      // Both acquisition paths funnel through the same construction site; asserting only
      // the fresh-provision one would leave a warm-pool grant free to carry nothing.
      if (path === "ready") await seedReady(harness);

      const granted = await harness.coordinator.request(request, {
        ownerId: "agent",
        requesterId: "agent",
      });

      expect(granted.environment).toEqual({
        SIMLOCK_IOS_DEVICE_SET: "/home/agent/.simlock/devices/ios",
      });
    },
  );

  it("grants a device from a driver contributing nothing an empty environment", async () => {
    const harness = await createHarness();

    const granted = await harness.coordinator.request(request, {
      ownerId: "agent",
      requesterId: "agent",
    });

    expect(granted.environment).toEqual({});
  });

  it("rejects missing drivers and unresolved specs without leaving pending demand", async () => {
    const empty = await createHarness({ drivers: [] });
    await expect(
      empty.coordinator.request(request, {
        ownerId: "missing-driver",
        requesterId: "missing-driver",
      }),
    ).rejects.toThrow("No driver registered");
    expect(empty.coordinator.queueDepth).toBe(0);

    const harness = await createHarness();
    await expect(
      harness.coordinator.request(
        { ...request, osVersion: "99" },
        { ownerId: "bad-spec", requesterId: "bad-spec" },
      ),
    ).rejects.toThrow("Runtime missing");
    expect(harness.coordinator.queueDepth).toBe(0);
  });

  it("grants a request queued while a new device was booting a second new device once the first is granted, with no release", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    harness.driver.hangMakeReady();

    const first = harness.coordinator.request(request, { ownerId: "a", requesterId: "a" });
    await settle();
    const second = harness.coordinator.request(request, { ownerId: "b", requesterId: "b" });
    let secondDeviceId: string | undefined;
    void second.then((grant) => {
      secondDeviceId = grant.device.id;
    });
    await settle();
    expect(harness.coordinator.queueDepth).toBe(1);

    harness.driver.releaseMakeReady();
    const firstGrant = await first;
    await settle();

    expect({
      queueDepth: harness.coordinator.queueDepth,
      secondGranted: secondDeviceId !== undefined,
      sameDevice: secondDeviceId === firstGrant.device.id,
    }).toEqual({ queueDepth: 0, secondGranted: true, sameDevice: false });
  });

  it("grants a request queued behind another request booting a shut-down device once that device is granted, with no release", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const held = await Promise.all([
      harness.coordinator.request(request, { ownerId: "x", requesterId: "x" }),
      harness.coordinator.request(request, { ownerId: "y", requesterId: "y" }),
    ]);
    const booting = harness.coordinator.request(request, { ownerId: "a", requesterId: "a" });
    await settle();
    // Both devices come back shut down without the release path, so only the kick below wakes
    // the queue; its head boots one of them and holds there.
    harness.driver.hangMakeReady();
    for (const grant of held) {
      await harness.registry.beginRelease(grant.lease.id);
      await harness.registry.transitionDevice(grant.device.id, "shutdown", {
        event: "device.reclaimed",
        payload: { deviceId: grant.device.id, duration: 0, strategy: "wipe" },
      });
    }
    harness.coordinator.kick();
    await settle();
    const second = harness.coordinator.request(request, { ownerId: "b", requesterId: "b" });
    let secondDeviceId: string | undefined;
    void second.then((grant) => {
      secondDeviceId = grant.device.id;
    });
    await settle();
    expect(harness.coordinator.queueDepth).toBe(2);

    harness.driver.releaseMakeReady();
    const bootedGrant = await booting;
    await settle();

    expect({
      queueDepth: harness.coordinator.queueDepth,
      secondGranted: secondDeviceId !== undefined,
      sameDevice: secondDeviceId === bootedGrant.device.id,
    }).toEqual({ queueDepth: 0, secondGranted: true, sameDevice: false });
  });

  it("grants a request queued behind a request whose shut-down device failed to boot and then to be destroyed, when another shut-down device and a running slot are free, with no release", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const held = await Promise.all([
      harness.coordinator.request(request, { ownerId: "x", requesterId: "x" }),
      harness.coordinator.request(request, { ownerId: "y", requesterId: "y" }),
    ]);
    const failing = harness.coordinator.request(request, { ownerId: "a", requesterId: "a" });
    void failing.catch(() => undefined);
    const second = harness.coordinator.request(request, { ownerId: "b", requesterId: "b" });
    const secondState = promiseState(second);
    await settle();
    expect(harness.coordinator.queueDepth).toBe(2);
    // Makeready calls 1 and 2 readied the held devices; call 3 is the head's boot. Its device
    // then fails to be destroyed, so it stays claimed and its running slot stays reserved.
    harness.driver.failOn("makeReady", 3, new DriverCrashError("simulator never booted"));
    harness.driver.failOn("destroy", 1, new DriverCrashError("simulator would not die"));
    // Both devices come back shut down without the release path, so only the kick below wakes
    // the queue; its head is the request that fails.
    for (const grant of held) {
      await harness.registry.beginRelease(grant.lease.id);
      await harness.registry.transitionDevice(grant.device.id, "shutdown", {
        event: "device.reclaimed",
        payload: { deviceId: grant.device.id, duration: 0, strategy: "wipe" },
      });
    }
    harness.coordinator.kick();
    await settle();
    await expect(failing).rejects.toMatchObject({ name: "BootTimeoutError" });
    const failedDeviceId = (
      harness.driver.calls.filter((call) => call.operation === "destroy")[0]?.arguments[0] as
        | { readonly deviceId: string }
        | undefined
    )?.deviceId;
    const otherDevice = held
      .map((grant) => grant.device)
      .find((device) => device.driverDeviceId !== failedDeviceId);

    expect({ queueDepth: harness.coordinator.queueDepth, second: secondState.state }).toEqual({
      queueDepth: 0,
      second: "fulfilled",
    });
    expect(failedDeviceId).toBeDefined();
    expect(otherDevice).toBeDefined();
    expect((await second).device.id).toBe(otherDevice?.id);
  });

  it("leaves a request that still cannot be served queued once, with no new work, when the device it queued behind is granted", async () => {
    const harness = await createHarness({ maxDevices: 1, maxRunning: 1 });
    harness.driver.hangMakeReady();
    const queuedEvents: unknown[] = [];
    harness.bus.subscribe("lease.queued", (envelope) => {
      queuedEvents.push(envelope.payload);
    });
    const progress: string[] = [];

    const first = harness.coordinator.request(request, { ownerId: "a", requesterId: "a" });
    await settle();
    const second = harness.coordinator.request(request, {
      onProgress: (update) => progress.push(update.stage),
      ownerId: "b",
      requesterId: "b",
    });
    void second.catch(() => undefined);
    await settle();

    harness.driver.releaseMakeReady();
    await first;
    await settle();

    expect({
      progress,
      provisions: harness.driver.calls.filter((call) => call.operation === "provision").length,
      queueDepth: harness.coordinator.queueDepth,
      queuedEvents: queuedEvents.length,
    }).toEqual({ progress: ["queued"], provisions: 1, queueDepth: 1, queuedEvents: 1 });
  });

  it("boots shutdown inventory and evicts managed demand before provisioning", async () => {
    const bootHarness = await createHarness();
    const ready = await seedReady(bootHarness);
    await bootHarness.driver.shutdown({
      address: ready.address ?? "",
      deviceId: ready.driverDeviceId,
      driverData: ready.driverData,
    });
    await bootHarness.registry.transitionDevice(ready.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ready.id, initiator: "test" },
    });
    const progress: string[] = [];
    await expect(
      bootHarness.coordinator.request(request, {
        onProgress: (update) => progress.push(update.stage),
        requesterId: "boot",
        ownerId: "boot",
      }),
    ).resolves.toMatchObject({ device: { id: ready.id } });
    expect(progress).toEqual(["booting"]);

    const eviction = await createHarness();
    const old = await seedReady(eviction, { ...request, model: "iPhone SE" });
    await expect(
      eviction.coordinator.request(request, {
        ownerId: "new-spec",
        requesterId: "new-spec",
      }),
    ).resolves.toMatchObject({ device: { spec: request } });
    expect(eviction.registry.snapshot.devices.find((device) => device.id === old.id)?.state).toBe(
      "deleted",
    );
  });

  it("drains a cancelled in-flight boot before maintenance returns", async () => {
    const harness = await createHarness();
    const shutdown = await seedReady(harness);
    await harness.driver.shutdown({
      address: shutdown.address ?? "",
      deviceId: shutdown.driverDeviceId,
      driverData: shutdown.driverData,
    });
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    harness.driver.hangMakeReady();
    const makeReadyBeforeRequest = harness.driver.calls.filter(
      (call) => call.operation === "makeReady",
    ).length;

    const acquisition = harness.coordinator.request(request, {
      requesterId: "drained",
      ownerId: "drained",
    });
    await flush();
    expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
      makeReadyBeforeRequest + 1,
    );

    let maintenanceReturned = false;
    const maintenance = harness.coordinator.beginMaintenance().then(() => {
      maintenanceReturned = true;
    });
    await flush();
    expect(maintenanceReturned).toBe(false);
    expect(harness.registry.snapshot.leases).toEqual([]);
    await expect(
      harness.coordinator.request(request, {
        ownerId: "during-maintenance",
        requesterId: "during-maintenance",
      }),
    ).rejects.toMatchObject({ name: "NukeCancelledError" });

    harness.driver.releaseMakeReady();
    await maintenance;
    await expect(acquisition).rejects.toMatchObject({ name: "NukeCancelledError" });
    expect(harness.registry.snapshot.leases).toEqual([]);

    await harness.coordinator.endMaintenance();
  });

  it("coalesces simultaneous kicks for the same queued waiter", async () => {
    const harness = await createHarness({ maxDevices: 2 });
    const first = await harness.coordinator.request(request, {
      requesterId: "first",
      ownerId: "first",
    });
    const shutdown = await seedReady(harness);
    await harness.driver.shutdown({
      address: shutdown.address ?? "",
      deviceId: shutdown.driverDeviceId,
      driverData: shutdown.driverData,
    });
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });

    const queued = harness.coordinator.request(request, {
      ownerId: "queued",
      requesterId: "queued",
    });
    await flush();
    harness.driver.hangMakeReady();
    await harness.registry.beginRelease(first.lease.id);
    const leased = harness.registry.snapshot.devices.find(
      (candidate) => candidate.id === first.device.id,
    );
    if (leased === undefined) throw new Error("expected leased device");
    await harness.registry.transitionDevice(leased.id, "shutdown", {
      event: "device.reclaimed",
      payload: { deviceId: leased.id, duration: 0, strategy: "wipe" },
    });

    const makeReadyBeforeKick = harness.driver.calls.filter(
      (call) => call.operation === "makeReady",
    ).length;
    harness.coordinator.kick();
    harness.coordinator.kick();
    await flush();
    expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
      makeReadyBeforeKick + 1,
    );

    let maintenanceReturned = false;
    const maintenance = harness.coordinator.beginMaintenance().then(() => {
      maintenanceReturned = true;
    });
    await flush();
    expect(maintenanceReturned).toBe(false);
    harness.driver.releaseMakeReady();
    await maintenance;
    await expect(queued).rejects.toMatchObject({ name: "NukeCancelledError" });
    await harness.coordinator.endMaintenance();
  });

  it("cancels a queued request, emits lease.rejected(cancelled), and frees the requester immediately", async () => {
    const harness = await createHarness();
    await harness.coordinator.request(request, {
      ownerId: "first",
      requesterId: "first",
    });
    const queued = harness.coordinator.request(request, {
      ownerId: "queued",
      requesterId: "queued",
    });
    await flush();
    expect(harness.coordinator.queueDepth).toBe(1);

    const rejections: unknown[] = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejections.push(envelope.payload));

    await expect(harness.coordinator.cancelPending("queued")).resolves.toBe("cancelled");
    await expect(queued).rejects.toMatchObject({ name: "RequestCancelledError" });
    expect(harness.coordinator.queueDepth).toBe(0);
    expect(rejections).toContainEqual({
      reason: "cancelled",
      requestId: expect.stringMatching(/^req_/),
      requester: "queued",
      requestSpec: request,
    });

    // No capacity remains (still held by "first"), but crucially this is NoCapacityError,
    // not RequesterAlreadyLeasedError -- the cancelled requester is no longer pending.
    await expect(
      harness.coordinator.request(request, {
        noWait: true,
        ownerId: "queued",
        requesterId: "queued",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("reports not-found for a requester with no pending waiter", async () => {
    const harness = await createHarness();
    await expect(harness.coordinator.cancelPending("nobody")).resolves.toBe("not-found");
  });

  it("reports not-cancellable while device work is already in flight, matching the queue timeout's envelope", async () => {
    const harness = await createHarness();
    const shutdown = await seedReady(harness);
    await harness.driver.shutdown({
      address: shutdown.address ?? "",
      deviceId: shutdown.driverDeviceId,
      driverData: shutdown.driverData,
    });
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    harness.driver.hangMakeReady();

    const acquisition = harness.coordinator.request(request, {
      requesterId: "booting",
      ownerId: "booting",
    });
    await flush();

    await expect(harness.coordinator.cancelPending("booting")).resolves.toBe("not-cancellable");

    harness.driver.releaseMakeReady();
    await expect(acquisition).resolves.toMatchObject({ device: { id: shutdown.id } });
  });

  it("keeps admission closed until concurrent maintenance callers have all finished", async () => {
    const harness = await createHarness();
    await harness.coordinator.beginMaintenance();
    await harness.coordinator.beginMaintenance();
    await harness.coordinator.endMaintenance();

    await expect(
      harness.coordinator.request(request, {
        ownerId: "still-maintained",
        requesterId: "still-maintained",
      }),
    ).rejects.toMatchObject({ name: "NukeCancelledError" });

    await harness.coordinator.endMaintenance();
    await expect(
      harness.coordinator.request(request, {
        ownerId: "reopened",
        requesterId: "reopened",
      }),
    ).resolves.toMatchObject({ lease: { ownerId: "reopened", requesterId: "reopened" } });
  });

  describe("device mode", () => {
    /** A driver that slims 26.5 and cannot slim 17.5, like iOS on either side of 18.5. */
    function slimmingDriver(options: { readonly mode?: DeviceMode } = {}): FakeDriver {
      return new FakeDriver({
        availableOsVersions: ["17.5", "26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
        slimmableOsVersions: ["26.5"],
        ...options,
      });
    }

    const owner = (id: string) => ({ ownerId: id, requesterId: id });

    it.each([
      ["full", "no mode", undefined, "full"],
      ["slim", "no mode", undefined, "slim"],
      ["full", "mode slim", "slim", "slim"],
      ["slim", "mode full", "full", "full"],
    ] as const)(
      "on a worker whose default is %s, a request with %s gets that device mode",
      async (defaultMode, _label, mode, planned) => {
        const harness = await createHarness({
          defaultModes: { ios: defaultMode },
          drivers: [slimmingDriver()],
        });

        const granted = await harness.coordinator.request(
          { ...request, ...(mode === undefined ? {} : { mode }) },
          owner("agent"),
        );

        expect(specMode(granted.device.spec)).toBe(planned);
        expect(granted.device.mode).toBe(planned);
      },
    );

    it.each([
      ["slim", "slim", true],
      ["slim", "full", false],
      ["full", "full", true],
      ["full", "slim", false],
    ] as const)(
      "on a worker whose default is %s, a device whose pool mode is %s reports servesDefaultMode %s",
      async (defaultMode, poolMode, served) => {
        const harness = await createHarness({
          defaultModes: { ios: defaultMode },
          drivers: [slimmingDriver()],
        });
        const spec = {
          model: "iPhone 17",
          osVersion: "26.5",
          platform: "ios" as const,
          ...(poolMode === "slim" ? { mode: "slim" as const } : {}),
        };

        expect(harness.coordinator.servesDefaultMode(spec)).toBe(served);
      },
    );

    it("compares a device's pool mode with its own platform's default, full when that platform has none", async () => {
      const harness = await createHarness({
        defaultModes: { ios: "slim" },
        drivers: [slimmingDriver()],
      });
      const android = { model: "Pixel 9", osVersion: "35", platform: "android" as const };

      expect(harness.coordinator.servesDefaultMode(android)).toBe(true);
      expect(harness.coordinator.servesDefaultMode({ ...android, mode: "slim" })).toBe(false);
    });

    it("passes the resolved mode to resolveSpec, the default filled in for a request that named none", async () => {
      const driver = slimmingDriver();
      const harness = await createHarness({ defaultModes: { ios: "slim" }, drivers: [driver] });

      await harness.coordinator.request(request, owner("agent"));

      const resolved = driver.calls.find((call) => call.operation === "resolveSpec");
      expect(resolved?.arguments[0]).toMatchObject({ mode: "slim" });
    });

    it("never plans a full request onto a slim spec, even when the driver's resolveSpec returns one", async () => {
      class AlwaysSlimDriver extends FakeDriver {
        override async resolveSpec(
          ...args: Parameters<FakeDriver["resolveSpec"]>
        ): Promise<DeviceSpec> {
          return { ...(await super.resolveSpec(...args)), mode: "slim" };
        }
      }
      const driver = new AlwaysSlimDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
      });
      const harness = await createHarness({ drivers: [driver] });

      const granted = await harness.coordinator.request(
        { ...request, mode: "full" },
        owner("agent"),
      );

      expect(granted.device.spec).not.toHaveProperty("mode");
      const provisioned = driver.calls.find((call) => call.operation === "provision");
      expect(provisioned?.arguments[0]).not.toHaveProperty("mode");
    });

    it("does not give a full request an idle slim device of the same model and runtime", async () => {
      const harness = await createHarness({ drivers: [slimmingDriver()], maxDevices: 2 });
      const slim = await seedReady(harness, { ...request, mode: "slim" });

      const granted = await harness.coordinator.request(
        { ...request, mode: "full" },
        owner("agent"),
      );

      expect(granted.device.id).not.toBe(slim.id);
      expect(granted.device.mode).toBe("full");
    });

    it("does not give a slim request an idle full device of the same model and runtime", async () => {
      const harness = await createHarness({ drivers: [slimmingDriver()], maxDevices: 2 });
      const full = await seedReady(harness, request);

      const granted = await harness.coordinator.request(
        { ...request, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.id).not.toBe(full.id);
      expect(granted.device.mode).toBe("slim");
    });

    it("resolves a slim request on a runtime the driver cannot slim to the full spec, reusing an idle full device", async () => {
      const oldRuntime = { ...request, osVersion: "17.5" };
      const harness = await createHarness({ drivers: [slimmingDriver()] });
      const full = await seedReady(harness, oldRuntime);

      const granted = await harness.coordinator.request(
        { ...oldRuntime, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.id).toBe(full.id);
      expect(granted.device.spec).toEqual(oldRuntime);
      expect(granted.device.mode).toBe("full");
    });

    it("grants a slim request against a driver that knows nothing of modes a full device", async () => {
      const harness = await createHarness();

      const granted = await harness.coordinator.request(
        { ...request, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.spec).toEqual(request);
      expect(granted.device.mode).toBe("full");
    });

    it("grants a slim-spec device whose slim pass failed as full, and keeps it in the slim pool", async () => {
      const harness = await createHarness({ drivers: [slimmingDriver({ mode: "full" })] });

      const granted = await harness.coordinator.request(
        { ...request, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.mode).toBe("full");
      expect(granted.device.spec).toEqual({ ...request, mode: "slim" });
    });
  });

  it("A failed eviction shutdown logs the device id and the error, and the waiter is deferred as before.", async () => {
    const { logger, sink } = capturingLogger();
    // Two devices allowed but only one running: a running device of another spec is
    // evicted by shutdown (not deleted) to make room for the request.
    const harness = await createHarness({ logger, maxDevices: 2 });
    const victim = await seedReady(harness, { ...request, model: "iPhone SE" });
    harness.driver.failOn("shutdown", 1, new DriverCrashError("shutdown wedged"));

    let settled = false;
    const acquisition = harness.coordinator.request(request, {
      ownerId: "evictor",
      requesterId: "evictor",
    });
    void acquisition.then(
      () => (settled = true),
      () => (settled = true),
    );
    await settle();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        module: "daemon.lease-acquisition-coordinator",
        fields: {
          deviceId: victim.id,
          error: "DriverCrashError: shutdown wedged",
          requesterId: "evictor",
          step: "shutdown",
        },
      }),
    ]);
    // Deferred: back in the queue, still pending, and the victim untouched.
    expect(settled).toBe(false);
    expect(harness.coordinator.queueDepth).toBe(1);
    expect(harness.registry.snapshot.devices.find((device) => device.id === victim.id)?.state).toBe(
      "ready",
    );
    await harness.coordinator.cancelPending("evictor");
    await expect(acquisition).rejects.toMatchObject({ name: "RequestCancelledError" });
  });

  it("A failed eviction delete logs the device id and the error.", async () => {
    const { logger, sink } = capturingLogger();
    // One device allowed: a managed device of another spec is deleted to make room.
    const harness = await createHarness({ logger, maxDevices: 1 });
    const victim = await seedShutdown(harness, { ...request, model: "iPhone SE" });
    harness.driver.failOn("destroy", 1, new DriverCrashError("simctl delete refused"));

    const acquisition = harness.coordinator.request(request, {
      ownerId: "evictor",
      requesterId: "evictor",
    });
    await settle();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          deviceId: victim.id,
          error: "DriverCrashError: simctl delete refused",
          requesterId: "evictor",
          step: "delete",
        },
      }),
    ]);
    await harness.coordinator.cancelPending("evictor");
    await expect(acquisition).rejects.toMatchObject({ name: "RequestCancelledError" });
  });

  it("A failed destroy after a shut-down device fails to boot for a waiter logs the device id and the error.", async () => {
    const { logger, sink } = capturingLogger();
    const harness = await createHarness({ logger });
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    harness.driver.failOn("destroy", 1, new DriverCrashError("simulator would not die"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    expect(sink.records.filter((record) => record.fields?.["step"] === "destroy")).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          deviceId: shutdown.id,
          error: "DriverCrashError: simulator would not die",
          requesterId: "booter",
          step: "destroy",
        },
      }),
    ]);
  });

  it("A device fenced after a failed boot and a failed destroy stays under a boot claim owned by a request, not an ownerless one.", async () => {
    const harness = await createHarness();
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    harness.driver.failOn("destroy", 1, new DriverCrashError("simulator would not die"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    // An ownerless boot claim is the warm pool's: a request would wait for it until its own timeout.
    expect(harness.claims.claim(shutdown.id)).toEqual({
      kind: "boot",
      owner: expect.stringMatching(/^req_/),
    });
  });

  it("grants a request that arrives while a failed boot's device is being destroyed a device of its own, without waiting for the destroy.", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const shutdownId = (await seedShutdown(harness)).id;
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    let failDestroy: (error: Error) => void = () => undefined;
    const realDestroy = harness.driver.destroy.bind(harness.driver);
    let destroys = 0;
    vi.spyOn(harness.driver, "destroy").mockImplementation(async (device) => {
      destroys += 1;
      if (destroys > 1) return realDestroy(device);
      return new Promise<void>((_resolve, reject) => {
        failDestroy = reject;
      });
    });

    const booter = harness.coordinator.request(request, {
      ownerId: "booter",
      requesterId: "booter",
    });
    const booterOutcome = booter.catch((error: unknown) => error);
    await settle();
    const second = harness.coordinator.request(request, { ownerId: "b", requesterId: "b" });
    let secondGranted = false;
    void second.then(() => {
      secondGranted = true;
    });
    await settle();

    expect(secondGranted).toBe(true);
    expect((await second).device.id).not.toBe(shutdownId);
    expect(harness.claims.claim(shutdownId)).toEqual({ kind: "cleanup" });

    failDestroy(new DriverCrashError("simulator would not die"));
    await booterOutcome;
  });

  it("A device whose boot for a waiter failed is deleted by the lease engine, and its slot is freed.", async () => {
    const harness = await createHarness();
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    expect(harness.bus.replay().filter((event) => event.event === "device.deleted")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ deviceId: shutdown.id, initiator: "lease-engine" }),
      }),
    ]);
    expect(harness.claims.claim(shutdown.id)).toBeUndefined();
    expect(harness.capacity.runningCapacity([]).global.reserved).toBe(0);
  });

  it("A failed boot whose device the destroy can no longer claim frees the waiter's running slot and leaves no fence.", async () => {
    const harness = await createHarness();
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    const realMakeReady = harness.driver.makeReady.bind(harness.driver);
    vi.spyOn(harness.driver, "makeReady").mockImplementation(async (...args) => {
      try {
        return await realMakeReady(...args);
      } finally {
        // The record leaves `shutdown` while the boot fails, so the destroy finds nothing to claim.
        await harness.registry.transitionDevice(shutdown.id, "deleted", {
          event: "device.deleted",
          payload: { deviceId: shutdown.id, initiator: "test" },
        });
      }
    });

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    expect(harness.claims.claim(shutdown.id)).toBeUndefined();
    expect(harness.capacity.runningCapacity([]).global.reserved).toBe(0);
  });

  it("A failed boot whose destroy throws keeps the waiter's running slot and fences the device under its waiter.", async () => {
    const harness = await createHarness({
      lifecycle: (lifecycle) => ({
        bootForLease: (device, claim) => lifecycle.bootForLease(device, claim),
        dispose: (...args) => lifecycle.dispose(...args),
        shutdown: (...args) => lifecycle.shutdown(...args),
        destroy: () => Promise.reject(new DriverCrashError("simulator would not delete")),
      }),
    });
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    expect(harness.claims.claim(shutdown.id)).toEqual({
      kind: "boot",
      owner: expect.stringMatching(/^req_/),
    });
    expect(harness.capacity.runningCapacity([]).global.reserved).toBe(1);
  });

  it("A shut-down device that fails to boot for a waiter logs the driver's error.", async () => {
    const { logger, sink } = capturingLogger();
    const harness = await createHarness({ logger });
    const shutdown = await seedShutdown(harness);
    // Call 1 is seedReady's own boot; call 2 is the waiter's.
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    expect(sink.records.filter((record) => record.fields?.["step"] === "boot")).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          deviceId: shutdown.id,
          error: "DriverCrashError: simulator never booted",
          requesterId: "booter",
          step: "boot",
        },
      }),
    ]);
  });
  it("releases the running slot reserved to boot a shut-down device for a waiter when the boot fails and another boot claims the device before it is destroyed", async () => {
    // The warm pool's boot reserves its own slot and claims the device in one decision. Here it
    // lands after the failed boot has released its claim and before the destroy claims the device.
    let raced = false;
    let warmBoot: { release(): void } | undefined;
    const harness = await createHarness({
      maxRunning: 2,
      lifecycle: (lifecycle, { capacity, claims, registry }) => ({
        bootForLease: (device, claim) => lifecycle.bootForLease(device, claim),
        dispose: (...args) => lifecycle.dispose(...args),
        shutdown: (...args) => lifecycle.shutdown(...args),
        destroy: (device, initiator, operation, claim) => {
          const reservation = capacity.tryReserveBoot(
            capacityDevice(device),
            capacityDevices(registry.snapshot.devices),
          );
          const warmClaim = claims.tryClaim(device.id, "boot");
          raced = reservation.ok && warmClaim !== undefined;
          warmBoot = {
            release: () => {
              warmClaim?.release();
              if (reservation.ok) reservation.reservation.release();
            },
          };
          return lifecycle.destroy(device, initiator, operation, claim);
        },
      }),
    });
    await seedShutdown(harness);
    // Call 1 is seedShutdown's own boot; call 2 is the waiter's.
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });
    expect(raced).toBe(true);

    // The warm pool's boot ends and gives back its own claim and slot.
    warmBoot?.release();
    await settle();

    const running = harness.capacity.runningCapacity(
      capacityDevices(harness.registry.snapshot.devices),
    );
    expect({ global: running.global.reserved, ios: running.ios.reserved }).toEqual({
      global: 0,
      ios: 0,
    });
  });
});

describe("LeaseAcquisitionCoordinator stored requests", () => {
  const keyed = { idempotencyKey: "key-1", ownerId: "agent", requesterId: "agent" } as const;

  /** Grants the one device capacity allows to `holder`, then frees it again on demand. */
  async function holdTheOnlyDevice(harness: Awaited<ReturnType<typeof createHarness>>) {
    const held = await harness.coordinator.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    return async () => {
      await harness.registry.beginRelease(held.lease.id);
      await harness.registry.transitionDevice(held.device.id, "ready", {
        event: "device.reclaimed",
        payload: { deviceId: held.device.id, duration: 0, strategy: "wipe" },
      });
      harness.coordinator.kick();
      await flush();
    };
  }

  it("returns the first result to a repeated request under the same key and grants no second lease", async () => {
    const harness = await createHarness();
    const first = await harness.coordinator.request(request, keyed);

    const second = await harness.coordinator.request(request, keyed);

    expect(second.lease.id).toBe(first.lease.id);
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });

  it("attaches a repeat of an open request to the existing wait instead of starting a second one", async () => {
    const harness = await createHarness();
    const free = await holdTheOnlyDevice(harness);
    const first = harness.coordinator.request(request, keyed);
    await flush();
    expect(harness.coordinator.queueDepth).toBe(1);

    const repeat = harness.coordinator.request(request, keyed);
    await flush();
    expect(harness.coordinator.queueDepth).toBe(1);
    expect(
      harness.registry.leaseRequests().filter((record) => record.requesterId === "agent"),
    ).toHaveLength(1);

    await free();
    const [granted, repeated] = await Promise.all([first, repeat]);
    expect(repeated.lease.id).toBe(granted.lease.id);
  });

  it("tells a repeat joining an open wait where that wait stands now", async () => {
    const harness = await createHarness();
    await holdTheOnlyDevice(harness);
    void harness.coordinator.request(request, keyed).catch(() => undefined);
    await flush();

    const heard: unknown[] = [];
    void harness.coordinator
      .request(request, { ...keyed, onProgress: (progress) => heard.push(progress) })
      .catch(() => undefined);
    await flush();

    expect(heard).toEqual([{ queuePosition: 1, stage: "queued" }]);
  });

  it("writes a request to disk before the wait queue sees it", async () => {
    const harness = await createHarness();
    const order: string[] = [];
    const write = harness.filesystem.writeFileAtomic.bind(harness.filesystem);
    harness.filesystem.writeFileAtomic = async (path, contents) => {
      await write(path, contents);
      const stored = (JSON.parse(contents) as { leaseRequests?: { requesterId: string }[] })
        .leaseRequests;
      if (stored?.some((record) => record.requesterId === "agent")) order.push("on disk");
    };
    const create = harness.queue.create.bind(harness.queue);
    harness.queue.create = (...args) => {
      order.push("queued");
      return create(...args);
    };

    await harness.coordinator.request(request, keyed);

    expect(order.slice(0, 2)).toEqual(["on disk", "queued"]);
  });

  it("keeps a capacity failure terminal under the same key after capacity frees up", async () => {
    const harness = await createHarness();
    const free = await holdTheOnlyDevice(harness);
    await expect(
      harness.coordinator.request(request, { ...keyed, noWait: true }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    await free();

    await expect(
      harness.coordinator.request(request, { ...keyed, noWait: true }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY", name: "ReplayedLeaseRequestError" });
    expect(harness.registry.snapshot.leases).toHaveLength(0);
  });

  it("starts a fresh request for a new key once the prior one is terminal", async () => {
    const harness = await createHarness();
    const free = await holdTheOnlyDevice(harness);
    await expect(
      harness.coordinator.request(request, { ...keyed, noWait: true }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    await free();

    const granted = await harness.coordinator.request(request, {
      ...keyed,
      idempotencyKey: "key-2",
    });

    expect(granted.lease.requesterId).toBe("agent");
    // The grant and its stored result land in one commit; the flush lets the wait settle.
    await flush();
    expect(harness.registry.leaseRequests().map((record) => record.state)).toEqual([
      "granted",
      "failed",
      "granted",
    ]);
  });

  it("answers REQUESTER_ALREADY_LEASED to a new key while the prior request is still open", async () => {
    const harness = await createHarness();
    await holdTheOnlyDevice(harness);
    void harness.coordinator.request(request, keyed).catch(() => undefined);
    await flush();

    const second = harness.coordinator.request(request, { ...keyed, idempotencyKey: "key-2" });
    const secondState = promiseState(second);
    await flush();

    expect(secondState.state).toBe("rejected");
    await expect(second).rejects.toBeInstanceOf(RequesterAlreadyLeasedError);
  });

  it("refuses the same key naming a different device as an idempotency conflict", async () => {
    const harness = await createHarness();
    await harness.coordinator.request(request, keyed);

    await expect(
      harness.coordinator.request({ ...request, model: "iPhone 17" }, keyed),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("refuses a repeat sent by a different principal", async () => {
    const harness = await createHarness();
    await harness.coordinator.request(request, keyed);

    await expect(
      harness.coordinator.request(request, { ...keyed, ownerId: "someone-else" }),
    ).rejects.toBeInstanceOf(LeaseRequestForbiddenError);
  });

  it("stores one record for two concurrent requests under one key", async () => {
    const harness = await createHarness();

    const [first, second] = await Promise.all([
      harness.coordinator.request(request, keyed),
      harness.coordinator.request(request, keyed),
    ]);

    expect(harness.registry.leaseRequests()).toHaveLength(1);
    expect(second.lease.id).toBe(first.lease.id);
  });

  it("stores a request that carries no idempotency key, and names it on lease.requested", async () => {
    const harness = await createHarness();

    await harness.coordinator.request(request, { ownerId: "agent", requesterId: "agent" });
    await flush();

    expect(harness.registry.leaseRequests()).toMatchObject([
      { requesterId: "agent", state: "granted" },
    ]);
    const [stored] = harness.registry.leaseRequests();
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.requested")
        .map((event) => event.payload),
    ).toMatchObject([{ requestId: stored?.id, requester: "agent" }]);
    expect(harness.registry.leaseRequests()[0]).not.toHaveProperty("idempotencyKey");
  });
});

describe("LeaseAcquisitionCoordinator: image tags", () => {
  const android = { model: "Pixel 8", osVersion: "34", platform: "android" } as const;
  const playstore = { ...android, imageTag: "google_apis_playstore" } as const;
  const owner = (id: string) => ({ ownerId: id, requesterId: id });

  /** API 34 has a google_apis and a google_apis_playstore image; API 35 only google_apis. */
  function taggedDriver(): FakeDriver {
    return new FakeDriver({
      availableOsVersions: ["34", "35"],
      clock: new FakeClock(1_000),
      images: [
        { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
      ],
      platform: "android",
    });
  }

  it("grants a request naming a tag a device whose spec carries that tag, and one naming none a spec without one", async () => {
    const driver = taggedDriver();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });

    const tagged = await harness.coordinator.request(playstore, owner("tagged"));
    const untagged = await harness.coordinator.request(android, owner("untagged"));

    expect(tagged.device.spec).toEqual(playstore);
    expect(untagged.device.spec).toEqual(android);
    const provisioned = driver.calls
      .filter((call) => call.operation === "provision")
      .map((call) => call.arguments[0]);
    expect(provisioned).toEqual([playstore, android]);
  });

  it.each([
    ["without allowDownload", false],
    ["with allowDownload", true],
  ])(
    "fails a tag not installed for the API level with a RuntimeMissingError %s, and never asks the installer",
    async (_label, allowDownload) => {
      const asked: unknown[] = [];
      const harness = await createHarness({
        components: {
          install: async (call) => {
            asked.push(call);
            return { outcome: "installed", version: "35" };
          },
        },
        drivers: [taggedDriver()],
      });

      await expect(
        harness.coordinator.request(
          { ...playstore, osVersion: "35" },
          { ...owner("agent"), allowDownload },
        ),
      ).rejects.toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
      expect(asked).toEqual([]);
    },
  );

  it("does not give a request naming a tag an idle device of another tag", async () => {
    const harness = await createHarness({ drivers: [taggedDriver()], maxDevices: 2 });
    const other = await seedReady(harness, { ...android, imageTag: "google_apis" });

    const granted = await harness.coordinator.request(playstore, owner("agent"));

    expect(granted.device.id).not.toBe(other.id);
    expect(granted.device.spec).toEqual(playstore);
  });

  it("does not give a request naming a tag an idle device with no tag", async () => {
    const harness = await createHarness({ drivers: [taggedDriver()], maxDevices: 2 });
    const untagged = await seedReady(harness, android);

    const granted = await harness.coordinator.request(playstore, owner("agent"));

    expect(granted.device.id).not.toBe(untagged.id);
    expect(granted.device.spec).toEqual(playstore);
  });

  it("does not give a request naming no tag an idle device with a tag", async () => {
    const harness = await createHarness({ drivers: [taggedDriver()], maxDevices: 2 });
    const tagged = await seedReady(harness, playstore);

    const granted = await harness.coordinator.request(android, owner("agent"));

    expect(granted.device.id).not.toBe(tagged.id);
    expect(granted.device.spec).toEqual(android);
  });

  it("gives a request naming a tag an idle device of that tag", async () => {
    const harness = await createHarness({ drivers: [taggedDriver()], maxDevices: 2 });
    const tagged = await seedReady(harness, playstore);

    const granted = await harness.coordinator.request(playstore, owner("agent"));

    expect(granted.device.id).toBe(tagged.id);
  });

  it("rejects a request whose driver refuses the image tag as unresolvable-spec, with the driver's error", async () => {
    class NoTagsDriver extends FakeDriver {
      override async resolveSpec(
        ...args: Parameters<FakeDriver["resolveSpec"]>
      ): Promise<DeviceSpec> {
        if (args[0].imageTag !== undefined) {
          throw new UnsupportedRequestOptionError(this.platform, "imageTag");
        }
        return super.resolveSpec(...args);
      }
    }
    const driver = new NoTagsDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    const harness = await createHarness({ drivers: [driver] });

    await expect(
      harness.coordinator.request({ ...request, imageTag: "google_apis" }, owner("agent")),
    ).rejects.toBeInstanceOf(UnsupportedRequestOptionError);
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload),
    ).toEqual([
      {
        reason: "unresolvable-spec",
        requestId: expect.stringMatching(/^req_/),
        requester: "agent",
        requestSpec: { ...request, imageTag: "google_apis" },
      },
    ]);
    expect(driver.calls.map((call) => call.operation)).not.toContain("provision");
  });

  it.each([
    ["another tag than the one the request named", playstore, { imageTag: "default" }],
    ["a tag for a request that named none", android, { imageTag: "google_apis" }],
  ] as const)(
    "refuses a spec the driver resolves with %s, and provisions nothing",
    async (_label, asked, returned) => {
      class WrongTagDriver extends FakeDriver {
        override async resolveSpec(
          ...args: Parameters<FakeDriver["resolveSpec"]>
        ): Promise<DeviceSpec> {
          return { ...(await super.resolveSpec(...args)), ...returned };
        }
      }
      const driver = new WrongTagDriver({
        availableOsVersions: ["34"],
        clock: new FakeClock(1_000),
        images: [{ abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" }],
        platform: "android",
      });
      const harness = await createHarness({ drivers: [driver] });

      await expect(harness.coordinator.request(asked, owner("agent"))).rejects.toThrow(
        /driver resolved image tag .* for a request naming/,
      );
      expect(driver.calls.map((call) => call.operation)).not.toContain("provision");
    },
  );
});

describe("LeaseAcquisitionCoordinator: class requests", () => {
  const owner = (id: string) => ({ ownerId: id, requesterId: id });
  const iosModels = ["iPhone 15", "iPhone 16", "iPhone 17", "Apple Watch", "iPad Pro"];
  const iosClasses = {
    "Apple Watch": "watch",
    "iPad Pro": "tablet",
    "iPhone 15": "phone",
    "iPhone 16": "phone",
    "iPhone 17": "phone",
  } as const;
  const iosPreferences: ModelPreferences = {
    ios: {
      phone: ["iPhone 17", "iPhone 16", "iPhone 15"],
      tablet: ["iPad Pro"],
      watch: ["Apple Watch"],
    },
  };
  const phone = { class: "phone", platform: "ios" } as const;
  const iphone15 = { model: "iPhone 15", osVersion: "18.4", platform: "ios" } as const;

  function iosDriver(options: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}) {
    return new FakeDriver({
      availableOsVersions: ["18.4", "26.5"],
      clock: new FakeClock(1_000),
      knownModels: iosModels,
      modelClasses: iosClasses,
      platform: "ios",
      ...options,
    });
  }

  function deviceWork(driver: FakeDriver): number {
    return driver.calls.filter((call) => ["provision", "makeReady"].includes(call.operation))
      .length;
  }

  function provisioned(harness: Awaited<ReturnType<typeof createHarness>>) {
    return harness.bus
      .replay()
      .filter((event) => event.event === "device.provisioned")
      .map((event) => (event.payload as { spec: DeviceSpec }).spec);
  }

  async function classHarness(driver = iosDriver(), preferences = iosPreferences) {
    return createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2, preferences });
  }

  it("resolves a request with neither model nor class as the phone class, and lease.requested carries neither", async () => {
    const harness = await classHarness();

    const granted = await harness.coordinator.request({ platform: "ios" }, owner("agent"));

    expect(granted.device.spec).toMatchObject({ model: "iPhone 17", osVersion: "26.5" });
    const requested = harness.bus.replay().filter((event) => event.event === "lease.requested");
    expect(
      requested.map((event) => (event.payload as { requestSpec: unknown }).requestSpec),
    ).toEqual([{ platform: "ios" }]);
  });

  it("grants a phone request one ready idle iPhone 15 with no boot and no provision", async () => {
    const driver = iosDriver();
    const harness = await classHarness(driver);
    const warm = await seedReady(harness, iphone15);
    const before = deviceWork(driver);

    const granted = await harness.coordinator.request(phone, owner("agent"));

    expect(granted.device.id).toBe(warm.id);
    expect(deviceWork(driver)).toBe(before);
  });

  it("does not grant an exact iPhone 16 request a ready idle iPhone 15", async () => {
    const harness = await classHarness();
    const warm = await seedReady(harness, { ...iphone15, osVersion: "26.5" });

    const granted = await harness.coordinator.request(
      { model: "iPhone 16", platform: "ios" },
      owner("agent"),
    );

    expect(granted.device.id).not.toBe(warm.id);
    expect(granted.device.spec.model).toBe("iPhone 16");
  });

  it("does not grant a request with no class a ready idle Apple Watch, and grants a watch request it", async () => {
    const watch = { model: "Apple Watch", osVersion: "26.5", platform: "ios" } as const;
    const first = await classHarness();
    const warm = await seedReady(first, watch);

    const noClass = await first.coordinator.request({ platform: "ios" }, owner("agent"));
    expect(noClass.device.id).not.toBe(warm.id);

    const second = await classHarness();
    const warmWatch = await seedReady(second, watch);
    const granted = await second.coordinator.request(
      { class: "watch", platform: "ios" },
      owner("agent"),
    );
    expect(granted.device.id).toBe(warmWatch.id);
  });

  it("boots a shut-down device of the class before creating any device", async () => {
    const driver = iosDriver();
    const harness = await classHarness(driver);
    const cold = await seedShutdown(harness, iphone15);
    const provisions = () => driver.calls.filter((call) => call.operation === "provision").length;
    const before = provisions();

    const granted = await harness.coordinator.request(phone, owner("agent"));

    expect(granted.device.id).toBe(cold.id);
    expect(provisions()).toBe(before);
  });

  describe("device mode", () => {
    const slimming = () =>
      iosDriver({ availableOsVersions: ["26.5"], slimmableOsVersions: ["26.5"] });
    const full15 = { ...iphone15, osVersion: "26.5" } as const;
    const slim15 = { ...full15, mode: "slim" } as const;

    it("never grants a full request a slim device of the class", async () => {
      const harness = await classHarness(slimming());
      const slim = await seedReady(harness, slim15);

      const granted = await harness.coordinator.request({ ...phone, mode: "full" }, owner("agent"));

      expect(granted.device.id).not.toBe(slim.id);
      expect(granted.device.mode).toBe("full");
    });

    it("does not grant a request with no mode a slim device when the default mode is full", async () => {
      const harness = await createHarness({
        defaultModes: { ios: "full" },
        drivers: [slimming()],
        maxDevices: 2,
        preferences: iosPreferences,
      });
      const slim = await seedReady(harness, slim15);

      const granted = await harness.coordinator.request(phone, owner("agent"));

      expect(granted.device.id).not.toBe(slim.id);
    });

    it("does not grant a request with no mode a full device when the default mode is slim", async () => {
      const harness = await createHarness({
        defaultModes: { ios: "slim" },
        drivers: [slimming()],
        maxDevices: 2,
        preferences: iosPreferences,
      });
      const full = await seedReady(harness, full15);

      const granted = await harness.coordinator.request(phone, owner("agent"));

      expect(granted.device.id).not.toBe(full.id);
      expect(granted.device.mode).toBe("slim");
    });
  });

  describe("image tags", () => {
    const pixel = { model: "Pixel 8", osVersion: "34", platform: "android" } as const;
    const androidPhone = { class: "phone", platform: "android" } as const;
    const androidPreferences: ModelPreferences = { android: { phone: ["Pixel 9", "Pixel 8"] } };
    const androidDriver = () =>
      new FakeDriver({
        availableOsVersions: ["34", "35"],
        clock: new FakeClock(1_000),
        images: [
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
          { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        ],
        knownModels: ["Pixel 8", "Pixel 9"],
        modelClasses: { "Pixel 8": "phone", "Pixel 9": "phone" },
        modelRuntimes: { "Pixel 8": ["34"], "Pixel 9": ["35"] },
        platform: "android",
      });

    it.each([
      ["of another tag", { imageTag: "google_apis" }, "google_apis_playstore"],
      ["with no tag", {}, "google_apis_playstore"],
    ] as const)(
      "does not grant a request naming a tag an idle device %s",
      async (_label, seeded, asked) => {
        const harness = await classHarness(androidDriver(), androidPreferences);
        const other = await seedReady(harness, { ...pixel, ...seeded });

        const granted = await harness.coordinator.request(
          { ...androidPhone, imageTag: asked },
          owner("agent"),
        );

        expect(granted.device.id).not.toBe(other.id);
        expect(granted.device.spec.imageTag).toBe(asked);
      },
    );

    it("does not grant a request naming no tag an idle device with a tag", async () => {
      const harness = await classHarness(androidDriver(), androidPreferences);
      const tagged = await seedReady(harness, { ...pixel, imageTag: "google_apis_playstore" });

      const granted = await harness.coordinator.request(androidPhone, owner("agent"));

      expect(granted.device.id).not.toBe(tagged.id);
      expect(granted.device.spec).not.toHaveProperty("imageTag");
    });

    it("grants a request naming a tag an idle device of that tag", async () => {
      const harness = await classHarness(androidDriver(), androidPreferences);
      const tagged = await seedReady(harness, { ...pixel, imageTag: "google_apis_playstore" });

      const granted = await harness.coordinator.request(
        { ...androidPhone, imageTag: "google_apis_playstore" },
        owner("agent"),
      );

      expect(granted.device.id).toBe(tagged.id);
    });

    it("skips a candidate whose only pairings carry another tag", async () => {
      const harness = await classHarness(androidDriver(), androidPreferences);

      const granted = await harness.coordinator.request(
        { ...androidPhone, imageTag: "google_apis_playstore" },
        owner("agent"),
      );

      expect(granted.device.spec).toMatchObject({ model: "Pixel 8", osVersion: "34" });
    });
  });

  describe("OS", () => {
    it("fits a class request with no OS to a device on any runtime the catalog lists, and not one on a runtime no longer listed", async () => {
      const listed = await classHarness();
      const old = await seedReady(listed, iphone15);
      const grantedListed = await listed.coordinator.request(phone, owner("agent"));
      expect(grantedListed.device.id).toBe(old.id);

      const gone = await classHarness();
      const stale = await seedReady(gone, { ...iphone15, osVersion: "17.0" });
      const grantedGone = await gone.coordinator.request(phone, owner("agent"));
      expect(grantedGone.device.id).not.toBe(stale.id);
      expect(grantedGone.device.spec.osVersion).toBe("26.5");
    });

    it("fits an exact request with no OS only to the runtime the driver picks, as on main", async () => {
      const harness = await classHarness();
      const old = await seedReady(harness, iphone15);

      const granted = await harness.coordinator.request(
        { model: "iPhone 15", platform: "ios" },
        owner("agent"),
      );

      expect(granted.device.id).not.toBe(old.id);
      expect(granted.device.spec.osVersion).toBe("26.5");
    });
  });

  describe("OS ranges", () => {
    const rangeDriver = (options: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}) =>
      iosDriver({
        availableOsVersions: ["18.0", "18.4", "26.5"],
        modelRuntimes: {
          "iPhone 15": ["18.0", "18.4", "26.5"],
          "iPhone 16": ["18.0", "18.4", "26.5"],
          "iPhone 17": ["26.5"],
        },
        ...options,
      });

    it("sends a class request with no osVersion to the driver without pinning a runtime", async () => {
      const driver = rangeDriver();
      const harness = await classHarness(driver);

      await harness.coordinator.request({ platform: "ios" }, owner("agent"));

      const resolve = driver.calls.find((call) => call.operation === "resolveSpec");
      expect(resolve?.arguments[0]).toEqual({ mode: "full", model: "iPhone 17", platform: "ios" });
    });

    it("grants a ready idle device whose OS satisfies the range, and not one outside it", async () => {
      const inside = await classHarness(rangeDriver());
      const warm = await seedReady(inside, { ...iphone15, osVersion: "18.0" });
      const grantedInside = await inside.coordinator.request(
        { ...phone, osVersion: ">=18 <26" },
        owner("agent"),
      );
      expect(grantedInside.device.id).toBe(warm.id);

      const outside = await classHarness(rangeDriver());
      const stale = await seedReady(outside, { ...iphone15, osVersion: "26.5" });
      const grantedOutside = await outside.coordinator.request(
        { ...phone, osVersion: ">=18 <26" },
        owner("agent"),
      );
      expect(grantedOutside.device.id).not.toBe(stale.id);
      expect(grantedOutside.device.spec.osVersion).toBe("18.4");
    });

    it("fails an exact model the catalog does not list, sent with a range, at once with UnknownModelError", async () => {
      const driver = rangeDriver();
      const harness = await classHarness(driver);

      await expect(
        harness.coordinator.request(
          { model: "iPhone 99", osVersion: ">=18", platform: "ios" },
          owner("agent"),
        ),
      ).rejects.toMatchObject({ model: "iPhone 99", name: "UnknownModelError" });
      expect(deviceWork(driver)).toBe(0);
    });

    it("grants an exact model with a range a ready idle device of that model in range, and not one of another model", async () => {
      const harness = await classHarness(rangeDriver());
      const other = await seedReady(harness, { ...iphone15, osVersion: "18.0" });
      const same = await seedReady(harness, {
        model: "iPhone 16",
        osVersion: "18.0",
        platform: "ios",
      });
      const before = deviceWork(harness.driver);

      const granted = await harness.coordinator.request(
        { model: "iPhone 16", osVersion: ">=18 <26", platform: "ios" },
        owner("agent"),
      );

      expect(granted.device.id).toBe(same.id);
      expect(granted.device.id).not.toBe(other.id);
      expect(deviceWork(harness.driver)).toBe(before);
    });

    it("fails an exact model with a range at once with UnknownModelError when the platform lists no catalog", async () => {
      const harness = await createHarness({
        catalogReader: { listCatalog: async () => [] },
        drivers: [rangeDriver()],
      });

      await expect(
        harness.coordinator.request(
          { model: "iPhone 16", osVersion: ">=18", platform: "ios" },
          owner("agent"),
        ),
      ).rejects.toMatchObject({ model: "iPhone 16", name: "UnknownModelError" });
    });

    it("never installs for a range even when the driver then reports a downloadable runtime missing", async () => {
      class Racing extends FakeDriver {
        override async resolveSpec(): Promise<DeviceSpec> {
          throw new RuntimeMissingError("ios", "18.4", { component: "18.4" });
        }
      }
      const asked: unknown[] = [];
      const harness = await createHarness({
        components: {
          install: async (call) => {
            asked.push(call);
            return { outcome: "installed", version: "18.4" };
          },
        },
        drivers: [
          new Racing({
            availableOsVersions: ["18.4"],
            clock: new FakeClock(1_000),
            knownModels: ["iPhone 16"],
            modelClasses: { "iPhone 16": "phone" },
            platform: "ios",
          }),
        ],
      });

      await expect(
        harness.coordinator.request(
          { model: "iPhone 16", osVersion: ">=18", platform: "ios" },
          { ...owner("agent"), allowDownload: true },
        ),
      ).rejects.toMatchObject({ name: "RuntimeMissingError" });
      expect(asked).toEqual([]);
    });

    it("creates an exact model with a range on the newest listed pairing in range", async () => {
      const harness = await classHarness(rangeDriver());

      const granted = await harness.coordinator.request(
        { model: "iPhone 16", osVersion: "<26", platform: "ios" },
        owner("agent"),
      );

      expect(granted.device.spec).toMatchObject({ model: "iPhone 16", osVersion: "18.4" });
      expect(provisioned(harness).map((spec) => spec.osVersion)).toEqual(["18.4"]);
    });

    it.each([
      ["without allowDownload", false],
      ["with allowDownload", true],
    ])(
      "fails an exact model with a range nothing installed satisfies at once with RuntimeMissingError, not downloadable, naming the range, and never installs, %s",
      async (_label, allowDownload) => {
        const driver = rangeDriver();
        const harness = await classHarness(driver);

        await expect(
          harness.coordinator.request(
            { model: "iPhone 16", osVersion: "<=17", platform: "ios" },
            { ...owner("agent"), allowDownload },
          ),
        ).rejects.toMatchObject({
          downloadable: false,
          name: "RuntimeMissingError",
          osVersion: "<=17",
        });
        expect(installs(driver)).toEqual([]);
        expect(deviceWork(driver)).toBe(0);
      },
    );

    it.each([["Baklava"], ["34-ext12"]])(
      "reaches resolveSpec with the bare version %s exact, as without ranges, and a range never picks it",
      async (name) => {
        const driver = rangeDriver({
          availableOsVersions: ["18.4", name],
          modelRuntimes: { "iPhone 16": ["18.4", name] },
        });
        const harness = await classHarness(driver);

        await harness.coordinator.request(
          { model: "iPhone 16", osVersion: name, platform: "ios" },
          owner("agent"),
        );
        const resolved = driver.calls.find((call) => call.operation === "resolveSpec");
        expect(resolved?.arguments[0]).toMatchObject({ osVersion: name });

        const ranged = await classHarness(driver);
        const granted = await ranged.coordinator.request(
          { model: "iPhone 16", osVersion: ">=18", platform: "ios" },
          owner("agent"),
        );
        expect(granted.device.spec.osVersion).toBe("18.4");
      },
    );

    it("picks the newest in-range runtime whatever order the catalog lists them in", async () => {
      const harness = await classHarness(
        rangeDriver({
          availableOsVersions: ["18.4", "26.5", "9.3", "18.0"],
          modelRuntimes: { "iPhone 16": ["18.4", "26.5", "9.3", "18.0"] },
        }),
      );

      const granted = await harness.coordinator.request(
        { model: "iPhone 16", osVersion: "<26", platform: "ios" },
        owner("agent"),
      );

      expect(granted.device.spec.osVersion).toBe("18.4");
    });

    it("takes the first class candidate that has an in-range pairing and its newest such runtime: <=18 creates an iPhone 16 on the newest 18.x", async () => {
      const harness = await classHarness(rangeDriver());

      const granted = await harness.coordinator.request(
        { ...phone, osVersion: "<=18" },
        owner("agent"),
      );

      expect(granted.device.spec).toMatchObject({ model: "iPhone 16", osVersion: "18.4" });
    });

    it.each([
      ["without allowDownload", false],
      ["with allowDownload", true],
    ])(
      "fails a class with a range no candidate pairs with at once with RuntimeMissingError and never installs, %s",
      async (_label, allowDownload) => {
        const driver = rangeDriver();
        const harness = await classHarness(driver);

        await expect(
          harness.coordinator.request(
            { ...phone, osVersion: "<=17" },
            { ...owner("agent"), allowDownload },
          ),
        ).rejects.toMatchObject({
          downloadable: false,
          name: "RuntimeMissingError",
          osVersion: "<=17",
        });
        expect(installs(driver)).toEqual([]);
      },
    );

    it("does not pick a runtime in range whose only images carry another tag: API 35 default only and API 34 google_apis, >=33 with tag google_apis creates on 34", async () => {
      const driver = new FakeDriver({
        availableOsVersions: ["34", "35"],
        clock: new FakeClock(1_000),
        images: [
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
          { abi: "arm64-v8a", runtime: "35", tag: "default" },
        ],
        knownModels: ["Pixel 8"],
        modelClasses: { "Pixel 8": "phone" },
        modelRuntimes: { "Pixel 8": ["34", "35"] },
        platform: "android",
      });
      const harness = await classHarness(driver, { android: { phone: ["Pixel 8"] } });

      const byModel = await harness.coordinator.request(
        { imageTag: "google_apis", model: "Pixel 8", osVersion: ">=33", platform: "android" },
        owner("agent"),
      );
      expect(byModel.device.spec).toMatchObject({ imageTag: "google_apis", osVersion: "34" });
    });
  });

  describe("creating a device for a class", () => {
    it("creates the first name on the class's list the catalog lists, and device.provisioned carries that model", async () => {
      const harness = await classHarness();

      const granted = await harness.coordinator.request(phone, owner("agent"));

      expect(granted.device.spec.model).toBe("iPhone 17");
      expect(provisioned(harness).map((spec) => spec.model)).toEqual(["iPhone 17"]);
    });

    it.each([
      ["a name the catalog does not list", "Unlisted Phone", {}],
      ["a name of another class", "iPad Pro", {}],
      ["a name with no pairing", "Orphan", { modelRuntimes: { Orphan: [] } }],
    ] as const)("skips %s for the next on the list", async (_label, skipped, driverOptions) => {
      const driver = iosDriver({
        ...driverOptions,
        knownModels: [...iosModels, "Orphan"],
        modelClasses: { ...iosClasses, Orphan: "phone" },
      });
      const harness = await classHarness(driver, {
        ios: { phone: [skipped, "iPhone 16"] },
      });

      const granted = await harness.coordinator.request(phone, owner("agent"));

      expect(granted.device.spec.model).toBe("iPhone 16");
    });

    it.each([
      ["without allowDownload", false],
      ["with allowDownload", true],
    ])(
      "fails a class whose listed models pair with no installed runtime at once with RuntimeMissingError, not downloadable, %s",
      async (_label, allowDownload) => {
        const asked: unknown[] = [];
        const driver = iosDriver({ modelRuntimes: { "iPhone 16": [] } });
        const harness = await createHarness({
          components: {
            install: async (call) => {
              asked.push(call);
              return { outcome: "installed", version: "27.0" };
            },
          },
          drivers: [driver],
          preferences: { ios: { phone: ["iPhone 16"] } },
        });

        await expect(
          harness.coordinator.request(phone, { ...owner("agent"), allowDownload }),
        ).rejects.toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
        expect(asked).toEqual([]);
        expect(deviceWork(driver)).toBe(0);
      },
    );

    it.each([
      ["ios", "ios.defaultModels.phone", { ...phone }],
      ["android", "android.defaultModels.tablet", { class: "tablet", platform: "android" }],
    ] as const)(
      "fails a class with no listed name at once with UnknownModelError naming the class and %s, whatever is idle",
      async (platform, key, asked) => {
        const driver = new FakeDriver({
          availableOsVersions: ["18.4"],
          clock: new FakeClock(1_000),
          knownModels: ["iPhone 15"],
          modelClasses: { "iPhone 15": "phone" },
          platform,
        });
        const harness = await classHarness(driver, {
          [platform]: { phone: ["Unlisted Phone"], tablet: ["Unlisted Tablet"] },
        });
        if (platform === "ios") await seedReady(harness, iphone15);

        await expect(harness.coordinator.request(asked, owner("agent"))).rejects.toMatchObject({
          class: asked.class,
          message: expect.stringContaining(key),
          name: "UnknownModelError",
          platform,
        });
      },
    );

    it("fails a class request at once with UnknownModelError when the platform has no preference list at all", async () => {
      const harness = await classHarness(iosDriver(), {});

      await expect(harness.coordinator.request(phone, owner("agent"))).rejects.toMatchObject({
        class: "phone",
        name: "UnknownModelError",
        message: expect.stringContaining("ios.defaultModels.phone"),
      });
    });

    it("lists a queued class request's class requirement and the catalog's class lookup", async () => {
      const harness = await createHarness({
        drivers: [iosDriver()],
        maxDevices: 1,
        maxRunning: 1,
        preferences: iosPreferences,
      });
      await harness.coordinator.request(phone, owner("holder"));
      void harness.coordinator.request(phone, owner("waiter")).catch(() => undefined);
      await settle();

      const [demand] = harness.coordinator.waitingDemand();

      expect(demand).toMatchObject({
        inFlight: false,
        mode: "full",
        platform: "ios",
        requirement: { platform: "ios", target: { class: "phone", kind: "class" } },
      });
      expect(demand?.classOf("iPhone 15")).toBe("phone");
    });

    it("lists no waiting demand for a request whose class is still being resolved", async () => {
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const harness = await createHarness({
        catalogReader: {
          listCatalog: async () => {
            await gate;
            return [];
          },
        },
        drivers: [iosDriver()],
        preferences: iosPreferences,
      });

      const pending = harness.coordinator.request(phone, owner("agent"));
      const settled = pending.catch(() => undefined);
      await flush();
      const whileResolving = harness.coordinator.waitingDemand();
      open();
      await settled;

      expect(whileResolving).toEqual([]);
      await expect(pending).rejects.toMatchObject({ name: "UnknownModelError" });
    });

    it("fails a class request with UnknownModelError when the catalog reader answers no entry for the platform", async () => {
      const harness = await createHarness({
        catalogReader: { listCatalog: async () => [] },
        drivers: [iosDriver()],
        preferences: iosPreferences,
      });

      await expect(harness.coordinator.request(phone, owner("agent"))).rejects.toMatchObject({
        name: "UnknownModelError",
      });
    });

    it.each([
      ["names none", undefined, "default"],
      ["names a version", "18.4", "18.4"],
    ])(
      "names the OS in the RuntimeMissingError of a class whose models pair with no runtime when the request %s",
      async (_label, osVersion, named) => {
        const driver = iosDriver({ modelRuntimes: { "iPhone 16": [] } });
        const harness = await classHarness(driver, { ios: { phone: ["iPhone 16"] } });

        await expect(
          harness.coordinator.request(
            { ...phone, ...(osVersion === undefined ? {} : { osVersion }) },
            owner("agent"),
          ),
        ).rejects.toMatchObject({ name: "RuntimeMissingError", osVersion: named });
      },
    );

    it("fits a class request naming an OS only a device on that OS, and creates a device on it otherwise", async () => {
      const harness = await classHarness();
      const newest = await seedReady(harness, { ...iphone15, osVersion: "26.5" });

      const older = await harness.coordinator.request(
        { ...phone, osVersion: "18.4" },
        owner("agent"),
      );

      expect(older.device.id).not.toBe(newest.id);
      expect(older.device.spec.osVersion).toBe("18.4");

      const sameOs = await classHarness();
      const warm = await seedReady(sameOs, iphone15);
      const granted = await sameOs.coordinator.request(
        { ...phone, osVersion: "18.4" },
        owner("agent"),
      );
      expect(granted.device.id).toBe(warm.id);
    });

    it("fails a class request naming an image tag on a driver with no images with RuntimeMissingError, not downloadable", async () => {
      const harness = await classHarness();

      await expect(
        harness.coordinator.request({ ...phone, imageTag: "google_apis" }, owner("agent")),
      ).rejects.toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
    });

    it("passes the driver an exact model, never a class", async () => {
      const driver = iosDriver();
      const harness = await classHarness(driver);

      await harness.coordinator.request(phone, owner("agent"));

      const resolved = driver.calls.find((call) => call.operation === "resolveSpec");
      expect(resolved?.arguments[0]).toMatchObject({ model: "iPhone 17" });
      expect(resolved?.arguments[0]).not.toHaveProperty("class");
    });
  });

  describe("idempotency", () => {
    const keyed = { ...owner("agent"), idempotencyKey: "key-1" };

    it("returns the stored grant to a repeat of the same class request", async () => {
      const harness = await classHarness();
      const first = await harness.coordinator.request(phone, keyed);

      const second = await harness.coordinator.request(phone, keyed);

      expect(second.lease.id).toBe(first.lease.id);
    });

    it.each([
      ["an exact request", { model: "iPhone 17", platform: "ios" }],
      ["a request of another class", { class: "watch", platform: "ios" }],
      ["a request with neither field", { platform: "ios" }],
    ] as const)("refuses the key of a class request used for %s", async (_label, other) => {
      const harness = await classHarness();
      await harness.coordinator.request(phone, keyed);

      await expect(harness.coordinator.request(other, keyed)).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });
  });
});

describe("LeaseAcquisitionCoordinator: what lease.granted reports", () => {
  const owner = (id: string) => ({ ownerId: id, requesterId: id });

  function granted(harness: Awaited<ReturnType<typeof createHarness>>) {
    const events: Array<{ requestId: string; source: string; leaseId: string }> = [];
    harness.bus.subscribe("lease.granted", (envelope) => events.push(envelope.payload));
    const requested: string[] = [];
    harness.bus.subscribe("lease.requested", (envelope) =>
      requested.push(envelope.payload.requestId),
    );
    return { events, requested };
  }

  it("emits lease.granted with source warm and the request's id for a lease granted from a ready device", async () => {
    const harness = await createHarness();
    await seedReady(harness);
    const { events, requested } = granted(harness);

    const grant = await harness.coordinator.request(request, owner("agent"));

    expect(events).toEqual([
      expect.objectContaining({ leaseId: grant.lease.id, requestId: requested[0], source: "warm" }),
    ]);
    expect(requested[0]).toMatch(/^req_/);
  });

  it("emits lease.granted with source booted for a lease granted after booting a shut-down device", async () => {
    const harness = await createHarness();
    await seedShutdown(harness);
    const { events, requested } = granted(harness);

    await harness.coordinator.request(request, owner("agent"));

    expect(events).toEqual([
      expect.objectContaining({ requestId: requested[0], source: "booted" }),
    ]);
  });

  it("emits lease.granted with source provisioned for a lease granted on a device provisioned for it", async () => {
    const harness = await createHarness();
    const { events, requested } = granted(harness);

    await harness.coordinator.request(request, owner("agent"));

    expect(events).toEqual([
      expect.objectContaining({ requestId: requested[0], source: "provisioned" }),
    ]);
  });

  it("emits lease.granted with source provisioned when an eviction deleted a device and a new one was created", async () => {
    const harness = await createHarness();
    await seedReady(harness, { ...request, model: "iPhone SE" });
    const { events } = granted(harness);

    await harness.coordinator.request(request, owner("agent"));

    expect(events).toEqual([expect.objectContaining({ source: "provisioned" })]);
  });

  it("emits lease.granted with source booted when an eviction shut a device down and a shut-down device was then booted", async () => {
    // One running slot, two devices allowed: a ready device of another model holds the slot, a
    // shut-down device of the requested model waits. Booting the second needs the slot back.
    const harness = await createHarness({ maxDevices: 2, maxRunning: 1 });
    await seedShutdown(harness);
    const evicted = await seedReady(harness, { ...request, model: "iPhone SE" });
    const { events } = granted(harness);

    await harness.coordinator.request(request, owner("agent"));

    expect(
      harness.registry.snapshot.devices.find((device) => device.id === evicted.id)?.state,
    ).not.toBe("ready");
    expect(events).toEqual([expect.objectContaining({ source: "booted" })]);
  });

  it("gives a request refused as already-leased the id its admission would have minted, and emits no lease.requested for it", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const first = await harness.coordinator.request(request, owner("agent"));
    const requested: string[] = [];
    harness.bus.subscribe("lease.requested", (envelope) =>
      requested.push(envelope.payload.requestId),
    );
    const rejected: Array<{ requestId: string; requester: string; reason: string }> = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
    const mintedBefore = harness.requestIds.length;

    await expect(harness.coordinator.request(request, owner("agent"))).rejects.toMatchObject({
      existingLeaseId: first.lease.id,
    });

    expect(requested).toEqual([]);
    expect(harness.requestIds).toHaveLength(mintedBefore + 1);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "already-leased",
        requestId: `req_${harness.requestIds[mintedBefore]}`,
        requester: "agent",
      }),
    ]);

    // The same position in the sequence, on a request that passes admission: that id is the one
    // the stored request gets, and nothing mints a second.
    const mintedBeforeAdmitted = harness.requestIds.length;
    await harness.coordinator.request(request, owner("other"));
    expect(harness.requestIds).toHaveLength(mintedBeforeAdmitted + 1);
    expect(requested).toEqual([`req_${harness.requestIds[mintedBeforeAdmitted]}`]);
  });

  it("gives a request refused as killed the id it would have been stored under", async () => {
    const harness = await createHarness();
    await harness.coordinator.beginMaintenance();
    const rejected: Array<{ requestId: string; requester: string; reason: string }> = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

    await expect(harness.coordinator.request(request, owner("agent"))).rejects.toMatchObject({
      name: "NukeCancelledError",
    });

    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "killed",
        requestId: `req_${harness.requestIds[0]}`,
        requester: "agent",
      }),
    ]);
  });
});

describe("LeaseAcquisitionCoordinator waiting demand", () => {
  it("lists a request waiting for a device with what a device must satisfy, and drops it once it is granted", async () => {
    const harness = await createHarness();
    const held = await harness.coordinator.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    expect(harness.coordinator.waitingDemand()).toEqual([]);

    const waiting = harness.coordinator.request(request, {
      ownerId: "waiter",
      requesterId: "waiter",
    });
    await flush();

    expect(harness.coordinator.waitingDemand()).toEqual([
      {
        classOf: expect.any(Function),
        inFlight: false,
        mode: "full",
        platform: "ios",
        requirement: {
          imageTag: undefined,
          osVersion: { kind: "exact", version: "26.5" },
          platform: "ios",
          target: { kind: "model", model: "iPhone 16" },
        },
      },
    ]);

    await harness.registry.beginRelease(held.lease.id);
    await harness.registry.transitionDevice(held.device.id, "ready", {
      event: "device.reclaimed",
      payload: { deviceId: held.device.id, duration: 0, strategy: "wipe" },
    });
    harness.coordinator.kick();
    await waiting;
    expect(harness.coordinator.waitingDemand()).toEqual([]);
  });

  it("reports the mode a request resolved to, and marks a request whose device work has begun as in flight", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { provision: 50 },
      platform: "ios",
      slimmableOsVersions: ["26.5"],
    });
    const harness = await createHarness({ drivers: [driver] });
    const pending = harness.coordinator.request(
      { ...request, mode: "slim" },
      { ownerId: "slim", requesterId: "slim" },
    );
    await flush();

    expect(harness.coordinator.waitingDemand()).toMatchObject([{ inFlight: true, mode: "slim" }]);

    clock.advance(50);
    await pending;
    expect(harness.coordinator.waitingDemand()).toEqual([]);
  });

  it("reports maintenance active between beginMaintenance and endMaintenance", async () => {
    const harness = await createHarness();
    expect(harness.coordinator.maintenanceActive).toBe(false);

    await harness.coordinator.beginMaintenance();
    expect(harness.coordinator.maintenanceActive).toBe(true);

    await harness.coordinator.endMaintenance();
    expect(harness.coordinator.maintenanceActive).toBe(false);
  });
});

describe("LeaseAcquisitionCoordinator: resolve", () => {
  const installer = () => {
    const asked: unknown[] = [];
    return {
      asked,
      components: {
        install: async (call: unknown) => {
          asked.push(call);
          return { outcome: "installed" as const, version: "26.5" };
        },
      },
    };
  };
  const iphone17 = { model: "iPhone 17", platform: "ios" } as const;
  const driverOf = (options: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}) =>
    new FakeDriver({
      availableOsVersions: ["18.0", "18.4", "26.0"],
      clock: new FakeClock(1_000),
      knownModels: ["iPhone 17"],
      platform: "ios",
      ...options,
    });

  it("resolves a target naming a model and an installed OS to the spec a request for it is granted a device of", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: "26.0" });
    const granted = await harness.coordinator.request(
      { ...iphone17, osVersion: "26.0" },
      { ownerId: "a", requesterId: "a" },
    );

    expect(resolved).toEqual({ spec: { model: "iPhone 17", osVersion: "26.0", platform: "ios" } });
    expect(granted.device.spec).toEqual(
      "spec" in resolved ? resolved.spec : { model: "never matches" },
    );
  });

  it("resolves an OS range to the newest installed runtime in it", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: ">=18 <26" });

    expect(resolved).toEqual({ spec: { model: "iPhone 17", osVersion: "18.4", platform: "ios" } });
  });

  it("queues nothing, reserves nothing and creates nothing", async () => {
    const driver = driverOf();
    const harness = await createHarness({ drivers: [driver] });

    await harness.coordinator.resolve({ ...iphone17, osVersion: "26.0" });

    expect(harness.queue.depth).toBe(0);
    expect(harness.registry.snapshot.devices).toEqual([]);
    const running = harness.capacity.runningCapacity([]);
    expect([running.global.reserved, running.ios.reserved, running.android.reserved]).toEqual([
      0, 0, 0,
    ]);
    expect(
      driver.calls.filter((call) => ["provision", "makeReady"].includes(call.operation)),
    ).toEqual([]);
  });

  it("answers runtime-missing for an OS that is not installed, and never calls the installer though a request could download it", async () => {
    const { asked, components } = installer();
    const driver = driverOf({ availableOsVersions: [] });
    const harness = await createHarness({ components, drivers: [driver] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: "27.0" });

    expect(resolved).toMatchObject({ refusal: "runtime-missing" });
    expect(resolved).toHaveProperty("message", expect.stringContaining("27.0"));
    expect(asked).toEqual([]);
    expect(driver.calls.filter((call) => call.operation === "installComponent")).toEqual([]);
  });

  it("answers runtime-missing for an OS range no installed runtime is in", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: ">=30" });

    expect(resolved).toMatchObject({ refusal: "runtime-missing" });
  });

  it("answers unknown-model for a model the catalog does not list, exact or in a range", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const exact = await harness.coordinator.resolve({
      model: "iPhone 99",
      osVersion: "26.0",
      platform: "ios",
    });
    const ranged = await harness.coordinator.resolve({
      model: "iPhone 99",
      osVersion: ">=18",
      platform: "ios",
    });

    expect(exact).toMatchObject({ refusal: "unknown-model" });
    expect(ranged).toMatchObject({ refusal: "unknown-model" });
  });

  it("answers no-driver for a platform this machine has no driver for", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const resolved = await harness.coordinator.resolve({ model: "Pixel 9", platform: "android" });

    expect(resolved).toMatchObject({ refusal: "no-driver" });
    expect(resolved).toHaveProperty("message", expect.stringContaining("android"));
  });

  it("answers unresolvable with the driver's message when the driver throws any other error", async () => {
    const driver = driverOf();
    driver.failOn("resolveSpec", 1, new Error("the simulator service is down"));
    const harness = await createHarness({ drivers: [driver] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: "26.0" });

    expect(resolved).toEqual({
      message: "the simulator service is down",
      refusal: "unresolvable",
    });
  });

  it("gives a slim target on a runtime the driver can slim a slim spec, and one it cannot a full spec", async () => {
    const driver = driverOf({
      availableOsVersions: ["17.5", "26.5"],
      slimmableOsVersions: ["26.5"],
    });
    const harness = await createHarness({ drivers: [driver] });

    const slimmable = await harness.coordinator.resolve({
      ...iphone17,
      mode: "slim",
      osVersion: "26.5",
    });
    const below = await harness.coordinator.resolve({
      ...iphone17,
      mode: "slim",
      osVersion: "17.5",
    });

    expect(slimmable).toEqual({
      spec: { mode: "slim", model: "iPhone 17", osVersion: "26.5", platform: "ios" },
    });
    expect(below).toEqual({ spec: { model: "iPhone 17", osVersion: "17.5", platform: "ios" } });
  });

  it("gives a target naming no mode the worker's default mode, and a full one a full spec", async () => {
    const driver = driverOf({ availableOsVersions: ["26.5"], slimmableOsVersions: ["26.5"] });
    const harness = await createHarness({ defaultModes: { ios: "slim" }, drivers: [driver] });

    const defaulted = await harness.coordinator.resolve({ ...iphone17, osVersion: "26.5" });
    const full = await harness.coordinator.resolve({
      ...iphone17,
      mode: "full",
      osVersion: "26.5",
    });

    expect(defaulted).toMatchObject({ spec: { mode: "slim" } });
    expect(full).toEqual({ spec: { model: "iPhone 17", osVersion: "26.5", platform: "ios" } });
  });
});
