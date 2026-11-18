import { type OsRange, requestedClass } from "../contract/index.js";
import {
  BadDeviceRequestError,
  baselineMismatch,
  BaselineMismatchError,
  BaselineStaleError,
  classCandidates,
  type CurrentBaseline,
  type DeviceClass,
  type DeviceMode,
  type DeviceRequest,
  type DeviceRequirement,
  type Driver,
  type DriverCatalogEntry,
  type ExactDeviceRequest,
  exactRequirement,
  findCatalogModel,
  modelClass,
  type Platform,
  RuntimeMissingError,
  type TargetResolution,
  UnknownBaselineError,
  UnknownModelError,
  type VirtualSpec,
} from "../core/index.js";
import { asError, ModeUnavailableError, VirtualDevicesOffError } from "./acquisition-errors.js";
import { type LeaseAcquisitionCoordinatorOptions } from "./acquisition-ports.js";
import {
  downloadingProgress,
  type DownloadingProgress,
  fullSpec,
  matchingRuntimes,
  newestRuntime,
  requestedRange,
  requiredOs,
  sameDownloadingProgress,
} from "./acquisition-requests.js";
import { type LeaseRequestOptions } from "./wait-queue.js";

export type AcquisitionSpecResolverOptions = Pick<
  LeaseAcquisitionCoordinatorOptions,
  | "baselines"
  | "catalog"
  | "components"
  | "defaultImageTags"
  | "defaultModes"
  | "drivers"
  | "modelPreferences"
  | "servedModes"
>;

/** why: turns a request into the exact spec a driver resolves, and a baseline request into that baseline's spec, so the root and the workflow never resolve a spec themselves. */
export class AcquisitionSpecResolver {
  constructor(private readonly options: AcquisitionSpecResolverOptions) {}

  defaultMode(platform: Platform): DeviceMode {
    return this.options.defaultModes[platform] ?? "full";
  }

  /** why: the modes this worker serves on a platform; a platform with no `ios.modes` of its own serves both (ADR 0082 §1). */
  servedModes(platform: Platform): readonly DeviceMode[] {
    return this.options.servedModes[platform] ?? ["slim", "full"];
  }

  async resolveSpec(
    driver: Driver,
    request: DeviceRequest,
    options: LeaseRequestOptions,
    onProgress: (progress: DownloadingProgress) => void,
  ): Promise<{
    readonly spec: VirtualSpec;
    readonly requirement: DeviceRequirement;
    readonly classOf: ((model: string) => DeviceClass | undefined) | undefined;
  }> {
    // why: before the baseline branch, any catalog read, download or wait: a phones-only platform makes no virtual device (ADR 0084 §2).
    if (!this.options.catalog.virtualDevices(request.platform)) {
      throw new VirtualDevicesOffError(request);
    }
    if (request.baseline !== undefined) {
      return this.#resolveBaseline(driver, request.baseline, request);
    }
    const tag = this.#defaultTag(request);
    if (tag !== undefined) {
      try {
        return await this.#resolveAttempt(
          driver,
          { ...request, imageTag: tag },
          { ...options, allowDownload: false },
          onProgress,
          true,
        );
      } catch (error: unknown) {
        // why: only a missing runtime says the tag cannot be met here; any other refusal is the request's answer (ADR 0078 §2).
        if (!(error instanceof RuntimeMissingError)) throw error;
      }
    }
    return this.#resolveAttempt(driver, request, options, onProgress, false);
  }

  /** why: the image tag the worker gives this request, or none for a request the default does not apply to (ADR 0078 §1). */
  #defaultTag(request: DeviceRequest): string | undefined {
    if (request.imageTag !== undefined || request.physical === true) return undefined;
    return this.options.defaultImageTags[request.platform];
  }

  async #resolveAttempt(
    driver: Driver,
    request: DeviceRequest,
    options: LeaseRequestOptions,
    onProgress: (progress: DownloadingProgress) => void,
    defaultTag: boolean,
  ): Promise<{
    readonly spec: VirtualSpec;
    readonly requirement: DeviceRequirement;
    readonly classOf: ((model: string) => DeviceClass | undefined) | undefined;
  }> {
    // The one place a request with no mode gets the worker's default (ADR 0007 §2).
    const mode = request.mode ?? this.defaultMode(request.platform);
    if (request.except !== undefined && mode !== "slim") {
      throw new BadDeviceRequestError(
        "except needs a slim lease (this worker's default mode is full)",
      );
    }
    this.#requireServed(request.platform, mode);
    const range = requestedRange(request);
    const target =
      range === undefined
        ? (this.#exactTarget(request, mode) ?? (await this.#resolveClass(request, mode)))
        : await this.#resolveRanged(request, mode, range);
    // A range was settled against the catalog above, so it never installs (ADR 0015 §5).
    const exact = defaultTag ? { ...target.exact, defaultTag: true as const } : target.exact;
    const resolved = await this.#resolveOrInstall(onProgress, driver, exact, {
      ...options,
      allowDownload: options.allowDownload === true && range === undefined,
    });
    const spec = checkedSpec(resolved, request, mode);
    return {
      classOf: target.classOf,
      requirement: target.requirement ?? exactRequirement(spec),
      spec,
    };
  }

  /** why: the asked or default mode is checked before the spec is resolved, so a refused mode downloads nothing (ADR 0082 §2). */
  #requireServed(platform: Platform, mode: DeviceMode): void {
    const served = this.servedModes(platform);
    if (served.includes(mode)) return;
    const other = mode === "full" ? "slim" : "full";
    throw new ModeUnavailableError(
      mode,
      served,
      `This worker does not serve ${mode} iOS simulators (ios.modes is ${JSON.stringify(served)}); ` +
        `ask for a ${other} one (--mode ${other}, or mode: "${other}")`,
    );
  }

  /** why: a request naming a baseline takes the baseline's own platform, model, OS, mode and image tag; no download is ever attempted. */
  async #resolveBaseline(
    driver: Driver,
    name: string,
    request: DeviceRequest,
  ): Promise<{
    readonly spec: VirtualSpec;
    readonly requirement: DeviceRequirement;
    readonly classOf: undefined;
  }> {
    const current = this.options.baselines.current(name);
    if (current === undefined) throw new UnknownBaselineError(name);
    const entry = (await this.options.catalog.listCatalog(current.platform))[0];
    const mismatch = baselineMismatch(current, request, entry ?? { modelAliases: {}, models: [] });
    if (mismatch !== undefined) {
      throw new BaselineMismatchError(name, mismatch.field, mismatch.message);
    }
    if (current.staleReason !== undefined) throw new BaselineStaleError(name, current.staleReason);
    const spec = baselineSpec(current);
    if (request.except !== undefined && spec.mode !== "slim") {
      throw new BadDeviceRequestError(`except needs a slim lease (baseline "${name}" is full)`);
    }
    if (request.except !== undefined) {
      // why: the driver judges the names (ADR 0066 §2); its answer is dropped, the baseline's spec stands.
      await driver.resolveSpec({
        except: request.except,
        mode: "slim",
        model: spec.model,
        osVersion: spec.osVersion,
        platform: spec.platform,
        ...(spec.imageTag === undefined ? {} : { imageTag: spec.imageTag }),
      });
    }
    return { classOf: undefined, requirement: exactRequirement(spec), spec };
  }

  /**
   * The exact request an exact-model request already is, answered without awaiting anything so
   * its path takes no extra turn of the event loop; `undefined` for one that names no model.
   */
  #exactTarget(request: DeviceRequest, mode: DeviceMode): ResolvedTarget | undefined {
    const { class: _class, model, ...rest } = request;
    return model === undefined ? undefined : { exact: { ...rest, mode, model } };
  }

  /**
   * Turns a request that names no model, or names an OS range, into the exact one a driver
   * resolves (ADR 0015 §5). A class, named or meant by naming nothing, becomes the first model
   * on its preference list that this host's catalog lists, classes as that class, and pairs with
   * an installed runtime (of the requested image tag, and in the requested range, when it names
   * them); an exact model with a range must be listed, or the request fails as
   * `UnknownModelError`. With a range the runtime is the newest paired one in it, passed on as an
   * exact version. The catalog is read, and nothing is downloaded. A class with no listed model
   * fails as `UnknownModelError`, and a model or class with no pairing as a `RuntimeMissingError`
   * no download can fix.
   */
  async #resolveClass(
    request: DeviceRequest,
    mode: DeviceMode,
    range?: OsRange,
  ): Promise<ResolvedTarget> {
    const deviceClass = requestedClass({ class: request.class });
    const entry = (await this.options.catalog.listCatalog(request.platform))[0];
    if (entry === undefined) throw new UnknownModelError(request.platform, undefined, deviceClass);
    const candidates = classCandidates(
      entry,
      deviceClass,
      this.options.modelPreferences[request.platform]?.[deviceClass] ?? [],
    );
    if (candidates.length === 0) {
      throw new UnknownModelError(request.platform, undefined, deviceClass);
    }
    const chosen = candidates.find(
      (candidate) => matchingRuntimes(entry, candidate, request, range).length > 0,
    );
    if (chosen === undefined) {
      throw new RuntimeMissingError(request.platform, request.osVersion ?? "default");
    }
    return {
      ...this.#rangedTarget(
        entry,
        chosen,
        { class: deviceClass, kind: "class" },
        request,
        mode,
        range,
      ),
      classOf: (candidate) => modelClass(entry, candidate),
    };
  }

  /** A request that names a model and an OS range: the model must be listed (ADR 0015 §5). */
  async #resolveRanged(
    request: DeviceRequest,
    mode: DeviceMode,
    range: OsRange,
  ): Promise<ResolvedTarget> {
    if (request.model === undefined) return this.#resolveClass(request, mode, range);
    const entry = (await this.options.catalog.listCatalog(request.platform))[0];
    if (entry === undefined) throw new UnknownModelError(request.platform, request.model);
    const listed = findCatalogModel(entry, request.model);
    if (listed === undefined) throw new UnknownModelError(request.platform, request.model);
    return this.#rangedTarget(
      entry,
      listed,
      { kind: "model", model: listed },
      request,
      mode,
      range,
    );
  }

  /** The target for `model` once the request's runtime constraints are settled against `entry`. */
  #rangedTarget(
    entry: DriverCatalogEntry,
    model: string,
    target: DeviceRequirement["target"],
    request: DeviceRequest,
    mode: DeviceMode,
    range: OsRange | undefined,
  ): ResolvedTarget {
    const { class: _class, model: _model, ...rest } = request;
    return {
      exact: {
        ...rest,
        mode,
        model,
        ...(range === undefined ? {} : { osVersion: newestRuntime(entry, model, request, range) }),
      },
      requirement: {
        imageTag: request.imageTag,
        osVersion: requiredOs(entry, request, range),
        platform: request.platform,
        target,
      },
    };
  }

  /**
   * Resolves the request; when its runtime is missing, a download could supply it, and the
   * request may download, asks the installer for it and resolves once more. The installer skips
   * the install when, by the time this call reaches the front of its queue, `resolveSpec` no
   * longer fails with `RuntimeMissingError` -- another install made the runtime available.
   * Without `allowDownload` the first failure stands and the installer is never called.
   *
   * The installer's reports reach the requester as the `downloading` stage, through the queue
   * like every other stage. A report equal to the last one sent is skipped, so a percentage is
   * sent once per whole number.
   */
  async #resolveOrInstall(
    onProgress: (progress: DownloadingProgress) => void,
    driver: Driver,
    request: ExactDeviceRequest,
    options: LeaseRequestOptions,
  ): Promise<VirtualSpec> {
    try {
      return await driver.resolveSpec(request);
    } catch (error: unknown) {
      if (
        !(error instanceof RuntimeMissingError) ||
        !error.downloadable ||
        error.component === undefined ||
        options.allowDownload !== true
      ) {
        throw error;
      }
      const { component } = error;
      let lastSent: DownloadingProgress | undefined;
      await this.options.components.install({
        component,
        onProgress: (progress) => {
          const next = downloadingProgress(component, progress);
          if (lastSent !== undefined && sameDownloadingProgress(lastSent, next)) return;
          lastSent = next;
          onProgress(next);
        },
        platform: request.platform,
        requesterId: options.requesterId,
        stillNeeded: async () => {
          try {
            await driver.resolveSpec(request);
            return false;
          } catch (stillMissing: unknown) {
            return stillMissing instanceof RuntimeMissingError;
          }
        },
      });
      return driver.resolveSpec(request);
    }
  }

  /**
   * Resolves a request to the spec it would be granted a device of, with downloads off, or says
   * why there is none. A read: nothing is queued, reserved or installed. The warm pool resolves
   * its targets here, so a target and a request become a spec in one place.
   */
  async resolve(request: DeviceRequest): Promise<TargetResolution> {
    let driver: Driver;
    try {
      driver = this.options.drivers.get(request.platform);
    } catch (error: unknown) {
      return { message: asError(error).message, refusal: "no-driver" };
    }
    try {
      const { spec } = await this.resolveSpec(
        driver,
        request,
        { allowDownload: false, ownerId: "warm-pool", requesterId: "warm-pool" },
        () => undefined,
      );
      return { spec };
    } catch (error: unknown) {
      return { message: asError(error).message, refusal: refusalOf(error) };
    }
  }
}

/** why: the exact spec of a baseline's current version, which a request naming the baseline stands for. */
export function baselineSpec(current: CurrentBaseline): VirtualSpec {
  return {
    baseline: { name: current.name, version: current.version },
    model: current.model,
    osVersion: current.osVersion,
    physical: false,
    platform: current.platform,
    ...(current.mode === "slim" ? { mode: "slim" as const } : {}),
    ...(current.imageTag === undefined ? {} : { imageTag: current.imageTag }),
  };
}

/**
 * The spec a driver resolved, held to what the request asked. The image tag is the request's, or
 * none: a driver that returns another, or one the request did not name, would plan the device
 * into a pool the request did not ask for. Full is a guarantee (ADR 0007 §5): a slim spec is
 * accepted only for a slim request, so a driver that returns the wrong thing still cannot put a
 * full request on a slim device.
 */
function checkedSpec(resolved: VirtualSpec, request: DeviceRequest, mode: DeviceMode): VirtualSpec {
  if (resolved.imageTag !== request.imageTag) {
    throw new Error(
      `The ${request.platform} driver resolved image tag ${String(resolved.imageTag)} ` +
        `for a request naming ${String(request.imageTag)}`,
    );
  }
  return mode === "slim" ? resolved : fullSpec(resolved);
}

/** What a target's refusal is called: the kinds a pool can act on, and any other as is. */
function refusalOf(error: unknown): Exclude<TargetResolution, { spec: VirtualSpec }>["refusal"] {
  if (error instanceof RuntimeMissingError) return "runtime-missing";
  if (error instanceof UnknownModelError) return "unknown-model";
  return "unresolvable";
}

/** What `#resolveClass` settles on; an exact request has only `exact`. */
interface ResolvedTarget {
  readonly exact: ExactDeviceRequest;
  readonly requirement?: DeviceRequirement;
  readonly classOf?: (model: string) => DeviceClass | undefined;
}
