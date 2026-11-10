import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, type Logger, MemoryFilesystem } from "../ports/index.js";
import { AcquisitionPlanner } from "./acquisition-planner.js";
import {
  CapacityCoordinator,
  type Config,
  DeviceOperationClaims,
  DeviceProvisioner,
  ComponentInstaller,
  DriverCatalog,
  type ModelPreferences,
  DiskSpaceGuard,
  type Driver,
  type DeviceMode,
  type VirtualSpec,
  type Platform,
  specMode,
  type BaselineService,
  type CatalogReader,
  ManagedDeviceLifecycle,
  type Registry,
  SerializedDecision,
} from "../core/index.js";
import {
  createCapacityStrategy,
  loadTestRegistry,
  openTestState,
  readyTransitionUpdate,
} from "../core/testing.js";
import { FakeDriver } from "../core/testing.js";
import { QuarantineCoordinator } from "../core/testing.js";
import {
  LeaseAcquisitionCoordinator,
  type LeaseAcquisitionCoordinatorOptions,
  NoCapacityError,
} from "./lease-acquisition-coordinator.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseRequestBook } from "./lease-request-book.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { WaitQueue } from "./wait-queue.js";

export const gibibyte = 1024 ** 3;
export const request = {
  physical: false,
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
} as const;

function config(maxDevices = 1, maxRunning = 1): Pick<Config, "capacity" | "warmPool"> {
  return {
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
export async function createHarness(
  options: {
    /** why: stands in for the baselines a request names, when a test scripts the versions. */
    readonly baselines?: Pick<BaselineService, "current">;
    readonly components?: Pick<ComponentInstaller, "install">;
    readonly defaultModes?: Readonly<Partial<Record<Platform, DeviceMode>>>;
    readonly drivers?: readonly Driver[];
    readonly freeDiskBytes?: number;
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
    readonly quarantine?: LeaseAcquisitionCoordinatorOptions["quarantine"];
    readonly preferences?: ModelPreferences;
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
  const state = await openTestState();
  const registry = await loadTestRegistry({
    clock,
    eventBus: bus,
    idGenerator: { generate: () => `${nextId++}` },
    state,
  });
  const decisions = new SerializedDecision();
  const claims = new DeviceOperationClaims();
  const catalog = new DriverCatalog(drivers, { preferences: options.preferences ?? {} });
  const appConfig = config(options.maxDevices, options.maxRunning);
  const capacity = new CapacityCoordinator(
    createCapacityStrategy(
      appConfig.capacity,
      new FakeSystemStats({
        cpuCount: 8,
        totalRamBytes: 32 * gibibyte,
      }),
    ),
  );
  const lifecycle = new ManagedDeviceLifecycle(catalog, registry, decisions, claims, clock);
  // why: quarantine's kick wakes this coordinator's queue, and `coordinator` is only assigned below.
  const quarantine =
    options.quarantine ??
    new QuarantineCoordinator({
      claims,
      clock,
      config: appConfig.warmPool.quarantine,
      decisions,
      drivers: catalog,
      eventBus: bus,
      notifyAvailability: () => coordinator?.kick(),
      registry,
    });
  const provisioner = new DeviceProvisioner({
    baselines: () => ({ current: () => undefined, hold: () => () => undefined }),
    catalog,
    claims,
    clock,
    // why: never refuses: what a removal does to provisioning is `DeviceProvisioner`'s own test.
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
    baselines: options.baselines ?? { current: () => undefined },
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
    quarantine,
    registry,
    requests: new LeaseRequestBook({
      decisions,
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
    provisioner,
    queue,
    registry,
    requestIds,
    state,
  };
}

export async function seedReady(
  harness: Awaited<ReturnType<typeof createHarness>>,
  spec: VirtualSpec = request,
) {
  const driverDevice = await harness.driver.provision(spec);
  const provisioned = await harness.registry.registerDevice({
    backend: "local",
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

export async function flush(): Promise<void> {
  for (let count = 0; count < 50; count += 1) await Promise.resolve();
}

export async function settle(): Promise<void> {
  for (let count = 0; count < 20; count += 1) await new Promise((resolve) => setImmediate(resolve));
}

export async function seedShutdown(
  harness: Awaited<ReturnType<typeof createHarness>>,
  spec: VirtualSpec = request,
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

export function installs(driver: FakeDriver): readonly unknown[] {
  return driver.calls
    .filter((call) => call.operation === "installComponent")
    .map((call) => call.arguments[0]);
}
