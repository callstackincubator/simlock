import { type Logger, NoopLogger } from "../ports/index.js";
import { findCatalogModel } from "./catalog-match.js";
import { DEVICE_CLASSES, type DeviceClass, type DeviceSpec, type Platform } from "./domain.js";
import type {
  ExactDeviceRequest,
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

/**
 * The model names to try for each class, per platform, most preferred first: the operator's own
 * list followed by the driver's built-in one (ADR 0015 §4). Built once, by the composition root.
 */
export type ModelPreferences = Readonly<
  Partial<Record<Platform, Readonly<Partial<Record<DeviceClass, readonly string[]>>>>>
>;

/** One registered driver's catalog entry, tagged with its platform. */
export interface PlatformCatalog extends DriverCatalogEntry {
  readonly platform: Platform;
  /** ADR 0015 §4: the model Simlock would create for each class on this host. */
  readonly classDefaults: Readonly<Partial<Record<DeviceClass, string>>>;
}

/** Immutable platform-to-driver lookup used by the lease path. */
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

  async resolveSpec(request: ExactDeviceRequest): Promise<DeviceSpec> {
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

  /**
   * For each class, the model Simlock would create on this host (ADR 0015 §4): of the names on
   * the class's preference list that the entry lists and that are of that class, the first that
   * pairs with an installed runtime, else the first of them. A class in which no name counts has
   * no entry.
   */
  #classDefaults(
    platform: Platform,
    entry: DriverCatalogEntry,
  ): Partial<Record<DeviceClass, string>> {
    const defaults: Partial<Record<DeviceClass, string>> = {};
    for (const deviceClass of DEVICE_CLASSES) {
      const counted = (this.#preferences[platform]?.[deviceClass] ?? []).flatMap((name) => {
        const model = findCatalogModel(entry, name);
        return model !== undefined && classOf(entry, model) === deviceClass ? [model] : [];
      });
      const chosen = counted.find((model) => pairedRuntimes(entry, model).length > 0) ?? counted[0];
      if (chosen !== undefined) defaults[deviceClass] = chosen;
    }
    return defaults;
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

/** A model's class; an inherited property of a name like `constructor` is never a class string. */
function classOf(entry: DriverCatalogEntry, model: string): DeviceClass | undefined {
  return entry.modelClasses[model];
}

/** The installed runtimes a model pairs with, reading own keys only. */
function pairedRuntimes(entry: DriverCatalogEntry, model: string): readonly string[] {
  return (Object.hasOwn(entry.modelRuntimes, model) ? entry.modelRuntimes[model] : undefined) ?? [];
}
