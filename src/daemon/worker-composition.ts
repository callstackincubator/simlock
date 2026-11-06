import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus/index.js";
import { fitHostFacts, fitHostLoad, type ProtocolRange } from "../contract/index.js";
import { HostLoadSampler, MemoryPressureTracker } from "../host-load/index.js";
import { type EventHistoryHandle, HISTORY_DB_NAME } from "../history/index.js";
import {
  type Config,
  type DeviceClass,
  type DeviceDataTable,
  type DeviceMode,
  type Driver,
  type Platform,
  type ModelPreferences,
  type PrerequisiteCheck,
  type ServiceCheck,
  CleanupReaper,
  ComponentInstaller,
  DEVICE_CLASSES,
  driverConfig,
  DiskSpaceGuard,
  DriverCatalog,
  HostFactsReader,
  createCore,
  latestPresence,
  loadInstanceId,
  Registry,
  Nuke,
  SerializedDecision,
  stableError,
  sweepWriteLeftovers,
  toDriverDevice,
} from "../core/index.js";
import { createLeasing } from "../leasing/index.js";
import { type StateDatabase } from "../state/index.js";
import { androidDriverConfig } from "../drivers/android/index.js";
import { iosDriverConfig } from "../drivers/ios/index.js";
import { type Auth } from "../auth/index.js";
import { createHttpApp } from "../http/app.js";
import { createLeaseFiles, type LeaseFilesLimits } from "../lease-files/index.js";
import type { HttpDispatch } from "../http/dispatcher-session.js";
import { HttpGateway } from "../http/server.js";
import {
  LoggingProcessRunner,
  type Clock,
  type Filesystem,
  type HostLoadProbe,
  productionHostLoadProbe,
  type HostSystem,
  type IdGenerator,
  type IpcConnector,
  type IpcListenerFactory,
  type Logger,
  type LogLevel,
  type NpmCli,
  type SystemStats,
  type ProcessRunner,
  type ProcessSupervisor,
  type TcpProbe,
  type UplinkConnector,
  defaultWorkerLockPath,
  NodeWorkerLock,
  type WorkerLockHandle,
} from "../ports/index.js";
import { createLeaseInputs } from "./lease-inputs.js";
import { createModuleHost, type OptionalModuleDefinition } from "../modules/index.js";
import { DaemonServer } from "./server.js";
import { createUpdateCoordinator } from "./update-coordinator.js";
import { type VersionCheck } from "./version-check.js";
import { DaemonEndpointHost } from "./connection-host.js";
import { describeLeaseRequestFailure } from "./error-code.js";
import { wakingQueueAfter } from "./enrollment-wake.js";
import { execBaseEnvironment } from "./exec-env.js";
import { GatewayUplink } from "./gateway-uplink.js";
import type { RelayTargets, TwoWayRelayTargets } from "./relay.js";
import { discoverDrivers } from "./driver-discovery.js";
import {
  updateOptionsFor,
  errorMessage,
  startHistory,
  stopForRefusedHistory,
} from "./composition-support.js";

export interface WorkerOptions {
  readonly defaultRequesterId?: string;
  readonly drivers?: readonly Driver[];
  readonly hostLoadProbe?: HostLoadProbe | null;
  /** why: test-only, lower file and folder limits so a rig reaches a refusal without gigabytes. */
  readonly leaseFilesLimits?: LeaseFilesLimits;
  readonly prerequisiteChecks?: readonly PrerequisiteCheck[];
  /** why: test-only, the protocol range the worker daemon announces. */
  readonly protocolVersion?: number | ProtocolRange;
  readonly relayTargets?: RelayTargets;
  readonly relayTwoWayTargets?: TwoWayRelayTargets;
  readonly serviceCheck?: ServiceCheck;
  /** why: test-only, moves the worker lock (never decides whether it is taken). */
  readonly workerLockPath?: string;
}

/** why: what `composeDaemon` builds for both roles before the role branch, handed to the worker's half. */
export interface SharedParts {
  readonly auth: Auth;
  readonly clock: Clock;
  readonly config: Config;
  readonly dataDirectory: string;
  readonly defaulted: ReadonlySet<string>;
  readonly deviceDataTables: ReadonlyMap<Platform, DeviceDataTable>;
  readonly eventBus: EventBus;
  readonly eventHistory: EventHistoryHandle;
  readonly filesystem: Filesystem;
  readonly hostSystem: HostSystem;
  readonly idGenerator: IdGenerator;
  readonly ipc: IpcConnector & IpcListenerFactory;
  readonly logger: Logger;
  readonly moduleDefinitions: readonly OptionalModuleDefinition<unknown>[];
  readonly npm: NpmCli;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly role: "worker";
  readonly socketPath: string;
  readonly state: StateDatabase;
  readonly systemStats: SystemStats;
  readonly tcpProbe: TcpProbe;
  /** why: the WebSocket adapters sit past the ports index, so only `main.ts` imports them. */
  readonly upgradeRouter: (options: {
    readonly clock: Clock;
    readonly leaseSocket: ReturnType<typeof createHttpApp>["leaseSocket"];
  }) => { readonly attach: (server: Server) => void };
  readonly uplinkConnector: () => UplinkConnector;
  readonly version: string;
  readonly versionCheck: VersionCheck;
}

// fallow-ignore-next-line complexity -- explicit production composition necessarily wires all external ports.
export async function composeWorker(
  parts: SharedParts,
  options: WorkerOptions,
  onWorkerLock: (lock: WorkerLockHandle) => void,
): Promise<DaemonServer> {
  const {
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
    upgradeRouter,
    uplinkConnector,
    version,
    versionCheck,
  } = parts;
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
  // why: Before discovery, because every root a driver validates is checked against it, and it
  // is written exactly once per home and never regenerated (ADR 0001, decision 2).
  const instanceId = await loadInstanceId({
    filesystem,
    idGenerator,
    path: join(dataDirectory, "instance.json"),
  });
  // why: only a worker whose drivers are discovered touches the machine's adb server, console ports and runtimes; substituted drivers touch none (ADR 0059 §1).
  let workerLock: WorkerLockHandle | undefined;
  if (options.drivers === undefined && process.env.SIMLOCK_DRIVERS_MODULE === undefined) {
    workerLock = await new NodeWorkerLock({
      filesystem,
      path:
        options.workerLockPath ??
        defaultWorkerLockPath(process.platform, process.getuid?.() ?? 0, tmpdir()),
      processSupervisor,
      uid: process.platform === "win32" ? undefined : process.getuid?.(),
    }).take({
      folder: dataDirectory,
      pid: process.pid,
      startedAt: new Date(clock.now()).toISOString(),
    });
    onWorkerLock(workerLock);
  }
  const { drivers, prerequisiteChecks, rejections } =
    options.drivers === undefined
      ? await discoverDrivers({
          acceptAndroidLicenses: config.downloads.acceptAndroidLicenses,
          clock,
          database: state.database,
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
          iosConfig: driverConfig(config, iosDriverConfig),
          slimByDefault: deviceModeWiring(config).slimByDefault,
          androidConfig: driverConfig(config, androidDriverConfig),
          tcpProbe,
        })
      : {
          drivers: options.drivers,
          prerequisiteChecks: options.prerequisiteChecks ?? [],
          rejections: [],
        };
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
  const memoryPressure =
    hostLoadProbe === null
      ? undefined
      : new MemoryPressureTracker({ clock, config: config.memoryPressure, eventBus });
  const hostLoad =
    hostLoadProbe === null
      ? undefined
      : new HostLoadSampler({
          clock,
          logger: logger.child("host-load"),
          onReading: (reading) => memoryPressure?.observe(reading),
          probe: hostLoadProbe,
        });
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
    ...(memoryPressure === undefined
      ? {}
      : {
          memoryPressure: {
            current: () => memoryPressure.current(),
            onReading: (listener: () => void) => memoryPressure.onReading(listener),
          },
        }),
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
  const catalog = new DriverCatalog(drivers);
  const leaseInputs = createLeaseInputs({
    openInput: (platform, device, signal) => catalog.openInput(platform, device, signal),
  });
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
      hostPlatform: process.platform,
      platforms: drivers.map((driver) => driver.platform),
      processRunner,
      processSupervisor,
      registry,
      deviceTcp: {
        connect: (platform, device, devicePort, signal) =>
          catalog.connectDevicePort(platform, device, devicePort, signal),
        supports: (platform, device) => catalog.supportsDeviceTcp(platform, device),
        reverse: (platform, device, devicePort, signal) =>
          catalog.reverseDevicePort(platform, device, devicePort, signal),
        supportsEmulatorPort: (platform, device) => catalog.supportsEmulatorPort(platform, device),
        connectEmulatorPort: (platform, device, name, signal) =>
          catalog.connectEmulatorPort(platform, device, name, signal),
      },
      inputs: leaseInputs,
      screens: catalog,
      tcpProbe,
    },
    definitions: moduleDefinitions,
    logger,
    tokens: auth.tokens,
    role: "worker",
  });
  const leaseFiles = createLeaseFiles({
    clock,
    dataDirectory,
    diskPressureThreshold: config.diskPressure.freeBytesThreshold,
    filesystem,
    findGrant: (leaseId) => {
      const lease = registry.snapshot.leases.find((candidate) => candidate.id === leaseId);
      const device = registry.snapshot.devices.find(
        (candidate) => candidate.id === lease?.deviceId,
      );
      return lease === undefined || device === undefined
        ? undefined
        : { grantedAt: lease.grantedAt, id: lease.id, platform: device.spec.platform };
    },
    idGenerator,
    ...(options.leaseFilesLimits === undefined ? {} : { limits: options.leaseFilesLimits }),
    logger: logger.child("lease-files"),
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
    leaseEndParticipants: [
      leaseInputs.leaseEnd,
      leaseFiles.leaseEnd,
      ...moduleHost.leaseEndParticipants,
    ],
    logger,
    modelPreferences,
  });
  cancelPendingRequest = (requesterId) => leasing.cancelPending(requesterId);
  // why: Core declared ports only leasing can implement; this is the one place they are handed over,
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
  const gatewayUplink =
    config.gateway.url === undefined || config.gateway.token === undefined
      ? undefined
      : new GatewayUplink({
          accept: (connection) => daemon.acceptUplink(connection),
          clock,
          connector: uplinkConnector(),
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
  let lockClaim: Promise<unknown> = Promise.resolve();
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
    await sweepWriteLeftovers({
      deviceRoots: deviceRoots(drivers),
      directories: [dataDirectory],
      filesystem,
      logger,
      processSupervisor,
      ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
    });
    // why: before any request is served, so a tunnel rule a stopped daemon left is gone before a lease uses its device; each driver proves a device its own first.
    await Promise.all(
      drivers.map(async (driver) => {
        try {
          await driver.deviceTcp?.sweep(
            registry.snapshot.devices
              .filter(
                (device) => device.spec.platform === driver.platform && device.state !== "deleted",
              )
              .map((device) => ({
                device: toDriverDevice(device),
                leased: device.state === "leased",
              })),
          );
        } catch (error) {
          logger.warn("A driver's start sweep of tunnel rules failed", {
            error: stableError(error),
            platform: driver.platform,
          });
        }
      }),
    );
    await leasing.settleRequests();
    const read = await core.readStartup();
    const steps = [
      () => core.doctor.reconcile({ read }),
      () => leasing.reconcile(read),
      () => leaseFiles.sweep(registry.snapshot.leases),
      () => core.converge(read),
    ];
    for (const step of steps) {
      if (stopping) return;
      await step();
    }
    // why: startup is not done while the HTTP listener may still fail to bind: `running` is a promise that the console and API answer.
    await gatewayStarted.catch((error: unknown) => {
      void daemon.stop("http-start-failed").catch(() => undefined);
      throw error;
    });
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
    historyPath: join(dataDirectory, HISTORY_DB_NAME),
    healthMonitor: leasing.healthMonitor,
    physicalDeviceWatcher: leasing.physicalDeviceWatcher,
    hostFacts: () => fitHostFacts(hostFacts.current()),
    ...(hostLoad === undefined ? {} : { hostLoad, load: () => fitHostLoad(hostLoad.current()) }),
    ...(memoryPressure === undefined
      ? {}
      : {
          memoryPressure: {
            dispose: () => memoryPressure.dispose(),
            current: () => {
              const state = memoryPressure.current();
              if (state === undefined) return undefined;
              const { readingAt: _readingAt, ...figures } = state;
              return figures;
            },
          },
        }),
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
    inputs: leaseInputs,
    processRunner,
    leaseFiles,
    execEnv: execBaseEnvironment(process.env),
    queue: leasing,
    presence: latestPresence,
    reaper,
    relayTargets: {
      ...moduleHost.relayTargets,
      ...options.relayTargets,
      // why: `files` is reserved as a module name (ADR 0067 §7), so the core target never shadows a module's.
      files: (request) => leaseFiles.relayTarget(request),
    },
    relayTwoWayTargets: {
      ...moduleHost.relayTwoWayTargets,
      ...options.relayTwoWayTargets,
    },
    enrollment: wakingQueueAfter(core.enrollment, () => leasing.corePorts.notifyAvailability()),
    nuke,
    registry,
    warmKinds: core.warmKinds,
    baselines: core.baselines,
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
      // why: after the reclaims settled, so a device that just came back ready is shut down too; before `dispose`, which stops adb.
      await core.shutdownIdle();
    },
    // why: Every driver is tried even when another throws: Android's disposal is the only thing that can stop the adb server it started.
    dispose: async () => {
      versionCheck.dispose();
      core.dispose();
      leasing.dispose();
      // why: Before the drivers: a running install is ended through its signal while its driver
      // can still stop the installer process.
      await components.close();
      // why: a lease request still booting a device would otherwise fail against a disposed driver and leave its adb server and device behind (#1200).
      await leasing.settleAcquisitions();
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
      // why: ADR 0059: after the drivers are disposed, so no other worker sweeps while this one still acts on devices.
      await workerLock?.release();
      await eventHistory.stop();
      state.close();
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
      lockClaim = (workerLock?.claimed() ?? Promise.resolve()).then(
        () => undefined,
        (error: unknown) => error ?? new Error("worker lock check failed"),
      );
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
      dispatch,
      eventBus,
      idGenerator,
      leaseFiles,
      leaseRequests: leasing.requests,
      logger: httpLogger,
      leaseRoutes: [...moduleHost.leaseRoutes()],
      mounts: [...moduleHost.mounts({ dispatch })],
      ownerRoutedFacts: daemon.ownerRoutedFacts,
      registry,
      auth,
    });
    const gateway = new HttpGateway(app, {
      host: config.http.host,
      logger: httpLogger,
      onServerCreated: (server) =>
        upgradeRouter({ clock, leaseSocket: (request) => app.leaseSocket(request) }).attach(server),
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
  const lockFailure = await lockClaim;
  if (lockFailure !== undefined) {
    await daemon.stop().catch(() => undefined);
    throw lockFailure;
  }
  if (gatewayResult.status === "rejected" && daemonResult.status === "fulfilled") {
    // why: The daemon itself came all the way up -- convergence succeeded, `daemon.started` was
    // already emitted -- but its HTTP gateway never bound. Tear the whole thing down now,
    // *after* that success is a settled fact, so `daemon.stopping` never precedes (or follows
    // out of order) `daemon.started`; see this function's own comment above `onSocketClaimed`
    // and review finding B6. `stop()` is idempotent/dedups concurrent callers, so this is safe
    // even if `stopAuxiliary`'s own path already ran one.
    await daemon.stop("http-start-failed").catch(() => undefined);
  }
  if (daemonResult.status === "rejected") {
    // why: a stop accepted before the start failed may still run, and `stopAuxiliary` above waits for the start, so the start rejects without it; waiting here keeps the entry's `process.exit` from cutting that teardown short.
    await daemon.stop().catch(() => undefined);
    throw daemonResult.reason;
  }
  if (gatewayResult.status === "rejected") throw gatewayResult.reason;
  return daemon;
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

export function processRunnerFor(
  level: LogLevel,
  runner: ProcessRunner,
  logger: Logger,
  clock: Clock,
): ProcessRunner {
  if (level !== "debug") return runner;
  return new LoggingProcessRunner({ clock, inner: runner, logger: logger.child("process") });
}

/** why: a root's staging directory sits beside it, so the sweep looks there for leftovers. */
function deviceRoots(drivers: readonly Driver[]): string[] {
  return drivers.flatMap((driver) =>
    "deviceRoot" in driver && typeof driver.deviceRoot === "string" ? [driver.deviceRoot] : [],
  );
}
