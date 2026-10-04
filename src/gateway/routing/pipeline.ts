/**
 * The composition rule of ADR 0009 §1: a routing policy is an ordered list of stages, each a pure
 * function over worker views. This module knows how stages combine and nothing about what any
 * one stage checks -- that lives in `stages/`, one file per stage, so adding or removing a stage
 * touches that stage and the list in `routing.ts`, and no other stage.
 */
import type { Platform } from "../../contract/index.js";
import type { WorkerView } from "../worker-registry.js";

export interface RoutableRequest {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string;
  /** The image tag the request names, matched against the catalog's `images`; absent for none. */
  readonly imageTag?: string;
  /** The mode the request names; absent for none, which the worker answers with its default. */
  readonly mode?: "slim" | "full";
}

/** Drops every worker `keeps` answers `false` for. Never decides a pick on its own. */
export interface FilterStage {
  readonly kind: "filter";
  keeps(worker: WorkerView, request: RoutableRequest): boolean;
}

/**
 * Scores the remaining workers. When the best score is zero or less the stage abstains and
 * changes nothing; otherwise it decides and keeps only its best scorers, which may be all of
 * them. A settling rank ends the walk when it decides.
 */
export interface RankStage {
  readonly kind: "rank";
  readonly name: string;
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
