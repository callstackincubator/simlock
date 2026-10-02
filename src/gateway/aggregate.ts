/**
 * The fleet, expressed in the same shapes one machine uses (ADR 0005 §20/§21): pure functions
 * over worker views, with no clock, no I/O and no state of their own, so what a gateway
 * reports is a function of what it currently knows and nothing else.
 */
import type { z } from "zod";

import {
  CATALOG_LIST_LIMITS,
  INSTALL_LIST_LIMIT,
  OPERATIONS,
  type Platform,
} from "../contract/index.js";
import type { FleetLeaseIndex } from "./lease-index.js";
import type { WorkerView } from "./worker-registry.js";

type StatusOutput = z.infer<(typeof OPERATIONS)["status.get"]["output"]>;
type CatalogOutput = z.infer<(typeof OPERATIONS)["catalog.get"]["output"]>;
type StatusCapacity = StatusOutput["capacity"];
type PlatformCatalog = CatalogOutput["platforms"][number];
type CatalogImage = NonNullable<PlatformCatalog["images"]>[number];

const PLATFORMS: readonly Platform[] = ["ios", "android"];

const EMPTY_PLATFORM_CAPACITY = {
  limit: 0,
  maxRunning: 0,
  overLimit: false,
  reserved: 0,
  running: 0,
  used: 0,
  warm: 0,
};

const EMPTY_GLOBAL_CAPACITY = {
  maxRunning: 0,
  overLimit: false,
  reserved: 0,
  running: 0,
  warm: 0,
};

export interface AggregateStatusOptions {
  /** The *gateway's* own health, not any worker's. */
  readonly health: StatusOutput["daemon"]["health"];
  /** The *gateway's* own machine. Each worker's is on its view. */
  readonly host: StatusOutput["host"];
  /** The gateway's fleet queue depth -- 0 until #118 gives it a queue. */
  readonly queueDepth: number;
  /**
   * #118: rewrites each view's leases to gateway-facing form (its own id, fleet-level
   * `requesterId`, `worker`) for the ones this gateway actually issued -- see
   * `FleetLeaseIndex#project`. A caller's own `status.get`-derived lease id must round-trip into
   * `lease.renew` the same way `lease.list`'s does; leaving this out (as every caller before
   * #118 did, and every `aggregate.test.ts` case that still omits it) reports each worker's raw
   * lease record instead, which is still correct for a worker's own local lease -- it only stops
   * being correct for one the gateway granted.
   */
  readonly leaseIndex?: Pick<FleetLeaseIndex, "project">;
}

/**
 * ADR 0005 §20: "the same shape a worker returns -- capacity summed across connected workers,
 * all leases and devices, the gateway queue's depth -- plus an additive `workers` array".
 *
 * Two deliberate asymmetries in what is included:
 *
 * - **Capacity sums connected workers only.** An unreachable machine's last-known free slots
 *   are not capacity; reporting them would tell an operator the fleet can take work it cannot.
 * - **Devices and leases include every view, connected or not.** A lease on a machine that
 *   dropped off is precisely what an operator needs to see (it is still holding a device, and
 *   its worker's TTL is still counting down), so hiding it would be the more misleading
 *   choice. Each entry carries `workerId`, and that worker's view says whether it is live.
 */
export function aggregateStatus(
  views: readonly WorkerView[],
  options: AggregateStatusOptions,
): StatusOutput {
  return {
    capacity: sumCapacity(views.filter((view) => view.connection === "connected")),
    daemon: { health: options.health, mode: "gateway" },
    host: options.host,
    installs: fleetInstalls(views),
    devices: views.flatMap((view) =>
      view.devices.map((device) => ({ ...device, workerId: view.id })),
    ),
    leases: views.flatMap((view) =>
      view.leases.map((lease) =>
        options.leaseIndex === undefined
          ? { ...lease, workerId: view.id }
          : options.leaseIndex.project(lease, view.id, view.label),
      ),
    ),
    queueDepth: options.queueDepth,
    workers: [...views],
  };
}

/**
 * ADR 0010 §3/§7: the workers' installs, each naming its worker. Only a connected worker's view
 * lists any: `WorkerRegistry` drops them when a worker disconnects or turns incompatible. The
 * fleet list has the same bound as one worker's, so it keeps the oldest.
 */
function fleetInstalls(views: readonly WorkerView[]): NonNullable<StatusOutput["installs"]> {
  return views
    .flatMap((view) => (view.installs ?? []).map((install) => ({ ...install, workerId: view.id })))
    .sort((a, b) => a.since - b.since)
    .slice(0, INSTALL_LIST_LIMIT);
}

function sumCapacity(views: readonly WorkerView[]): StatusCapacity {
  const capacity: StatusCapacity = {
    android: { ...EMPTY_PLATFORM_CAPACITY },
    global: { ...EMPTY_GLOBAL_CAPACITY },
    ios: { ...EMPTY_PLATFORM_CAPACITY },
  };
  for (const view of views) {
    const reported = view.capacity;
    if (reported === undefined) continue;
    for (const platform of PLATFORMS) {
      capacity[platform] = {
        limit: capacity[platform].limit + reported[platform].limit,
        maxRunning: capacity[platform].maxRunning + reported[platform].maxRunning,
        // True if *any* worker is over its own limit: the fleet has a machine in trouble, and
        // summing booleans any other way would hide it behind the ones that are fine.
        overLimit: capacity[platform].overLimit || reported[platform].overLimit,
        reserved: capacity[platform].reserved + reported[platform].reserved,
        running: capacity[platform].running + reported[platform].running,
        used: capacity[platform].used + reported[platform].used,
        warm: capacity[platform].warm + reported[platform].warm,
      };
    }
    capacity.global = {
      maxRunning: capacity.global.maxRunning + reported.global.maxRunning,
      overLimit: capacity.global.overLimit || reported.global.overLimit,
      reserved: capacity.global.reserved + reported.global.reserved,
      running: capacity.global.running + reported.global.running,
      warm: capacity.global.warm + reported.global.warm,
    };
    const ramBudget = sumRamBudget(capacity.ramBudget, reported.ramBudget);
    if (ramBudget !== undefined) capacity.ramBudget = ramBudget;
  }
  return capacity;
}

type RamBudget = NonNullable<StatusCapacity["ramBudget"]>;

/** A worker under `fixed` reports no budget and adds nothing; none reporting leaves it absent. */
function sumRamBudget(
  sum: RamBudget | undefined,
  reported: RamBudget | undefined,
): RamBudget | undefined {
  if (reported === undefined) return sum;
  if (sum === undefined) return { ...reported };
  return {
    limitBytes: sum.limitBytes + reported.limitBytes,
    // Over when any worker is, for the same reason as `overLimit` above.
    overLimit: sum.overLimit || reported.overLimit,
    usedBytes: sum.usedBytes + reported.usedBytes,
  };
}

/**
 * ADR 0005 §21: the union of the connected workers' catalogs, each model and runtime annotated
 * with the workers that have it.
 *
 * Connected workers only: a catalog answers "what can this fleet give me", and a machine whose
 * uplink is closed can give nothing. `incompatible` workers are excluded for the same reason
 * (the gateway never even read their catalog). A drained worker *is* included -- draining stops
 * new dispatches, but it is a temporary operator state, and a catalog that shrank while a
 * machine was drained would read as models having been uninstalled.
 *
 * `defaultRuntime` survives only when every worker offering that platform names the same one.
 * A fleet whose machines default differently has no single default, and picking one at random
 * would make `simlock lease` non-deterministic across an unchanged fleet.
 *
 * `modelRuntimes` pairs a model with a runtime only when one worker pairs them itself (ADR 0008
 * §4). It is never built from the fleet's `models` and `runtimes`: one worker having a model and
 * another having a runtime does not make the pair leasable anywhere.
 *
 * `customModels` lists a model when any worker that lists it marks it custom, and is absent when
 * none does. `modelAliases` is the union per model, deduplicated ignoring case. `images` is the union by
 * runtime, tag, and ABI, and is absent when no worker reports the field at all. Each worker's
 * lists fit the contract's bounds but their union may not, so both are cut to those bounds after
 * sorting: an answer its own clients refuse would lose the whole catalog, not a tail of it.
 */
export function aggregateCatalog(views: readonly WorkerView[], platform?: Platform): CatalogOutput {
  const byPlatform = indexCatalogs(views, platform);
  const platforms: PlatformCatalog[] = [];
  // Iterated over `PLATFORMS` rather than the map's own keys so the answer is ordered the same
  // way a worker's own `catalog.get` orders it, whichever worker happened to connect first.
  for (const candidate of PLATFORMS) {
    const bucket = byPlatform.get(candidate);
    if (bucket !== undefined) platforms.push(renderPlatform(candidate, bucket));
  }
  return { platforms };
}

/** One platform's models and runtimes, each mapped to the workers that reported it, plus every
 * `defaultRuntime` seen for it -- which is what makes disagreement visible to `renderPlatform`
 * rather than resolved silently at insertion. */
interface CatalogBucket {
  readonly models: Map<string, string[]>;
  readonly runtimes: Map<string, string[]>;
  /** Each model's runtimes, as the union of what each worker pairs it with itself. */
  readonly modelRuntimes: Map<string, Set<string>>;
  /** Each model's other names, keyed by the name lower-cased so a spelling is listed once. */
  readonly modelAliases: Map<string, Map<string, string>>;
  /** Every image reported, keyed by runtime, tag, and ABI; `undefined` until one worker has the field. */
  images: Map<string, CatalogImage> | undefined;
  /** Models any worker that lists them marks custom. */
  readonly customModels: Set<string>;
  readonly defaults: Set<string | undefined>;
}

function indexCatalogs(
  views: readonly WorkerView[],
  platform: Platform | undefined,
): Map<Platform, CatalogBucket> {
  const byPlatform = new Map<Platform, CatalogBucket>();
  for (const view of views) {
    if (view.connection !== "connected") continue;
    for (const entry of view.catalog) {
      if (platform === undefined || entry.platform === platform) {
        addCatalogEntry(byPlatform, entry, view.id);
      }
    }
  }
  return byPlatform;
}

/** Folds one worker's catalog entry for one platform into that platform's bucket. */
function addCatalogEntry(
  byPlatform: Map<Platform, CatalogBucket>,
  entry: PlatformCatalog,
  workerId: string,
): void {
  const bucket = byPlatform.get(entry.platform) ?? {
    customModels: new Set<string>(),
    defaults: new Set<string | undefined>(),
    images: undefined,
    modelAliases: new Map<string, Map<string, string>>(),
    modelRuntimes: new Map<string, Set<string>>(),
    models: new Map<string, string[]>(),
    runtimes: new Map<string, string[]>(),
  };
  byPlatform.set(entry.platform, bucket);
  for (const model of entry.models) annotate(bucket.models, model, workerId);
  for (const runtime of entry.runtimes) annotate(bucket.runtimes, runtime, workerId);
  for (const model of entry.models) addPairings(bucket.modelRuntimes, entry, model);
  for (const model of entry.models) addAliases(bucket.modelAliases, entry, model);
  addCustomModels(bucket.customModels, entry);
  if (entry.images !== undefined) bucket.images = addImages(bucket.images, entry, entry.images);
  bucket.defaults.add(entry.defaultRuntime);
}

/** Folds one worker's other names for `model` into the fleet's, once per spelling ignoring case. */
function addAliases(
  index: Map<string, Map<string, string>>,
  entry: PlatformCatalog,
  model: string,
): void {
  const own = Object.hasOwn(entry.modelAliases, model) ? entry.modelAliases[model] : undefined;
  const aliases = index.get(model) ?? new Map<string, string>();
  for (const alias of own ?? []) {
    const key = alias.toLocaleLowerCase();
    // The model's own name is not another name for it.
    if (key !== model.toLocaleLowerCase() && !aliases.has(key)) aliases.set(key, alias);
  }
  if (aliases.size > 0) index.set(model, aliases);
}

/** Folds one worker's custom models into the fleet's; a name the worker does not list itself is dropped. */
function addCustomModels(index: Set<string>, entry: PlatformCatalog): void {
  for (const model of entry.customModels ?? []) {
    if (entry.models.includes(model)) index.add(model);
  }
}

/** Folds one worker's images into the fleet's; one whose runtime the worker does not list is dropped. */
function addImages(
  index: Map<string, CatalogImage> | undefined,
  entry: PlatformCatalog,
  images: readonly CatalogImage[],
): Map<string, CatalogImage> {
  const merged = index ?? new Map<string, CatalogImage>();
  for (const image of images) {
    if (!entry.runtimes.includes(image.runtime)) continue;
    const { abi, runtime, tag } = image;
    merged.set(JSON.stringify([runtime, tag, abi]), { abi, runtime, tag });
  }
  return merged;
}

/** Folds one worker's own pairings for `model` into the fleet's. */
function addPairings(index: Map<string, Set<string>>, entry: PlatformCatalog, model: string): void {
  const paired = index.get(model) ?? new Set<string>();
  // Own keys only: a model a worker names `constructor` must not read Object.prototype's.
  const own = Object.hasOwn(entry.modelRuntimes, model) ? entry.modelRuntimes[model] : undefined;
  // A pairing is the worker's claim; one with a runtime it does not list itself is dropped.
  for (const runtime of own ?? []) if (entry.runtimes.includes(runtime)) paired.add(runtime);
  index.set(model, paired);
}

function renderPlatform(platform: Platform, bucket: CatalogBucket): PlatformCatalog {
  const agreedDefault = bucket.defaults.size === 1 ? [...bucket.defaults][0] : undefined;
  const runtimes = [...bucket.runtimes.keys()].sort();
  return {
    ...(bucket.customModels.size === 0
      ? {}
      : {
          customModels: [...bucket.customModels].sort().slice(0, CATALOG_LIST_LIMITS.customModels),
        }),
    ...(bucket.images === undefined
      ? {}
      : {
          images: [...bucket.images]
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .slice(0, CATALOG_LIST_LIMITS.images)
            .map(([, image]) => image),
        }),
    modelAliases: Object.fromEntries(
      [...bucket.modelAliases]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, CATALOG_LIST_LIMITS.aliasedModels)
        .map(([model, aliases]) => [
          model,
          [...aliases.values()].sort().slice(0, CATALOG_LIST_LIMITS.aliasesPerModel),
        ]),
    ),
    modelRuntimes: Object.fromEntries(
      [...bucket.modelRuntimes].map(([model, paired]) => [model, [...paired].sort()]),
    ),
    models: [...bucket.models.keys()].sort(),
    modelWorkers: Object.fromEntries(bucket.models),
    platform,
    runtimes,
    runtimeWorkers: Object.fromEntries(bucket.runtimes),
    ...(agreedDefault === undefined ? {} : { defaultRuntime: agreedDefault }),
  };
}

function annotate(index: Map<string, string[]>, key: string, workerId: string): void {
  const workers = index.get(key) ?? [];
  if (!workers.includes(workerId)) workers.push(workerId);
  index.set(key, workers);
}
