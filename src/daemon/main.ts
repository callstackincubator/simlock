import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { EventBus } from "../bus/index.js";
import {
  type ConfigOverrides,
  type Driver,
  CleanupReaper,
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
import { IosSimctlDriver } from "../drivers/ios/index.js";
import {
  CryptoIdGenerator,
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
  const drivers =
    options.drivers ??
    (await discoverDrivers({
      acceptAndroidLicenses: config.downloads.acceptAndroidLicenses,
      clock,
      downloadTimeoutMs: config.downloads.timeoutMs,
      eventBus,
      filesystem,
      idGenerator,
      logger,
      processRunner,
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
  });
  await daemon.start();
  return daemon;
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
  /** Bridges each driver's `component.install-*` diagnostic onto the bus -- see `emitComponentInstallDiagnostic`. */
  readonly eventBus: Pick<EventBus, "emit">;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly processRunner: ProcessRunner;
}

export async function discoverDrivers(options: DriverDiscoveryContext): Promise<Driver[]> {
  const logger = options.logger.child("driver-discovery");
  const driversModule = process.env.SIMLOCK_DRIVERS_MODULE;
  if (driversModule !== undefined) {
    return loadDriversModule(driversModule, options, logger);
  }

  const drivers: Driver[] = [];
  if (process.platform === "darwin") {
    drivers.push(
      new IosSimctlDriver({
        clock: options.clock,
        coreSimulatorRoot: `${homedir()}/Library/Developer/CoreSimulator`,
        ...(options.downloadTimeoutMs === undefined
          ? {}
          : { downloadTimeoutMs: options.downloadTimeoutMs }),
        filesystem: options.filesystem,
        idGenerator: options.idGenerator,
        onDiagnostic: emitComponentInstallDiagnostic(options.eventBus, "ios"),
        processRunner: options.processRunner,
      }),
    );
    logger.info("Discovered driver", { platform: "ios" });
  }
  try {
    drivers.push(
      await AndroidDriver.create({
        acceptAndroidLicenses: options.acceptAndroidLicenses ?? false,
        clock: options.clock,
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
          { componentId: diagnostic.componentId, platform },
          "driver-diagnostics",
        );
        return;
      case "component-installed":
        eventBus.emit(
          "component.installed",
          { componentId: diagnostic.componentId, durationMs: diagnostic.durationMs, platform },
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
          },
          "driver-diagnostics",
        );
        return;
    }
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
 * Durable bookkeeping for component installs: the event ring buffer (`simlock events`) resets
 * on daemon restart, so a component simlock installed on an agent's behalf is only attributable
 * later through this log line -- see the `Logger` port ("Operational logging is a separate
 * concern from the event bus" in ARCHITECTURE.md).
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
