import {
  BackendUnavailableError,
  OwnedRootError,
  type BackendContext,
  type BackendDiagnostic,
  type BackendModule,
  type BackendSettings,
  type Driver,
} from "../../../core/index.js";
import { rootRejection } from "../../backend-rejection.js";
import { iosDriverConfig, type IosDriverConfig } from "../definition.js";
import {
  IOS_PASSTHROUGH_TOOLS,
  IosSimctlDriver,
  iosDeviceDataTable,
  iosPrerequisites,
  type SlimmedFact,
} from "../index.js";
import { logSilenceFailure, logWindowFailure } from "./logging.js";

type Context = BackendContext<BackendSettings, IosDriverConfig>;

export const iosLocalBackend: BackendModule<BackendSettings, IosDriverConfig> = {
  definition: iosDriverConfig,
  deviceDataTable: iosDeviceDataTable,
  prerequisites: (context) => iosPrerequisites(context),
  create,
};

async function create(context: Context): Promise<Driver> {
  const { logger } = context;
  try {
    const onSlimmed = emitSlimDiagnostic(context.onDiagnostic);
    const onSilenceFailed = logSilenceFailure(logger);
    const onWindowFailed = logWindowFailure(logger);
    return await IosSimctlDriver.create({
      clock: context.clock,
      coreSimulatorRoot: `${context.homeDirectory}/Library/Developer/CoreSimulator`,
      database: context.database,
      driverConfig: context.settings,
      filesystem: context.filesystem,
      idGenerator: context.idGenerator,
      instanceId: context.instanceId,
      logger,
      onSilenceFailed,
      onWindowFailed,
      onSlimmed,
      screenCapture: {
        baseEnvironment: context.env,
        command: context.capture.iosCommand,
        deviceCommand: context.capture.iosDeviceCommand,
        launcher: context.capture.launcher,
        onLog: (line) => logger.debug("Screen capture", { line }),
      },
      onSlimSkipped: (fact) => {
        logger.warn("Skipped iOS device slim", {
          deviceId: fact.deviceId,
          detail: fact.detail,
          reason: fact.reason,
        });
      },
      processRunner: context.processRunner,
      simlockHome: context.simlockHome,
      tcpListener: context.tcp.listener,
      tcpProbe: context.tcp.probe,
      tcpStreamConnector: context.tcp.connector,
      config: context.configuration,
      ...(context.slimByDefault === undefined ? {} : { slimByDefault: context.slimByDefault }),
      ...(context.uid === undefined ? {} : { uid: context.uid }),
      pid: context.pid,
    });
  } catch (error: unknown) {
    if (!(error instanceof OwnedRootError)) throw error;
    logger.error("Skipped iOS driver: device root rejected", {
      reason: error.reason,
      root: error.path,
      summary: error.message,
    });
    const rejection = rootRejection(error, IOS_PASSTHROUGH_TOOLS);
    throw new BackendUnavailableError(error.message, rejection);
  }
}

export function emitSlimDiagnostic(
  onDiagnostic: (diagnostic: BackendDiagnostic) => void,
): (fact: SlimmedFact) => void {
  return (fact) => {
    onDiagnostic({
      event: "device.slimmed",
      payload: {
        deviceId: fact.deviceId,
        address: fact.address,
        platform: "ios",
        categories: fact.categories,
        labelCount: fact.labelCount,
        durationMs: fact.durationMs,
        signature: fact.signature,
        unknownLabels: fact.unknownLabels,
      },
    });
  };
}
