/**
 * The one place the gateway decides whether a worker can serve a request (ADR 0009 §3). It reads
 * only the worker's catalog (ADR 0008 §1): the `can-serve` stage, the `warm-hit` stage, and the
 * forwarded `lease.request` all ask it, so the worker resolves exactly what the gateway matched.
 */
import type { WorkerView } from "../worker-registry.js";
import type { RoutableRequest } from "./pipeline.js";

/**
 * The worker's own name for the requested model, or `undefined` when it cannot serve the request.
 *
 * The model is the first entry of `models` whose name or `modelAliases` entry equals the requested
 * name, ignoring letter case. A named runtime must be among that model's `modelRuntimes`; an
 * unnamed one needs the list to be non-empty. Only installed runtimes are listed, so a request
 * that would need a download never matches. A request naming an image tag counts only the
 * runtimes for which the catalog's `images` lists an image of that tag.
 */
export function matchRequest(worker: WorkerView, request: RoutableRequest): string | undefined {
  const catalog = catalogOf(worker, request);
  if (catalog === undefined) return undefined;
  const model = findModel(catalog, request);
  if (model === undefined) return undefined;
  const runtimes = pairedRuntimes(catalog, model, request);
  const pairs =
    request.osVersion === undefined ? runtimes.length > 0 : runtimes.includes(request.osVersion);
  return pairs ? model : undefined;
}

/**
 * The runtime the worker would pick for the request, or `undefined` when the gateway cannot say
 * (ADR 0009 §6). The one the request names, when it names one. With none named: the catalog's
 * `defaultRuntime` when the model pairs with it, otherwise the model's only paired runtime.
 * A model with several paired runtimes and no paired default has no answer: the worker's choice
 * then depends on what it would boot, and the gateway compares no versions.
 */
export function pickedRuntime(worker: WorkerView, request: RoutableRequest): string | undefined {
  if (request.osVersion !== undefined) return request.osVersion;
  const catalog = catalogOf(worker, request);
  if (catalog === undefined) return undefined;
  const model = findModel(catalog, request);
  if (model === undefined) return undefined;
  const runtimes = pairedRuntimes(catalog, model, request);
  const paired = runtimes.find((runtime) => runtime === catalog.defaultRuntime);
  return paired ?? (runtimes.length === 1 ? runtimes[0] : undefined);
}

/**
 * The runtimes the model pairs with. A request naming an image tag counts only the runtimes for
 * which the catalog's `images` lists an image of that tag.
 */
function pairedRuntimes(
  catalog: PlatformEntry,
  model: string,
  request: RoutableRequest,
): readonly string[] {
  const { imageTag } = request;
  const runtimes = ownList(catalog.modelRuntimes, model);
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
 * Whether the worker lists the requested model, by name or alias in any letter case, whatever
 * runtimes it pairs with. The table of ADR 0009 §4 tells a missing model from a missing runtime
 * with it.
 */
export function listsModel(worker: WorkerView, request: RoutableRequest): boolean {
  const catalog = catalogOf(worker, request);
  return catalog !== undefined && findModel(catalog, request) !== undefined;
}

type PlatformEntry = WorkerView["catalog"][number];

function catalogOf(worker: WorkerView, request: RoutableRequest): PlatformEntry | undefined {
  return worker.catalog.find((entry) => entry.platform === request.platform);
}

/** The first entry of `models` whose name or alias is the requested name. */
function findModel(catalog: PlatformEntry, request: RoutableRequest): string | undefined {
  const wanted = fold(request.model);
  return catalog.models.find(
    (name) =>
      fold(name) === wanted ||
      ownList(catalog.modelAliases, name).some((alias) => fold(alias) === wanted),
  );
}

/** Locale-independent, so a gateway and a worker on different locales fold a name alike. */
function fold(name: string): string {
  return name.toLowerCase();
}

/** A record lookup that ignores inherited keys, so a model named `constructor` reads nothing. */
function ownList(
  record: Readonly<Record<string, readonly string[]>>,
  key: string,
): readonly string[] {
  return Object.hasOwn(record, key) ? (record[key] ?? []) : [];
}
