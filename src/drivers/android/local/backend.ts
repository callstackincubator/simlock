import {
  BackendUnavailableError,
  OwnedRootError,
  type BackendContext,
  type BackendModule,
  type BackendSettings,
  type Driver,
  type DriverRejection,
} from "../../../core/index.js";
import type { Logger } from "../../../ports/index.js";
import { rootRejection } from "../../backend-rejection.js";
import { androidDriverConfig, type AndroidDriverConfig } from "../definition.js";
import {
  AdbServerUnavailableError,
  AndroidDriver,
  ANDROID_PASSTHROUGH_TOOLS,
  hostAbiFor,
  SdkMissingError,
  androidDeviceDataTable,
  androidPrerequisites,
  type AndroidDriverDiagnostic,
} from "../index.js";

type Context = BackendContext<BackendSettings, AndroidDriverConfig>;

export const androidLocalBackend: BackendModule<BackendSettings, AndroidDriverConfig> = {
  definition: androidDriverConfig,
  deviceDataTable: androidDeviceDataTable,
  prerequisites: (context) => androidPrerequisites(context),
  create,
};

async function create(context: Context): Promise<Driver> {
  const { logger } = context;
  try {
    const hostAbi = hostAbiFor(context.hostArch);
    return await AndroidDriver.create({
      acceptAndroidLicenses: context.acceptAndroidLicenses,
      clock: context.clock,
      database: context.database,
      driverConfig: context.settings,
      config: context.configuration,
      env: context.env,
      filesystem: context.filesystem,
      homeDirectory: context.homeDirectory,
      hostAbi,
      idGenerator: context.idGenerator,
      instanceId: context.instanceId,
      logger,
      onDiagnostic: (diagnostic) => logAndroidDiagnostic(logger, diagnostic),
      processRunner: context.processRunner,
      processSupervisor: context.processSupervisor,
      scrcpyServerPath: context.capture.scrcpyServerPath,
      simlockHome: context.simlockHome,
      tcpListener: context.tcp.listener,
      tcpProbe: context.tcp.probe,
      tcpStreamConnector: context.tcp.connector,
      ...(context.uid === undefined ? {} : { uid: context.uid }),
      pid: context.pid,
    });
  } catch (error: unknown) {
    if (error instanceof SdkMissingError) {
      logger.warn("Skipped Android driver: SDK missing", { reason: error.message });
      throw new BackendUnavailableError(error.message);
    }
    if (error instanceof OwnedRootError) {
      logger.error("Skipped Android driver: device root rejected", {
        reason: error.reason,
        root: error.path,
        summary: error.message,
      });
      const rejection = rootRejection(error, ANDROID_PASSTHROUGH_TOOLS);
      throw new BackendUnavailableError(error.message, rejection);
    }
    if (error instanceof AdbServerUnavailableError) {
      logger.error("Skipped Android driver: adb server unavailable", {
        port: error.port,
        reason: error.reason,
        summary: error.message,
      });
      const rejection = adbServerRejection(error);
      throw new BackendUnavailableError(error.message, rejection);
    }
    throw error;
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
