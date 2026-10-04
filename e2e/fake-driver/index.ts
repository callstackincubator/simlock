import type { Driver, PrerequisiteCheck } from "../../dist/core/driver.js";
import { OutOfProcessFakeDriver, readPlatformScript, type FakeDriverClock } from "./fake-driver.js";
import { DEFAULT_LOG_ENV, DEFAULT_PLATFORMS_ENV, DEFAULT_SCRIPT_ENV } from "./types.js";

/**
 * The `SIMLOCK_DRIVERS_MODULE` entry point: substitutes real driver discovery in a
 * daemon process spawned by the e2e suite. Reads `SIMLOCK_FAKE_DRIVER_SCRIPT` and
 * `SIMLOCK_FAKE_DRIVER_LOG` from the environment and hands both fake drivers
 * (ios + android) the same paths, so one script file and one call log cover a whole
 * daemon instance regardless of which platform a test leases against.
 */
export function createDrivers(context: { readonly clock: FakeDriverClock }): Driver[] {
  const scriptPath = process.env[DEFAULT_SCRIPT_ENV];
  const logPath = process.env[DEFAULT_LOG_ENV];
  // A machine with only some drivers (`SIMLOCK_FAKE_DRIVER_PLATFORMS`), the way a Mac with no
  // Android SDK has no Android driver.
  const wanted = process.env[DEFAULT_PLATFORMS_ENV]?.split(",");
  return (["ios", "android"] as const)
    .filter((platform) => wanted === undefined || wanted.includes(platform))
    .map(
      (platform) =>
        new OutOfProcessFakeDriver({ clock: context.clock, logPath, platform, scriptPath }),
    );
}

/**
 * Stands in for the real prerequisite checks: each platform reports its script's
 * `missingPrerequisites`, read on every `doctor` run so a flow can stage one under a
 * running daemon.
 */
export const prerequisiteChecks: readonly PrerequisiteCheck[] = (["ios", "android"] as const).map(
  (platform) => ({
    check: async () =>
      (await readPlatformScript(process.env[DEFAULT_SCRIPT_ENV], platform)).missingPrerequisites ??
      [],
    platform,
  }),
);
