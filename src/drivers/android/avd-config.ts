import type { Filesystem, IdGenerator } from "../../ports/index.js";
import type { AdbTools } from "./adb-tools.js";

export interface AvdConfigOptions {
  readonly adb: string;
  readonly adbTools: AdbTools;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly seedLaunchInputs: readonly string[];
}

export class AvdConfig {
  constructor(_options: AvdConfigOptions) {}

  async currentConfigHash(
    _folder: string,
    _imageIdentity: string,
    _knownEmulatorVersion?: string,
  ): Promise<string> {
    return "";
  }
}
