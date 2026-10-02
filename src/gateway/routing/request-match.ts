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
 * that would need a download never matches.
 */
export function matchRequest(worker: WorkerView, request: RoutableRequest): string | undefined {
  const catalog = worker.catalog.find((entry) => entry.platform === request.platform);
  if (catalog === undefined) return undefined;
  const wanted = fold(request.model);
  const model = catalog.models.find(
    (name) =>
      fold(name) === wanted ||
      ownList(catalog.modelAliases, name).some((alias) => fold(alias) === wanted),
  );
  if (model === undefined) return undefined;
  const runtimes = ownList(catalog.modelRuntimes, model);
  const pairs =
    request.osVersion === undefined ? runtimes.length > 0 : runtimes.includes(request.osVersion);
  return pairs ? model : undefined;
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
