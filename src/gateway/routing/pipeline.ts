import type { Platform } from "../../contract/index.js";
import type { DeviceClass } from "../../core/index.js";
import type { WorkerView } from "../worker-registry.js";

export interface RoutableRequest {
  readonly platform: Platform;
  readonly model?: string;
  readonly class?: DeviceClass;
  readonly osVersion?: string;
  readonly imageTag?: string;
  readonly mode?: "slim" | "full";
  readonly physical?: boolean;
  readonly requires?: readonly string[];
}

export type CapacityReason =
  | "device-limit"
  | "ram-budget"
  | "global-running-limit"
  | "platform-running-limit";

export type WorkerReasonCode =
  | "disconnected"
  | "incompatible"
  | "not-ready"
  | "unhealthy"
  | "drained"
  | "busy"
  | "no-driver"
  | "unknown-model"
  | "runtime-missing"
  | "capability-missing"
  | "full"
  | "no-free-physical"
  | "not-chosen";
export interface WorkerReason {
  readonly reason: WorkerReasonCode;
  readonly capacityReason?: CapacityReason;
}

export interface FilterStage {
  readonly kind: "filter";
  readonly appliesToPhysical: boolean;
  check(worker: WorkerView, request: RoutableRequest): WorkerReason | undefined;
}

export interface RankStage {
  readonly kind: "rank";
  readonly name: string;
  readonly appliesToPhysical: boolean;
  readonly settles: boolean;
  score(worker: WorkerView, request: RoutableRequest): number;
  zeroReason?(worker: WorkerView, request: RoutableRequest): WorkerReason | undefined;
}

export type RoutingStage = FilterStage | RankStage;

export interface StagePick {
  readonly workerId: string;
  /** The last rank that removed a worker or, when none removed any, the last rank that decided. */
  readonly stage: string;
}

/**
 * Walks `stages` over `workers` in ascending worker id (the same order `WorkerRegistry#views`
 * returns). The pick is the first remaining worker, provided at least one rank decided; with
 * none, there is no pick.
 */
export function runStages(
  stages: readonly RoutingStage[],
  request: RoutableRequest,
  workers: readonly WorkerView[],
): StagePick | undefined {
  let remaining = [...workers].sort((left, right) => left.id.localeCompare(right.id));
  let lastDecided: string | undefined;
  let lastRemoved: string | undefined;

  for (const stage of stages) {
    // why: the one place a stage is skipped for a physical request.
    if (request.physical === true && !stage.appliesToPhysical) continue;
    if (stage.kind === "filter") {
      remaining = remaining.filter((worker) => stage.check(worker, request) === undefined);
      continue;
    }
    const scored = remaining.map((worker) => ({ score: stage.score(worker, request), worker }));
    const best = Math.max(...scored.map((entry) => entry.score));
    if (!(best > 0)) continue;
    const kept = scored.filter((entry) => entry.score === best).map((entry) => entry.worker);
    lastDecided = stage.name;
    if (kept.length < remaining.length) lastRemoved = stage.name;
    remaining = kept;
    if (stage.settles) break;
  }

  const first = remaining[0];
  if (lastDecided === undefined || first === undefined) return undefined;
  return { stage: lastRemoved ?? lastDecided, workerId: first.id };
}

export interface Explanation {
  readonly workerId: string;
  readonly reason?: WorkerReason;
}

// why: reasons only, in ascending worker id; it picks no one, `runStages` does.
export function explainStages(
  stages: readonly RoutingStage[],
  request: RoutableRequest,
  workers: readonly WorkerView[],
): readonly Explanation[] {
  const applicable = stages.filter((stage) => request.physical !== true || stage.appliesToPhysical);
  return [...workers]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((worker) => {
      const reason = firstReason(applicable, worker, request);
      return reason === undefined ? { workerId: worker.id } : { reason, workerId: worker.id };
    });
}

function firstReason(
  stages: readonly RoutingStage[],
  worker: WorkerView,
  request: RoutableRequest,
): WorkerReason | undefined {
  for (const stage of stages) {
    if (stage.kind !== "filter") continue;
    const reason = stage.check(worker, request);
    if (reason !== undefined) return reason;
  }
  for (const stage of stages) {
    if (stage.kind !== "rank" || stage.score(worker, request) !== 0) continue;
    const reason = stage.zeroReason?.(worker, request);
    if (reason !== undefined) return reason;
  }
  return undefined;
}
