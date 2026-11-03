import type { FilterStage } from "../pipeline.js";
import { baselineEntry, baselineMismatchOf } from "../request-match.js";

// why: ADR 0061 §6: a request naming a baseline goes only to a worker that holds a fresh copy of it that fits; a request naming none passes. The reasons run in the order the fast-fail table checks them: no copy, a copy that differs, a stale copy.
export const hasBaseline: FilterStage = {
  appliesToPhysical: false,
  check(worker, request) {
    if (request.baseline === undefined) return undefined;
    const entry = baselineEntry(worker, request);
    if (entry === undefined) return { reason: "no-baseline" };
    if (baselineMismatchOf(worker, request) !== undefined) return { reason: "baseline-mismatch" };
    if (entry.staleReason !== undefined) return { reason: "baseline-stale" };
    return undefined;
  },
  kind: "filter",
};
