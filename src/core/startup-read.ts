import { type Clock, type Logger, type TimerHandle } from "../ports/index.js";
import type { Platform } from "./domain.js";
import type { Driver, DriverReality } from "./driver.js";
import { stableError } from "./stable-error.js";

/** The fixed limit on one platform's startup read. A constant, not a config key. */
export const STARTUP_READ_LIMIT_MS = 60_000;

/**
 * What each platform's driver listed at startup, the one read doctor's startup pass and leasing's
 * reconciler share. A platform missing from it is *unreadable*: it has no driver, or its listing
 * threw or passed the limit. "I could not look" is not "the device is gone".
 */
export class StartupRead {
  constructor(private readonly realities: ReadonlyMap<Platform, DriverReality> = new Map()) {}

  /** What the platform's driver listed, or undefined when the platform is unreadable. */
  reality(platform: Platform): DriverReality | undefined {
    return this.realities.get(platform);
  }

  isReadable(platform: Platform): boolean {
    return this.realities.has(platform);
  }
}

export interface StartupReadOptions {
  readonly clock: Clock;
  readonly drivers: readonly Driver[];
  readonly logger?: Logger | undefined;
}

/**
 * Calls `listManaged` once per driver, all platforms side by side, each bounded by
 * `STARTUP_READ_LIMIT_MS` on the daemon's own clock. Never throws: a platform whose listing throws
 * or passes the limit is left out of the read, and startup goes on without it.
 */
export async function readStartup(options: StartupReadOptions): Promise<StartupRead> {
  const listed = await Promise.all(
    options.drivers.map(async (driver) => ({
      platform: driver.platform,
      reality: await readOne(driver, options),
    })),
  );
  return new StartupRead(
    new Map(
      listed.flatMap(({ platform, reality }) =>
        reality === undefined ? [] : [[platform, reality] as const],
      ),
    ),
  );
}

async function readOne(
  driver: Driver,
  { clock, logger }: StartupReadOptions,
): Promise<DriverReality | undefined> {
  let timer: TimerHandle | undefined;
  const limit = new Promise<"timeout">((resolve) => {
    timer = clock.setTimer(STARTUP_READ_LIMIT_MS, () => resolve("timeout"));
  });
  const listing = Promise.resolve()
    .then(() => driver.listManaged())
    .catch((error: unknown) => {
      logger?.warn("startup read failed; the platform is unreadable", {
        error: stableError(error),
        platform: driver.platform,
      });
      return undefined;
    });
  try {
    const result = await Promise.race([listing, limit]);
    if (result === "timeout") {
      logger?.warn("startup read passed its limit; the platform is unreadable", {
        limitMs: STARTUP_READ_LIMIT_MS,
        platform: driver.platform,
      });
      return undefined;
    }
    return result;
  } finally {
    if (timer !== undefined) clock.cancel(timer);
  }
}
