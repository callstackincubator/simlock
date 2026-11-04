import type { Filesystem } from "../../ports/index.js";
import type { AdbTools } from "./adb-tools.js";
import type { AvdConfig } from "./avd-config.js";
import type { Ownership } from "./ownership.js";

export interface DeviceTableOptions {
  readonly adbTools: Pick<
    AdbTools,
    "avdFolder" | "dataFor" | "runOrThrow" | "scanSerials" | "shellOrUndefined"
  >;
  readonly avdConfig: Pick<AvdConfig, "readDurableMark">;
  readonly avdmanager: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly deviceRoot: string;
  readonly filesystem: Filesystem;
  /** why: where an AVD Simlock made before it owned a root sits (ADR 0001, Migration). */
  readonly legacyAvdHome: string;
  readonly ownership: Pick<Ownership, "avdPathOf" | "sameDirectory">;
  /** why: announces one console port to Simlock's adb server; it swallows its own failures. */
  readonly register: (consolePort: number) => Promise<void>;
}

/** why: the part of AndroidDriver (ADR 0063) that owns the device states (keyed by AVD folder) and the per-device locks, and reports the devices the root holds. */
export class DeviceTable {
  constructor(_options: DeviceTableOptions) {}

  async withLock<T>(_deviceId: string, operation: () => Promise<T>): Promise<T> {
    return await operation();
  }
}
