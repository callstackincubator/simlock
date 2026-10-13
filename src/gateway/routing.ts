import {
  type Assessment,
  assess,
  canServe,
  freeCapacity,
  freeSlot,
  hasCapabilities,
  healthy,
  idleQueue,
  ramBudget,
  type RoutableRequest,
  type RoutingStage,
  runStages,
  takesRequests,
  warmHit,
} from "./routing/index.js";
import type { WorkerView } from "./worker-registry.js";

export { matchRequest, type RoutableRequest } from "./routing/index.js";

export type RoutingReason = "warm-hit" | "free-capacity";

export interface RoutingDecision {
  readonly workerId: string;
  readonly reason: RoutingReason;
  readonly stage: string;
}

export interface RoutingPolicy {
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

const routingPolicies = {
  "warm-then-free": [
    takesRequests,
    hasCapabilities,
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
