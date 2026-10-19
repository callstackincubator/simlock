import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EVENT_FILE_NAME, EventBus, EventHistory, type EventBusLogger } from "../bus/index.js";
import { fitHostFacts, fitHostLoad } from "../contract/index.js";
import { HostLoadSampler } from "../host-load/index.js";
import {
  type Config,
  type ConfigOverrides,
  type DeviceClass,
  type DeviceMode,
  type Driver,
  type DriverRejection,
  type ModelPreferences,
  type PrerequisiteCheck,
  CleanupReaper,
  ComponentInstaller,
  DEVICE_CLASSES,
  DiskSpaceGuard,
  DriverCatalog,
  HostFactsReader,
  createCore,
  loadConfig,
  latestPresence,
  loadInstanceId,
  OwnedRootError,
  Registry,
  Nuke,
  SerializedDecision,
} from "../core/index.js";
import { createLeasing } from "../leasing/index.js";
import {
  AdbServerUnavailableError,
  AndroidDriver,
  ANDROID_PASSTHROUGH_TOOLS,
  hostAbiFor,
  SdkMissingError,
  type AndroidEmulatorLaunchOptions,
  androidPrerequisites,
} from "../drivers/android/index.js";
import {
  IOS_PASSTHROUGH_TOOLS,
  IosSimctlDriver,
  type SlimmedFact,
  iosPrerequisites,
} from "../drivers/ios/index.js";
import { createHttpApp } from "../http/app.js";
import type { HttpDispatch } from "../http/dispatcher-session.js";
import { HttpGateway } from "../http/server.js";
import { TokenStore } from "../http/token-store.js";
import {
  CryptoIdGenerator,
  CryptoTokenSecrets,
  JsonLinesLogger,
  LoggingProcessRunner,
  NodeFileLogSink,
  type Clock,
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
  NodeHostInfo,
  NodeIpcTransport,
  NodeProcessRunner,
  NodeProcessSupervisor,
  NodeSystemStats,
  NodeBytePipeLauncher,
  NodeTcpProbe,
  NodeTcpStreamConnector,
  resolveDaemonSocketPath,
  readPackageVersion,
  resolveSimlockHome,
  SystemClock,
  type SystemStats,
  type ProcessRunner,
  type ProcessSupervisor,
  type TcpProbe,
} from "../ports/index.js";
import {
  createRoutingPolicy,
  FileDrainStore,
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
import { DaemonEndpointHost } from "./connection-host.js";
import { AdminSecretManager } from "./admin-secret.js";
import { describeLeaseRequestFailure } from "./error-code.js";
import { wakingQueueAfter } from "./enrollment-wake.js";
import { GatewayUplink } from "./gateway-uplink.js";
import type { RelayTargets } from "./relay.js";
import { createCredentialRoleResolver } from "./session.js";

export interface StartDaemonOptions {
  readonly clock?: Clock;
  readonly configOverrides?: ConfigOverrides;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly defaultRequesterId?: string;
  readonly drivers?: readonly Driver[];
  readonly gatewayRelay?: (relay: GatewayRelay) => void;
  /** why: test-only, hands over the gateway's uplink listener, to close one worker's socket. */
  readonly gatewayUplinks?: (uplinks: WebSocketUplinkListenerFactory) => void;
  /** why: test-only, replaces the registry of optional modules. */
  readonly optionalModules?: readonly OptionalModuleDefinition<unknown>[];
  readonly relayTargets?: RelayTargets;
  readonly prerequisiteChecks?: readonly PrerequisiteCheck[];
  readonly filesystem?: Filesystem;
  readonly hostInfo?: HostInfo;
  readonly hostLoadProbe?: HostLoadProbe | null;
  readonly idGenerator?: IdGenerator;
  readonly ipc?: IpcConnector & IpcListenerFactory;
  readonly logger?: Logger;
  readonly processRunner?: ProcessRunner;
  readonly processSupervisor?: ProcessSupervisor;
  readonly socketPath?: string;
  readonly statePath?: string;
  readonly systemStats?: SystemStats;
  readonly tcpProbe?: TcpProbe;
  readonly version?: string;
}

// fallow-ignore-next-line complexity -- explicit production composition necessarily wires all external ports.
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonServer> {
  const version = options.version ?? readPackageVersion();
  const dataDirectory = options.dataDirectory ?? resolveSimlockHome();
  const filesystem = options.filesystem ?? new NodeFilesystem();
  const clock = options.clock ?? new SystemClock();
  const systemStats = options.systemStats ?? new NodeSystemStats();
  const idGenerator = options.idGenerator ?? new CryptoIdGenerator();
  const ipc = options.ipc ?? new NodeIpcTransport();
  const baseProcessRunner = options.processRunner ?? new NodeProcessRunner();
  const processSupervisor = options.processSupervisor ?? new NodeProcessSupervisor();
  const tcpProbe = options.tcpProbe ?? new NodeTcpProbe();
  const configPath = options.configPath ?? join(dataDirectory, "config.json");
  const statePath = options.statePath ?? join(dataDirectory, "state.json");
  const socketPath = options.socketPath ?? resolveDaemonSocketPath(dataDirectory);
  const configWarnings: string[] = [];
  const moduleDefinitions = options.optionalModules ?? optionalModules;
  const config = await loadConfig({
    configPath,
    filesystem,
    modules: moduleDefinitions.map(({ config: moduleConfig, name }) => ({
      name,
      ...moduleConfig,
    })),
    ...(options.configOverrides === undefined ? {} : { overrides: options.configOverrides }),
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
  // why: ADR 0008 §6: the machine is read once, here. Bounded and never throwing, so a slow or
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
    filesystem,
    logger,
  });
  // why: ADR 0005 §1/§2: one process, one mode. A gateway starts no drivers, validates no device
  // roots, loads no registry, and runs no reaper, health monitor or capacity strategy -- so the
  // branch is here, before any of that is built, rather than as a set of conditionals threaded
  // through the worker's composition below.
  if (config.mode === "gateway") {
    return startGatewayDaemon({
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
      optionalModules: moduleDefinitions,
      socketPath,
      version: version,
    });
  }
  // why: `defaultTtlMs` is read on load only, and only by ADR 0004's record migration: a lease
  // written before it has no stored width of its own, and takes the configured default rather
  // than a guess derived from its deadline.
  const registry = await Registry.load({
    clock,
    defaultTtlMs: config.lease.defaultTtlMs,
    eventBus,
    filesystem,
    idGenerator,
    leaseIdentity: config.lease.identity,
    leaseRequestLimits: {
      maxRecords: config.lease.maxRequestRecords,
      retentionMs: config.lease.requestRetentionMs,
    },
    statePath,
  });
  // why: Before discovery, because every root a driver validates is checked against it, and it
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
  // why: ADR 0008 §7: read at startup in the background, served from memory, re-read when stale.
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
  const decisions = new SerializedDecision();
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
    registry,
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
    role: "worker",
  });
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
  // why: Constructed unconditionally, not just when `config.http.enabled` -- ADR 0003 §5's operator
  // token is a socket-hello credential too, so the daemon must be able to verify one against
  // the token store regardless of whether the HTTP gateway is running. Previously this was
  // only ever constructed inside the `config.http.enabled` block below; it is reused there now
  // instead of being built twice.
  const tokens = new TokenStore({
    clock,
    filesystem,
    idGenerator,
    path: join(dataDirectory, "tokens.json"),
    secrets: new CryptoTokenSecrets(),
  });
  const adminSecret = new AdminSecretManager({
    filesystem,
    secrets: new CryptoTokenSecrets(),
    path: join(dataDirectory, "admin.token"),
  });
  const resolveRole = createCredentialRoleResolver({
    verifyOperatorToken: async (secret) => (await tokens.verify(secret))?.role === "operator",
    verifyAdminSecret: (secret) => adminSecret.verify(secret),
  });
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
  // why: Reassigned once the HTTP frontend actually starts, but must exist as a stable closure now:
  // `stopAuxiliary` is fixed at `DaemonServer` construction time, before the frontend itself
  // exists.
  let stopHttpGateway: (() => Promise<void>) | undefined;
  // why: Settles once the HTTP gateway either finishes starting or fails to -- resolved/rejected from
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
  let socketClaimed = false;
  const gatewayStarted: Promise<void> = config.http.enabled
    ? new Promise<void>((resolve, reject) => {
        resolveGatewayStarted = resolve;
        rejectGatewayStarted = reject;
      })
    : Promise.resolve();
  // why: ADR 0019 §1, in this order: settle the open requests, read each platform once, doctor's
  // startup pass on that read, end every lease whose device is not running and restore the
  // timers of the rest, then core's device convergence, then the queue's first depth, which every
  // run begins with. One after another: the reconciler needs the read, and convergence must not
  // pick a device the reconciler is about to release.
  // Set once a stop begins. A `daemon.stop` is accepted while startup runs, and the read takes up
  // to a minute: every step after it would arm timers (expiry, quarantine retry, warm pool tick)
  // on a daemon whose disposal has already run, and nothing would cancel them.
  let stopping = false;
  const convergeStartup = async (): Promise<void> => {
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
    // why: Closes the warm pool the moment a stop is asked for, ahead of every await in the stop.
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
    resolveRole,
    adminSecret,
    tokens,
    version: version,
    converge: convergeStartup,
    settle: async () => {
      stopping = true;
      await leasing.settle();
      await core.drain();
    },
    // why: Every driver is tried even when another throws: Android's disposal is the only thing that can stop the adb server it started.
    dispose: async () => {
      core.dispose();
      leasing.dispose();
      // why: Before the drivers: a running install is ended through its signal while its driver
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
    },
    // why: Review finding S5: waits for the concurrently-started gateway to either finish binding
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
      // why: Stopped with the other auxiliary frontends, and for the same reason: the uplink is a
      // live connection into this daemon's dispatcher, so it must be shut before lease/queue
      // teardown begins. Stopping it also stops the reconnect loop, so a shutting-down worker
      // does not redial the gateway it just left.
      await gatewayUplink?.stop();
    },
    // why: ADR 0003 §2: "an HTTP request during startup now waits like a socket request instead of
    // being refused". Firing the gateway's own `start()` from here (not after `daemon.start()`
    // resolves) is what makes that true: the gateway is listening, and every route calls
    // `daemon.dispatch(...)`, which parks on the same startup-readiness gate a socket request
    // does. A bind failure (occupied port, invalid host) is reported through `gatewayStarted`
    // rather than acted on immediately here -- see the bottom of this function for why: calling
    // `daemon.stop()` right away, while `daemon.start()` may still be awaiting convergence, is
    // what let a stale "Daemon started" log/event follow "Daemon stopping" (review finding B6).
    onSocketClaimed: () => {
      socketClaimed = true;
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
      if (!config.http.enabled) return;
      void startHttpGateway().then(
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
      tokens,
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
    // why: No self-stop check here: `stopAuxiliary` above is the single place that decides whether
    // to stop the gateway, and it does so by awaiting `gatewayStarted` (settled once this
    // function's caller -- `onSocketClaimed`'s handler below -- resolves or rejects) before
    // calling `stopHttpGateway`. Stopping here too would double-stop it.
  }

  // why: Awaited together, not `daemon.start()` alone: `gatewayStarted` is the promise
  // `onSocketClaimed`'s handler above settles once the concurrently-started HTTP gateway either
  // finishes starting or fails to. Both are already running concurrently by the time this line
  // is reached (the gateway since `onSocketClaimed` fired partway through `daemon.start()`), so
  // this changes nothing about when either finishes -- only what `startDaemon()` itself reports.
  // `gatewayStarted` is settled only from inside `onSocketClaimed`'s handler, and `start()`
  // fires that callback only once the socket claim (and the admin-secret write) has succeeded.
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
    // why: The daemon itself came all the way up -- convergence succeeded, `daemon.started` was
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
  readonly clock: Clock;
  readonly config: Config;
  readonly dataDirectory: string;
  readonly eventBus: EventBus;
  readonly eventHistory: EventHistory;
  readonly filesystem: Filesystem;
  readonly gatewayRelay?: (relay: GatewayRelay) => void;
  readonly gatewayUplinks?: (uplinks: WebSocketUplinkListenerFactory) => void;
  readonly hostSystem: HostSystem;
  readonly hostLoadProbe?: HostLoadProbe | null;
  readonly idGenerator: IdGenerator;
  readonly ipc: IpcConnector & IpcListenerFactory;
  readonly logger: Logger;
  readonly optionalModules: readonly OptionalModuleDefinition<unknown>[];
  readonly socketPath: string;
  readonly version: string;
}

// fallow-ignore-next-line complexity -- explicit production composition, exactly like `startDaemon`'s worker half.
async function startGatewayDaemon(options: GatewayDaemonOptions): Promise<DaemonServer> {
  const { clock, config, dataDirectory, eventBus, eventHistory, filesystem, idGenerator, logger } =
    options;
  const instanceId = await loadInstanceId({
    filesystem,
    idGenerator,
    path: join(dataDirectory, "instance.json"),
  });
  const tokens = new TokenStore({
    clock,
    filesystem,
    idGenerator,
    path: join(dataDirectory, "tokens.json"),
    secrets: new CryptoTokenSecrets(),
  });
  const adminSecret = new AdminSecretManager({
    filesystem,
    secrets: new CryptoTokenSecrets(),
    path: join(dataDirectory, "admin.token"),
  });
  const resolveRole = createCredentialRoleResolver({
    verifyOperatorToken: async (secret) => (await tokens.verify(secret))?.role === "operator",
    verifyAdminSecret: (secret) => adminSecret.verify(secret),
  });

  const gatewayRequesterPrefix = `gw:${instanceId}:`;
  const leaseIndex = new FleetLeaseIndex(gatewayRequesterPrefix, logger.child("lease-index"));
  // why: `src/gateway` cannot see `core`'s `Config` (ADR 0005 §33), so the two lists of policy names
  // are separate declarations. This call is where they meet: a name `loadConfig` accepts that
  // the gateway's registry lacks fails `pnpm typecheck` here, not a daemon start.
  const routing = createRoutingPolicy(config.gateway.routing);

  const uplinks = new WebSocketUplinkListenerFactory();
  options.gatewayUplinks?.(uplinks);
  const gatewayService = new GatewayService({
    authenticate: async (credential) => {
      if (credential === undefined) return "unauthenticated";
      const identity = await tokens.verify(credential);
      if (identity === undefined) return "unauthenticated";
      if (identity.role !== "worker") return "forbidden";
      return { outcome: "accept", tokenId: identity.requesterId };
    },
    clock,
    drainStore: new FileDrainStore({
      filesystem,
      logger: logger.child("gateway"),
      path: join(dataDirectory, "workers.json"),
    }),
    eventBus,
    leaseMaxTtlMs: config.lease.maxTtlMs,
    logger: logger.child("gateway"),
    principal: `gw:${instanceId}`,
    retentionMs: config.gateway.disconnectedRetentionMs,
    uplinks,
  } satisfies GatewayServiceOptions);

  const fleetCoordinator = new FleetLeaseCoordinator({
    clock,
    directory: gatewayService,
    eventBus,
    execTimeoutMs: config.gateway.execTimeoutMs,
    idGenerator,
    leaseIndex,
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

  const daemon = new DaemonServer({
    adminSecret,
    clock,
    config,
    defaultRequesterId: process.env.SIMLOCK_AGENT_ID ?? String(process.pid),
    ...(hostLoad === undefined ? {} : { hostLoad }),
    dispatcher: new GatewayDispatcher({
      awaitReady: () => Promise.resolve(),
      clock,
      errorCode: classifyError,
      closeUplinksForToken: (tokenId) => gatewayService.closeLinksForToken(tokenId),
      config,
      coordinator: fleetCoordinator,
      directory: gatewayService,
      eventHistory,
      health: () => daemon.health,
      host: fitHostFacts({ ...options.hostSystem, tools: [] }),
      ...(hostLoad === undefined ? {} : { load: () => fitHostLoad(hostLoad.current()) }),
      leaseIndex,
      logger: logger.child("gateway"),
      tokens,
      workers: gatewayService.workers,
    }),
    eventBus,
    host: new DaemonEndpointHost({
      connector: options.ipc,
      endpoint: options.socketPath,
      filesystem,
      listenerFactory: options.ipc,
      logger: logger.child("connection-host"),
    }),
    leaseSnapshot: () =>
      leaseIndex.all().map((entry) => ({ id: entry.gatewayLeaseId, ownerId: entry.ownerId })),
    logger: logger.child("server"),
    ownerRoutedFacts: gatewayOwnerRoutedFacts,
    resolveRole,
    version: options.version,
    // why: A gateway's "convergence" is starting to accept uplinks and arming the refresh tick.
    // Running it here rather than before `start()` keeps one lifecycle: a listener that cannot
    // start fails the daemon start, and `status.get` answers throughout (a fleet with no views
    // yet is a true answer, not an unready one). A worker that dials in the window before this
    // resolves is refused and redials on its own backoff.
    converge: async () => {
      await gatewayService.start();
      fleetCoordinator.start();
    },
    dispose: async () => {
      fleetCoordinator.dispose();
      gatewayOwnerRoutedFacts.dispose();
      await gatewayService.stop();
    },
    stopAuxiliary: async () => {
      await moduleHost.beforeDrain();
      await httpStarted.catch(() => undefined);
      await stopHttpGateway?.();
    },
    onSocketClaimed: () => {
      socketClaimed = true;
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
      leaseRequests: fleetCoordinator.requests,
      logger: httpLogger,
      mounts: [...moduleHost.mounts({ dispatch })],
      ownerRoutedFacts: daemon.ownerRoutedFacts,
      registry: {
        get snapshot() {
          return { devices: gatewayService.workers.grantedDevices() };
        },
      },
      answerDownloadsEarly: false,
      tokens,
    });
    const gateway = new HttpGateway(app, {
      host: config.http.host,
      logger: httpLogger,
      onServerCreated: (server) => uplinks.attach(server),
      port: config.http.port,
    });
    await gateway.start();
    stopHttpGateway = async () => {
      await gateway.stop();
      app.dispose();
    };
  }

  const daemonStarted = daemon.start().finally(() => {
    if (!socketClaimed) resolveHttpStarted?.();
  });
  const [daemonResult, httpResult] = await Promise.allSettled([daemonStarted, httpStarted]);
  if (httpResult.status === "rejected" && daemonResult.status === "fulfilled") {
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
  readonly acceptAndroidLicenses?: boolean;
  readonly clock: Clock;
  readonly driversConfig: Config["drivers"];
  readonly eventBus: Pick<EventBus, "emit">;
  readonly filesystem: Filesystem;
  /**
   * why: Which platform's tooling this host has, `process.platform` in production and supplied
   * by the composition root rather than read here. Discovery's fail-closed branch -- the
   * one that must cost a platform and never the daemon -- is otherwise reachable only on a
   * Mac, and so is untestable everywhere Simlock's own CI runs.
   */
  readonly hostPlatform: NodeJS.Platform;
  readonly hostArch: string;
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly logger: Logger;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly simlockHome: string;
  readonly tcpProbe: TcpProbe;
  readonly slim?: {
    readonly categories?: readonly string[];
    readonly bootTimeoutMs: number;
  };
  readonly slimByDefault?: boolean;
  readonly androidEmulator?: AndroidEmulatorLaunchOptions;
}

export interface DriverDiscovery {
  readonly drivers: readonly Driver[];
  readonly prerequisiteChecks: readonly PrerequisiteCheck[];
  readonly rejections: readonly DriverRejection[];
}

export async function discoverDrivers(options: DriverDiscoveryContext): Promise<DriverDiscovery> {
  const logger = options.logger.child("driver-discovery");
  const driversModule = process.env.SIMLOCK_DRIVERS_MODULE;
  if (driversModule !== undefined) {
    // why: A substituted driver set owns whatever roots it wants, so there is nothing here to
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
 * why: A refused root costs the daemon one platform, never the whole daemon: the other platform
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
      // why: Ambient like `homedir()` above, and read here rather than in the driver so the
      // composition root stays the only place that touches process state.
      ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
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
      // why: Ambient like `homedir()` above, and read here rather than in the driver so the
      // composition root stays the only place that touches process state.
      ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
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

export function deviceModeWiring(config: Pick<Config, "ios">): {
  readonly defaultModes: Readonly<Partial<Record<"ios" | "android", DeviceMode>>>;
  readonly slimByDefault: boolean;
} {
  return {
    defaultModes: { ios: config.ios.defaultMode },
    slimByDefault: config.ios.defaultMode === "slim",
  };
}

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
  readonly filesystem: Filesystem;
  readonly logger: Logger;
}): EventHistory {
  const path = join(options.dataDirectory, EVENT_FILE_NAME);
  const logger = options.logger.child("events");
  let sink: NodeFileLogSink | undefined;
  try {
    const { maxBytes, retention, rotateBytes } = options.config.eventLog;
    sink = new NodeFileLogSink({
      clock: options.clock,
      maxBytes: rotateBytes,
      path,
      retentionMs: retention,
      totalMaxBytes: maxBytes,
    });
  } catch (error: unknown) {
    logger.error("Event file could not be opened; events are kept in memory only", {
      error: error instanceof Error ? error.message : String(error),
      path,
    });
  }
  return new EventHistory({
    bus: options.eventBus,
    filesystem: options.filesystem,
    logger,
    path,
    ...(sink === undefined ? {} : { sink }),
  });
}

export function processRunnerFor(
  level: LogLevel,
  runner: ProcessRunner,
  logger: Logger,
  clock: Clock,
): ProcessRunner {
  if (level !== "debug") return runner;
  return new LoggingProcessRunner({ clock, inner: runner, logger: logger.child("process") });
}

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

function createFatalLogger(): Logger {
  return new JsonLinesLogger({
    clock: new SystemClock(),
    level: "error",
    module: "daemon",
    sink: new NodeFileLogSink({ path: join(resolveSimlockHome(), "daemon.log") }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void startDaemon().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    try {
      createFatalLogger().error("Daemon failed to start", { message, stack });
    } catch {
      // why: Logging itself failed (e.g. an unwritable data directory) -- fall back to
      // the original behavior so the failure is not silently swallowed.
      console.error(error);
    }
    process.exitCode = 1;
  });
}
