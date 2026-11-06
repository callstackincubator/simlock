import type { FilterStage } from "../pipeline.js";
import { catalogOf, withBaseline } from "../request-match.js";

// why: ADR 0066 §5: a request with `except` goes only to a worker that slims every excepted name and would give a slim device: the mode asked for (a baseline's, when it names one), else the worker's default. A request without `except` passes.
export const keepsExcept: FilterStage = {
  appliesToPhysical: false,
  check(worker, request) {
    if (request.except === undefined) return undefined;
    const entry = catalogOf(worker, request);
    const slims = entry?.slimCategories ?? [];
    const mode = withBaseline(worker, request).mode ?? entry?.defaultMode;
    return mode === "slim" && request.except.every((name) => slims.includes(name))
      ? undefined
      : { reason: "cannot-keep-except" };
  },
  kind: "filter",
};
