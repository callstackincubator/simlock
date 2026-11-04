import { basename, join } from "node:path";

import { DriverCrashError, type DriverDevice } from "../../core/index.js";
import type { Clock, ProcessResult, ProcessRunner } from "../../ports/index.js";
import { type AndroidDriverData, isAndroidDriverData } from "./data.js";

/**
 * why: The command timeout on the `adb devices` that `listManaged` runs. It sits below the 60-second
 * limit the daemon's startup read puts on a whole platform, so a hung adb server ends this call
 * first and the read reports the platform's failure rather than its own timeout.
 */
export const ADB_DEVICES_TIMEOUT_MS = 30_000;
export const SEED_AVD_NAME = "simlock";

export interface AdbToolsOptions {
  readonly adb: string;
  readonly adbServerPort: number;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly deviceRoot: string;
  readonly emulator: string;
  readonly processRunner: ProcessRunner;
}

export interface AdbSerialScan {
  readonly settledSerials: readonly string[];
  readonly unattributableTransitionalSerial: boolean;
}

export class AdbTools {
  readonly #options: AdbToolsOptions;

  constructor(options: AdbToolsOptions) {
    this.#options = options;
  }

  /**
   * why: The single insertion point for Android's scoping, the way `--set` is iOS's: every
   * `adb`, `emulator`, and `avdmanager` invocation this driver makes carries both keys, so
   * a call that slipped past here would address the user's AVD home and the shared adb
   * server. Layered over the injected environment because `ProcessRunner` replaces a
   * child's environment wholesale rather than merging into it -- a scoped env alone would
   * drop `PATH` and `ANDROID_HOME` and break every tool it scopes.
   */
  env(): NodeJS.ProcessEnv {
    return {
      ...this.#options.baseEnv,
      ANDROID_ADB_SERVER_PORT: String(this.#options.adbServerPort),
      ANDROID_AVD_HOME: this.#options.deviceRoot,
    };
  }

  async runOrThrow(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
  ): Promise<ProcessResult> {
    // why: The scoped environment unless a caller supplies its own, which only the two legacy
    // methods do -- pointing a command at a root this driver does not own is the whole of
    // what they are for, and nothing else here may.
    const result = await this.#options.processRunner.run(command, args, {
      ...options,
      env: options.env ?? this.env(),
    });
    if (result.code !== 0) {
      throw new DriverCrashError(
        `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }

  async scanSerials(): Promise<AdbSerialScan> {
    const attached = await this.runOrThrow(this.#options.adb, ["devices"], {
      timeoutMs: ADB_DEVICES_TIMEOUT_MS,
    });
    const settledSerials: string[] = [];
    let unattributableTransitionalSerial = false;
    for (const match of attached.stdout.matchAll(/^((?:emulator)-\d+)\s+(\S+)$/gm)) {
      const candidate = match[1];
      const state = match[2];
      if (candidate === undefined || state === undefined) continue;
      if (state === "device") {
        settledSerials.push(candidate);
      } else {
        unattributableTransitionalSerial = true;
      }
    }
    return { settledSerials, unattributableTransitionalSerial };
  }

  async shellOrUndefined(
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<ProcessResult | undefined> {
    try {
      return await this.runOrThrow(
        this.#options.adb,
        args,
        timeoutMs === undefined ? {} : { timeoutMs },
      );
    } catch {
      return undefined;
    }
  }

  async emulatorVersion(): Promise<string> {
    const result = await this.runOrThrow(this.#options.emulator, ["-version"]);
    return result.stdout.trim();
  }

  /** why: a copy's AVD sits in its own folder under the root; a device made before copies sat at `<root>/<avdName>.avd`. */
  avdFolder(data: AndroidDriverData): string {
    return data.avdHome === undefined
      ? `${this.#options.deviceRoot}/${data.avdName}.avd`
      : `${data.avdHome}/${SEED_AVD_NAME}.avd`;
  }

  dataFor(device: DriverDevice): AndroidDriverData {
    if (!isAndroidDriverData(device.driverData)) {
      throw new Error(`Android device ${device.deviceId} has invalid driver data`);
    }
    const { avdHome, avdName } = device.driverData;
    if (device.deviceId !== (avdHome === undefined ? avdName : basename(avdHome))) {
      throw new Error(`Android device id ${device.deviceId} does not match AVD ${avdName}`);
    }
    // why: `destroy` deletes this folder whole, so only the folder the root holds for this device id is accepted (safety rule 8).
    if (avdHome !== undefined && avdHome !== join(this.#options.deviceRoot, device.deviceId)) {
      throw new Error(`Android device ${device.deviceId} names a folder outside the root`);
    }
    return device.driverData;
  }

  delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.#options.clock.setTimer(milliseconds, resolve);
    });
  }
}

export function deviceIdOf(data: AndroidDriverData): string {
  return data.avdHome === undefined ? data.avdName : basename(data.avdHome);
}

export function serialFor(port: number): string {
  return `emulator-${port}`;
}
