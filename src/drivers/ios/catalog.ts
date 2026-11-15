import {
  type ExactDeviceRequest,
  type DriverAdvisory,
  type DriverCatalogEntry,
  DriverCrashError,
  UnsupportedRequestOptionError,
  type DeviceClass,
  type VirtualSpec,
} from "../../core/index.js";

import { Simctl } from "./simctl.js";

import { supportsPersistentSlim, type SlimOptions } from "./slim-boot.js";

import { iosRuntimeVersionFromId } from "./runtime-version.js";

import { resolveSlimCategories } from "./slim-labels.js";
import { checkExcept } from "./slim-except.js";
import { type DeviceType, type Runtime, type SimctlCatalog } from "./simctl-parse.js";
import { requireIosPlatform } from "./simulator-data.js";

import {
  LATEST_COMPONENT,
  missingRuntime,
  IosUnknownModelError,
  IosVersionOutOfRangeError,
  IosRuntimeUnpairedError,
  findInstalledRuntime,
  findDeviceType,
  pairedInstalledRuntimes,
  findPairedRuntime,
  pairedVersions,
  isUnboundedMax,
  isVersionInRange,
  majorVersionString,
  newestRuntime,
  compareVersions,
} from "./runtime-versions.js";

const PRODUCT_FAMILY_CLASSES: ReadonlyMap<string | undefined, DeviceClass> = new Map([
  ["iPhone", "phone"],
  ["iPad", "tablet"],
  ["Apple Watch", "watch"],
  ["Apple TV", "tv"],
  ["Apple Vision", "vision"],
]);

export interface ResolvedIosSpec {
  readonly deviceType: DeviceType;
  readonly runtime: Runtime;
  readonly spec: VirtualSpec;
}

function specKey(spec: VirtualSpec): string {
  return `${spec.model.toLocaleLowerCase()}\u0000${spec.osVersion}`;
}

interface SimulatorCatalogOptions {
  readonly simctl: Simctl;
  readonly slim: SlimOptions | undefined;
  readonly slimByDefault: boolean;
}

/** why: the part of IosSimctlDriver (ADR 0063) that resolves a requested model and OS version to an installed runtime and device type, lists the catalog, and reports the slim advisories. */
export class SimulatorCatalog {
  readonly #resolvedSpecs = new Map<string, ResolvedIosSpec>();
  readonly #simctl: Simctl;
  readonly #slim: SlimOptions | undefined;
  readonly #slimByDefault: boolean;

  constructor(options: SimulatorCatalogOptions) {
    this.#simctl = options.simctl;
    this.#slim = options.slim;
    this.#slimByDefault = options.slimByDefault;
  }

  async resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    requireIosPlatform(request.platform);
    if (request.imageTag !== undefined) {
      throw new UnsupportedRequestOptionError("ios", "imageTag");
    }
    checkExcept(request.except ?? [], resolveSlimCategories(this.#slim?.categories));
    const catalog = await this.#simctl.loadCatalog();
    const deviceType = findDeviceType(catalog, request.model);

    if (deviceType === undefined) {
      throw new IosUnknownModelError(request.model);
    }

    const spec =
      request.osVersion === undefined
        ? this.#resolveDefaultRuntime(deviceType, catalog)
        : this.#resolveExactRuntime(deviceType, request.osVersion, catalog);
    // why: The resolution cache (`specKey`) ignores the mode, so the mode is applied here, outside it.
    return request.mode === "slim" && this.#canSlim(spec) ? { ...spec, mode: "slim" } : spec;
  }

  #canSlim(spec: VirtualSpec): boolean {
    const runtime = this.#resolvedSpecs.get(specKey(spec))?.runtime;
    return (
      this.#slim !== undefined &&
      runtime !== undefined &&
      supportsPersistentSlim(iosRuntimeVersionFromId(runtime.identifier))
    );
  }

  /**
   * why: Version requested explicitly: validated against the model's `[min, max]` pairing range
   * *before* anything else -- an out-of-range request can never be fixed by downloading, so it
   * is never reported as downloadable.
   */
  #resolveExactRuntime(
    deviceType: DeviceType,
    osVersion: string,
    catalog: SimctlCatalog,
  ): VirtualSpec {
    if (!isVersionInRange(osVersion, deviceType)) {
      throw new IosVersionOutOfRangeError(deviceType.name, osVersion, deviceType);
    }

    // why: Looked up among the runtimes the catalog lists for this model, so a listed pair always
    // resolves and an unlisted one never does (ADR 0008 §3). Any installed build of the version
    // that pairs will do: two builds can share a marketing version and pair differently.
    const paired = findPairedRuntime(catalog, deviceType, osVersion);
    if (paired !== undefined) {
      return this.#commitResolution(deviceType, paired);
    }
    // why: Installed but not paired: in the model's declared `[min, max]` range is necessary but not
    // sufficient, since `supportedDeviceTypeIds` is the authoritative source once a runtime is
    // on disk. Refused before committing, so a mismatch never reaches `simctl create`.
    if (findInstalledRuntime(catalog, osVersion) !== undefined) {
      throw new IosRuntimeUnpairedError(deviceType.name, osVersion);
    }

    throw missingRuntime(
      osVersion,
      `iOS ${osVersion} is not installed; pass --allow-download (or set downloads.policy) ` +
        `to download it`,
      osVersion,
    );
  }

  #resolveDefaultRuntime(deviceType: DeviceType, catalog: SimctlCatalog): VirtualSpec {
    const paired = newestRuntime(pairedInstalledRuntimes(catalog, deviceType));
    if (paired !== undefined) {
      return this.#commitResolution(deviceType, paired);
    }

    throw missingRuntime(
      "default",
      `No installed iOS runtime pairs with ${deviceType.name}; pass --allow-download (or ` +
        `set downloads.policy) to download a compatible runtime`,
      isUnboundedMax(deviceType.maxRuntimeVersion)
        ? LATEST_COMPONENT
        : majorVersionString(deviceType.maxRuntimeVersion),
    );
  }

  #commitResolution(deviceType: DeviceType, runtime: Runtime): VirtualSpec {
    const spec: VirtualSpec = {
      model: deviceType.name,
      osVersion: runtime.version,
      physical: false,
      platform: "ios",
    };
    this.#resolvedSpecs.set(specKey(spec), { deviceType, runtime, spec });
    return spec;
  }

  async resolvedSpec(spec: VirtualSpec): Promise<ResolvedIosSpec> {
    const existing = this.#resolvedSpecs.get(specKey(spec));
    if (existing !== undefined) {
      return existing;
    }

    await this.resolveSpec(spec);
    const resolved = this.#resolvedSpecs.get(specKey(spec));
    if (resolved === undefined) {
      throw new DriverCrashError("simctl did not resolve the requested device specification");
    }

    return resolved;
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    const catalog = await this.#simctl.loadCatalog();
    const installedRuntimes = catalog.runtimes.filter((runtime) => runtime.isAvailable);
    const models = catalog.deviceTypes.map((deviceType) => deviceType.name);
    return {
      defaultRuntime: newestRuntime(installedRuntimes)?.version,
      // why: Keyed by name and paired through the device type `resolveSpec` would pick for that name,
      // so two device types that differ only in letter case both list the first one's runtimes.
      // A device type answers to its name only, in any letter case (`findDeviceType`).
      modelAliases: {},
      modelClasses: Object.fromEntries(
        catalog.deviceTypes.flatMap((deviceType) => {
          const deviceClass = PRODUCT_FAMILY_CLASSES.get(deviceType.productFamily);
          return deviceClass === undefined ? [] : [[deviceType.name, deviceClass]];
        }),
      ),
      modelRuntimes: Object.fromEntries(
        models.map((model) => [model, pairedVersions(catalog, findDeviceType(catalog, model))]),
      ),
      models,
      runtimes: installedRuntimes.map((runtime) => runtime.version),
      slimCategories: resolveSlimCategories(this.#slim?.categories).categories.map(
        (category) => category.name,
      ),
    };
  }

  async slimAdvisories(): Promise<readonly DriverAdvisory[]> {
    if (this.#slim === undefined || !this.#slimByDefault) {
      return [];
    }

    const catalog = await this.#simctl.loadCatalog();
    const unsupportedVersions = [
      ...new Set(
        catalog.runtimes
          .filter((runtime) => runtime.isAvailable)
          .filter((runtime) => !supportsPersistentSlim(iosRuntimeVersionFromId(runtime.identifier)))
          .map((runtime) => runtime.version),
      ),
    ].sort(compareVersions);

    if (unsupportedVersions.length === 0) {
      return [];
    }

    const plural = unsupportedVersions.length > 1;
    return [
      {
        code: "slim-runtime-unsupported",
        message:
          `The default device mode is slim, but iOS ${unsupportedVersions.join(", ")} ${plural ? "are" : "is"} ` +
          `below the 18.5 persistent-override floor; devices on ${plural ? "those runtimes" : "that runtime"} ` +
          `get full devices -- \`launchctl disable\` overrides do not survive a reboot below iOS 18.5`,
      },
    ];
  }
}
