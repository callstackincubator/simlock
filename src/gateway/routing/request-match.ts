/**
 * The one place the gateway decides whether a worker can serve a request (ADR 0009 §3). It reads
 * only the worker's catalog (ADR 0008 §1): the `can-serve` stage, the `warm-hit` stage, and the
 * forwarded `lease.request` all ask it, so the worker resolves exactly what the gateway matched.
 */
import { requestedClass } from "../../contract/index.js";
import { type OsConstraint, parseOsConstraint, satisfies } from "../../contract/os-range.js";
import { findCatalogModel, modelClass, pairedRuntimes } from "../../core/catalog-match.js";
import type { DeviceClass, DeviceRequirement } from "../../core/domain.js";
import type { WorkerView } from "../worker-registry.js";
import type { RoutableRequest } from "./pipeline.js";

/**
 * The worker's own name for a model that can serve the request, or `undefined` when none can.
 *
 * An exact request: the first entry of `models` whose name or `modelAliases` entry equals the
 * requested name, ignoring letter case. A class request (the class `requestedClass` gives, `phone`
 * for neither): the first model the catalog classes as that class. Either way the model must pair
 * with an installed runtime that satisfies the request's OS constraint (`os-range`); with none
 * named, one runtime is enough. Only installed runtimes are listed, so a request that would need
 * a download never matches. A request naming an image tag counts only the runtimes for which the
 * catalog's `images` lists an image of that tag.
 */
export function matchRequest(worker: WorkerView, request: RoutableRequest): string | undefined {
  const catalog = catalogOf(worker, request);
  if (catalog === undefined) return undefined;
  return candidates(catalog, request).find((model) =>
    pairedRuntimesOf(catalog, model, request).some((runtime) => osFits(runtime, request)),
  );
}

/**
 * The runtime the worker would pick for an exact request, or `undefined` when the gateway cannot
 * say (ADR 0009 §6). The one the request names, when it names an exact version. With none named:
 * the catalog's `defaultRuntime` when the model pairs with it, otherwise the model's only paired
 * runtime. A model with several paired runtimes and no paired default has no answer: the worker's
 * choice then depends on what it would boot, and the gateway compares no versions.
 */
export function pickedRuntime(worker: WorkerView, request: RoutableRequest): string | undefined {
  const constraint = osConstraintOf(request);
  if (constraint?.kind === "exact") return constraint.version;
  if (constraint !== undefined) return undefined;
  const catalog = catalogOf(worker, request);
  if (catalog === undefined || request.model === undefined) return undefined;
  const model = findCatalogModel(catalog, request.model);
  if (model === undefined) return undefined;
  const runtimes = pairedRuntimesOf(catalog, model, request);
  const paired = runtimes.find((runtime) => runtime === catalog.defaultRuntime);
  return paired ?? (runtimes.length === 1 ? runtimes[0] : undefined);
}

/**
 * The requirement a ready device must `fit` to serve the request on this worker (ADR 0015 §6), or
 * `undefined` when the gateway cannot say which runtime the worker would pick. A class request
 * with no OS accepts any installed runtime; an exact one with no OS, the runtime the worker would
 * pick. The mode is not part of it.
 */
export function requirementOf(
  worker: WorkerView,
  request: RoutableRequest,
): DeviceRequirement | undefined {
  const catalog = catalogOf(worker, request);
  const model = matchRequest(worker, request);
  if (catalog === undefined || model === undefined) return undefined;
  const target: DeviceRequirement["target"] =
    request.model === undefined
      ? { class: wantedClass(request), kind: "class" }
      : { kind: "model", model };
  const constraint = osConstraintOf(request);
  let osVersion: DeviceRequirement["osVersion"] | undefined;
  if (constraint !== undefined) osVersion = constraint;
  else if (request.model === undefined)
    osVersion = { kind: "installed", versions: catalog.runtimes };
  else {
    const picked = pickedRuntime(worker, request);
    osVersion = picked === undefined ? undefined : { kind: "exact", version: picked };
  }
  if (osVersion === undefined) return undefined;
  return { imageTag: request.imageTag, osVersion, platform: request.platform, target };
}

/** The class a model is listed under on this worker, for `fits`. */
export function classOfModel(
  worker: WorkerView,
  request: RoutableRequest,
): (model: string) => DeviceClass | undefined {
  const catalog = catalogOf(worker, request);
  return (model) => (catalog === undefined ? undefined : modelClass(catalog, model));
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

type PlatformEntry = WorkerView["catalog"][number];

function catalogOf(worker: WorkerView, request: RoutableRequest): PlatformEntry | undefined {
  return worker.catalog.find((entry) => entry.platform === request.platform);
}
