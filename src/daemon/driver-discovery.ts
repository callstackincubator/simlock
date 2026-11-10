import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventBus } from "../bus/index.js";
import {
  backendKey,
  BackendUnavailableError,
  type BackendContext,
  type BackendModule,
  type Config,
  type DeviceDataTable,
  type Driver,
  type DriverRejection,
  type Platform,
  type PrerequisiteCheck,
} from "../core/index.js";
import {
  type Clock,
  type Filesystem,
  type IdGenerator,
  type Logger,
  NodeBytePipeLauncher,
  NodeTcpListenerFactory,
  NodeTcpStreamConnector,
  NodeWebSocketClientConnector,
  FetchHttpJsonRequester,
  type ProcessRunner,
  type ProcessSupervisor,
  type TcpProbe,
  type SqliteDatabase,
} from "../ports/index.js";
import { backendModules, selectedBackend } from "./backends.js";

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
  readonly platformConfigurations?: Readonly<Partial<Record<Platform, unknown>>>;
  readonly slimByDefault?: boolean;
}

export interface DriverDiscovery {
  readonly drivers: readonly Driver[];
  readonly prerequisiteChecks: readonly PrerequisiteCheck[];
  readonly rejections: readonly DriverRejection[];
}

/** why: both local tables stay registered even when the host cannot start a platform's driver. */
export function productionDeviceDataTables(): ReadonlyMap<Platform, DeviceDataTable> {
  const tables = new Map<Platform, DeviceDataTable>();
  for (const backend of backendModules) {
    tables.set(backend.definition.platform, backend.deviceDataTable);
  }
  return tables;
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
    // why: substituted drivers own their test roots and checks rather than using production discovery.
    const loaded = await loadDriversModule(driversModule, options, logger);
    return { ...loaded, rejections: [] };
  }
  const drivers: Driver[] = [];
  const rejections: DriverRejection[] = [];
  const prerequisiteChecks: PrerequisiteCheck[] = [];
  for (const platform of hostPlatforms(options.hostPlatform)) {
    const backend = selectedBackend(platform, options.driversConfig);
    const context = contextFor(backend, options, logger);
    const prerequisite = backend.prerequisites(context);
    prerequisiteChecks.push(prerequisite);
    try {
      const driver = await backend.create(context);
      drivers.push(driver);
      logger.info("Discovered driver", { platform });
    } catch (error: unknown) {
      if (!(error instanceof BackendUnavailableError)) throw error;
      if (error.rejection !== undefined) rejections.push(error.rejection);
    }
  }
  return { drivers, prerequisiteChecks, rejections };
}

function hostPlatforms(platform: NodeJS.Platform): readonly Platform[] {
  return platform === "darwin" ? ["ios", "android"] : ["android"];
}

function contextFor(
  backend: BackendModule<unknown, unknown>,
  options: DriverDiscoveryContext,
  logger: Logger,
): BackendContext<unknown, unknown> {
  const platform = backend.definition.platform;
  const key = backendKey(platform, backend.definition.id);
  return {
    settings: options.driversConfig[platform] ?? {},
    configuration: options.platformConfigurations?.[platform] ?? backend.definition.defaults,
    clock: options.clock,
    database: options.database,
    env: process.env,
    filesystem: options.filesystem,
    http: new FetchHttpJsonRequester(),
    webSockets: new NodeWebSocketClientConnector(),
    processRunner: options.processRunner,
    processSupervisor: options.processSupervisor,
    tcp: {
      listener: new NodeTcpListenerFactory(),
      probe: options.tcpProbe,
      connector: new NodeTcpStreamConnector(),
    },
    idGenerator: options.idGenerator,
    instanceId: options.instanceId,
    simlockHome: options.simlockHome,
    homeDirectory: homedir(),
    hostArch: options.hostArch,
    hostPlatform: options.hostPlatform,
    logger: logger.child(key),
    acceptAndroidLicenses: options.acceptAndroidLicenses ?? false,
    ...(options.slimByDefault === undefined ? {} : { slimByDefault: options.slimByDefault }),
    ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
    pid: process.pid,
    onDiagnostic: (diagnostic) => {
      options.eventBus.emit(diagnostic.event, diagnostic.payload, "driver-diagnostics");
    },
    capture: {
      launcher: new NodeBytePipeLauncher(),
      iosCommand: PACKAGED_SCREEN_CAPTURE,
      iosDeviceCommand: PACKAGED_DEVICE_CAPTURE,
      scrcpyServerPath: PACKAGED_SCRCPY_SERVER,
    },
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
