import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type Alerts, createAlerts } from "../alerts/index.js";
import { EventBus, type EventBusLogger } from "../bus/index.js";
import { fitHostFacts, fitHostLoad, type ProtocolRange } from "../contract/index.js";
import { HostLoadSampler } from "../host-load/index.js";
import {
  createEventHistory,
  type EventHistoryHandle,
  HISTORY_DB_NAME,
  HISTORY_PROJECTIONS,
} from "../history/index.js";
import {
  type Config,
  type ConfigOverrides,
  type DaemonMode,
  type DeviceClass,
  type DeviceDataTable,
  type DeviceMode,
  type Driver,
  type DriverRejection,
  type Platform,
  type ModelPreferences,
  type PrerequisiteCheck,
  type ServiceCheck,
  CleanupReaper,
  ComponentInstaller,
  DEVICE_CLASSES,
  DiskSpaceGuard,
  DriverCatalog,
  HostFactsReader,
  createCore,
  loadConfigWithDefaults,
  latestPresence,
  loadInstanceId,
  OwnedRootError,
  Registry,
  registryOwner,
  warmPoolOwner,
  Nuke,
  SerializedDecision,
  sweepWriteLeftovers,
} from "../core/index.js";
import { createLeasing } from "../leasing/index.js";
import { openStateDatabase, type StateDatabase } from "../state/index.js";
import {
  AdbServerUnavailableError,
  AndroidDriver,
  ANDROID_PASSTHROUGH_TOOLS,
  hostAbiFor,
  SdkMissingError,
  type AndroidEmulatorLaunchOptions,
  androidDeviceDataTable,
  androidPrerequisites,
} from "../drivers/android/index.js";
import {
  IOS_PASSTHROUGH_TOOLS,
  IosSimctlDriver,
  type SlimmedFact,
  iosDeviceDataTable,
  iosPrerequisites,
} from "../drivers/ios/index.js";
import { type Auth, createAuth, tokensOwner } from "../auth/index.js";
import { createHttpApp } from "../http/app.js";
import type { HttpDispatch } from "../http/dispatcher-session.js";
import { HttpGateway } from "../http/server.js";
import {
  CryptoIdGenerator,
  CryptoTokenSecrets,
  JsonLinesLogger,
  LoggingProcessRunner,
  NodeFileLogSink,
  type Clock,
  type DaemonRole,
  type Filesystem,
  type HostInfo,
  type HostLoadProbe,
  productionHostLoadProbe,
  type HostSystem,
  type IdGenerator,
  type IpcConnector,
  type IpcListenerFactory,
  type Logger,
  type LogLevel,
  NodeFilesystem,
  filterSqliteExperimentalWarning,
  NodeSqliteOpener,
  NodeHostInfo,
  NodeIpcTransport,
  NodeProcessRunner,
  productionServiceManager,
  serviceDefinition,
  type ServiceDefinition,
  type ServiceManager,
  NodeNpmCli,
  type NpmCli,
  NodeProcessSupervisor,
  NodeSystemStats,
  NodeUpdaterLauncher,
  type UpdaterLauncher,
  NodeBytePipeLauncher,
  NodeTcpProbe,
  NodeTcpStreamConnector,
  daemonDataDirectory,
  resolveDaemonSocketPath,
  readPackageVersion,
  resolveSimlockHome,
  NodeKeySetFetcher,
  SystemClock,
  type SystemStats,
  type ProcessRunner,
  type ProcessSupervisor,
  type TcpProbe,
  FetchWebhookPoster,
  type WebhookPoster,
} from "../ports/index.js";
import {
  createRoutingPolicy,
  StateDrainStore,
  drainedWorkersOwner,
  FleetLeaseCoordinator,
  FleetLeaseIndex,
  GatewayDispatcher,
  GatewayOwnerRoutedFacts,
  GatewayRelay,
  GatewayService,
  type GatewayServiceOptions,
} from "../gateway/index.js";
import {
  WebSocketUplinkConnector,
  WebSocketUplinkListenerFactory,
} from "../ports/uplink-websocket.js";
import { classifyError } from "./error-code.js";
import { createModuleHost, type OptionalModuleDefinition } from "../modules/index.js";
import { optionalModules } from "../module-registry/index.js";
import { DaemonServer } from "./server.js";
import { socketHeld } from "../updater/index.js";
import { createUpdateCoordinator, type UpdateCoordinatorOptions } from "./update-coordinator.js";
import { startVersionCheck, type VersionCheck } from "./version-check.js";
import {
  DaemonAlreadyRunningError,
  DaemonEndpointHost,
  refuseWhenDaemonAnswers,
} from "./connection-host.js";
import { describeLeaseRequestFailure } from "./error-code.js";
import { wakingQueueAfter } from "./enrollment-wake.js";
import { GatewayUplink } from "./gateway-uplink.js";
import type { RelayTargets } from "./relay.js";

export interface StartDaemonOptions {
  readonly clock?: Clock;
  readonly configOverrides?: ConfigOverrides;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly defaultRequesterId?: string;
  readonly deviceDataTables?: ReadonlyMap<Platform, DeviceDataTable>;
  readonly drivers?: readonly Driver[];
  readonly gatewayRelay?: (relay: GatewayRelay) => void;
  /** why: test-only, hands over the gateway's uplink listener, to close one worker's socket. */
  readonly gatewayUplinks?: (uplinks: WebSocketUplinkListenerFactory) => void;
  /** why: the entry removes the credential when SIGTERM lands after it was written but before the daemon is up; called only once this daemon owns the file. */
  readonly onAdminSecretWritten?: (remove: () => Promise<void>) => void;
  /** why: test-only, replaces the registry of optional modules. */
  readonly optionalModules?: readonly OptionalModuleDefinition<unknown>[];
  readonly relayTargets?: RelayTargets;
  readonly role?: DaemonMode;
  readonly prerequisiteChecks?: readonly PrerequisiteCheck[];
  readonly serviceCheck?: ServiceCheck;
  readonly filesystem?: Filesystem;
  readonly hostInfo?: HostInfo;
  readonly hostLoadProbe?: HostLoadProbe | null;
  readonly idGenerator?: IdGenerator;
  readonly ipc?: IpcConnector & IpcListenerFactory;
  readonly logger?: Logger;
  /** why: test-only, replaces the npm CLI the version check and the update coordinator run. */
  readonly npm?: NpmCli;
  readonly processRunner?: ProcessRunner;
  /** why: test-only, replaces the launcher, package root and shared-install check of the gateway's update coordinator. */
  readonly updater?: {
    readonly launcher: UpdaterLauncher;
    readonly otherRoleRunning: () => Promise<boolean>;
    readonly packageRoot: string;
  };
  /** why: test-only, the protocol range the worker daemon announces. */
  readonly protocolVersion?: number | ProtocolRange;
  readonly processSupervisor?: ProcessSupervisor;
  readonly socketPath?: string;
  readonly systemStats?: SystemStats;
  readonly tcpProbe?: TcpProbe;
  readonly version?: string;
  /** why: test-only, replaces the poster a gateway's alerts send through. */
  readonly webhookPoster?: WebhookPoster;
}

interface UpdateOptionsParts {
  readonly clock: Clock;
  readonly dataDirectory: string;
  readonly eventBus: EventBus;
  readonly filesystem: Filesystem;
  readonly ipc: IpcConnector & IpcListenerFactory;
  readonly npm: NpmCli;
  readonly role: DaemonRole;
  readonly version: string;
  readonly versionCheck: VersionCheck;
}

// why: both roles share these; each adds what it holds leases with.
function updateOptionsFor(
  parts: UpdateOptionsParts,
): Omit<UpdateCoordinatorOptions, "leasing" | "registry"> {
  const { dataDirectory, ipc, role } = parts;
  return {
    clock: parts.clock,
    dataDirectory,
    eventBus: parts.eventBus,
    filesystem: parts.filesystem,
    latestVersion: () => parts.versionCheck.latest(),
    launcher: new NodeUpdaterLauncher(),
    logPath: join(dataDirectory, "daemon.log"),
    npm: parts.npm,
    otherRoleRunning: () =>
      socketHeld(
        ipc,
        resolveDaemonSocketPath(
          daemonDataDirectory(resolveSimlockHome(), role === "worker" ? "gateway" : "worker"),
        ),
      ),
    packageRoot: fileURLToPath(new URL("../../", import.meta.url)),
    pid: process.pid,
    role,
    simlockHome: resolveSimlockHome(),
    version: parts.version,
  };
}

/** Constructs the daemon's real adapters once; all state remains in the daemon. */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonServer> {
  let opened: StateDatabase | undefined;
  let check: VersionCheck | undefined;
  try {
    return await composeDaemon(
      options,
      (state) => {
        opened = state;
      },
      (started) => {
        check = started;
      },
    );
  } catch (error: unknown) {
    // why: the check's 24 h timer would keep a failed start's process alive and re-ask npm; a running daemon disposes it in `dispose`.
    check?.dispose();
    // why: a start that fails after `state.db` opened must not hold the file; a running daemon closes it in `dispose`.
    opened?.close();
    throw error;
  }
}

// fallow-ignore-next-line complexity -- explicit production composition necessarily wires all external ports.
async function composeDaemon(
  options: StartDaemonOptions,
  onStateOpened: (state: StateDatabase) => void,
  onVersionCheck: (check: VersionCheck) => void,
): Promise<DaemonServer> {
  const version = options.version ?? readPackageVersion();
  const role = options.role ?? "worker";
  const dataDirectory = options.dataDirectory ?? daemonDataDirectory(resolveSimlockHome(), role);
  const filesystem = options.filesystem ?? new NodeFilesystem();
  const clock = options.clock ?? new SystemClock();
  const systemStats = options.systemStats ?? new NodeSystemStats();
  const idGenerator = options.idGenerator ?? new CryptoIdGenerator();
  const ipc = options.ipc ?? new NodeIpcTransport();
  const baseProcessRunner = options.processRunner ?? new NodeProcessRunner();
  const processSupervisor = options.processSupervisor ?? new NodeProcessSupervisor();
  const tcpProbe = options.tcpProbe ?? new NodeTcpProbe();
  const configPath = options.configPath ?? join(dataDirectory, "config.json");
  const socketPath = options.socketPath ?? resolveDaemonSocketPath(dataDirectory);
  const configWarnings: string[] = [];
  const moduleDefinitions = options.optionalModules ?? optionalModules;
  const { config, defaulted } = await loadConfigWithDefaults({
    configPath,
    filesystem,
    modules: moduleDefinitions.map(({ config: moduleConfig, enabledByDefault, name }) => ({
      name,
      ...moduleConfig,
      ...(enabledByDefault === undefined ? {} : { enabledByDefault }),
    })),
    ...(options.configOverrides === undefined ? {} : { overrides: options.configOverrides }),
    role,
    systemStats,
    warn: (message) => configWarnings.push(message),
  });
  const logger =
    options.logger ??
    new JsonLinesLogger({
      clock,
      level: config.log.level,
      sink: new NodeFileLogSink({
        maxBytes: config.log.rotateBytes,
        path: join(dataDirectory, "daemon.log"),
      }),
    });
  // why: the logger needs the config's log level, so what the config load found to warn about is told once the logger exists.
  for (const message of configWarnings) logger.warn(message);
  const processRunner = processRunnerFor(config.log.level, baseProcessRunner, logger, clock);
  // ADR 0008 §6: the machine is read once, here. Bounded and never throwing, so a slow or
  // missing `sw_vers` costs a fallback value, not the daemon.
  const hostSystem = await (
    options.hostInfo ?? new NodeHostInfo({ platform: process.platform, processRunner })
  ).read();
  const eventBus = new EventBus(
    clock,
    config.eventBuffer.capacity,
    eventBusLogger(logger),
    idGenerator,
  );
  const eventHistory = openEventHistory({
    clock,
    config,
    dataDirectory,
    eventBus,
    logger,
  });
  const deviceDataTables = await resolveDeviceDataTables(options);
  await refuseWhenDaemonAnswers({ connector: ipc, endpoint: socketPath });
  const state = await openStateDatabase({
    dataDirectory,
    // why: node:sqlite writes the real disk, so the state never goes through a daemon's injected filesystem
    filesystem: new NodeFilesystem(),
    logger: logger.child("state"),
    oldFiles: role === "gateway" ? ["tokens.json", "workers.json"] : ["state.json", "tokens.json"],
    owners:
      role === "gateway"
        ? [tokensOwner, drainedWorkersOwner]
        : [registryOwner, warmPoolOwner, tokensOwner, ...new Set(deviceDataTables.values())],
    sqlite: new NodeSqliteOpener(),
    upgradeStep: role === "gateway" ? GATEWAY_UPGRADE_STEP : WORKER_UPGRADE_STEP,
  });
  onStateOpened(state);
  // why: both modes check the same credentials, so the checks are built once, before the mode branch.
  const created = createAuth({
    clock,
    config: config.http,
    database: state.database,
    dataDirectory,
    filesystem,
    idGenerator,
    keySetFetcher: new NodeKeySetFetcher(),
    logger: logger.child("auth"),
    secrets: new CryptoTokenSecrets(),
  });
  const auth = { ...created, adminSecret: reportingAdminSecret(created.adminSecret, options) };
  // ADR 0005 §1/§2: one process, one mode. A gateway starts no drivers, validates no device
  // roots, loads no registry, and runs no reaper, health monitor or capacity strategy -- so the
  // branch is here, before any of that is built, rather than as a set of conditionals threaded
  // through the worker's composition below.
  const npm =
    options.npm ?? new NodeNpmCli({ runner: baseProcessRunner, filesystem, dataDirectory });
  const versionCheck = startVersionCheck({
    npm,
    clock,
    logger: logger.child("version-check"),
    enabled: config.update.check,
  });
  onVersionCheck(versionCheck);
  if (role === "gateway") {
    return startGatewayDaemon({
      auth,
      clock,
      config,
      dataDirectory,
      eventBus,
      eventHistory,
      filesystem,
      ...(options.gatewayRelay === undefined ? {} : { gatewayRelay: options.gatewayRelay }),
      ...(options.gatewayUplinks === undefined ? {} : { gatewayUplinks: options.gatewayUplinks }),
      hostSystem,
      ...(options.hostLoadProbe === undefined ? {} : { hostLoadProbe: options.hostLoadProbe }),
      idGenerator,
      ipc,
      logger,
      npm,
      optionalModules: moduleDefinitions,
      socketPath,
      state,
      ...(options.updater === undefined ? {} : { updater: options.updater }),
      version: version,
      versionCheck,
      ...(options.webhookPoster === undefined ? {} : { webhookPoster: options.webhookPoster }),
    });
  }
  const registry = await Registry.load({
    clock,
    deviceData: deviceDataTables,
    eventBus,
    idGenerator,
    leaseIdentity: config.lease.identity,
    leaseRequestLimits: {
      maxRecords: config.lease.maxRequestRecords,
      retentionMs: config.lease.requestRetentionMs,
    },
    state,
  });
  // Before discovery, because every root a driver validates is checked against it, and it
  // is written exactly once per home and never regenerated (ADR 0001, decision 2).
  const instanceId = await loadInstanceId({
    filesystem,
    idGenerator,
    path: join(dataDirectory, "instance.json"),
  });
  const { drivers, prerequisiteChecks, rejections } =
    options.drivers === undefined
      ? await discoverDrivers({
          acceptAndroidLicenses: config.downloads.acceptAndroidLicenses,
          clock,
          driversConfig: config.drivers,
          eventBus,
          filesystem,
          hostArch: hostSystem.arch,
          hostPlatform: process.platform,
          idGenerator,
          instanceId,
          logger,
          processRunner,
          processSupervisor,
          simlockHome: dataDirectory,
          slim: config.ios.slim,
          slimByDefault: deviceModeWiring(config).slimByDefault,
          androidEmulator: config.android.emulator,
          tcpProbe,
        })
      : {
          drivers: options.drivers,
          prerequisiteChecks: options.prerequisiteChecks ?? [],
          rejections: [],
        };
  // ADR 0008 §7: read at startup in the background, served from memory, re-read when stale.
  // Nothing waits on the first read; `status.get` reports no tools until it lands.
  const hostFacts = new HostFactsReader({
    clock,
    drivers,
    logger: logger.child("host-facts"),
    system: hostSystem,
  });
  void hostFacts.refresh();
  const hostLoadProbe =
    options.hostLoadProbe === undefined
      ? productionHostLoadProbe({ dataDirectory, platform: process.platform })
      : options.hostLoadProbe;
  const hostLoad =
    hostLoadProbe === null
      ? undefined
      : new HostLoadSampler({ clock, logger: logger.child("host-load"), probe: hostLoadProbe });
  // One gate for every registry write: leasing's, core's and the installer's records.
  const decisions = new SerializedDecision();
  // The one caller of `Driver.installComponent` (ADR 0010 §3). Its `DiskSpaceGuard` is the only
  // one, so an iOS and an Android install see each other's reservations.
  const components = new ComponentInstaller({
    clock,
    decisions,
    diskSpace: new DiskSpaceGuard(),
    drivers: new DriverCatalog(drivers),
    eventBus,
    filesystem,
    logger: logger.child("components"),
    registry,
    timeoutMs: config.downloads.timeoutMs,
  });
  const modelPreferences = modelPreferenceWiring(config, drivers);
  const core = createCore({
    clock,
    components,
    config,
    decisions,
    drivers,
    driverRejections: rejections,
    eventBus,
    logger,
    modelPreferences,
    optionalModules: () => moduleHost.findings(),
    prerequisiteChecks,
    ...(options.serviceCheck === undefined ? {} : { serviceCheck: options.serviceCheck }),
    registry,
    state,
    systemStats,
  });
  const leaseEnvironment: Record<string, string> = Object.assign(
    {},
    ...drivers.map((driver) => driver.virtualLeaseEnvironment()),
  );
  // why: a module's context is built before leasing exists, so `cancelPending` answers only once leasing does.
  let cancelPendingRequest: ((requesterId: string) => Promise<unknown>) | undefined;
  const moduleHost = await createModuleHost({
    config,
    defaulted,
    context: {
      cancelPending: (requesterId) => {
        if (cancelPendingRequest === undefined) {
          throw new Error("leasing is not ready yet");
        }
        return cancelPendingRequest(requesterId);
      },
      clock,
      dataDirectory,
      environment: process.env,
      events: { subscribe: (event, handler) => eventBus.subscribe(event, handler) },
      filesystem,
      instanceId,
      leaseEnvironment,
      nodePath: process.execPath,
      nodeVersion: process.versions.node,
      platforms: drivers.map((driver) => driver.platform),
      processRunner,
      processSupervisor,
      registry,
      screens: new DriverCatalog(drivers),
      tcpProbe,
    },
    definitions: moduleDefinitions,
    logger,
    tokens: auth.tokens,
    role: "worker",
  });
  // Builds leasing on top of core (ADR 0018 §2).
  const leasing = createLeasing({
    clock,
    components,
    config,
    core,
    defaultModes: deviceModeWiring(config).defaultModes,
    describeFailure: describeLeaseRequestFailure,
    eventBus,
    idGenerator,
    leaseEndParticipants: [...moduleHost.leaseEndParticipants],
    logger,
    modelPreferences,
  });
  cancelPendingRequest = (requesterId) => leasing.cancelPending(requesterId);
  // Core declared ports only leasing can implement; this is the one place they are handed over,
  // before any request is admitted (ADR 0018 §2).
  core.connect(leasing.corePorts);
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: core.cleanup,
    filesystem,
    logger,
    registry,
    diskPath: dataDirectory,
    targetedDevices: () => core.targetedDevices(),
  });
  const nuke = new Nuke({ executor: core.nuke, registry });
  /**
   * ADR 0005 §3/§4: two config keys join a fleet. Undefined here means this worker has no
   * gateway, which is every worker today -- and the daemon is otherwise completely unchanged
   * either way, which is the point of the uplink being outbound.
   */
  const gatewayUplink =
    config.gateway.url === undefined || config.gateway.token === undefined
      ? undefined
      : new GatewayUplink({
          accept: (connection) => daemon.acceptUplink(connection),
          clock,
          connector: new WebSocketUplinkConnector(),
          logger: logger.child("uplink"),
          token: config.gateway.token,
          url: config.gateway.url,
          workerId: instanceId,
          ...(config.gateway.label === undefined ? {} : { label: config.gateway.label }),
        });
  // Reassigned once the HTTP frontend actually starts, but must exist as a stable closure now:
  // `stopAuxiliary` is fixed at `DaemonServer` construction time, before the frontend itself
  // exists.
  let stopHttpGateway: (() => Promise<void>) | undefined;
  // Settles once the HTTP gateway either finishes starting or fails to -- resolved/rejected from
  // inside `onSocketClaimed`'s handler below. `startDaemon()` awaits this alongside
  // `daemon.start()` itself (see the bottom of this function) so a bind failure (occupied port,
  // invalid host) makes `startDaemon()` reject and the entrypoint report a non-zero exit code,
  // the way it did before the gateway moved to firing concurrently with convergence. `stopAuxiliary`
  // below *also* awaits this -- that is what closes review finding S5: without it, `stopAuxiliary`
  // could return having stopped nothing (because `stopHttpGateway` isn't assigned yet, the
  // gateway still being mid-`start()`), and `#stop()` would go on to settle and dispose while
  // the gateway finishes binding and starts accepting requests against a daemon already being
  // torn down -- see `server.ts`'s `stopAuxiliary` doc: it must be shut off before lease/queue
  // teardown begins. When HTTP is disabled there is nothing to wait for, so this resolves
  // immediately.
  let resolveGatewayStarted: (() => void) | undefined;
  let rejectGatewayStarted: ((error: unknown) => void) | undefined;
  /** Whether `onSocketClaimed` ever fired, i.e. whether anything will ever settle
   * `gatewayStarted`. See the `finally` on `daemon.start()` below. */
  let socketClaimed = false;
  const gatewayStarted: Promise<void> = config.http.enabled
    ? new Promise<void>((resolve, reject) => {
        resolveGatewayStarted = resolve;
        rejectGatewayStarted = reject;
      })
    : Promise.resolve();
  // ADR 0019 §1, in this order: settle the open requests, read each platform once, doctor's
  // startup pass on that read, end every lease whose device is not running and restore the
  // timers of the rest, then core's device convergence, then the queue's first depth, which every
  // run begins with. One after another: the reconciler needs the read, and convergence must not
  // pick a device the reconciler is about to release.
  // Set once a stop begins. A `daemon.stop` is accepted while startup runs, and the read takes up
  // to a minute: every step after it would arm timers (expiry, quarantine retry, warm pool tick)
  // on a daemon whose disposal has already run, and nothing would cancel them.
  let stopping = false;
  const convergeStartup = async (): Promise<void> => {
    await sweepWriteLeftovers({
      deviceRoots: deviceRoots(drivers),
      directories: [dataDirectory],
      filesystem,
      logger,
      processSupervisor,
      ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
    });
    await leasing.settleRequests();
    const read = await core.readStartup();
    const steps = [
      () => core.doctor.reconcile({ read }),
      () => leasing.reconcile(read),
      () => core.converge(read),
    ];
    for (const step of steps) {
      if (stopping) return;
      await step();
    }
    leasing.announceQueueDepth();
  };
  const daemon = new DaemonServer({
    // Closes the warm pool the moment a stop is asked for, ahead of every await in the stop.
    beginStop: () => core.closeWarmPool(),
    // why: the source's name is the config key's; the core names no module, so the composition supplies it.
    capabilitySources: [...moduleHost.capabilitySources],
    capacity: core.capacityReader,
    warmPool: core.warmPoolReader,
    catalog: core.catalog,
    deviceModes: leasing,
    clock,
    components,
    config,
    doctor: core.doctor,
    driverRejections: rejections,
    defaultRequesterId:
      options.defaultRequesterId ?? process.env.SIMLOCK_AGENT_ID ?? String(process.pid),
    eventBus,
    eventHistory,
    historyPath: join(dataDirectory, HISTORY_DB_NAME),
    healthMonitor: leasing.healthMonitor,
    physicalDeviceWatcher: leasing.physicalDeviceWatcher,
    hostFacts: () => fitHostFacts(hostFacts.current()),
    ...(hostLoad === undefined ? {} : { hostLoad, load: () => fitHostLoad(hostLoad.current()) }),
    instanceId,
    host: new DaemonEndpointHost({
      connector: ipc,
      endpoint: socketPath,
      filesystem,
      listenerFactory: ipc,
      logger: logger.child("connection-host"),
    }),
    leases: leasing,
    logger: logger.child("server"),
    ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
    passthrough: core.catalog,
    processRunner,
    execEnv: process.env,
    queue: leasing,
    presence: latestPresence,
    reaper,
    relayTargets: {
      ...moduleHost.relayTargets,
      ...options.relayTargets,
    },
    enrollment: wakingQueueAfter(core.enrollment, () => leasing.corePorts.notifyAvailability()),
    nuke,
    registry,
    stalls: { claims: core.claimReader, drivers },
    resolveRole: { resolve: (hello) => auth.resolveHelloRole(hello) },
    adminSecret: auth.adminSecret,
    tokens: auth.tokens,
    update: createUpdateCoordinator({
      ...updateOptionsFor({
        clock,
        dataDirectory,
        eventBus,
        filesystem,
        ipc,
        npm,
        role,
        version,
        versionCheck,
      }),
      leasing,
      registry,
    }),
    version: version,
    converge: convergeStartup,
    settle: async () => {
      stopping = true;
      await leasing.settle();
      await core.drain();
    },
    // Every driver is tried even when another throws: Android's disposal is the only thing that can stop the adb server it started.
    dispose: async () => {
      versionCheck.dispose();
      core.dispose();
      leasing.dispose();
      // Before the drivers: a running install is ended through its signal while its driver
      // can still stop the installer process.
      await components.close();
      await moduleHost.beforeDriversDispose();
      const disposals = await Promise.allSettled(drivers.map((driver) => driver.dispose?.()));
      for (const [index, disposal] of disposals.entries()) {
        if (disposal.status === "rejected") {
          logger.error("Driver disposal failed", {
            platform: drivers[index]?.platform,
            reason: disposal.reason instanceof Error ? disposal.reason.message : "unknown",
          });
        }
      }
      await eventHistory.stop();
      state.close();
    },
    // Review finding S5: waits for the concurrently-started gateway to either finish binding
    // (so `stopHttpGateway` is assigned and can actually be called) or fail to bind (nothing to
    // stop) *before* returning -- `#stop()` awaits this call before settling and disposing
    // (see `server.ts`; the leases themselves are left alone, ADR 0004 §3), so by the time
    // either of those runs, the gateway is guaranteed to be either stopped or never listening
    // in the first place. `gatewayStarted`'s rejection (a bind failure) is not this function's
    // problem to surface -- the `Promise.allSettled` at the bottom of this function, or the
    // standalone `daemon.stop()` call after it, already handle that -- so it is swallowed
    // here.
    stopAuxiliary: async () => {
      await moduleHost.beforeDrain();
      await gatewayStarted.catch(() => undefined);
      await stopHttpGateway?.();
      // Stopped with the other auxiliary frontends, and for the same reason: the uplink is a
      // live connection into this daemon's dispatcher, so it must be shut before lease/queue
      // teardown begins. Stopping it also stops the reconnect loop, so a shutting-down worker
      // does not redial the gateway it just left.
      await gatewayUplink?.stop();
    },
    // ADR 0003 §2: "an HTTP request during startup now waits like a socket request instead of
    // being refused". Firing the gateway's own `start()` from here (not after `daemon.start()`
    // resolves) is what makes that true: the gateway is listening, and every route calls
    // `daemon.dispatch(...)`, which parks on the same startup-readiness gate a socket request
    // does. A bind failure (occupied port, invalid host) is reported through `gatewayStarted`
    // rather than acted on immediately here -- see the bottom of this function for why: calling
    // `daemon.stop()` right away, while `daemon.start()` may still be awaiting convergence, is
    // what let a stale "Daemon started" log/event follow "Daemon stopping" (review finding B6).
    onSocketClaimed: () => {
      socketClaimed = true;
      startHistory(
        eventHistory,
        logger,
        stopForRefusedHistory({ stop: (reason) => daemon.stop(reason) }),
      );
      moduleHost.afterSocketClaimed();
      // why: dialled here, once the socket is claimed and `#readyPromise` is set. The gateway's first
      // `status.get` never parks (it still answers `starting` during convergence), but its
      // `events.subscribe` does park on startup readiness, so the refresh that follows the
      // subscribe reads `running` instead of keeping `starting`. A daemon that fails its
      // claim never reaches this line, so its uplink is never dialled. Nothing awaits the
      // uplink: a worker whose gateway is down must still come up and serve its local agents
      // (`GatewayUplink` retries on its own backoff). The dial waits for the first host load reading,
      // because the gateway reads `status.get` once on connect and next on its 30 s beat, so a dial that beats the first host load reading leaves the worker without a Load for that long.
      if (gatewayUplink !== undefined) {
        void (hostLoad?.firstReading() ?? Promise.resolve()).then(() => gatewayUplink.start());
      }
      const profilesPrepared = moduleHost.prepareLocalProfiles();
      if (!config.http.enabled) return;
      void profilesPrepared.then(startHttpGateway).then(
        () => resolveGatewayStarted?.(),
        (error: unknown) => {
          logger.error("HTTP frontend failed to start", { message: errorMessage(error) });
          rejectGatewayStarted?.(error);
        },
      );
    },
  });

  async function startHttpGateway(): Promise<void> {
    const httpLogger = logger.child("http");
    const dispatch: HttpDispatch = (operation, input, session) =>
      daemon.dispatch(operation, input, session);
    const app = createHttpApp({
      clock,
      config,
      dispatch,
      eventBus,
      idGenerator,
      leaseRequests: leasing.requests,
      logger: httpLogger,
      mounts: [...moduleHost.mounts({ dispatch })],
      ownerRoutedFacts: daemon.ownerRoutedFacts,
      registry,
      auth,
    });
    const gateway = new HttpGateway(app, {
      host: config.http.host,
      logger: httpLogger,
      port: config.http.port,
    });
    await gateway.start();
    stopHttpGateway = async () => {
      await gateway.stop();
      app.dispose();
    };
    // No self-stop check here: `stopAuxiliary` above is the single place that decides whether
    // to stop the gateway, and it does so by awaiting `gatewayStarted` (settled once this
    // function's caller -- `onSocketClaimed`'s handler below -- resolves or rejects) before
    // calling `stopHttpGateway`. Stopping here too would double-stop it.
  }

  // why: awaited together, not `daemon.start()` alone: `gatewayStarted` is the promise
  // `onSocketClaimed`'s handler above settles once the concurrently-started HTTP gateway either
  // finishes starting or fails to. Both are already running concurrently by the time this line
  // is reached (the gateway since `onSocketClaimed` fired partway through `daemon.start()`), so
  // this changes nothing about when either finishes -- only what `startDaemon()` itself reports.
  // `gatewayStarted` is settled only from inside `onSocketClaimed`'s handler, and `start()`
  // fires that callback only once the socket claim (and the admin secret write) has succeeded.
  // A daemon that loses the start race therefore rejects without the callback ever running, so
  // nothing would settle `gatewayStarted` and the join below would hang forever rather than
  // reporting the failure. Release it here on that path -- resolving an already-settled promise
  // is a no-op, so this cannot pre-empt a real bind result, and the `socketClaimed` guard keeps
  // it from resolving early while a claimed daemon's gateway is still binding.
  const daemonStarted = daemon.start().finally(() => {
    if (!socketClaimed) resolveGatewayStarted?.();
  });
  const [daemonResult, gatewayResult] = await Promise.allSettled([daemonStarted, gatewayStarted]);
  if (gatewayResult.status === "rejected" && daemonResult.status === "fulfilled") {
    // The daemon itself came all the way up -- convergence succeeded, `daemon.started` was
    // already emitted -- but its HTTP gateway never bound. Tear the whole thing down now,
    // *after* that success is a settled fact, so `daemon.stopping` never precedes (or follows
    // out of order) `daemon.started`; see this function's own comment above `onSocketClaimed`
    // and review finding B6. `stop()` is idempotent/dedups concurrent callers, so this is safe
    // even if `stopAuxiliary`'s own path already ran one.
    await daemon.stop("http-start-failed").catch(() => undefined);
  }
  if (daemonResult.status === "rejected") throw daemonResult.reason;
  if (gatewayResult.status === "rejected") throw gatewayResult.reason;
  return daemon;
}

interface GatewayDaemonOptions {
  readonly auth: Auth;
  readonly clock: Clock;
  readonly config: Config;
  readonly dataDirectory: string;
  readonly eventBus: EventBus;
  readonly eventHistory: EventHistoryHandle;
  readonly filesystem: Filesystem;
  readonly gatewayRelay?: (relay: GatewayRelay) => void;
  readonly gatewayUplinks?: (uplinks: WebSocketUplinkListenerFactory) => void;
  /** The gateway's own machine. It runs no drivers, so its host facts carry no tools. */
  readonly hostSystem: HostSystem;
  readonly hostLoadProbe?: HostLoadProbe | null;
  readonly idGenerator: IdGenerator;
  readonly ipc: IpcConnector & IpcListenerFactory;
  readonly logger: Logger;
  readonly npm: NpmCli;
  readonly optionalModules: readonly OptionalModuleDefinition<unknown>[];
  readonly socketPath: string;
  readonly state: StateDatabase;
  readonly updater?: StartDaemonOptions["updater"];
  readonly version: string;
  readonly versionCheck: VersionCheck;
  readonly webhookPoster?: WebhookPoster;
}

/**
 * A daemon in gateway mode (ADR 0005 §2, §32): no drivers, no registry, no reaper, no health
 * monitor, no capacity strategy. What it has instead is a worker registry fed by uplinks, and
 * `GatewayDispatcher` answering the same contract from those views.
 *
 * Two things are unconditional here where a worker makes them optional, and both follow from
 * §2's "a gateway always listens on HTTP (it is the fleet's contact point) and on its unix
 * socket": HTTP is started (the config loader refuses `http.enabled: false` in this mode), and
 * the uplink listener is attached to that same HTTP server, so the whole fleet has exactly one
 * inbound port.
 */
// fallow-ignore-next-line complexity -- explicit production composition, exactly like `startDaemon`'s worker half.
async function startGatewayDaemon(options: GatewayDaemonOptions): Promise<DaemonServer> {
  const {
    auth,
    clock,
    config,
    dataDirectory,
    eventBus,
    eventHistory,
    filesystem,
    idGenerator,
    logger,
    state,
  } = options;
  // The gateway's own identity, used to namespace the principal it announces to each worker
  // (ADR 0005 §27's shape) so a worker's logs attribute what the gateway did to the gateway.
  const instanceId = await loadInstanceId({
    filesystem,
    idGenerator,
    path: join(dataDirectory, "instance.json"),
  });
  // ADR 0005 §14/§27: stamped on every requester id this gateway forwards, and what
  // `FleetLeaseIndex` recognizes its own leases by when rebuilding from a worker's view.
  const gatewayRequesterPrefix = `gw:${instanceId}:`;
  const leaseIndex = new FleetLeaseIndex(gatewayRequesterPrefix, logger.child("lease-index"));
  // `src/gateway` cannot see `core`'s `Config` (ADR 0005 §33), so the two lists of policy names
  // are separate declarations. This call is where they meet: a name `loadConfig` accepts that
  // the gateway's registry lacks fails `pnpm typecheck` here, not a daemon start.
  const routing = createRoutingPolicy(config.gateway.routing);

  const uplinks = new WebSocketUplinkListenerFactory();
  options.gatewayUplinks?.(uplinks);
  const gatewayService = new GatewayService({
    // ADR 0005 §4/§25: only a `worker`-role token opens an uplink. A token of another role is
    // real and simply has no authority here (403); anything else is unauthenticated (401).
    // C-2: the accepted case names the token's own id, so `token.revoke` can later find and
    // close every uplink it authorized (`GatewayService#closeLinksForToken`, wired below).
    authenticate: (credential) => auth.authenticateUplink(credential),
    clock,
    drainStore: new StateDrainStore({ database: state.database, logger: logger.child("gateway") }),
    eventBus,
    // ADR 0005 §15: this gateway's own cap, compared against every connected worker's own
    // reported one so the registry can warn when a worker's is lower.
    leaseMaxTtlMs: config.lease.maxTtlMs,
    logger: logger.child("gateway"),
    principal: `gw:${instanceId}`,
    retentionMs: config.gateway.disconnectedRetentionMs,
    uplinks,
  } satisfies GatewayServiceOptions);

  // ADR 0005 §10-§16/§27a: the fleet queue, routing, and lease/exec forwarding (#118).
  // `gatewayService` itself satisfies `WorkerDirectory` (`target()`), and its own registry
  // satisfies `FleetViews` -- neither is imported as its concrete class by the coordinator,
  // only through `fleet-ports.ts`'s seam.
  const fleetCoordinator = new FleetLeaseCoordinator({
    clock,
    directory: gatewayService,
    eventBus,
    // ADR §19e (P5, round 2 review): the gateway-side backstop on a forwarded `device.exec`.
    execTimeoutMs: config.gateway.execTimeoutMs,
    idGenerator,
    leaseIndex,
    // P2 (round 2 review): bounds a forwarded `lease.request`, the one uplink call that used to
    // have no timeout of its own.
    leaseRequestTimeoutMs: config.gateway.leaseRequestTimeoutMs,
    describeFailure: describeLeaseRequestFailure,
    leaseRequestLimits: {
      maxRecords: config.lease.maxRequestRecords,
      retentionMs: config.lease.requestRetentionMs,
    },
    logger: logger.child("gateway"),
    maxPerRequester: config.lease.maxPerRequester,
    routing,
    views: gatewayService.workers,
  });
  // #118: replaces the inert `OwnerRoutedFacts` gateway mode used since #117 -- see
  // `GatewayOwnerRoutedFacts`'s own doc comment for why the fleet's lease index, not a worker's
  // relayed payload, is what a fleet lease's push has to be routed by.
  const gatewayOwnerRoutedFacts = new GatewayOwnerRoutedFacts(eventBus, leaseIndex);
  const gatewayRelay = new GatewayRelay({ clock, directory: gatewayService });
  // why: a test reaches the gateway's relay through this callback.
  options.gatewayRelay?.(gatewayRelay);
  const moduleHost = await createModuleHost({
    config,
    definitions: options.optionalModules,
    logger,
    parts: {
      cancelPending: (requesterId) => fleetCoordinator.cancelPending(requesterId),
      clock,
      grantedDevices: () => gatewayService.workers.grantedDevices(),
      instanceId,
      leases: leaseIndex,
      relay: (workerId, call) => gatewayRelay.relay(workerId, call),
      requesterPrefix: gatewayRequesterPrefix,
      startedAt: clock.now(),
      worker: (id) => gatewayService.workers.view(id),
      workers: () => gatewayService.workers.views(),
    },
    role: "gateway",
  });

  let stopHttpGateway: (() => Promise<void>) | undefined;
  let resolveHttpStarted: (() => void) | undefined;
  let rejectHttpStarted: ((error: unknown) => void) | undefined;
  let socketClaimed = false;
  const httpStarted = new Promise<void>((resolveStarted, rejectStarted) => {
    resolveHttpStarted = resolveStarted;
    rejectHttpStarted = rejectStarted;
  });

  const hostLoadProbe =
    options.hostLoadProbe === undefined
      ? productionHostLoadProbe({ dataDirectory, platform: process.platform })
      : options.hostLoadProbe;
  const hostLoad =
    hostLoadProbe === null
      ? undefined
      : new HostLoadSampler({ clock, logger: logger.child("host-load"), probe: hostLoadProbe });

  let alerts: Alerts | undefined;

  // why: a gateway holds no leases of its own and fleet admission is not changed (ADR 0042 §6), so an update never waits.
  const update = createUpdateCoordinator({
    ...updateOptionsFor({
      clock,
      dataDirectory,
      eventBus,
      filesystem,
      ipc: options.ipc,
      npm: options.npm,
      role: "gateway",
      version: options.version,
      versionCheck: options.versionCheck,
    }),
    ...options.updater,
    leasing: { holdForUpdate: async () => {}, releaseUpdateHold: async () => {} },
    registry: { snapshot: { leases: [] } },
  });
  const gatewayDispatcher = new GatewayDispatcher({
    awaitReady: () => Promise.resolve(),
    clock,
    errorCode: classifyError,
    closeUplinksForToken: (tokenId) => gatewayService.closeLinksForToken(tokenId),
    config,
    coordinator: fleetCoordinator,
    directory: gatewayService,
    eventHistory,
    health: () => daemon.health,
    version: options.version,
    host: fitHostFacts({ ...options.hostSystem, tools: [] }),
    ...(hostLoad === undefined ? {} : { load: () => fitHostLoad(hostLoad.current()) }),
    leaseIndex,
    latestVersion: () => options.versionCheck.latest(),
    logger: logger.child("gateway"),
    update,
    // why: `alerts` is built after this dispatcher but before start(), and only with destinations; without any, the option stays out.
    ...(config.gateway.alerts.destinations.length === 0
      ? {}
      : { testDestination: (destination: string) => (alerts as Alerts).test(destination) }),
    tokens: auth.tokens,
    workers: gatewayService.workers,
    historyPath: join(dataDirectory, HISTORY_DB_NAME),
  });

  const daemon = new DaemonServer({
    adminSecret: auth.adminSecret,
    clock,
    config,
    defaultRequesterId: process.env.SIMLOCK_AGENT_ID ?? String(process.pid),
    ...(hostLoad === undefined ? {} : { hostLoad }),
    // ADR 0005 §32: the contract's second implementation, serving the same transport.
    dispatcher: gatewayDispatcher,
    update,
    eventBus,
    host: new DaemonEndpointHost({
      connector: options.ipc,
      endpoint: options.socketPath,
      filesystem,
      listenerFactory: options.ipc,
      logger: logger.child("connection-host"),
    }),
    // #118: a fleet client's own `lease.release-all` needs this to suppress its own
    // `lease-lost` pushes, exactly as a worker's own registry does for its engine.
    leaseSnapshot: () =>
      leaseIndex.all().map((entry) => ({ id: entry.gatewayLeaseId, ownerId: entry.ownerId })),
    logger: logger.child("server"),
    ownerRoutedFacts: gatewayOwnerRoutedFacts,
    resolveRole: { resolve: (hello) => auth.resolveHelloRole(hello) },
    version: options.version,
    // A gateway's "convergence" is starting to accept uplinks and arming the refresh tick.
    // Running it here rather than before `start()` keeps one lifecycle: a listener that cannot
    // start fails the daemon start, and `status.get` answers throughout (a fleet with no views
    // yet is a true answer, not an unready one). A worker that dials in the window before this
    // resolves is refused and redials on its own backoff.
    converge: async () => {
      await gatewayService.start();
      fleetCoordinator.start();
    },
    dispose: async () => {
      options.versionCheck.dispose();
      gatewayDispatcher.dispose();
      fleetCoordinator.dispose();
      gatewayOwnerRoutedFacts.dispose();
      await gatewayService.stop();
      await eventHistory.stop();
      state.close();
    },
    stopAuxiliary: async () => {
      // why: before the HTTP gateway closes the worker uplinks, so this gateway's own stop sends no worker.disconnected (ADR 0035 §4).
      alerts?.stop();
      await moduleHost.beforeDrain();
      await httpStarted.catch(() => undefined);
      await stopHttpGateway?.();
    },
    onSocketClaimed: () => {
      socketClaimed = true;
      startHistory(
        eventHistory,
        logger,
        stopForRefusedHistory({ stop: (reason) => daemon.stop(reason) }),
      );
      void startHttpFrontend().then(
        () => resolveHttpStarted?.(),
        (error: unknown) => {
          logger.error("HTTP frontend failed to start", { message: errorMessage(error) });
          rejectHttpStarted?.(error);
        },
      );
    },
  });

  async function startHttpFrontend(): Promise<void> {
    const httpLogger = logger.child("http");
    // why: looked up at each call, so a wrapper placed on the daemon's dispatch sits between the front and leasing.
    const dispatch: HttpDispatch = (operation, input, session) =>
      daemon.dispatch(operation, input, session);
    const app = createHttpApp({
      clock,
      config,
      dispatch,
      eventBus,
      idGenerator,
      // The fleet coordinator's in-memory request book: a gateway stores nothing on disk.
      leaseRequests: fleetCoordinator.requests,
      logger: httpLogger,
      mounts: [...moduleHost.mounts({ dispatch })],
      // Inert in gateway mode: the gateway issues no leases of its own in this PR, so there
      // are no owner-routed facts to buffer (see `DaemonServer`'s constructor).
      ownerRoutedFacts: daemon.ownerRoutedFacts,
      // A gateway owns no devices, so it has no registry. `GET /v1/leases/{id}` builds its lease
      // payload from the devices each worker view's refresh read in the grant shape, matched on
      // the lease's own worker. They carry no state, so `DELETE /v1/leases/{id}` reports its
      // `reclaiming` default.
      registry: {
        get snapshot() {
          return { devices: gatewayService.workers.grantedDevices() };
        },
      },
      // A gateway never downloads, so `allowDownload` has nothing slow to outlast the `POST`:
      // a request no worker can serve fails it, as without the flag.
      answerDownloadsEarly: false,
      auth,
    });
    const gateway = new HttpGateway(app, {
      host: config.http.host,
      logger: httpLogger,
      // ADR 0005 §4: the uplink upgrades on this same listener, so the fleet has one inbound
      // port. The factory only needs the server's `upgrade` event, which is all it is given.
      onServerCreated: (server) => uplinks.attach(server),
      port: config.http.port,
    });
    await gateway.start();
    stopHttpGateway = async () => {
      await gateway.stop();
      app.dispose();
    };
  }

  // why: built before start(), whose converge opens the uplink listener, so no worker joins before alerts subscribes.
  if (config.gateway.alerts.destinations.length > 0) {
    alerts = createAlerts({
      clock,
      destinations: config.gateway.alerts.destinations,
      eventBus,
      idGenerator,
      logger: logger.child("alerts"),
      poster: options.webhookPoster ?? new FetchWebhookPoster(),
      version: options.version,
      workerLabel: (workerId) => gatewayService.workers.view(workerId)?.label,
    });
  }

  const daemonStarted = daemon.start().finally(() => {
    if (!socketClaimed) resolveHttpStarted?.();
  });
  const [daemonResult, httpResult] = await Promise.allSettled([daemonStarted, httpStarted]);
  if (httpResult.status === "rejected" && daemonResult.status === "fulfilled") {
    // The gateway itself came up but its HTTP listener never bound -- which for a gateway means
    // no agent can reach it and no worker can join it. Tear it down, after the start is a
    // settled fact so `daemon.stopping` cannot precede `daemon.started`.
    await daemon.stop("http-start-failed").catch(() => undefined);
  }
  if (daemonResult.status === "rejected") throw daemonResult.reason;
  if (httpResult.status === "rejected") throw httpResult.reason;
  return daemon;
}

// why: `pnpm build` puts both capture artifacts beside the compiled daemon (scripts/build-capture.mjs),
// so a checkout that built finds them without configuration; `drivers.ios.screenCaptureCommand`
// names another iOS simulator program and `drivers.ios.deviceCaptureCommand` another physical iPhone one.
const PACKAGED_SCREEN_CAPTURE = fileURLToPath(
  new URL("../bin/simlock-screen-capture", import.meta.url),
);
const PACKAGED_DEVICE_CAPTURE = fileURLToPath(
  new URL("../bin/simlock-device-capture", import.meta.url),
);
const PACKAGED_SCRCPY_SERVER = fileURLToPath(
  // fallow-ignore-next-line unresolved-import -- a file pnpm build copies into dist, not a module.
  new URL("../vendor/scrcpy/scrcpy-server-v5.0.1", import.meta.url),
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DriverDiscoveryContext {
  /** Threaded into the Android driver's `downloads.acceptAndroidLicenses` gate; defaults to `false` when omitted. */
  readonly acceptAndroidLicenses?: boolean;
  readonly clock: Clock;
  /** Whole `drivers` config section: each driver is handed its own block, unread. */
  readonly driversConfig: Config["drivers"];
  /** Bridges the iOS driver's `device.slimmed` fact onto the bus -- see `emitSlimDiagnostic`. */
  readonly eventBus: Pick<EventBus, "emit">;
  readonly filesystem: Filesystem;
  /**
   * Which platform's tooling this host has, `process.platform` in production and supplied
   * by the composition root rather than read here. Discovery's fail-closed branch -- the
   * one that must cost a platform and never the daemon -- is otherwise reachable only on a
   * Mac, and so is untestable everywhere Simlock's own CI runs.
   */
  readonly hostPlatform: NodeJS.Platform;
  /** The host port's architecture; the Android driver prefers images of the ABI it runs. */
  readonly hostArch: string;
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly logger: Logger;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly simlockHome: string;
  readonly tcpProbe: TcpProbe;
  /**
   * How the iOS driver makes a slim device (`ios.slim` in config), whatever the default mode.
   * Never threaded into the Android driver -- slim is iOS-only until Android slim lands. Omitted
   * means the iOS driver slims nothing.
   */
  readonly slim?: {
    readonly categories?: readonly string[];
    readonly bootTimeoutMs: number;
  };
  /**
   * Whether `ios.defaultMode` is `slim`, so the iOS driver reports runtimes it cannot slim in
   * `doctor` (ADR 0007 §14). The driver is told this boolean, never the default itself.
   */
  readonly slimByDefault?: boolean;
  /**
   * How the Android driver launches emulators (`android.emulator` in config). Handed over
   * unread; omitted or undefined leaves the driver's own default launch untouched.
   */
  readonly androidEmulator?: AndroidEmulatorLaunchOptions;
}

/**
 * Drivers that started, and the platforms that refused to -- both are startup outcomes -- with
 * the prerequisite checks for every platform this host could run, started or not.
 */
export interface DriverDiscovery {
  readonly drivers: readonly Driver[];
  readonly prerequisiteChecks: readonly PrerequisiteCheck[];
  readonly rejections: readonly DriverRejection[];
}

const WORKER_UPGRADE_STEP =
  "with the older Simlock, release every lease and run `simlock nuke --delete-devices`; then remove <path> and start again.";
const GATEWAY_UPGRADE_STEP =
  "remove <path> and start again; then create each worker's join token again with `simlock --gateway token create --role worker`, set it as that worker's `gateway.token`, and drain workers again.";

/** why: both tables whatever the host's platform, so a device whose driver was refused still loads. */
export function productionDeviceDataTables(): ReadonlyMap<Platform, DeviceDataTable> {
  return new Map([
    ["android", androidDeviceDataTable],
    ["ios", iosDeviceDataTable],
  ]);
}

/**
 * why: one function picks the map -- the option, else the `SIMLOCK_DRIVERS_MODULE` module's
 * `deviceDataTables` export, else the production tables -- so the state open and `Registry.load`
 * always see the same one.
 */
export async function resolveDeviceDataTables(
  options: Pick<StartDaemonOptions, "deviceDataTables">,
): Promise<ReadonlyMap<Platform, DeviceDataTable>> {
  if (options.deviceDataTables !== undefined) return options.deviceDataTables;
  const modulePath = process.env.SIMLOCK_DRIVERS_MODULE;
  if (modulePath === undefined) return productionDeviceDataTables();
  const imported = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    deviceDataTables?: unknown;
  };
  if (!(imported.deviceDataTables instanceof Map)) {
    throw new Error(
      `SIMLOCK_DRIVERS_MODULE ${modulePath} does not export deviceDataTables, a Map from platform to its device-data table`,
    );
  }
  return imported.deviceDataTables as ReadonlyMap<Platform, DeviceDataTable>;
}

export async function discoverDrivers(options: DriverDiscoveryContext): Promise<DriverDiscovery> {
  const logger = options.logger.child("driver-discovery");
  const driversModule = process.env.SIMLOCK_DRIVERS_MODULE;
  if (driversModule !== undefined) {
    // A substituted driver set owns whatever roots it wants, so there is nothing here to
    // refuse on its behalf.
    return { ...(await loadDriversModule(driversModule, options, logger)), rejections: [] };
  }

  const drivers: Driver[] = [];
  const rejections: DriverRejection[] = [];
  if (options.hostPlatform === "darwin") {
    const ios = await discoverIosDriver(options, logger);
    if (ios.driver !== undefined) drivers.push(ios.driver);
    if (ios.rejection !== undefined) rejections.push(ios.rejection);
  }
  const android = await discoverAndroidDriver(options, logger);
  if (android.driver !== undefined) drivers.push(android.driver);
  if (android.rejection !== undefined) rejections.push(android.rejection);
  return {
    drivers,
    prerequisiteChecks: platformPrerequisiteChecks({
      env: process.env,
      filesystem: options.filesystem,
      homeDirectory: homedir(),
      hostPlatform: options.hostPlatform,
      processRunner: options.processRunner,
    }),
    rejections,
  };
}

/**
 * The checks `doctor` runs for the platforms this host could run: iOS only on macOS, as
 * discovery itself decides, and Android everywhere. Built whether or not the platform's
 * driver started, because a driver that did not start is exactly when they are needed.
 */
export function platformPrerequisiteChecks(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly processRunner: ProcessRunner;
}): readonly PrerequisiteCheck[] {
  const checks: PrerequisiteCheck[] = [];
  if (options.hostPlatform === "darwin") {
    checks.push(iosPrerequisites({ processRunner: options.processRunner }));
  }
  checks.push(
    androidPrerequisites({
      env: options.env,
      filesystem: options.filesystem,
      homeDirectory: options.homeDirectory,
      processRunner: options.processRunner,
    }),
  );
  return checks;
}

/**
 * A refused root costs the daemon one platform, never the whole daemon: the other platform
 * may be perfectly healthy, and a daemon that will not start is a daemon that cannot tell
 * anyone why (safety rule 9). Every other failure still fails startup -- an unreadable root
 * is already an `OwnedRootError`, so what is left is a genuine bug.
 */
async function discoverIosDriver(
  options: DriverDiscoveryContext,
  logger: Logger,
): Promise<{ readonly driver?: Driver; readonly rejection?: DriverRejection }> {
  try {
    const driver = await IosSimctlDriver.create({
      clock: options.clock,
      coreSimulatorRoot: `${homedir()}/Library/Developer/CoreSimulator`,
      driverConfig: options.driversConfig["ios"] ?? {},
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      onSlimmed: emitSlimDiagnostic(options.eventBus),
      screenCapture: {
        baseEnvironment: process.env,
        command: PACKAGED_SCREEN_CAPTURE,
        deviceCommand: PACKAGED_DEVICE_CAPTURE,
        launcher: new NodeBytePipeLauncher(),
        onLog: (line) => logger.debug("Screen capture", { line }),
      },
      onSlimSkipped: (fact) => {
        logger.warn("Skipped iOS device slim", {
          deviceId: fact.deviceId,
          detail: fact.detail,
          reason: fact.reason,
        });
      },
      processRunner: options.processRunner,
      simlockHome: options.simlockHome,
      ...(options.slim === undefined ? {} : { slim: options.slim }),
      ...(options.slimByDefault === undefined ? {} : { slimByDefault: options.slimByDefault }),
      // Ambient like `homedir()` above, and read here rather than in the driver so the
      // composition root stays the only place that touches process state.
      ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
      pid: process.pid,
    });
    logger.info("Discovered driver", { platform: "ios" });
    return { driver };
  } catch (error: unknown) {
    if (!(error instanceof OwnedRootError)) {
      throw error;
    }

    logger.error("Skipped iOS driver: device root rejected", {
      reason: error.reason,
      root: error.path,
      summary: error.message,
    });
    return { rejection: rootRejection(error, IOS_PASSTHROUGH_TOOLS) };
  }
}

/**
 * Android refuses for one more reason than iOS does -- it needs a private adb server as
 * well as an owned root -- and both refusals cost the platform rather than the daemon.
 * A missing SDK is not a refusal at all: this host simply has no Android tooling, which is
 * ordinary and reported by the absence of the platform.
 */
async function discoverAndroidDriver(
  options: DriverDiscoveryContext,
  logger: Logger,
): Promise<{ readonly driver?: Driver; readonly rejection?: DriverRejection }> {
  try {
    const driver = await AndroidDriver.create({
      acceptAndroidLicenses: options.acceptAndroidLicenses ?? false,
      clock: options.clock,
      driverConfig: options.driversConfig["android"] ?? {},
      emulator: options.androidEmulator,
      env: process.env,
      filesystem: options.filesystem,
      homeDirectory: homedir(),
      hostAbi: hostAbiFor(options.hostArch),
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      processRunner: options.processRunner,
      processSupervisor: options.processSupervisor,
      scrcpyServerPath: PACKAGED_SCRCPY_SERVER,
      simlockHome: options.simlockHome,
      tcpProbe: options.tcpProbe,
      tcpStreamConnector: new NodeTcpStreamConnector(),
      // Ambient like `homedir()` above, and read here rather than in the driver so the
      // composition root stays the only place that touches process state.
      ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
      pid: process.pid,
    });
    logger.info("Discovered driver", { platform: "android" });
    return { driver };
  } catch (error: unknown) {
    if (error instanceof SdkMissingError) {
      logger.warn("Skipped Android driver: SDK missing", { reason: error.message });
      return {};
    }
    if (error instanceof OwnedRootError) {
      logger.error("Skipped Android driver: device root rejected", {
        reason: error.reason,
        root: error.path,
        summary: error.message,
      });
      return { rejection: rootRejection(error, ANDROID_PASSTHROUGH_TOOLS) };
    }
    if (error instanceof AdbServerUnavailableError) {
      logger.error("Skipped Android driver: adb server unavailable", {
        port: error.port,
        reason: error.reason,
        summary: error.message,
      });
      return { rejection: adbServerRejection(error) };
    }

    throw error;
  }
}

function adbServerRejection(error: AdbServerUnavailableError): DriverRejection {
  return {
    event: "driver.adb-server-rejected",
    passthroughTools: ANDROID_PASSTHROUGH_TOOLS,
    payload: { port: error.port, reason: error.reason },
    platform: "android",
    reason: error.reason,
    summary: error.message,
  };
}

/**
 * why: the tool names are passed in rather than derived from `error.platform`: which wrapper a
 * platform answers to is the driver module's business, and this file is the composition
 * root that already knows both driver classes (architecture rule 2).
 */
function rootRejection(
  error: OwnedRootError,
  passthroughTools: readonly string[],
): DriverRejection {
  return {
    event: "driver.root-rejected",
    passthroughTools,
    payload: { platform: error.platform, reason: error.reason, root: error.path },
    platform: error.platform,
    reason: error.reason,
    summary: error.message,
  };
}

/**
 * Testing/advanced hook: substitutes real driver discovery with a module supplied via
 * `SIMLOCK_DRIVERS_MODULE`. The daemon always runs as a separately spawned process, so
 * the module is resolved as a file path (relative to `process.cwd()`) and dynamically
 * imported -- this is how the e2e suite injects a scriptable fake driver without the
 * daemon ever knowing it isn't talking to real hardware. A missing module, an import
 * error, or a module without a `createDrivers` export fails daemon startup loudly
 * rather than silently falling back to real discovery. Its optional `prerequisiteChecks`
 * export replaces the real checks too; without one, `doctor` runs none.
 */
async function loadDriversModule(
  modulePath: string,
  context: DriverDiscoveryContext,
  logger: Logger,
): Promise<Omit<DriverDiscovery, "rejections">> {
  logger.info("Substituting driver discovery via SIMLOCK_DRIVERS_MODULE", {
    module: modulePath,
  });
  const moduleUrl = pathToFileURL(resolve(modulePath)).href;
  const imported = (await import(moduleUrl)) as {
    createDrivers?: (
      context: DriverDiscoveryContext,
    ) => Promise<readonly Driver[]> | readonly Driver[];
    prerequisiteChecks?: readonly PrerequisiteCheck[];
  };
  if (typeof imported.createDrivers !== "function") {
    throw new Error(
      `SIMLOCK_DRIVERS_MODULE ${modulePath} does not export a createDrivers(context) function`,
    );
  }
  const drivers = await imported.createDrivers(context);
  logger.info("Loaded drivers from SIMLOCK_DRIVERS_MODULE", {
    count: drivers.length,
    module: modulePath,
    platforms: drivers.map((driver) => driver.platform),
  });
  return { drivers, prerequisiteChecks: imported.prerequisiteChecks ?? [] };
}

/**
 * What the config says about device modes, in the two shapes the composition root hands out
 * (ADR 0007 §2, §14): the worker's default mode per platform for leasing, and whether
 * the iOS default is slim for the iOS driver's advisory. Android has no key until Android slim
 * lands, so it is left out and falls to the core's own `"full"`.
 */
export function deviceModeWiring(config: Pick<Config, "ios">): {
  readonly defaultModes: Readonly<Partial<Record<"ios" | "android", DeviceMode>>>;
  readonly slimByDefault: boolean;
} {
  return {
    defaultModes: { ios: config.ios.defaultMode },
    slimByDefault: config.ios.defaultMode === "slim",
  };
}

/**
 * The one place a class's preference list is merged (ADR 0015 §4): the operator's names from
 * `ios.defaultModels` or `android.defaultModels` first, then the driver's built-in ones, per
 * platform that has a driver. The catalog reads the result; nothing else builds the list.
 */
export function modelPreferenceWiring(
  config: Pick<Config, "android" | "ios">,
  drivers: readonly Pick<Driver, "defaultModels" | "platform">[],
): ModelPreferences {
  return Object.fromEntries(
    drivers.map((driver) => {
      const configured =
        driver.platform === "ios" ? config.ios.defaultModels : config.android.defaultModels;
      const merged: Partial<Record<DeviceClass, readonly string[]>> = {};
      for (const deviceClass of DEVICE_CLASSES) {
        const names = [
          ...(configured[deviceClass] ?? []),
          ...(driver.defaultModels[deviceClass] ?? []),
        ];
        if (names.length > 0) merged[deviceClass] = names;
      }
      return [driver.platform, merged];
    }),
  );
}

// why: the iOS driver never depends on the event bus directly (architecture rule 5); this is the one place that bridges its `onSlimmed` callback to a post-commit fact. A skipped slim is not bridged: `onSlimSkipped` in `discoverDrivers` logs it instead.
export function emitSlimDiagnostic(eventBus: Pick<EventBus, "emit">): (fact: SlimmedFact) => void {
  return (fact) => {
    eventBus.emit(
      "device.slimmed",
      {
        deviceId: fact.deviceId,
        address: fact.address,
        platform: "ios",
        categories: fact.categories,
        labelCount: fact.labelCount,
        durationMs: fact.durationMs,
        signature: fact.signature,
        unknownLabels: fact.unknownLabels,
      },
      "driver-diagnostics",
    );
  };
}

function openEventHistory(options: {
  readonly clock: Clock;
  readonly config: Config;
  readonly dataDirectory: string;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}): EventHistoryHandle {
  const { maxBytes, retention } = options.config.eventLog;
  return createEventHistory({
    bus: options.eventBus,
    clock: options.clock,
    config: { maxBytes, retention },
    dataDirectory: options.dataDirectory,
    // why: node:sqlite writes the real disk, so the history never goes through a daemon's injected filesystem
    filesystem: new NodeFilesystem(),
    logger: options.logger.child("events"),
    projectionOptions: {
      fleet: options.config.mode === "gateway",
      metricsRetentionMs: options.config.metrics.retention,
    },
    projections: Object.values(HISTORY_PROJECTIONS),
    sqlite: new NodeSqliteOpener(),
  });
}

/** why: a history that refuses to start is one a newer simlock wrote or a migration could not fix; the daemon stops rather than run without the figures it promises. */
function startHistory(history: EventHistoryHandle, logger: Logger, refused: () => void): void {
  void history.start().catch((error: unknown) => {
    logger.error("The event history could not start", { message: errorMessage(error) });
    refused();
  });
}

function stopForRefusedHistory(daemon: { stop(reason: string): Promise<void> }): () => void {
  return () => {
    process.exitCode = 1;
    void daemon.stop("history-refused").catch(() => undefined);
  };
}

/**
 * The runner every driver and `device.exec` shell out through. At `log.level: debug` each
 * command leaves a `process` line; at any other level the runner is used unwrapped, so a
 * daemon not asked for that detail pays nothing for it.
 */
export function processRunnerFor(
  level: LogLevel,
  runner: ProcessRunner,
  logger: Logger,
  clock: Clock,
): ProcessRunner {
  if (level !== "debug") return runner;
  return new LoggingProcessRunner({ clock, inner: runner, logger: logger.child("process") });
}

/** Writes a failing event subscriber to the daemon log as one JSON line, not to stderr. */
export function eventBusLogger(logger: Logger): EventBusLogger {
  const bus = logger.child("bus");
  return {
    error(message, { error, envelope }) {
      bus.error(message, {
        event: envelope.event,
        seq: envelope.seq,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    },
  };
}

export function parseDaemonArgv(argv: readonly string[]): DaemonMode | undefined {
  if (argv.length === 0) return "worker";
  if (argv.length === 1 && argv[0] === "--gateway") return "gateway";
  return undefined;
}

/**
 * why: best-effort logger for the fatal startup handler below. It cannot depend on the
 * daemon's own `Config` — that is exactly what may have failed to load — so it always
 * writes to the daemon's own folder at a fixed level.
 */
function createFatalLogger(
  role: DaemonMode | undefined,
  level: "error" | "info" = "error",
): Logger {
  return new JsonLinesLogger({
    clock: new SystemClock(),
    level,
    module: "daemon",
    sink: new NodeFileLogSink({
      path: join(daemonDataDirectory(resolveSimlockHome(), role ?? "worker"), "daemon.log"),
    }),
  });
}

function logAlreadyRunning(role: DaemonMode, error: DaemonAlreadyRunningError): void {
  try {
    createFatalLogger(role, "info").info("Daemon already running", { socket: error.endpoint });
  } catch {
    // why: logging itself failed, so the line goes to the console rather than being swallowed.
    console.error(error.message);
  }
}

function logFatalStart(role: DaemonMode | undefined, message: string, extra: object): void {
  try {
    createFatalLogger(role).error("Daemon failed to start", { message, ...extra });
  } catch {
    // why: logging itself failed (e.g. an unwritable data directory), so the failure goes to the console rather than being swallowed.
    console.error(message);
  }
  process.exitCode = 1;
}

/** why: only a worker has a service check; a gateway and an unsupported platform (no manager) have none. */
export function serviceCheckFor(
  role: DaemonMode,
  manager: ServiceManager | undefined,
  definition: () => ServiceDefinition,
): { readonly serviceCheck?: ServiceCheck } {
  if (manager === undefined || role !== "worker") return {};
  const { name } = definition();
  return {
    serviceCheck: {
      manager: manager.manager,
      name,
      check: async () => {
        const state = await manager.state(definition());
        return state.state === "broken" ? state.missing : [];
      },
    },
  };
}

/** why: the process facts the production service check reads, injectable so a test can prove the definition it builds. */
export interface ServiceCheckHost {
  readonly manager: ServiceManager | undefined;
  readonly root: string;
  readonly home: string;
  readonly nodePath: string;
  readonly mainPath: string;
  readonly env: NodeJS.ProcessEnv;
}

function currentServiceCheckHost(): ServiceCheckHost {
  return {
    manager: productionServiceManager(process.platform, {
      runner: new NodeProcessRunner(),
      filesystem: new NodeFilesystem(),
      uid: process.getuid?.() ?? 0,
    }),
    root: resolveSimlockHome(),
    home: homedir(),
    nodePath: process.execPath,
    mainPath: fileURLToPath(import.meta.url),
    env: process.env,
  };
}

export function productionServiceCheck(
  role: DaemonMode,
  host: ServiceCheckHost = currentServiceCheckHost(),
): { readonly serviceCheck?: ServiceCheck } {
  return serviceCheckFor(role, host.manager, () =>
    serviceDefinition({
      ...(host.manager === undefined ? {} : { manager: host.manager.manager }),
      role,
      root: host.root,
      dataDirectory: daemonDataDirectory(host.root, role),
      home: host.home,
      nodePath: host.nodePath,
      mainPath: host.mainPath,
      env: host.env,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  filterSqliteExperimentalWarning();
  const argv = process.argv.slice(2);
  const role = parseDaemonArgv(argv);
  if (role === undefined) {
    logFatalStart(undefined, "Unknown daemon arguments", { argv });
  } else {
    // why: one SIGTERM handler for both phases: before the daemon is up there is nothing to stop, so it exits 0 at once; after, it stops with reason `signal` and exits 0.
    let running: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let removeAdminSecret: (() => Promise<void>) | undefined;
    void startDaemon({
      role,
      ...productionServiceCheck(role),
      onAdminSecretWritten: (remove) => {
        removeAdminSecret = remove;
      },
    })
      .then((daemon) => {
        running = daemon;
      })
      .catch((error: unknown) => {
        if (error instanceof DaemonAlreadyRunningError) {
          logAlreadyRunning(role, error);
          return;
        }
        logFatalStart(role, error instanceof Error ? error.message : String(error), {
          stack: error instanceof Error ? error.stack : undefined,
        });
      });
    process.once("SIGTERM", () => {
      if (running === undefined) {
        // why: the credential is written before startup finishes; a daemon exiting now must not leave it behind.
        void (removeAdminSecret?.() ?? Promise.resolve()).finally(() => process.exit(0));
        return;
      }
      void running.stop("signal").finally(() => process.exit(0));
    });
  }
}

/** why: hands the entry a way to remove the credential only after this daemon wrote it, so a start that lost the race never removes the winner's file. */
function reportingAdminSecret(
  secret: Auth["adminSecret"],
  options: StartDaemonOptions,
): Auth["adminSecret"] {
  return {
    persist: async () => {
      await secret.persist();
      options.onAdminSecretWritten?.(() => secret.remove());
    },
    remove: () => secret.remove(),
  };
}

/** why: a root's staging directory sits beside it, so the sweep looks there for leftovers. */
function deviceRoots(drivers: readonly Driver[]): string[] {
  return drivers.flatMap((driver) =>
    "deviceRoot" in driver && typeof driver.deviceRoot === "string" ? [driver.deviceRoot] : [],
  );
}
