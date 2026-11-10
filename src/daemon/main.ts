import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Alerts, createAlerts } from "../alerts/index.js";
import { EventBus, type EventBusLogger } from "../bus/index.js";
import { fitHostFacts, fitHostLoad } from "../contract/index.js";
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
  type DeviceDataTable,
  type ServiceCheck,
  loadConfigWithDefaults,
  loadInstanceId,
  registryOwner,
  warmPoolOwner,
  baselinesOwner,
} from "../core/index.js";
import { openStateDatabase, type StateDatabase } from "../state/index.js";
import { androidSourceDataOwner } from "../drivers/android/index.js";
import { iosSourceDataOwner } from "../drivers/ios/index.js";
import { type Auth, createAuth, tokensOwner } from "../auth/index.js";
import { createHttpApp } from "../http/app.js";
import { createGatewayLeaseFiles } from "./gateway-lease-files.js";
import type { HttpDispatch } from "../http/dispatcher-session.js";
import { HttpGateway } from "../http/server.js";
import {
  CryptoIdGenerator,
  CryptoTokenSecrets,
  JsonLinesLogger,
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
  NodeFilesystem,
  filterSqliteExperimentalWarning,
  NodeSqliteOpener,
  NodeHostInfo,
  NodeIpcTransport,
  NodeProcessRunner,
  productionServiceManager,
  serviceDefinition,
  NodeNpmCli,
  type NpmCli,
  NodeProcessSupervisor,
  NodeSystemStats,
  type UpdaterLauncher,
  NodeTcpProbe,
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
  type WorkerLockHandle,
  type SqliteSchemaOwner,
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
  createUpgradeRouter,
  WebSocketUplinkConnector,
  WebSocketUplinkListenerFactory,
} from "../ports/uplink-websocket.js";
import { classifyError } from "./error-code.js";
import { createModuleHost, type OptionalModuleDefinition } from "../modules/index.js";
import { backendDefinitions } from "../driver-registry/index.js";
import { optionalModules } from "../module-registry/index.js";
import { DaemonServer } from "./server.js";
import { createUpdateCoordinator } from "./update-coordinator.js";
import { startVersionCheck, type VersionCheck } from "./version-check.js";
import {
  DaemonAlreadyRunningError,
  DaemonEndpointHost,
  prepareDataDirectory,
  refuseWhenDaemonAnswers,
} from "./connection-host.js";
import { describeLeaseRequestFailure } from "./error-code.js";
import { composeWorker, type WorkerOptions, processRunnerFor } from "./worker-composition.js";
import { resolveDeviceDataTables } from "./driver-discovery.js";
import {
  parseDaemonArgv,
  logAlreadyRunning,
  logFatalStart,
  serviceCheckFor,
  type ServiceCheckHost,
} from "./entry-support.js";
import {
  updateOptionsFor,
  errorMessage,
  startHistory,
  stopForRefusedHistory,
} from "./composition-support.js";

export interface StartDaemonOptions extends WorkerOptions {
  readonly clock?: Clock;
  readonly configOverrides?: ConfigOverrides;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly deviceDataTables?: ReadonlyMap<string, DeviceDataTable>;
  /** why: test-only, a gateway's silence bound on a relayed file upload, so a rig reaches 408 without waiting 330 s. */
  readonly fileSilenceMs?: number;
  readonly gatewayRelay?: (relay: GatewayRelay) => void;
  /** why: test-only, hands over the gateway's uplink listener, to close one worker's socket. */
  readonly gatewayUplinks?: (uplinks: WebSocketUplinkListenerFactory) => void;
  /** why: the entry removes the credential when SIGTERM lands after it was written but before the daemon is up; called only once this daemon owns the file. */
  readonly onAdminSecretWritten?: (remove: () => Promise<void>) => void;
  /** why: test-only, replaces the registry of optional modules. */
  readonly optionalModules?: readonly OptionalModuleDefinition<unknown>[];
  readonly role?: DaemonMode;
  readonly filesystem?: Filesystem;
  readonly hostInfo?: HostInfo;
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
  readonly processSupervisor?: ProcessSupervisor;
  readonly socketPath?: string;
  readonly systemStats?: SystemStats;
  readonly tcpProbe?: TcpProbe;
  readonly version?: string;
  /** why: test-only, replaces the poster a gateway's alerts send through. */
  readonly webhookPoster?: WebhookPoster;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonServer> {
  let opened: StateDatabase | undefined;
  let check: VersionCheck | undefined;
  let workerLock: WorkerLockHandle | undefined;
  try {
    return await composeDaemon(
      options,
      (state) => {
        opened = state;
      },
      (started) => {
        check = started;
      },
      (lock) => {
        workerLock = lock;
      },
    );
  } catch (error: unknown) {
    // why: the check's 24 h timer would keep a failed start's process alive and re-ask npm; a running daemon disposes it in `dispose`.
    check?.dispose();
    // why: a start that fails after `state.db` opened must not hold the file; a running daemon closes it in `dispose`.
    opened?.close();
    // why: a start that fails after taking the worker lock must not leave a lock that blocks the next worker; a running daemon releases it in `dispose`.
    await workerLock?.release().catch(() => undefined);
    throw error;
  }
}

// why: the schema owners each role's state.db opens, one place so a test reads the list the daemon uses.
export function stateOwners(
  role: DaemonMode,
  deviceDataTables: ReadonlyMap<string, DeviceDataTable>,
): readonly SqliteSchemaOwner[] {
  return role === "gateway"
    ? [tokensOwner, drainedWorkersOwner]
    : [
        registryOwner,
        warmPoolOwner,
        baselinesOwner,
        tokensOwner,
        iosSourceDataOwner,
        androidSourceDataOwner,
        ...new Set(deviceDataTables.values()),
      ];
}

// fallow-ignore-next-line complexity -- explicit production composition necessarily wires all external ports.
async function composeDaemon(
  options: StartDaemonOptions,
  onStateOpened: (state: StateDatabase) => void,
  onVersionCheck: (check: VersionCheck) => void,
  onWorkerLock: (lock: WorkerLockHandle) => void,
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
  const tcpProbe = options.tcpProbe ?? new NodeTcpProbe();
  const configPath = options.configPath ?? join(dataDirectory, "config.json");
  const socketPath = options.socketPath ?? resolveDaemonSocketPath(dataDirectory);
  const dataDirectoryWarning = await prepareDataDirectory(filesystem, dataDirectory);
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
    driverSections: backendDefinitions,
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
  if (dataDirectoryWarning !== undefined) logger.warn(dataDirectoryWarning);
  const processRunner = processRunnerFor(config.log.level, baseProcessRunner, logger, clock);
  const processSupervisor =
    options.processSupervisor ??
    new NodeProcessSupervisor({ platform: process.platform, processRunner });
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
    owners: stateOwners(role, deviceDataTables),
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
      ...(options.fileSilenceMs === undefined ? {} : { fileSilenceMs: options.fileSilenceMs }),
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
  return composeWorker(
    {
      auth,
      clock,
      config,
      dataDirectory,
      defaulted,
      deviceDataTables,
      eventBus,
      eventHistory,
      filesystem,
      hostSystem,
      idGenerator,
      ipc,
      logger,
      moduleDefinitions,
      npm,
      processRunner,
      processSupervisor,
      role,
      socketPath,
      state,
      systemStats,
      tcpProbe,
      upgradeRouter: createUpgradeRouter,
      uplinkConnector: () => new WebSocketUplinkConnector(),
      version,
      versionCheck,
    },
    options,
    onWorkerLock,
  );
}

interface GatewayDaemonOptions {
  readonly auth: Auth;
  readonly clock: Clock;
  readonly config: Config;
  readonly dataDirectory: string;
  readonly eventBus: EventBus;
  /** why: test-only, see `StartDaemonOptions.fileSilenceMs`. */
  readonly fileSilenceMs?: number;
  readonly eventHistory: EventHistoryHandle;
  readonly filesystem: Filesystem;
  readonly gatewayRelay?: (relay: GatewayRelay) => void;
  readonly gatewayUplinks?: (uplinks: WebSocketUplinkListenerFactory) => void;
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
  const instanceId = await loadInstanceId({
    filesystem,
    idGenerator,
    path: join(dataDirectory, "instance.json"),
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
    // why: ADR 0005 §4/§25: only a `worker`-role token pinned to the claimed worker id opens an
    // uplink. The accepted case names the token's own id, so `token.revoke` can later find and
    // close every uplink it authorized (`GatewayService#closeLinksForToken`, wired below).
    authenticate: (credential, workerId) => auth.authenticateUplink(credential, workerId),
    clock,
    drainStore: new StateDrainStore({ database: state.database, logger: logger.child("gateway") }),
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
  const gatewayRelay = new GatewayRelay({
    clock,
    directory: gatewayService,
    ...(config.http.proxyAuth === undefined
      ? {}
      : { proxyAuthHeader: config.http.proxyAuth.header }),
  });
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
      relayTwoWay: (workerId, call) => gatewayRelay.relayTwoWay(workerId, call),
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
    leaseSnapshot: () =>
      leaseIndex.all().map((entry) => ({ id: entry.gatewayLeaseId, ownerId: entry.ownerId })),
    logger: logger.child("server"),
    ownerRoutedFacts: gatewayOwnerRoutedFacts,
    resolveRole: { resolve: (hello) => auth.resolveHelloRole(hello) },
    version: options.version,
    // why: A gateway's "convergence" is starting to accept uplinks and arming the refresh tick.
    // Running it here rather than before `start()` keeps one lifecycle: a listener that cannot
    // start fails the daemon start, and `status.get` answers throughout (a fleet with no views
    // yet is a true answer, not an unready one). A worker that dials in the window before this
    // resolves is refused and redials on its own backoff.
    converge: async () => {
      await gatewayService.start();
      fleetCoordinator.start();
      // why: the gateway is not up while its HTTP listener may still fail to bind; the stop reason names that, not convergence.
      await httpStarted.catch((error: unknown) => {
        void daemon.stop("http-start-failed").catch(() => undefined);
        throw error;
      });
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
      dispatch,
      eventBus,
      idGenerator,
      leaseFiles: createGatewayLeaseFiles({
        relay: (workerId, call) => gatewayRelay.relay(workerId, call),
        requesterPrefix: gatewayRequesterPrefix,
        ...(options.fileSilenceMs === undefined ? {} : { silenceMs: options.fileSilenceMs }),
      }),
      leaseRequests: fleetCoordinator.requests,
      logger: httpLogger,
      leaseRoutes: [...moduleHost.leaseRoutes()],
      mounts: [...moduleHost.mounts({ dispatch })],
      ownerRoutedFacts: daemon.ownerRoutedFacts,
      registry: {
        get snapshot() {
          return { devices: gatewayService.workers.grantedDevices() };
        },
      },
      answerDownloadsEarly: false,
      auth,
    });
    const gateway = new HttpGateway(app, {
      host: config.http.host,
      logger: httpLogger,
      // why: ADR 0005 §4: the uplink upgrades on this same listener, so the fleet has one inbound
      // port. The factory only needs the server's `upgrade` event, which is all it is given.
      onServerCreated: (server) =>
        createUpgradeRouter({
          clock,
          leaseSocket: (request) => app.leaseSocket(request),
          uplinks,
        }).attach(server),
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
    // why: The gateway itself came up but its HTTP listener never bound -- which for a gateway means
    // no agent can reach it and no worker can join it. Tear it down, after the start is a
    // settled fact so `daemon.stopping` cannot precede `daemon.started`.
    await daemon.stop("http-start-failed").catch(() => undefined);
  }
  if (daemonResult.status === "rejected") {
    // why: as for a worker: `stopAuxiliary` waits for `httpStarted`, which only the start's settling releases here.
    await daemon.stop().catch(() => undefined);
    throw daemonResult.reason;
  }
  if (httpResult.status === "rejected") throw httpResult.reason;
  return daemon;
}

const WORKER_UPGRADE_STEP =
  "with the older Simlock, release every lease and run `simlock nuke --delete-devices`; then remove <path> and start again.";

const GATEWAY_UPGRADE_STEP =
  "remove <path> and start again; then create each worker's join token again with `simlock --gateway token create --role worker`, set it as that worker's `gateway.token`, and drain workers again.";

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
        } else {
          logFatalStart(role, error instanceof Error ? error.message : String(error), {
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
        // why: a start that lost the claim leaves its drivers to the live daemon, so a child one of them spawned (Simlock's adb server) can still hold this process open with nothing to serve; the line above is written synchronously.
        process.exit();
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
