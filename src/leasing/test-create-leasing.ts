import {
  type ModelPreferences,
  type ComponentInstaller,
  type Config,
  type DeviceMode,
  type VirtualSpec,
} from "../core/index.js";
import { type CapacityLimits, type ResourceStrategyOptions, testStateOf } from "../core/testing.js";
import {
  FakeDriver,
  loadTestRegistry,
  openTestState,
  testComponentWiring,
} from "../core/testing.js";
import { type StateDatabase } from "../state/index.js";
import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, type Logger } from "../ports/index.js";
import { type LeaseEndParticipant } from "./lease-ports.js";
import { createTestEngine, type TestEngineConfig } from "./testing.js";

export const gibibyte = 1024 ** 3;
export const request = {
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
} as const;

export const androidRequest = {
  model: "Pixel 9",
  osVersion: "36",
  platform: "android",
} as const;

export function config(
  overrides: Partial<Config["lease"]> = {},
  warmPoolEnabled = true,
  idleShutdownAfterMs = 10_000,
  warmPool: Partial<Config["warmPool"]> = {},
): TestEngineConfig {
  return {
    android: { virtualDevices: true },
    devices: { autoEnroll: false, deletedRetentionMs: 3_600_000 },
    ios: { virtualDevices: true },
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
      endedIdRetentionMs: 600_000,
      maxRequestRecords: 10_000,
      maxPerRequester: 1,
      endWaitMs: 600_000,
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

function resourceOptions(source: Pick<Config, "capacity">): ResourceStrategyOptions {
  if (source.capacity.strategy !== "resource") throw new Error("expected the resource strategy");
  return source.capacity.config;
}

function withCapacity(
  base: ResourceStrategyOptions,
  overrides: Partial<ResourceStrategyOptions>,
): ResourceStrategyOptions {
  return {
    limits: overrides.limits ?? base.limits,
    ramBudget: overrides.ramBudget ?? base.ramBudget,
  };
}

function capacityConfig(
  base: Pick<Config, "capacity">,
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
export async function createHarness(
  options: {
    readonly components?: Pick<ComponentInstaller, "claimProvision" | "install">;
    readonly driver?: FakeDriver;
    readonly drivers?: readonly FakeDriver[];
    readonly state?: StateDatabase;
    readonly identity?: Config["lease"]["identity"];
    readonly lease?: Partial<Config["lease"]>;
    /** why: a participant holds a released device in `reclaiming` until it returns. */
    readonly leaseEndParticipants?: readonly LeaseEndParticipant[];
    readonly capacity?: Config["capacity"];
    readonly defaultImageTags?: Parameters<typeof createTestEngine>[0]["defaultImageTags"];
    readonly defaultModes?: Parameters<typeof createTestEngine>[0]["defaultModes"];
    readonly limits?: CapacityLimits;
    readonly logger?: Logger;
    readonly modelPreferences?: ModelPreferences;
    readonly ramBudget?: ResourceStrategyOptions["ramBudget"];
    readonly totalRamBytes?: number;
    readonly warmPoolEnabled?: boolean;
    readonly warmPool?: Partial<Config["warmPool"]>;
    /** why: how long a ready device may idle before the pool shuts it down. */
    readonly idleShutdownAfterMs?: number;
    /** why: a platform a test turns `<platform>.virtualDevices` off for (ADR 0078). */
    readonly virtualDevices?: Readonly<Partial<Record<"android" | "ios", boolean>>>;
    /** why: starts the warm pool as the daemon's startup does, so it learns from the leases and reacts to events. */
    readonly startPool?: boolean;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const state = options.state ?? (await openTestState());
  const bus = new EventBus(clock);
  const driver =
    options.driver ?? new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  let nextId = options.state === undefined ? 1 : 1_000;
  const registry = await loadTestRegistry({
    clock,
    eventBus: bus,
    idGenerator: { generate: () => `${nextId++}` },
    ...(options.identity === undefined ? {} : { leaseIdentity: options.identity }),
    state,
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
  const engineConfig: TestEngineConfig = {
    ...baseConfig,
    android: { virtualDevices: options.virtualDevices?.android ?? true },
    capacity: capacityConfig(baseConfig, options),
    ios: { virtualDevices: options.virtualDevices?.ios ?? true },
  };
  const totalRamBytes = options.totalRamBytes ?? 32 * gibibyte;
  const drivers = options.drivers ?? [driver];
  const wiring = testComponentWiring({
    clock,
    components: options.components,
    drivers,
    eventBus: bus,
    registry,
  });
  const engine = createTestEngine({
    ...wiring,
    clock,
    config: engineConfig,
    drivers,
    ...(options.defaultImageTags === undefined
      ? {}
      : { defaultImageTags: options.defaultImageTags }),
    ...(options.defaultModes === undefined ? {} : { defaultModes: options.defaultModes }),
    eventBus: bus,
    idGenerator: { generate: () => `request-${nextId++}` },
    ...(options.leaseEndParticipants === undefined
      ? {}
      : { leaseEndParticipants: options.leaseEndParticipants }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.modelPreferences === undefined
      ? {}
      : { modelPreferences: options.modelPreferences }),
    registry,
    state: testStateOf(registry),
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes }),
  });

  if (options.startPool === true) await engine.convergeRunningCapacity();
  return { bus, clock, decisions: wiring.decisions, driver, engine, registry, state };
}

export async function seedReady(
  harness: Awaited<ReturnType<typeof createHarness>>,
  spec: VirtualSpec = { ...request, physical: false },
  mode: DeviceMode = "full",
  driver: FakeDriver = harness.driver,
) {
  const driverDevice = await driver.provision(spec);
  // why: Running on the machine too: a daemon start reads that of a leased device to keep its lease.
  const booted = await driver.makeReady(driverDevice, { mode, purpose: "prepare" });
  const device = await harness.registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec,
  });
  return harness.registry.transitionDevice(
    device.id,
    "ready",
    { event: "device.ready", payload: { bootDuration: 0, deviceId: device.id } },
    booted.mode === undefined ? undefined : { mode: booted.mode },
  );
}

export async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    await Promise.resolve();
  }
}

export async function settledOrPending(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise.catch((error: unknown) => error),
    flush().then(() => "still pending"),
  ]);
}
