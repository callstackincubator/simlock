import type { Clock, Logger } from "../ports/index.js";
import type { Platform } from "./domain.js";
import type { Driver, DriverReality } from "./driver.js";

/** The fixed limit on one platform's startup read. A constant, not a config key. */
export const STARTUP_READ_LIMIT_MS = 60_000;

/** What each platform's driver listed at startup, or nothing for a platform that is unreadable. */
class StartupRead {
  constructor(private readonly realities: ReadonlyMap<Platform, DriverReality> = new Map()) {}

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

export async function readStartup(_options: StartupReadOptions): Promise<StartupRead> {
  return new StartupRead();
}
