import { testLeaseFiles } from "./test-lease-files.js";
import { testConfig as configWithDefaults } from "../core/testing.js";
import {
  FakeDriver,
  loadTestRegistry,
  readyTransitionUpdate,
  openTestState,
  testComponentWiring,
  type FakeDriverOptions,
  testStateOf,
} from "../core/testing.js";
import type { StateDatabase } from "../state/index.js";
import { EventBus } from "../bus/index.js";
import type { EventHistoryHandle } from "../history/index.js";
import { ringEventHistory } from "../history/testing.js";
import {
  CleanupReaper,
  ComponentInstaller,
  type Config,
  Doctor,
  type HostFacts,
  type LatestPresence,
  Nuke,
  PassthroughRefusedError,
  type CatalogReader,
  type MemoryPressureReader,
  type PassthroughResolver,
} from "../core/index.js";

type MemoryPressureStep = "none" | "warming-paused" | "new-devices-paused";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeSystemStats,
  MemoryFilesystem,
  FakeKeySetFetcher,
  NoopLogger,
  type ProcessRunner,
} from "../ports/index.js";
import { createAuth, tokensOwner } from "../auth/index.js";
import { openMemoryStateDatabase } from "../auth/testing.js";
import type { DispatcherOptions, DispatchSession } from "./dispatcher.js";
import { Dispatcher } from "./dispatcher.js";
import { createTestEngine, type TestEngine } from "../leasing/testing.js";

export const gibibyte = 1024 ** 3;

export const HOST_SYSTEM = { arch: "arm64", os: "macOS", osVersion: "15.5" };

function resolvePassthroughOverride(
  engine: TestEngine,
  override: PassthroughResolver | undefined,
): PassthroughResolver {
  return override ?? engine;
}

function stallOptions(
  engine: TestEngine,
  driver: FakeDriver,
  overrides: {
    readonly claims?: { isClaimed(deviceId: string): boolean };
    readonly otherStallDrivers?: readonly FakeDriver[];
  },
) {
  return {
    claims: overrides.claims ?? engine.claimReader,
    drivers: [...(overrides.otherStallDrivers ?? []), driver],
  };
}

function resolveEventHistoryOverride(
  eventBus: EventBus,
  override: Pick<EventHistoryHandle, "replay" | "replayPage" | "status"> | undefined,
): Pick<EventHistoryHandle, "replay" | "replayPage" | "status"> {
  return override ?? ringEventHistory(eventBus);
}

function fakePassthroughOptions(
  tool: string | undefined,
  contextSink: unknown[] | undefined,
): Partial<FakeDriverOptions> {
  if (tool === undefined) return {};
  const options = {
    passthrough: (_tool: string, _device: unknown, args: readonly string[], context?: unknown) => {
      contextSink?.push(context);
      if (args.includes("delete")) {
        throw new PassthroughRefusedError(
          tool,
          "Refusing `simlock simctl delete`: use `simlock release` instead.",
        );
      }
      return {
        args: ["--set", "/root", ...args],
        command: tool,
        env: { SIMLOCK_SCOPED: "1" },
      };
    },
    passthroughTools: [tool],
  };
  return options;
}

function withGatewayLabel(config: Config, label: string | undefined): Config {
  return label === undefined ? config : { ...config, gateway: { ...config.gateway, label } };
}

function withHttp(config: Config, http: Config["http"] | undefined): Config {
  return http === undefined ? config : { ...config, http };
}

export interface SeededPhysicalDevice {
  readonly createdAt: number;
  readonly driverDeviceId: string;
  readonly enrolledApps: readonly string[];
  readonly id: string;
  readonly lastLeaseEndedAt?: number;
  readonly reclaimingSince?: number;
  readonly spec: { readonly class: string; readonly model: string; readonly osVersion: string };
  readonly state: string;
}

function seedPhysicalDevices(state: StateDatabase, devices: readonly SeededPhysicalDevice[]): void {
  for (const device of devices) {
    state.database
      .prepare(
        "INSERT INTO devices (id, platform, physical, driver_device_id, state, model, os_version, class, created_at, last_lease_ended_at, reclaiming_since) VALUES (?, 'ios', 1, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        device.id,
        device.driverDeviceId,
        device.state,
        device.spec.model,
        device.spec.osVersion,
        device.spec.class,
        device.createdAt,
        device.lastLeaseEndedAt ?? null,
        device.reclaimingSince ?? null,
      );
    device.enrolledApps.forEach((app, position) => {
      state.database
        .prepare("INSERT INTO device_enrolled_apps (device_id, position, app) VALUES (?, ?, ?)")
        .run(device.id, position, app);
    });
  }
}

// fallow-ignore-next-line complexity -- one test harness builder; each option is a plain pass-through to a collaborator.
export async function buildDispatcher(
  overrides: {
    readonly downloadsPolicy?: Config["downloads"]["policy"];
    readonly driverOptions?: Partial<FakeDriverOptions>;
    readonly awaitReady?: () => Promise<void>;
    readonly catalog?: CatalogReader;
    readonly includeNuke?: boolean;
    readonly warmKinds?: DispatcherOptions["warmKinds"];
    readonly includeEnrollment?: boolean;
    readonly passthroughTool?: string;
    readonly lease?: Partial<Config["lease"]>;
    readonly processRunner?: ProcessRunner;
    readonly leaseFiles?: DispatcherOptions["leaseFiles"];
    readonly exec?: Partial<Config["exec"]>;
    readonly passthroughContextSink?: unknown[];
    readonly clock?: FakeClock;
    readonly passthroughOverride?: PassthroughResolver;
    readonly execEnv?: NodeJS.ProcessEnv;
    readonly eventHistory?: Pick<EventHistoryHandle, "replay" | "replayPage" | "status">;
    readonly historyPath?: string;
    readonly withoutTokens?: boolean;
    /** why: a daemon wired without the baseline service. */
    readonly withoutBaselines?: boolean;
    readonly hostFacts?: () => HostFacts;
    readonly capacity?: Config["capacity"];
    /** why: the worker's memory pressure step at the start; a test changes it with `setMemoryPressure`. */
    readonly memoryPressureStep?: MemoryPressureStep;
    readonly warmPool?: Partial<Config["warmPool"]>;
    /** why: the `ios.defaultMode` `catalog.get` reports. */
    readonly iosDefaultMode?: "slim" | "full";
    /** why: the two boot deadlines `config.get` reports. */
    readonly bootTimeouts?: { readonly iosFull: number; readonly android: number };
    readonly components?: Pick<
      ComponentInstaller,
      "claimProvision" | "inProgress" | "install" | "list" | "remove"
    >;
    readonly health?: "starting" | "running" | "failed";
    readonly gatewayLabel?: string;
    readonly http?: Config["http"];
    readonly claims?: { isClaimed(deviceId: string): boolean };
    readonly otherStallDrivers?: readonly FakeDriver[];
    /** why: a second platform's driver for the leasing engine, for a test that leases on both. */
    readonly extraDrivers?: readonly FakeDriver[];
    readonly engine?: Pick<Parameters<typeof createTestEngine>[0], "defaultModes">;
    readonly physicalDevices?: readonly SeededPhysicalDevice[];
    /** why: rows a test writes to `state.db` before the registry loads. */
    readonly seedState?: (state: StateDatabase) => void;
    readonly presence?: (driverDeviceId: string) => LatestPresence | undefined;
    readonly capabilitySources?: DispatcherOptions["capabilitySources"];
    readonly load?: DispatcherOptions["load"];
    readonly driverRejections?: ConstructorParameters<typeof Doctor>[0]["driverRejections"];
  } = {},
) {
  const clock = overrides.clock ?? new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  let pressureStep = overrides.memoryPressureStep;
  const memoryPressure: MemoryPressureReader = {
    current: () =>
      pressureStep === undefined ? undefined : { readingAt: clock.now(), step: pressureStep },
    onReading: () => () => undefined,
  };
  const filesystem = new MemoryFilesystem();
  const state = await openTestState();
  seedPhysicalDevices(state, overrides.physicalDevices ?? []);
  overrides.seedState?.(state);
  const registry = await loadTestRegistry({
    clock,
    eventBus,
    idGenerator: sequence(),
    state,
  });
  const driver = new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    platform: "ios",
    ...overrides.driverOptions,
    ...fakePassthroughOptions(overrides.passthroughTool, overrides.passthroughContextSink),
  });
  const baseConfig = withHttp(
    withGatewayLabel(
      testConfig(
        overrides.downloadsPolicy,
        overrides.lease ?? {},
        overrides.exec ?? {},
        overrides.capacity,
      ),
      overrides.gatewayLabel,
    ),
    overrides.http,
  );
  const config: Config = {
    ...baseConfig,
    warmPool: { ...baseConfig.warmPool, ...overrides.warmPool },
    ...(overrides.iosDefaultMode === undefined
      ? {}
      : { ios: { ...baseConfig.ios, defaultMode: overrides.iosDefaultMode } }),
    ...(overrides.bootTimeouts === undefined
      ? {}
      : {
          android: { ...baseConfig.android, bootTimeoutMs: overrides.bootTimeouts.android },
          ios: { ...baseConfig.ios, full: { bootTimeoutMs: overrides.bootTimeouts.iosFull } },
        }),
  };
  const wiring = testComponentWiring({
    clock: clock,
    components: overrides.components,
    drivers: [driver, ...(overrides.extraDrivers ?? [])],
    eventBus: eventBus,
    registry: registry,
  });
  const engine = createTestEngine({
    ...wiring,
    clock,
    config,
    ...overrides.engine,
    drivers: [driver, ...(overrides.extraDrivers ?? [])],
    eventBus,
    idGenerator: sequence(),
    memoryPressure,
    registry,
    state: testStateOf(registry),
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      totalRamBytes: 32 * gibibyte,
    }),
  });
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: engine.cleanup,
    filesystem,
    registry,
  });
  const doctor = new Doctor({
    baselines: engine.core.baselines,
    decisions: wiring.decisions,
    claims: engine.claimReader,
    clock,
    config,
    drivers: [driver],
    ...(overrides.driverRejections === undefined
      ? {}
      : { driverRejections: overrides.driverRejections }),
    eventBus,
    leaseExpirer: engine,
    quarantine: engine.core.quarantine,
    registry,
  });
  const { tokens } = createAuth({
    clock,
    config: { enabled: false, host: "127.0.0.1", port: 4700 },
    dataDirectory: "/",
    database: (await openMemoryStateDatabase([tokensOwner])).database,
    filesystem,
    idGenerator: sequence(),
    keySetFetcher: new FakeKeySetFetcher(),
    logger: new NoopLogger(),
    secrets: new CryptoTokenSecrets(),
  });
  const dispatcher = new Dispatcher({
    awaitReady: overrides.awaitReady ?? (() => Promise.resolve()),
    ...(overrides.capabilitySources === undefined
      ? {}
      : { capabilitySources: overrides.capabilitySources }),
    capacity: engine,
    warmPool: engine,
    ...(overrides.withoutBaselines === true ? {} : { baselines: engine.core.baselines }),
    deviceModes: engine,
    catalog: overrides.catalog ?? engine,
    clock,
    components: wiring.components,
    config,
    doctor,
    eventBus,
    eventHistory: resolveEventHistoryOverride(eventBus, overrides.eventHistory),
    ...(overrides.historyPath === undefined ? {} : { historyPath: overrides.historyPath }),
    health: () => overrides.health ?? "running",
    hostFacts: overrides.hostFacts ?? (() => ({ ...HOST_SYSTEM, tools: [] })),
    instanceId: "instance-1",
    leases: engine,
    ...(overrides.load === undefined ? {} : { load: overrides.load }),
    ...(overrides.includeNuke === true ? { nuke: new Nuke({ executor: engine, registry }) } : {}),
    ...(overrides.warmKinds === undefined ? {} : { warmKinds: overrides.warmKinds }),
    ...(overrides.includeEnrollment === true ? { enrollment: engine.core.enrollment } : {}),
    passthrough: resolvePassthroughOverride(engine, overrides.passthroughOverride),
    ...(overrides.processRunner === undefined ? {} : { processRunner: overrides.processRunner }),
    leaseFiles: overrides.leaseFiles ?? testLeaseFiles,
    execEnv: overrides.execEnv ?? { PATH: "/usr/bin" },
    queue: engine,
    ...(overrides.presence === undefined ? {} : { presence: overrides.presence }),
    reaper,
    registry,
    stalls: stallOptions(engine, driver, overrides),
    ...(overrides.withoutTokens === true ? {} : { tokens }),
    version: "1.2.3",
  });
  return {
    clock,
    components: wiring.components,
    dispatcher,
    doctor,
    driver,
    engine,
    eventBus,
    registry,
    setMemoryPressure: (step: MemoryPressureStep) => {
      pressureStep = step;
    },
    state,
    tokens,
  };
}

/** why: a slim device a worker already holds, ready or shut down, as the warm pool or an earlier lease leaves one. */
export async function seedSlimDevice(
  built: Awaited<ReturnType<typeof buildDispatcher>>,
  state: "ready" | "shutdown",
) {
  const spec = {
    mode: "slim",
    model: "iPhone 17 Pro",
    osVersion: "26.5",
    physical: false,
    platform: "ios",
  } as const;
  const driverDevice = await built.driver.provision(spec);
  const driven = await built.driver.makeReady(driverDevice, { mode: "slim", purpose: "prepare" });
  // why: the seed is a slim device whatever the fake reports on its boot, so a test whose driver answers `full` still starts from slim.
  const ready = { ...driven, mode: "slim" as const };
  const registered = await built.registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec,
  });
  await built.registry.transitionDevice(
    registered.id,
    "ready",
    { event: "device.ready", payload: { bootDuration: 0, deviceId: registered.id } },
    readyTransitionUpdate(ready),
  );
  if (state === "ready") return registered;
  await built.driver.shutdown(driverDevice);
  await built.registry.transitionDevice(registered.id, "shutdown", {
    event: "device.shutdown",
    payload: { deviceId: registered.id, initiator: "test" },
  });
  return registered;
}

export function session(overrides: Partial<DispatchSession> = {}): DispatchSession {
  return {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "tok_agent",
    role: "agent",
    ...overrides,
  };
}

export async function flushPromises(): Promise<void> {
  for (let count = 0; count < 100; count += 1) await Promise.resolve();
}

export async function flush(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
  }
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function testConfig(
  downloadsPolicy: Config["downloads"]["policy"] = "on-request",
  leaseOverrides: Partial<Config["lease"]> = {},
  execOverrides: Partial<Config["exec"]> = {},
  capacity: Config["capacity"] = {
    strategy: "resource",
    config: {
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 3,
      },
      ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    },
  },
): Config {
  return configWithDefaults({
    capacity,
    downloads: { policy: downloadsPolicy },
    eventBuffer: { capacity: 100 },
    exec: execOverrides,
    http: { enabled: false, port: 4700 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { defaultTtlMs: 60_000, maxTtlMs: 3_600_000, ...leaseOverrides },
    warmPool: { maxConcurrentBoots: 1 },
  });
}
