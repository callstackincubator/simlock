/**
 * Fleet routing (ADR 0005 §13, Decision 7; ADR 0009 §1): "a pure function over worker views, a
 * module with one entry point selected by `gateway.routing`". A policy is an ordered list of
 * stages (`routing/pipeline.ts` for how they combine, `routing/stages/` for each one), and the
 * registry below maps a policy name to its list. Stages are code: no config key lists or orders
 * them. Nothing outside this module decides how a worker is chosen.
 */
import { type RoutableRequest, type RoutingStage, runStages } from "./routing/pipeline.js";
import { type Assessment, assess } from "./routing/serviceability.js";
import { canServe } from "./routing/stages/can-serve.js";
import { freeCapacity } from "./routing/stages/free-capacity.js";
import { freeSlot } from "./routing/stages/free-slot.js";
import { healthy } from "./routing/stages/healthy.js";
import { idleQueue } from "./routing/stages/idle-queue.js";
import { ramBudget } from "./routing/stages/ram-budget.js";
import { takesRequests } from "./routing/stages/takes-requests.js";
import { warmHit } from "./routing/stages/warm-hit.js";
import type { WorkerView } from "./worker-registry.js";

export type { RoutableRequest } from "./routing/pipeline.js";
export { matchRequest } from "./routing/request-match.js";

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
  /**
   * Whether the request can be served at all, and if not, why (ADR 0009 §4). Asked before
   * `select`, over every view: a worker that is merely busy still makes a request servable.
   */
  assess(request: RoutableRequest, workers: readonly WorkerView[]): Assessment;
  select(request: RoutableRequest, workers: readonly WorkerView[]): RoutingDecision | undefined;
}

function composeRoutingPolicy(stages: readonly RoutingStage[]): RoutingPolicy {
  return {
    assess,
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
 * The registry: adding a policy means adding one entry here, and its name to the lists
 * `core/config.ts` and the contract's config schema accept.
 *
 * `warm-then-free` is ADR 0005 §13's v1 policy: keep the workers that take requests and whose
 * catalog can serve this one (ADR 0009 §2, §3), drop the ones that are unhealthy or have waiters
 * of their own, prefer a warm hit, otherwise keep those with a free running slot, prefer one under
 * its RAM budget, then the one with the most free running capacity, ties broken by ascending
 * worker id.
 */
const routingPolicies = {
  "warm-then-free": [
    takesRequests,
    canServe,
    healthy,
    idleQueue,
    warmHit,
    freeSlot,
    ramBudget,
    freeCapacity,
  ],
} as const satisfies Record<string, readonly RoutingStage[]>;

export type RoutingPolicyName = keyof typeof routingPolicies;

export function createRoutingPolicy(name: RoutingPolicyName): RoutingPolicy {
  return composeRoutingPolicy(routingPolicies[name]);
}
