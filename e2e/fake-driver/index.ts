import type { Driver } from "../../dist/core/driver.js";
import { OutOfProcessFakeDriver, type FakeDriverClock } from "./fake-driver.js";
import { DEFAULT_LOG_ENV, DEFAULT_SCRIPT_ENV } from "./types.js";

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
  return [
    new OutOfProcessFakeDriver({ clock: context.clock, logPath, platform: "ios", scriptPath }),
    new OutOfProcessFakeDriver({ clock: context.clock, logPath, platform: "android", scriptPath }),
  ];
}
