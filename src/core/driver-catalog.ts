import { type Logger, NoopLogger } from "../ports/index.js";
import type { DeviceSpec, Platform } from "./domain.js";
import type {
  DeviceRequest,
  Driver,
  DriverCatalogEntry,
  PassthroughCommand,
  PassthroughContext,
} from "./driver.js";
import { stableError } from "./stable-error.js";

/** Thrown when no installed driver can serve the requested platform. */
export class NoDriverError extends Error {
  constructor(readonly platform: Platform) {
    super(`No driver registered for platform: ${platform}`);
    this.name = "NoDriverError";
  }
}

/** Thrown when no registered driver answers to the requested `simlock <tool>` wrapper. */
export class UnknownPassthroughToolError extends Error {
  constructor(readonly tool: string) {
    super(`No driver provides a ${tool} passthrough`);
    this.name = "UnknownPassthroughToolError";
  }
}

/** One registered driver's catalog entry, tagged with its platform. */
export interface PlatformCatalog extends DriverCatalogEntry {
  readonly platform: Platform;
}

/** Immutable platform-to-driver lookup used by the lease path. */
export class DriverCatalog {
  readonly #drivers: ReadonlyMap<Platform, Driver>;
  readonly #logger: Logger;

  constructor(drivers: readonly Driver[], options: { readonly logger?: Logger | undefined } = {}) {
    this.#drivers = new Map(drivers.map((driver) => [driver.platform, driver]));
    this.#logger = options.logger ?? new NoopLogger();
  }

  get(platform: Platform): Driver {
    const driver = this.#drivers.get(platform);
    if (driver === undefined) throw new NoDriverError(platform);
    return driver;
  }

  /** Whether a driver started for this platform; false for one discovery refused. */
  // fallow-ignore-next-line unused-class-member -- reached through StartupDriverAvailability by StartupConverger.
  has(platform: Platform): boolean {
    return this.#drivers.has(platform);
  }

  /**
   * Routes `simlock <tool> <args>` to whichever driver claims that tool name. Routing is
   * all this does: which flag scopes the tool, which verbs it refuses, and what its
   * environment must carry are decided inside the driver, so a third driver can add a
   * wrapper without a line changing here (architecture rules 2 and 3).
   */
  passthrough(
    tool: string,
    args: readonly string[],
    context?: PassthroughContext,
  ): PassthroughCommand {
    for (const driver of this.#drivers.values()) {
      if (driver.passthroughTool === tool && driver.passthrough !== undefined) {
        return driver.passthrough(args, context);
      }
    }
    throw new UnknownPassthroughToolError(tool);
  }

  async resolveSpec(request: DeviceRequest): Promise<DeviceSpec> {
    return this.get(request.platform).resolveSpec(request);
  }

  /**
   * Aggregates catalogs across every registered driver, or just the given
   * platform. A platform with no registered driver (its SDK is missing) is
   * omitted rather than raising `NoDriverError` — mirrors `discoverDrivers`.
   * Across platforms, a driver whose catalog rejects is left out and logged and
   * the others are still listed; with one platform named, its rejection is the
   * answer.
   */
  async listCatalog(platform?: Platform): Promise<readonly PlatformCatalog[]> {
    const listed = await Promise.all(
      this.select(platform).map(async (driver): Promise<PlatformCatalog | undefined> => {
        try {
          return { platform: driver.platform, ...(await driver.listCatalog()) };
        } catch (error: unknown) {
          if (platform !== undefined) throw error;
          this.#logger.warn("A driver could not read its catalog", {
            error: stableError(error),
            platform: driver.platform,
          });
          return undefined;
        }
      }),
    );
    return listed.filter((entry) => entry !== undefined);
  }

  /**
   * Every registered driver, or only the given platform's. A platform with no registered driver
   * gives none rather than raising `NoDriverError`: a read across platforms leaves it out.
   */
  select(platform?: Platform): readonly Driver[] {
    if (platform === undefined) return [...this.#drivers.values()];
    const driver = this.#drivers.get(platform);
    return driver === undefined ? [] : [driver];
  }
}
