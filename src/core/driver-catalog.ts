import type { DeviceSpec, Platform } from "./domain.js";
import type { DeviceRequest, Driver } from "./driver.js";

/** Thrown when no installed driver can serve the requested platform. */
export class NoDriverError extends Error {
  constructor(readonly platform: Platform) {
    super(`No driver registered for platform: ${platform}`);
    this.name = "NoDriverError";
  }
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
}
