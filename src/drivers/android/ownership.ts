import { isAbsolute } from "node:path";

import { DriverCrashError, type VirtualDriverDevice } from "../../core/index.js";
import type { Filesystem } from "../../ports/index.js";
import { deviceIdOf, type AdbTools } from "./adb-tools.js";
import type { AndroidDriverData } from "./data.js";

export const OWNERSHIP_PROBE_TIMEOUT_MS = 5_000;

export interface OwnershipOptions {
  readonly adb: string;
  readonly adbTools: AdbTools;
  readonly filesystem: Filesystem;
}

export class Ownership {
  readonly #options: OwnershipOptions;

  constructor(options: OwnershipOptions) {
    this.#options = options;
  }

  async deviceIsOwn(device: VirtualDriverDevice): Promise<boolean> {
    const data = this.#options.adbTools.dataFor(device);
    return data.serial !== "" && (await this.serialIsOwn(data));
  }

  /**
   * why: The gate before any emulator mutation (`emu kill`): asks the emulator on the
   * serial for its AVD path, bounded by a timeout, on every call -- the answer is never kept,
   * because the serial can change hands between calls. An unreachable, timed-out or unreadable
   * answer is "not ours" (fail closed), so nothing is sent.
   */
  async serialIsOwn(data: AndroidDriverData): Promise<boolean> {
    try {
      return await this.isOwnPath(
        await this.avdPathOf(data.serial),
        this.#options.adbTools.avdFolder(data),
      );
    } catch {
      return false;
    }
  }

  /**
   * why: Proves the emulator that answered the readiness wait on `data.serial` runs this device's
   * AVD, by the AVD directory it reports: only this device's own directory in the device root
   * will do -- not a sibling's, and never a name (safety rule 8). An emulator whose console
   * port is already held exits without answering, so the one that answers is whoever holds
   * the port -- another device, another Simlock instance, the user's own emulator. Refusing
   * here, before a mark or a snapshot save touches it, is what keeps a port collision from
   * readying a device at another device's address; `serialIsOwn` then keeps the
   * shutdown and destroy that follow a failed boot from sending it `emu kill`, by asking the
   * serial again each time. The reported
   * path is compared whole, and through `realpath` when the two spellings differ (an ancestor
   * symlink such as macOS's `/var` -> `/private/var`); anything unreadable fails closed.
   */
  async confirmAvdAnswers(data: AndroidDriverData): Promise<void> {
    const expected = this.#options.adbTools.avdFolder(data);
    const answered = await this.avdPathOf(data.serial);
    if (await this.isOwnPath(answered, expected)) {
      return;
    }
    throw new DriverCrashError(
      `Refusing to ready ${data.avdName}: the emulator answering on ${data.serial} runs ${JSON.stringify(answered)}, not ${expected} -- another emulator holds its console port`,
    );
  }

  /** why: A destroy after a restart has no handle, so each serial is asked which AVD it runs; one that cannot answer refuses the delete. */
  async serialsRunningAvd(data: AndroidDriverData, serials: readonly string[]): Promise<string[]> {
    const expected = this.#options.adbTools.avdFolder(data);
    const own: string[] = [];
    for (const serial of serials) {
      let answered: string | undefined;
      try {
        answered = await this.avdPathOf(serial);
      } catch {
        answered = undefined;
      }
      if (answered === undefined || answered === "") {
        throw new DriverCrashError(
          `Refusing to delete ${deviceIdOf(data)}: could not tell which AVD the emulator on ${serial} runs`,
        );
      }
      if (await this.isOwnPath(answered, expected)) own.push(serial);
    }
    return own;
  }

  async avdPathOf(serial: string): Promise<string> {
    const result = await this.#options.adbTools.runOrThrow(
      this.#options.adb,
      ["-s", serial, "emu", "avd", "path"],
      { timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS },
    );
    return answeredAvdPath(result.stdout);
  }

  async isOwnPath(answered: string, expected: string): Promise<boolean> {
    return answered === expected || (await this.sameDirectory(answered, expected));
  }

  async sameDirectory(left: string, right: string): Promise<boolean> {
    if (left === right) return true;
    if (!isAbsolute(left)) return false;
    try {
      const [realLeft, realRight] = await Promise.all([
        this.#options.filesystem.realpath(left),
        this.#options.filesystem.realpath(right),
      ]);
      return realLeft === realRight;
    } catch {
      return false;
    }
  }
}

function answeredAvdPath(stdout: string): string {
  return (stdout.split("\n")[0] ?? "").trim().replace(/(?<=.)\/+$/, "");
}
