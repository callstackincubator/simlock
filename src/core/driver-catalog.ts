import type { DeviceSpec, Platform } from "./domain.js";
import type { DeviceRequest, Driver, DriverCatalogEntry, PassthroughCommand } from "./driver.js";

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

  constructor(drivers: readonly Driver[]) {
    this.#drivers = new Map(drivers.map((driver) => [driver.platform, driver]));
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
  passthrough(tool: string, args: readonly string[]): PassthroughCommand {
    for (const driver of this.#drivers.values()) {
      if (driver.passthroughTool === tool && driver.passthrough !== undefined) {
        return driver.passthrough(args);
      }
    }
    throw new UnknownPassthroughToolError(tool);
  }

  async resolveSpec(
    request: DeviceRequest,
    options: { readonly allowDownload: boolean; readonly requesterId?: string },
  ): Promise<DeviceSpec> {
    return this.get(request.platform).resolveSpec(request, options);
  }

  /**
   * Aggregates catalogs across every registered driver, or just the given
   * platform. A platform with no registered driver (its SDK is missing) is
   * omitted rather than raising `NoDriverError` — mirrors `discoverDrivers`.
   */
  async listCatalog(platform?: Platform): Promise<readonly PlatformCatalog[]> {
    const drivers =
      platform === undefined ? [...this.#drivers.values()] : this.#driverIfKnown(platform);
    return Promise.all(
      drivers.map(async (driver) => ({
        platform: driver.platform,
        ...(await driver.listCatalog()),
      })),
    );
  }

  #driverIfKnown(platform: Platform): readonly Driver[] {
    const driver = this.#drivers.get(platform);
    return driver === undefined ? [] : [driver];
  }
}
