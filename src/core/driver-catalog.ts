import { type Logger, NoopLogger } from "../ports/index.js";
import { classCandidates, pairedRuntimes } from "./catalog-match.js";
import { DEVICE_CLASSES, type DeviceClass, type VirtualSpec, type Platform } from "./domain.js";
import type {
  ExactDeviceRequest,
  Driver,
  DriverCatalogEntry,
  PassthroughCommand,
  PassthroughContext,
  PhysicalDriverDevice,
  VirtualDriverDevice,
} from "./driver.js";
import type { DeviceInput, UnavailableDeviceInput } from "./input.js";
import { type ScreenFeed, ScreenNotSupportedError, type ScreenSettings } from "./screen.js";
import { stableError } from "./stable-error.js";

export class NoDriverError extends Error {
  constructor(readonly platform: Platform) {
    super(`No driver registered for platform: ${platform}`);
    this.name = "NoDriverError";
  }
}

export class UnknownPassthroughToolError extends Error {
  constructor(readonly tool: string) {
    super(`No driver provides a ${tool} passthrough`);
    this.name = "UnknownPassthroughToolError";
  }
}

export type ModelPreferences = Readonly<
  Partial<Record<Platform, Readonly<Partial<Record<DeviceClass, readonly string[]>>>>>
>;

export interface PlatformCatalog extends DriverCatalogEntry {
  readonly platform: Platform;
  readonly classDefaults: Readonly<Partial<Record<DeviceClass, string>>>;
}

export interface ScreenAvailability {
  readonly platform: Platform;
  readonly reason?: string;
}

export class DriverCatalog {
  readonly #drivers: ReadonlyMap<Platform, Driver>;
  readonly #logger: Logger;
  readonly #preferences: ModelPreferences;

  constructor(
    drivers: readonly Driver[],
    options: {
      readonly logger?: Logger | undefined;
      readonly preferences?: ModelPreferences | undefined;
    } = {},
  ) {
    this.#drivers = new Map(drivers.map((driver) => [driver.platform, driver]));
    this.#preferences = options.preferences ?? {};
    this.#logger = options.logger?.child("driver-catalog") ?? new NoopLogger();
  }

  get(platform: Platform): Driver {
    const driver = this.#drivers.get(platform);
    if (driver === undefined) throw new NoDriverError(platform);
    return driver;
  }

  async passthrough(
    tool: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand> {
    for (const driver of this.#drivers.values()) {
      if (driver.passthroughTools?.includes(tool) === true && driver.passthrough !== undefined) {
        return await driver.passthrough(tool, device, args, context);
      }
    }
    throw new UnknownPassthroughToolError(tool);
  }

  async openScreen(
    platform: Platform,
    device: VirtualDriverDevice | PhysicalDriverDevice,
    settings: ScreenSettings,
    signal: AbortSignal,
  ): Promise<ScreenFeed> {
    const capture = this.#drivers.get(platform)?.screenCapture;
    if (capture === undefined) {
      throw new ScreenNotSupportedError(`A ${platform} device's screen cannot be streamed`);
    }
    return await capture.open(device, settings, signal);
  }

  async openInput(
    platform: Platform,
    device: VirtualDriverDevice | PhysicalDriverDevice,
    signal: AbortSignal,
  ): Promise<DeviceInput | UnavailableDeviceInput> {
    const factory = this.#drivers.get(platform)?.input;
    if (factory === undefined) return { unavailable: `${platform} devices take no input` };
    return await factory.open(device, signal);
  }

  async screenAvailability(): Promise<readonly ScreenAvailability[]> {
    return await Promise.all(
      [...this.#drivers.values()].flatMap((driver) =>
        driver.screenCapture === undefined
          ? []
          : [
              driver.screenCapture
                .unavailable()
                .then((reason) =>
                  reason === undefined
                    ? { platform: driver.platform }
                    : { platform: driver.platform, reason },
                ),
            ],
      ),
    );
  }

  async resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    return this.get(request.platform).resolveSpec(request);
  }

  async listCatalog(platform?: Platform): Promise<readonly PlatformCatalog[]> {
    const listed = await Promise.all(
      this.select(platform).map(async (driver): Promise<PlatformCatalog | undefined> => {
        try {
          const entry = await driver.listCatalog();
          return {
            platform: driver.platform,
            ...entry,
            classDefaults: this.#classDefaults(driver.platform, entry),
          };
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

  #classDefaults(
    platform: Platform,
    entry: DriverCatalogEntry,
  ): Partial<Record<DeviceClass, string>> {
    const defaults: Partial<Record<DeviceClass, string>> = {};
    for (const deviceClass of DEVICE_CLASSES) {
      const counted = classCandidates(
        entry,
        deviceClass,
        this.#preferences[platform]?.[deviceClass] ?? [],
      );
      const chosen = counted.find((model) => pairedRuntimes(entry, model).length > 0) ?? counted[0];
      if (chosen !== undefined) defaults[deviceClass] = chosen;
    }
    return defaults;
  }

  select(platform?: Platform): readonly Driver[] {
    if (platform === undefined) return [...this.#drivers.values()];
    const driver = this.#drivers.get(platform);
    return driver === undefined ? [] : [driver];
  }
}
