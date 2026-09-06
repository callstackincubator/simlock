/**
 * The fleet, expressed in the same shapes one machine uses (ADR 0005 §20/§21): pure functions
 * over worker views, with no clock, no I/O and no state of their own, so what a gateway
 * reports is a function of what it currently knows and nothing else.
 */
import type { z } from "zod";

import { OPERATIONS, type Platform } from "../contract/index.js";
import type { WorkerView } from "./worker-registry.js";

type StatusOutput = z.infer<(typeof OPERATIONS)["status.get"]["output"]>;
type CatalogOutput = z.infer<(typeof OPERATIONS)["catalog.get"]["output"]>;
type StatusCapacity = StatusOutput["capacity"];
type PlatformCatalog = CatalogOutput["platforms"][number];

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
  readonly health: StatusOutput["health"];
  /** The gateway's fleet queue depth -- 0 until #118 gives it a queue. */
  readonly queueDepth: number;
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
    daemon: { mode: "gateway" },
    devices: views.flatMap((view) =>
      view.devices.map((device) => ({ ...device, workerId: view.id })),
    ),
    health: options.health,
    leases: views.flatMap((view) => view.leases.map((lease) => ({ ...lease, workerId: view.id }))),
    queueDepth: options.queueDepth,
    workers: [...views],
  };
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
  }
  return capacity;
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
 */
export function aggregateCatalog(views: readonly WorkerView[], platform?: Platform): CatalogOutput {
  const byPlatform = new Map<
    Platform,
    {
      readonly models: Map<string, string[]>;
      readonly runtimes: Map<string, string[]>;
      readonly defaults: Set<string | undefined>;
    }
  >();
  for (const view of views) {
    if (view.connection !== "connected") continue;
    for (const entry of view.catalog) {
      if (platform !== undefined && entry.platform !== platform) continue;
      const bucket = byPlatform.get(entry.platform) ?? {
        defaults: new Set<string | undefined>(),
        models: new Map<string, string[]>(),
        runtimes: new Map<string, string[]>(),
      };
      byPlatform.set(entry.platform, bucket);
      for (const model of entry.models) annotate(bucket.models, model, view.id);
      for (const runtime of entry.runtimes) annotate(bucket.runtimes, runtime, view.id);
      bucket.defaults.add(entry.defaultRuntime);
    }
  }

  const platforms: PlatformCatalog[] = [];
  for (const candidate of PLATFORMS) {
    const bucket = byPlatform.get(candidate);
    if (bucket === undefined) continue;
    const agreedDefault = bucket.defaults.size === 1 ? [...bucket.defaults][0] : undefined;
    platforms.push({
      models: [...bucket.models.keys()].sort(),
      modelWorkers: Object.fromEntries(bucket.models),
      platform: candidate,
      runtimes: [...bucket.runtimes.keys()].sort(),
      runtimeWorkers: Object.fromEntries(bucket.runtimes),
      ...(agreedDefault === undefined ? {} : { defaultRuntime: agreedDefault }),
    });
  }
  return { platforms };
}

function annotate(index: Map<string, string[]>, key: string, workerId: string): void {
  const workers = index.get(key) ?? [];
  if (!workers.includes(workerId)) workers.push(workerId);
  index.set(key, workers);
}
