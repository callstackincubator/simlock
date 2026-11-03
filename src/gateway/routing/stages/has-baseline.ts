import type { FilterStage } from "../pipeline.js";
import { baselineEntry } from "../request-match.js";

// why: ADR 0061 §6: a request naming a baseline goes only to a worker that holds a fresh copy of it that fits; a request naming none passes.
export const hasBaseline: FilterStage = {
  appliesToPhysical: false,
  check(worker, request) {
    if (request.baseline === undefined) return undefined;
    if (baselineEntry(worker, request) === undefined) return { reason: "no-baseline" };
    return undefined;
  },
  kind: "filter",
};
