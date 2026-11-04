import type { DriverDevice, DriverSource, VirtualSpec } from "../../core/index.js";
import type { Clock, Filesystem, IdGenerator, ProcessRunner } from "../../ports/index.js";
import type { SqliteDatabase } from "../../ports/index.js";
import type { AdbTools } from "./adb-tools.js";
import type { AvdConfig } from "./avd-config.js";
import type { Catalog } from "./catalog.js";
import type { ConsolePorts } from "./console-ports.js";
import type { DeviceTable } from "./device-table.js";
import type { Emulator } from "./emulator.js";
import type { Ownership } from "./ownership.js";
import type { SystemImages } from "./system-images.js";

export interface SeedsOptions {
  readonly adb: string;
  readonly adbTools: AdbTools;
  readonly avdConfig: AvdConfig;
  readonly avdmanager: string;
  readonly catalog: Pick<Catalog, "defaultAvdmanagerDeviceId" | "profileFor">;
  readonly clock: Clock;
  readonly consolePorts: ConsolePorts;
  readonly database: SqliteDatabase;
  readonly deviceRoot: string;
  readonly deviceTable: DeviceTable;
  readonly emulator: Emulator;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly ownership: Ownership;
  readonly processRunner: ProcessRunner;
  readonly systemImages: SystemImages;
}

/** why: the part of AndroidDriver (ADR 0063) that owns the sources table and the seeds being made, and makes and copies the seeds every virtual device starts from. */
export class Seeds {
  constructor(_options: SeedsOptions) {}

  async provision(
    _spec: VirtualSpec,
    _options: { readonly source?: string } = {},
  ): Promise<DriverDevice> {
    return { address: "", deviceId: "", driverData: {} };
  }

  async listSources(): Promise<readonly DriverSource[]> {
    return [];
  }
}
