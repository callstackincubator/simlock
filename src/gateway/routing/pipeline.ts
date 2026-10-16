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

export interface FilterStage {
  readonly kind: "filter";
  readonly appliesToPhysical: boolean;
  keeps(worker: WorkerView, request: RoutableRequest): boolean;
}

export interface RankStage {
  readonly kind: "rank";
  readonly name: string;
  readonly appliesToPhysical: boolean;
  readonly settles: boolean;
  score(worker: WorkerView, request: RoutableRequest): number;
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
      remaining = remaining.filter((worker) => stage.keeps(worker, request));
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
