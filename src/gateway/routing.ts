/**
 * Fleet routing (ADR 0005 §13, Decision 7): "a pure function over worker views, a module with
 * one entry point selected by `gateway.routing`, the same shape as `CapacityStrategy`" (see
 * `src/core/capacity/strategy.ts`/`strategies/index.ts`, whose registry shape this mirrors -- a
 * `RoutingPolicyDefinition` per policy, a name-keyed registry, `createRoutingPolicy`). Unlike a
 * capacity strategy, a routing policy takes no per-policy config in v1: there is exactly one,
 * and picking it is the whole knob `gateway.routing` turns. Nothing outside this module decides
 * how a worker is chosen.
 */
import type { Platform } from "../contract/index.js";
import type { WorkerView } from "./worker-registry.js";

export interface RoutableRequest {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string;
  /**
   * The request's own flag, forwarded as-is: a gateway has no `downloads.policy` of its own to
   * fold it against (that config key is worker-only, ADR §2), so the clamp this module applies
   * is only ever the *worker's* declared policy (below), never a gateway-side one -- the worker
   * still applies its own `effectiveAllowDownload` when the forwarded `lease.request` lands.
   */
  readonly allowDownload: boolean;
}

export type RoutingReason = "warm-hit" | "free-capacity";

export interface RoutingDecision {
  readonly workerId: string;
  readonly reason: RoutingReason;
}

/**
 * Chooses a worker for one request, or names none. A pure function: everything it needs is in
 * `workers`, and it neither mutates a view nor remembers anything between calls -- two calls
 * given the same arguments always agree, which is what lets `FleetLeaseCoordinator` re-run it on
 * every dispatch pass with no extra bookkeeping.
 */
export interface RoutingPolicy {
  select(request: RoutableRequest, workers: readonly WorkerView[]): RoutingDecision | undefined;
}

/** The registry entry shape a routing policy is declared with -- mirrors
 * `CapacityStrategyDefinition`'s `{ name, create }` (capacity strategies also carry
 * `defaults`/`validator` for their own per-strategy config, which no routing policy needs in
 * v1). Exported for a future policy to implement against, even though `warm-then-free` below is
 * declared as a plain object literal of this shape rather than through a builder function --
 * with only one policy in one file, `defineCapacityStrategy`'s real job (letting each strategy's
 * own directory import a shared constructor) has nothing to do yet. */
// fallow-ignore-next-line unused-type -- public shape for a future policy to implement against (see the doc comment above); no second policy exists yet to import it.
export interface RoutingPolicyDefinition<Name extends string> {
  readonly name: Name;
  create(): RoutingPolicy;
}

/**
 * ADR §13's v1 policy, the only one that ships:
 *
 * 1. **Eligibility.** Drop a worker that is disconnected, incompatible, or drained; that lacks
 *    the requested platform in its catalog at all; that lacks the requested `model`; that lacks
 *    the requested `osVersion` (when the request named one) among its reported runtimes; or
 *    whose own `downloads.policy` would refuse the download filling either gap would need,
 *    unless the request did not ask to allow one anyway. A worker whose capacity has never been
 *    read (`capacity` absent -- never actually observed in practice once a view exists, but
 *    `WorkerView`'s own schema allows it) is dropped too: a policy that cannot see free capacity
 *    must not guess it has some (`safety.md`'s fail-closed instinct, applied to routing rather
 *    than destruction).
 * 2. **Warm hit.** Among the eligible, the first (by `views()`'s own ascending-id order, so two
 *    calls over an unchanged fleet agree) with an unleased `ready` device matching the request.
 * 3. **Free capacity.** Otherwise the eligible worker with the most free running capacity for
 *    the platform (`maxRunning - running - reserved`), ties broken the same way.
 *
 * No requester affinity, no label selectors, no per-worker exclusions -- v1 has none, and adding
 * one is a new policy option, not a change to this shape (ADR §13).
 */
const warmThenFree: RoutingPolicyDefinition<"warm-then-free"> = {
  name: "warm-then-free",
  create: () => ({
    select(request, workers) {
      const eligible = workers.filter((worker) => isEligible(worker, request));
      const warm = eligible.find((worker) => hasWarmDevice(worker, request));
      if (warm !== undefined) return { workerId: warm.id, reason: "warm-hit" };

      let best: { readonly workerId: string; readonly free: number } | undefined;
      for (const worker of eligible) {
        const free = freeCapacity(worker, request.platform);
        if (free <= 0) continue;
        if (best === undefined || free > best.free) best = { workerId: worker.id, free };
      }
      return best === undefined ? undefined : { workerId: best.workerId, reason: "free-capacity" };
    },
  }),
};

function isEligible(worker: WorkerView, request: RoutableRequest): boolean {
  if (worker.connection !== "connected") return false;
  if (worker.drained) return false;
  if (worker.capacity === undefined) return false;
  const catalog = worker.catalog.find((entry) => entry.platform === request.platform);
  if (catalog === undefined) return false;
  const hasModel = catalog.models.includes(request.model);
  const hasRuntime =
    request.osVersion === undefined || catalog.runtimes.includes(request.osVersion);
  if (hasModel && hasRuntime) return true;
  // Missing the model or the runtime: only still eligible if this request may fill the gap with
  // a download, and this worker's own policy would permit one (ADR §13: "a download is
  // considered only on a worker whose download policy allows it"). An unread policy is treated
  // as `"never"` -- the same fail-closed default `downloads.policy` itself defaults away from,
  // but the right one for a view this gateway could not actually confirm.
  return request.allowDownload && (worker.downloads?.policy ?? "never") !== "never";
}

function hasWarmDevice(worker: WorkerView, request: RoutableRequest): boolean {
  return worker.devices.some(
    (device) =>
      device.state === "ready" &&
      device.spec.platform === request.platform &&
      device.spec.model === request.model &&
      (request.osVersion === undefined || device.spec.osVersion === request.osVersion),
  );
}

function freeCapacity(worker: WorkerView, platform: Platform): number {
  const entry = worker.capacity?.[platform];
  if (entry === undefined) return 0;
  return Math.max(0, entry.maxRunning - entry.running - entry.reserved);
}

/** The registry: adding a policy means adding one here, nothing else. Not exported itself --
 * `createRoutingPolicy`/`isRoutingPolicyName`/`routingPolicyNames` below are its public surface,
 * which is all a caller outside this module needs (unlike `capacity/strategies/index.ts`'s own
 * registry object, which is exported because each strategy's own directory needs to see it;
 * with one policy in one file, nothing here does). */
const routingPolicies = {
  "warm-then-free": warmThenFree,
} as const;

export type RoutingPolicyName = keyof typeof routingPolicies;

export const routingPolicyNames = Object.keys(routingPolicies) as readonly RoutingPolicyName[];

export const DEFAULT_ROUTING_POLICY: RoutingPolicyName = "warm-then-free";

export function isRoutingPolicyName(value: unknown): value is RoutingPolicyName {
  return typeof value === "string" && value in routingPolicies;
}

export function createRoutingPolicy(name: RoutingPolicyName): RoutingPolicy {
  return routingPolicies[name].create();
}
