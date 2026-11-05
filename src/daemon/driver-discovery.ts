import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventBus } from "../bus/index.js";
import {
  type Config,
  type DeviceDataTable,
  type Driver,
  type DriverRejection,
  type Platform,
  type PrerequisiteCheck,
  OwnedRootError,
} from "../core/index.js";
import {
  AdbServerUnavailableError,
  AndroidDriver,
  ANDROID_PASSTHROUGH_TOOLS,
  hostAbiFor,
  SdkMissingError,
  type AndroidDriverDiagnostic,
  type AndroidDriverConfig,
  androidDeviceDataTable,
  androidPrerequisites,
} from "../drivers/android/index.js";
import {
  IOS_PASSTHROUGH_TOOLS,
  IosSimctlDriver,
  type IosDriverConfig,
  type SlimmedFact,
  iosDeviceDataTable,
  iosPrerequisites,
} from "../drivers/ios/index.js";
import {
  type Clock,
  type Filesystem,
  type IdGenerator,
  type Logger,
  NodeBytePipeLauncher,
  NodeTcpListenerFactory,
  NodeTcpStreamConnector,
  type ProcessRunner,
  type ProcessSupervisor,
  type TcpProbe,
  type SqliteDatabase,
} from "../ports/index.js";
import { logSilenceFailure, logWindowFailure } from "./ios-driver-logging.js";

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
  new URL("../vendor/scrcpy/scrcpy-server-v5.0.1", import.meta.url),
);

export interface DriverDiscoveryContext {
  readonly acceptAndroidLicenses?: boolean;
  readonly clock: Clock;
  readonly database: SqliteDatabase;
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
  readonly iosConfig?: IosDriverConfig;
  readonly slimByDefault?: boolean;
  readonly androidConfig?: AndroidDriverConfig;
}

export interface DriverDiscovery {
  readonly drivers: readonly Driver[];
  readonly prerequisiteChecks: readonly PrerequisiteCheck[];
  readonly rejections: readonly DriverRejection[];
}

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
export async function resolveDeviceDataTables(options: {
  readonly deviceDataTables?: ReadonlyMap<Platform, DeviceDataTable> | undefined;
}): Promise<ReadonlyMap<Platform, DeviceDataTable>> {
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

function platformPrerequisiteChecks(options: {
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
      database: options.database,
      driverConfig: options.driversConfig["ios"] ?? {},
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      logger: logger.child("ios"),
      onSilenceFailed: logSilenceFailure(logger),
      onWindowFailed: logWindowFailure(logger),
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
      tcpListener: new NodeTcpListenerFactory(),
      tcpProbe: options.tcpProbe,
      tcpStreamConnector: new NodeTcpStreamConnector(),
      ...(options.iosConfig === undefined ? {} : { config: options.iosConfig }),
      ...(options.slimByDefault === undefined ? {} : { slimByDefault: options.slimByDefault }),
      // why: Ambient like `homedir()` above, and read here rather than in the driver so the
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

export function logAndroidDiagnostic(logger: Logger, diagnostic: AndroidDriverDiagnostic): void {
  if (diagnostic.kind === "snapshot-cold-boot") {
    logger.warn("Android snapshot boot fell back to a cold boot", {
      deviceId: diagnostic.deviceId,
      readyAfterMs: diagnostic.readyAfterMs,
    });
    return;
  }
  logger.warn("Android device profile source could not be read", {
    path: diagnostic.path,
    reason: diagnostic.reason,
  });
}

/**
 * why: Android refuses for one more reason than iOS does -- it needs a private adb server as
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
      database: options.database,
      driverConfig: options.driversConfig["android"] ?? {},
      config: options.androidConfig,
      env: process.env,
      filesystem: options.filesystem,
      homeDirectory: homedir(),
      hostAbi: hostAbiFor(options.hostArch),
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      logger: logger.child("android"),
      onDiagnostic: (diagnostic) => logAndroidDiagnostic(logger, diagnostic),
      processRunner: options.processRunner,
      processSupervisor: options.processSupervisor,
      scrcpyServerPath: PACKAGED_SCRCPY_SERVER,
      simlockHome: options.simlockHome,
      tcpListener: new NodeTcpListenerFactory(),
      tcpProbe: options.tcpProbe,
      tcpStreamConnector: new NodeTcpStreamConnector(),
      // why: Ambient like `homedir()` above, and read here rather than in the driver so the
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
