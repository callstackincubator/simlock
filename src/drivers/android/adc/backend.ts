import type { BackendModule } from "../../../core/index.js";
import { cloudDeviceDataTable } from "./data.js";
import { androidAdcDefinition, type AdcSettings } from "./definition.js";
import { cloudAndroidPrerequisites, createCloudAndroidDriver } from "./driver.js";

export const androidAdcBackend: BackendModule<AdcSettings> = {
  definition: androidAdcDefinition,
  deviceDataTable: cloudDeviceDataTable,
  prerequisites(context) {
    return cloudAndroidPrerequisites({
      driverConfig: context.settings,
      database: context.database,
      env: context.env,
      processRunner: context.processRunner,
    });
  },
  async create(context) {
    return await createCloudAndroidDriver({
      clock: context.clock,
      database: context.database,
      driverConfig: context.settings,
      env: context.env,
      filesystem: context.filesystem,
      http: context.http,
      idGenerator: context.idGenerator,
      instanceId: context.instanceId,
      logger: context.logger,
      pid: context.pid,
      ...(context.uid === undefined ? {} : { uid: context.uid }),
      processRunner: context.processRunner,
      processSupervisor: context.processSupervisor,
      scrcpyServerPath: context.capture.scrcpyServerPath,
      simlockHome: context.simlockHome,
      tcpListener: context.tcp.listener,
      tcpProbe: context.tcp.probe,
      tcpStreamConnector: context.tcp.connector,
      webSockets: context.webSockets,
    });
  },
};
