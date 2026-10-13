import { requestedClass } from "../../contract/index.js";
import {
  compareVersions,
  type OsConstraint,
  parseOsConstraint,
  satisfies,
} from "../../contract/os-range.js";
import {
  findCatalogModel,
  modelClass,
  pairedRuntimes,
  type DeviceClass,
  type DeviceRequirement,
  type FittableSpec,
  fits,
  fitsPhysical,
} from "../../core/index.js";
import type { WorkerView } from "../worker-registry.js";
import type { RoutableRequest } from "./pipeline.js";

export function matchRequest(worker: WorkerView, request: RoutableRequest): string | undefined {
  if (request.physical === true) return undefined;
  const catalog = catalogOf(worker, request);
  return catalog === undefined ? undefined : servingModel(catalog, request);
}

/** The first model of the entry that could serve the request: a pairing in the OS constraint. */
function servingModel(catalog: PlatformEntry, request: RoutableRequest): string | undefined {
  return candidates(catalog, request).find((model) =>
    pairedRuntimesOf(catalog, model, request).some((runtime) => osFits(runtime, request)),
  );
}

/**
 * What a ready device must satisfy, on this worker, to serve the request (ADR 0015 §6, §8): the
 * core's `fits` over a requirement built from the worker's own catalog. `undefined` when the
 * worker cannot serve the request. The mode is not part of it; `warm-hit` keeps that rule.
 */
export function deviceFit(
  worker: WorkerView,
  request: RoutableRequest,
): ((spec: FittableSpec) => boolean) | undefined {
  if (request.physical === true) return undefined;
  const catalog = catalogOf(worker, request);
  if (catalog === undefined) return undefined;
  const model = servingModel(catalog, request);
  if (model === undefined) return undefined;
  const requirement: DeviceRequirement = {
    imageTag: request.imageTag,
    osVersion: osRequirement(catalog, model, request),
    platform: request.platform,
    target:
      request.model === undefined
        ? { class: wantedClass(request), kind: "class" }
        : { kind: "model", model },
  };
  return (spec) => fits(requirement, spec, (listed) => modelClass(catalog, listed));
}

function osRequirement(
  catalog: PlatformEntry,
  model: string,
  request: RoutableRequest,
): DeviceRequirement["osVersion"] {
  const constraint = osConstraintOf(request);
  if (constraint !== undefined) return constraint;
  if (request.model === undefined) return { kind: "installed", versions: catalog.runtimes };
  const runtimes = pairedRuntimesOf(catalog, model, request);
  const newest = [...runtimes].sort(compareVersions).at(-1);
  return { kind: "installed", versions: newest === undefined ? [] : [newest] };
}

/**
 * The models that could serve the request, before pairing: the one an exact request names, or
 * every model of the requested class, in catalog order.
 */
function candidates(catalog: PlatformEntry, request: RoutableRequest): readonly string[] {
  if (request.model !== undefined) {
    const model = findCatalogModel(catalog, request.model);
    return model === undefined ? [] : [model];
  }
  const wanted = wantedClass(request);
  return catalog.models.filter((model) => modelClass(catalog, model) === wanted);
}

/** The class a request without a model means: the one it names, `phone` for neither. */
export function wantedClass(request: RoutableRequest): DeviceClass {
  return requestedClass({ class: request.class });
}

/** The OS constraint a request names, or `undefined` for none. A string the grammar refuses can
 * never reach here through the contract; it is read as exact, which no runtime matches. */
function osConstraintOf(request: RoutableRequest): OsConstraint | undefined {
  if (request.osVersion === undefined) return undefined;
  const parsed = parseOsConstraint(request.osVersion);
  return parsed.ok ? parsed.constraint : { kind: "exact", version: request.osVersion };
}

function osFits(runtime: string, request: RoutableRequest): boolean {
  const constraint = osConstraintOf(request);
  return constraint === undefined || satisfies(runtime, constraint);
}

/**
 * The runtimes the model pairs with. A request naming an image tag counts only the runtimes for
 * which the catalog's `images` lists an image of that tag.
 */
function pairedRuntimesOf(
  catalog: PlatformEntry,
  model: string,
  request: RoutableRequest,
): readonly string[] {
  const { imageTag } = request;
  const runtimes = pairedRuntimes(catalog, model);
  if (imageTag === undefined) return runtimes;
  return runtimes.filter((runtime) =>
    (catalog.images ?? []).some((image) => image.tag === imageTag && image.runtime === runtime),
  );
}

// why: the one gateway read of a worker's enrolled devices: `enrolled` is any state but `deleted`, `pickable` is `ready` and not last read not present (no read yet counts as present).
export function physicalMatch(
  worker: WorkerView,
  request: RoutableRequest,
  which: "enrolled" | "pickable",
): boolean {
  return (worker.devices ?? []).some((device) => {
    if (device.physical !== true || device.state === "deleted") return false;
    if (which === "pickable" && (device.state !== "ready" || device.presence?.present === false)) {
      return false;
    }
    const { spec } = device;
    return fitsPhysical(
      { spec, ...(device.class === undefined ? {} : { class: device.class }) },
      request,
    );
  });
}

/** Whether the worker's catalog has an entry for the request's platform. */
export function hasPlatform(worker: WorkerView, request: RoutableRequest): boolean {
  return catalogOf(worker, request) !== undefined;
}

/**
 * Whether the worker lists the requested model, by name or alias in any letter case, or, for a
 * class request, any model of the class, whatever runtimes it pairs with. The table of ADR 0009
 * §4 tells a missing model from a missing runtime with it.
 */
export function listsModel(worker: WorkerView, request: RoutableRequest): boolean {
  const catalog = catalogOf(worker, request);
  return catalog !== undefined && candidates(catalog, request).length > 0;
}

type PlatformEntry = NonNullable<WorkerView["catalog"]>[number];

function catalogOf(worker: WorkerView, request: RoutableRequest): PlatformEntry | undefined {
  return worker.catalog?.find((entry) => entry.platform === request.platform);
}
