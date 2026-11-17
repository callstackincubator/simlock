import { join } from "node:path";
import { DriverCrashError } from "../../core/index.js";
import type { Clock, Filesystem, Logger, ProcessRunner } from "../../ports/index.js";

import { runCommand } from "./command-run.js";

import { COMMAND_TIMEOUT_MS } from "./simctl.js";

const DEVICEHUB_DOMAIN = "com.apple.dt.Devices";
const DEVICEHUB_STAGING_FILE = "devicehub-preferences.plist";

let pasteboardWrites: Promise<void> = Promise.resolve();

async function withPasteboardWrite<T>(run: () => Promise<T>): Promise<T> {
  const turn = pasteboardWrites.then(run, run);
  pasteboardWrites = turn.then(
    () => undefined,
    () => undefined,
  );
  return await turn;
}

interface DeviceHubPreferencesOptions {
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  readonly logger: Logger | undefined;
  readonly overridesRoot: string;
  readonly processRunner: ProcessRunner;
}

/** why: the part of IosSimctlDriver (ADR 0063) that turns DeviceHub's clipboard sync off for a simulator, and removes that setting when the simulator is destroyed. */
export class DeviceHubPreferences {
  readonly #clock: Clock;
  readonly #filesystem: Filesystem;
  readonly #logger: Logger | undefined;
  readonly #overridesRoot: string;
  readonly #processRunner: ProcessRunner;

  constructor(options: DeviceHubPreferencesOptions) {
    this.#clock = options.clock;
    this.#filesystem = options.filesystem;
    this.#logger = options.logger;
    this.#overridesRoot = options.overridesRoot;
    this.#processRunner = options.processRunner;
  }

  // why: DeviceHub's preferences belong to cfprefsd, which keeps its own copy and writes it back
  // over the file, so an edit made to the file alone is lost or ignored. The domain is exported
  // to a scratch file, edited there with PlistBuddy, and imported back through cfprefsd.
  async #editDeviceHubPreferences(
    edit: (buddy: (command: string) => Promise<boolean>) => Promise<boolean>,
  ): Promise<boolean> {
    return await withPasteboardWrite(async () => {
      await this.#filesystem.mkdirp(this.#overridesRoot, { mode: 0o700 });
      const staged = join(this.#overridesRoot, DEVICEHUB_STAGING_FILE);
      const run = async (command: string, args: string[]): Promise<boolean> => {
        const outcome = await runCommand(
          this.#processRunner,
          this.#clock,
          command,
          args,
          COMMAND_TIMEOUT_MS,
        );
        return outcome.kind !== "timed-out" && outcome.result.code === 0;
      };
      try {
        if (!(await run("defaults", ["export", DEVICEHUB_DOMAIN, staged]))) return false;
        const buddy = (command: string) => run("/usr/libexec/PlistBuddy", ["-c", command, staged]);
        return (await edit(buddy)) && (await run("defaults", ["import", DEVICEHUB_DOMAIN, staged]));
      } finally {
        await this.#filesystem.rm(staged).catch(() => undefined);
      }
    });
  }

  async disablePasteboardSync(udid: string): Promise<void> {
    const path = `:DevicePreferences:${udid}`;
    const done = await this.#editDeviceHubPreferences(async (buddy) => {
      if (await buddy(`Set ${path}:pasteboardSyncEnabled false`)) return true;
      await buddy("Add :DevicePreferences dict");
      await buddy(`Add ${path} dict`);
      return await buddy(`Add ${path}:pasteboardSyncEnabled bool false`);
    });
    if (!done) throw new DriverCrashError(`Could not disable DeviceHub clipboard sync for ${udid}`);
  }

  async removePasteboardPreference(udid: string): Promise<void> {
    const done = await this.#editDeviceHubPreferences((buddy) =>
      buddy(`Delete :DevicePreferences:${udid}`),
    ).catch(() => false);
    if (!done) {
      this.#logger?.warn(
        `could not remove DeviceHub preference for ${udid}: preference deletion failed`,
      );
    }
  }
}
