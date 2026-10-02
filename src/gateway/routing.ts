/**
 * Fleet routing (ADR 0005 §13, Decision 7; ADR 0009 §1): "a pure function over worker views, a
 * module with one entry point selected by `gateway.routing`". A policy is an ordered list of
 * stages (`routing/pipeline.ts` for how they combine, `routing/stages/` for each one), and the
 * registry below maps a policy name to its list. Stages are code: no config key lists or orders
 * them. Nothing outside this module decides how a worker is chosen.
 */
import { type RoutableRequest, type RoutingStage, runStages } from "./routing/pipeline.js";
import { canServe } from "./routing/stages/can-serve.js";
import { eligible } from "./routing/stages/eligible.js";
import { freeCapacity } from "./routing/stages/free-capacity.js";
import { takesRequests } from "./routing/stages/takes-requests.js";
import { warmHit } from "./routing/stages/warm-hit.js";
import type { WorkerView } from "./worker-registry.js";

export type { FilterStage, RoutableRequest, RoutingStage } from "./routing/pipeline.js";
export { matchRequest } from "./routing/request-match.js";
// `eligible` is exported for the conformance tests only; no registered policy lists it.
export { eligible, freeCapacity, warmHit };

export type RoutingReason = "warm-hit" | "free-capacity";

export interface RoutingDecision {
  readonly workerId: string;
  /** `warm-hit` when the deciding stage is `warm-hit`, `free-capacity` otherwise (ADR 0009 §8). */
  readonly reason: RoutingReason;
  /** The name of the stage that decided the pick. */
  readonly stage: string;
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

export function composeRoutingPolicy(stages: readonly RoutingStage[]): RoutingPolicy {
  return {
    select(request, workers) {
      const pick = runStages(stages, request, workers);
      if (pick === undefined) return undefined;
      return {
        reason: pick.stage === warmHit.name ? "warm-hit" : "free-capacity",
        stage: pick.stage,
        workerId: pick.workerId,
      };
    },
  };
}

/**
 * The registry: adding a policy means adding one entry here, nothing else.
 *
 * `warm-then-free` is ADR 0005 §13's v1 policy: keep the workers that take requests and whose
 * catalog can serve this one (ADR 0009 §2, §3), prefer a warm hit, otherwise the worker with the
 * most free running capacity, ties broken by ascending worker id.
 */
const routingPolicies = {
  "warm-then-free": [takesRequests, canServe, warmHit, freeCapacity],
} as const satisfies Record<string, readonly RoutingStage[]>;

export type RoutingPolicyName = keyof typeof routingPolicies;

export const routingPolicyNames = Object.keys(routingPolicies) as readonly RoutingPolicyName[];

export const DEFAULT_ROUTING_POLICY: RoutingPolicyName = "warm-then-free";

export function isRoutingPolicyName(value: unknown): value is RoutingPolicyName {
  return typeof value === "string" && value in routingPolicies;
}

export function createRoutingPolicy(name: RoutingPolicyName): RoutingPolicy {
  return composeRoutingPolicy(routingPolicies[name]);
}
