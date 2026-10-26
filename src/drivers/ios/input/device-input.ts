import type { DeviceInputFactory } from "../../../core/index.js";
import type { BytePipeLauncher, Clock, Logger, ProcessRunner } from "../../../ports/index.js";

export interface IosDeviceInputOptions {
  readonly command: string;
  readonly launcher: BytePipeLauncher;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  /** why: absent when the simulators live in Xcode's own set, which the helper searches by default. */
  readonly deviceSet?: string;
  readonly logger?: Logger;
}

export function createIosDeviceInput(_options: IosDeviceInputOptions): DeviceInputFactory {
  return { open: () => Promise.resolve({ unavailable: "" }) };
}
