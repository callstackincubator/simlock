import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { EventBus } from "../bus/index.js";
import {
  type ConfigOverrides,
  type Driver,
  CleanupReaper,
  DiskSpaceGuard,
  Doctor,
  LeaseEngine,
  loadConfig,
  Registry,
  Nuke,
} from "../core/index.js";
import {
  AndroidDriver,
  SdkMissingError,
  type AndroidDriverDiagnostic,
} from "../drivers/android/index.js";
import type { ComponentInstallDiagnostic } from "../drivers/diagnostics.js";
import { IosSimctlDriver, type SlimmedFact } from "../drivers/ios/index.js";
import { createHttpApp } from "../http/app.js";
import { HttpGateway } from "../http/server.js";
import { TokenStore } from "../http/token-store.js";
import {
  CryptoIdGenerator,
  CryptoTokenSecrets,
  JsonLinesLogger,
  NodeFileLogSink,
  type Clock,
  type Filesystem,
  type IdGenerator,
  type IpcConnector,
  type IpcListenerFactory,
  type Logger,
  NodeFilesystem,
  NodeIpcTransport,
  NodeProcessRunner,
  NodeSystemStats,
  resolveSimlockHome,
  SystemClock,
  type SystemStats,
  type ProcessRunner,
} from "../ports/index.js";
import { DaemonServer } from "./server.js";
import { DaemonEndpointHost } from "./connection-host.js";
import { AdminSecretManager } from "./admin-secret.js";
import { createCredentialRoleResolver } from "./session.js";

export interface StartDaemonOptions {
  readonly clock?: Clock;
  readonly configOverrides?: ConfigOverrides;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly defaultRequesterId?: string;
  readonly drivers?: readonly Driver[];
  readonly filesystem?: Filesystem;
  readonly idGenerator?: IdGenerator;
  readonly ipc?: IpcConnector & IpcListenerFactory;
  readonly logger?: Logger;
  readonly processRunner?: ProcessRunner;
  readonly socketPath?: string;
  readonly statePath?: string;
  readonly systemStats?: SystemStats;
  readonly version?: string;
}

/** Constructs the daemon's real adapters once; all state remains in the daemon. */
// fallow-ignore-next-line complexity -- explicit production composition necessarily wires all external ports.
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonServer> {
  const dataDirectory = options.dataDirectory ?? resolveSimlockHome();
  const filesystem = options.filesystem ?? new NodeFilesystem();
  const clock = options.clock ?? new SystemClock();
  const systemStats = options.systemStats ?? new NodeSystemStats();
  const idGenerator = options.idGenerator ?? new CryptoIdGenerator();
  const ipc = options.ipc ?? new NodeIpcTransport();
  const processRunner = options.processRunner ?? new NodeProcessRunner();
  const configPath = options.configPath ?? join(dataDirectory, "config.json");
  const statePath = options.statePath ?? join(dataDirectory, "state.json");
  const socketPath = options.socketPath ?? join(dataDirectory, "daemon.sock");
  const config = await loadConfig({
    configPath,
    filesystem,
    ...(options.configOverrides === undefined ? {} : { overrides: options.configOverrides }),
    systemStats,
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
  const eventBus = new EventBus(clock, config.eventBuffer.capacity);
  // Durable bookkeeping for component installs: `simlock events` is an in-memory ring buffer
  // that resets on restart (see ARCHITECTURE.md "Event bus"), so a component simlock installed
  // is only attributable later through the daemon's own log file.
  wireComponentInstallLogging(eventBus, logger);
  const registry = await Registry.load({ clock, eventBus, filesystem, idGenerator, statePath });
  // One instance shared across every driver discovered below, so a disk-space reservation one
  // driver makes is visible to the other's own preflight -- see `DiskSpaceGuard`.
  const diskSpaceGuard = new DiskSpaceGuard();
  const drivers =
    options.drivers ??
    (await discoverDrivers({
      acceptAndroidLicenses: config.downloads.acceptAndroidLicenses,
      clock,
      diskSpaceGuard,
      downloadTimeoutMs: config.downloads.timeoutMs,
      eventBus,
      filesystem,
      idGenerator,
      logger,
      processRunner,
      slim: config.ios.slim,
    }));
  const leaseEngine = new LeaseEngine({
    clock,
    config,
    drivers,
    eventBus,
    idGenerator,
    logger,
    registry,
    systemStats,
  });
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: leaseEngine.cleanup,
    filesystem,
    registry,
    diskPath: dataDirectory,
  });
  const doctor = new Doctor({
    // Without this, a backgrounded reclaim -- which holds its device in `reclaiming`
    // for a full erase, and is now how every release purges -- reads as a stalled
    // transition.
    claims: leaseEngine.claimReader,
    clock,
    config,
    drivers,
    eventBus,
    leaseExpirer: leaseEngine,
    quarantine: leaseEngine,
    registry,
  });
  const nuke = new Nuke({ executor: leaseEngine, registry });
  // Constructed unconditionally, not just when `config.http.enabled` -- ADR 0003 §5's operator
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
  // Reassigned once the HTTP gateway actually starts, but must exist as a stable closure now:
  // `stopAuxiliary` is fixed at `DaemonServer` construction time, before the gateway itself
  // exists.
  let stopHttpGateway: (() => Promise<void>) | undefined;
  // Settles once the HTTP gateway either finishes starting or fails to -- resolved/rejected from
  // inside `onSocketClaimed`'s handler below. `startDaemon()` awaits this alongside
  // `daemon.start()` itself (see the bottom of this function) so a bind failure (occupied port,
  // invalid host) makes `startDaemon()` reject and the entrypoint report a non-zero exit code,
  // the way it did before the gateway moved to firing concurrently with convergence. `stopAuxiliary`
  // below *also* awaits this -- that is what closes review finding S5: without it, `stopAuxiliary`
  // could return having stopped nothing (because `stopHttpGateway` isn't assigned yet, the
  // gateway still being mid-`start()`), and `#stop()` would go on to release leases, settle, and
  // dispose while the gateway finishes binding and starts accepting requests against a daemon
  // already being torn down -- see `server.ts`'s `stopAuxiliary` doc: it "must be shut off before
  // held-lease release and lease/queue teardown begin". When HTTP is disabled there is nothing to
  // wait for, so this resolves immediately.
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
  const daemon = new DaemonServer({
    capacity: leaseEngine,
    catalog: leaseEngine,
    clock,
    config,
    doctor,
    defaultRequesterId:
      options.defaultRequesterId ?? process.env.SIMLOCK_AGENT_ID ?? String(process.pid),
    eventBus,
    healthMonitor: leaseEngine.healthMonitor,
    host: new DaemonEndpointHost({
      connector: ipc,
      endpoint: socketPath,
      filesystem,
      listenerFactory: ipc,
      logger: logger.child("connection-host"),
    }),
    leases: leaseEngine,
    logger: logger.child("server"),
    queue: leaseEngine,
    reaper,
    nuke,
    registry,
    resolveRole,
    adminSecret,
    tokens,
    version: options.version ?? "1.0.0",
    // Runs after the socket is claimed (see DaemonServer#start): reachability no
    // longer depends on doctor reconciliation or running-capacity convergence.
    // Requests other than hello/status.get park until this resolves, so the two are
    // run concurrently rather than doctor-then-capacity: doctor.reconcile() is pure
    // reconnaissance (it shells out per driver/device, then at most flags drift --
    // see doctor.ts) that already runs interleaved with live lease/reclaim activity
    // whenever a client issues `doctor.run` mid-session, so running it alongside
    // startup's own registry work is nothing this codebase doesn't already do.
    // convergeRunningCapacity() no longer awaits an orphaned lease's device reclaim
    // inline either (#43): that erase (~34s for one simulator) proceeds in the
    // background, off this critical path, once its lease is released registry-only.
    converge: async () => {
      await Promise.all([doctor.reconcile(), leaseEngine.convergeRunningCapacity()]);
    },
    settle: async () => leaseEngine.settle(),
    dispose: () => leaseEngine.dispose(),
    // Review finding S5: waits for the concurrently-started gateway to either finish binding
    // (so `stopHttpGateway` is assigned and can actually be called) or fail to bind (nothing to
    // stop) *before* returning -- `#stop()` awaits this call before releasing leases, settling,
    // and disposing (see `server.ts`), so by the time any of that runs, the gateway is
    // guaranteed to be either stopped or never listening in the first place. `gatewayStarted`'s
    // rejection (a bind failure) is not this function's problem to surface -- the
    // `Promise.allSettled` at the bottom of this function, or the standalone `daemon.stop()`
    // call after it, already handle that -- so it is swallowed here.
    stopAuxiliary: async () => {
      await gatewayStarted.catch(() => undefined);
      await stopHttpGateway?.();
    },
    // ADR 0003 §2: "an HTTP request during startup now waits like a socket request instead of
    // being refused". Firing the gateway's own `start()` from here (not after `daemon.start()`
    // resolves) is what makes that true: the gateway is listening, and every route calls
    // `daemon.dispatch(...)`, which parks on the same startup-readiness gate a socket request
    // does. A bind failure (occupied port, invalid host) is reported through `gatewayStarted`
    // rather than acted on immediately here -- see the bottom of this function for why: calling
    // `daemon.stop()` right away, while `daemon.start()` may still be awaiting convergence, is
    // what let a stale "Daemon started" log/event follow "Daemon stopping" (review finding B6).
    ...(config.http.enabled
      ? {
          onSocketClaimed: () => {
            socketClaimed = true;
            void startHttpGateway().then(
              () => resolveGatewayStarted?.(),
              (error: unknown) => {
                logger.error("HTTP gateway failed to start", { message: errorMessage(error) });
                rejectGatewayStarted?.(error);
              },
            );
          },
        }
      : {}),
  });

  async function startHttpGateway(): Promise<void> {
    const httpLogger = logger.child("http");
    const app = createHttpApp({
      clock,
      config,
      dispatch: (operation, input, session) => daemon.dispatch(operation, input, session),
      eventBus,
      idGenerator,
      logger: httpLogger,
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
    // No self-stop check here: `stopAuxiliary` above is the single place that decides whether
    // to stop the gateway, and it does so by awaiting `gatewayStarted` (settled once this
    // function's caller -- `onSocketClaimed`'s handler below -- resolves or rejects) before
    // calling `stopHttpGateway`. Stopping here too would double-stop it.
  }

  // Awaited together, not `daemon.start()` alone: `gatewayStarted` is the promise
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DriverDiscoveryContext {
  /** Threaded into the Android driver's `downloads.acceptAndroidLicenses` gate; defaults to `false` when omitted. */
  readonly acceptAndroidLicenses?: boolean;
  readonly clock: Clock;
  /**
   * Threaded into the iOS driver's `xcodebuild -downloadPlatform` timeout and the Android
   * driver's `sdkmanager --install` / `--licenses` timeout; defaults to each driver's own
   * default (mirroring `downloads.timeoutMs`'s config default) when omitted.
   */
  readonly downloadTimeoutMs?: number;
  /**
   * Shared across every driver constructed from this context, so concurrent installs on
   * different drivers see each other's outstanding reservations -- see `DiskSpaceGuard`.
   * Defaults to a private instance (no sharing) when omitted, which only matters for a caller
   * that constructs its own drivers directly rather than through `discoverDrivers`.
   */
  readonly diskSpaceGuard?: DiskSpaceGuard;
  /** Bridges each driver's `component.install-*` diagnostic onto the bus -- see `emitComponentInstallDiagnostic`. */
  readonly eventBus: Pick<EventBus, "emit">;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly processRunner: ProcessRunner;
  /**
   * The iOS driver's opt-in slim mode (`ios.slim` in config). Never threaded into the Android
   * driver -- slim is iOS-only (ADR 0002, out of scope: Android equivalent). Omitted or
   * undefined leaves the driver's own default (today's full-fat behaviour) untouched.
   */
  readonly slim?: {
    readonly enabled: boolean;
    readonly categories?: readonly string[];
    readonly bootTimeoutMs: number;
  };
}

export async function discoverDrivers(options: DriverDiscoveryContext): Promise<Driver[]> {
  const logger = options.logger.child("driver-discovery");
  const driversModule = process.env.SIMLOCK_DRIVERS_MODULE;
  if (driversModule !== undefined) {
    return loadDriversModule(driversModule, options, logger);
  }

  const diskSpaceGuard = options.diskSpaceGuard ?? new DiskSpaceGuard();
  const drivers: Driver[] = [];
  if (process.platform === "darwin") {
    drivers.push(
      new IosSimctlDriver({
        clock: options.clock,
        coreSimulatorRoot: `${homedir()}/Library/Developer/CoreSimulator`,
        diskSpaceGuard,
        ...(options.downloadTimeoutMs === undefined
          ? {}
          : { downloadTimeoutMs: options.downloadTimeoutMs }),
        filesystem: options.filesystem,
        idGenerator: options.idGenerator,
        onDiagnostic: emitComponentInstallDiagnostic(options.eventBus, "ios"),
        onSlimmed: emitSlimDiagnostic(options.eventBus),
        onSlimSkipped: (fact) => {
          logger.warn("Skipped iOS device slim", {
            deviceId: fact.deviceId,
            detail: fact.detail,
            reason: fact.reason,
          });
        },
        processRunner: options.processRunner,
        ...(options.slim === undefined ? {} : { slim: options.slim }),
      }),
    );
    logger.info("Discovered driver", { platform: "ios" });
  }
  try {
    drivers.push(
      await AndroidDriver.create({
        acceptAndroidLicenses: options.acceptAndroidLicenses ?? false,
        clock: options.clock,
        diskSpaceGuard,
        ...(options.downloadTimeoutMs === undefined
          ? {}
          : { downloadTimeoutMs: options.downloadTimeoutMs }),
        env: process.env,
        filesystem: options.filesystem,
        homeDirectory: homedir(),
        idGenerator: options.idGenerator,
        onDiagnostic: bridgeAndroidDriverDiagnostic(options.eventBus),
        processRunner: options.processRunner,
      }),
    );
    logger.info("Discovered driver", { platform: "android" });
    return drivers;
  } catch (error: unknown) {
    if (error instanceof SdkMissingError) {
      logger.warn("Skipped Android driver: SDK missing", { reason: error.message });
      return drivers;
    }
    throw error;
  }
}

/**
 * Testing/advanced hook: substitutes real driver discovery with a module supplied via
 * `SIMLOCK_DRIVERS_MODULE`. The daemon always runs as a separately spawned process, so
 * the module is resolved as a file path (relative to `process.cwd()`) and dynamically
 * imported -- this is how the e2e suite injects a scriptable fake driver without the
 * daemon ever knowing it isn't talking to real hardware. A missing module, an import
 * error, or a module without a `createDrivers` export fails daemon startup loudly
 * rather than silently falling back to real discovery.
 */
async function loadDriversModule(
  modulePath: string,
  context: DriverDiscoveryContext,
  logger: Logger,
): Promise<Driver[]> {
  logger.info("Substituting driver discovery via SIMLOCK_DRIVERS_MODULE", {
    module: modulePath,
  });
  const moduleUrl = pathToFileURL(resolve(modulePath)).href;
  const imported = (await import(moduleUrl)) as {
    createDrivers?: (context: DriverDiscoveryContext) => Promise<Driver[]> | Driver[];
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
  return drivers;
}

/**
 * Turns a driver's `component-install-*` diagnostic into the matching `component.install-*`
 * bus event. Drivers never depend on the event bus directly (architecture rule 5 -- loose
 * coupling via the bus is for observers only) -- this is the one place, at driver construction,
 * that bridges the driver's diagnostic callback to a post-commit fact for observers (`simlock
 * events`, and the durable-log subscription in `startDaemon`).
 */
export function emitComponentInstallDiagnostic(
  eventBus: Pick<EventBus, "emit">,
  platform: "android" | "ios",
): (diagnostic: ComponentInstallDiagnostic) => void {
  return (diagnostic) => {
    switch (diagnostic.kind) {
      case "component-install-started":
        eventBus.emit(
          "component.install-started",
          {
            componentId: diagnostic.componentId,
            platform,
            ...(diagnostic.requesterId === undefined
              ? {}
              : { requesterId: diagnostic.requesterId }),
          },
          "driver-diagnostics",
        );
        return;
      case "component-installed":
        eventBus.emit(
          "component.installed",
          {
            componentId: diagnostic.componentId,
            durationMs: diagnostic.durationMs,
            platform,
            ...(diagnostic.requesterId === undefined
              ? {}
              : { requesterId: diagnostic.requesterId }),
          },
          "driver-diagnostics",
        );
        return;
      case "component-install-failed":
        eventBus.emit(
          "component.install-failed",
          {
            componentId: diagnostic.componentId,
            durationMs: diagnostic.durationMs,
            error: diagnostic.error,
            platform,
            ...(diagnostic.requesterId === undefined
              ? {}
              : { requesterId: diagnostic.requesterId }),
          },
          "driver-diagnostics",
        );
        return;
    }
  };
}

/**
 * Turns the iOS driver's `SlimmedFact` into the matching `device.slimmed` bus event. Mirrors
 * `emitComponentInstallDiagnostic`: the driver never depends on the event bus directly
 * (architecture rule 5) -- this is the one place, at driver construction, that bridges the
 * driver's `onSlimmed` callback to a post-commit fact for observers (`simlock events`, and the
 * durable-log subscription in `startDaemon`). A *skipped* slim is deliberately not bridged here
 * -- see `onSlimSkipped` in `discoverDrivers`, which logs it instead (see `docs/EVENTS.md`).
 */
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

function isComponentInstallDiagnostic(diagnostic: {
  readonly kind: string;
}): diagnostic is ComponentInstallDiagnostic {
  return (
    diagnostic.kind === "component-install-started" ||
    diagnostic.kind === "component-installed" ||
    diagnostic.kind === "component-install-failed"
  );
}

/**
 * The Android driver's `onDiagnostic` also carries `snapshot-cold-boot` and
 * `device-profile-source-unreadable` facts, neither wired to the bus (unchanged from before
 * this change -- discovery never passed `onDiagnostic` to the Android driver at all, so every
 * diagnostic it ever reported was already dropped). Only `component-install-*` is bridged here.
 */
export function bridgeAndroidDriverDiagnostic(
  eventBus: Pick<EventBus, "emit">,
): (diagnostic: AndroidDriverDiagnostic) => void {
  const installBridge = emitComponentInstallDiagnostic(eventBus, "android");
  return (diagnostic) => {
    if (isComponentInstallDiagnostic(diagnostic)) {
      installBridge(diagnostic);
    }
  };
}

/**
 * Durable bookkeeping for component installs (and iOS slims, below): the event ring buffer
 * (`simlock events`) resets on daemon restart, so a component simlock installed -- or a device it
 * slimmed -- on an agent's behalf is only attributable later through this log line -- see the
 * `Logger` port ("Operational logging is a separate concern from the event bus" in
 * ARCHITECTURE.md).
 */
export function wireComponentInstallLogging(
  eventBus: Pick<EventBus, "subscribe">,
  logger: Logger,
): void {
  const componentsLogger = logger.child("components");
  eventBus.subscribe("component.installed", (envelope) => {
    componentsLogger.info("Component installed", {
      componentId: envelope.payload.componentId,
      durationMs: envelope.payload.durationMs,
      platform: envelope.payload.platform,
      ...(envelope.payload.requesterId === undefined
        ? {}
        : { requesterId: envelope.payload.requesterId }),
    });
  });

  const slimLogger = logger.child("slim");
  eventBus.subscribe("device.slimmed", (envelope) => {
    slimLogger.info("Device slimmed", {
      categories: envelope.payload.categories,
      deviceId: envelope.payload.deviceId,
      durationMs: envelope.payload.durationMs,
      labelCount: envelope.payload.labelCount,
      signature: envelope.payload.signature,
      unknownLabels: envelope.payload.unknownLabels,
    });
  });
}

/**
 * Best-effort logger for the fatal startup handler below. It cannot depend on the
 * daemon's own `Config` — that is exactly what may have failed to load — so it always
 * writes to the default log location at a fixed level.
 */
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
      // Logging itself failed (e.g. an unwritable data directory) -- fall back to
      // the original behavior so the failure is not silently swallowed.
      console.error(error);
    }
    process.exitCode = 1;
  });
}
