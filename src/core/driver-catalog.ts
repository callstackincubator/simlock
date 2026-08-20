import type { DeviceSpec, Platform } from "./domain.js";
import type { DeviceRequest, Driver, DriverCatalogEntry } from "./driver.js";

/** Thrown when no installed driver can serve the requested platform. */
export class NoDriverError extends Error {
  constructor(readonly platform: Platform) {
    super(`No driver registered for platform: ${platform}`);
    this.name = "NoDriverError";
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

  async resolveSpec(
    request: DeviceRequest,
    options: { readonly allowDownload: boolean },
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
