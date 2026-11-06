import type { FilterStage } from "../pipeline.js";
import { catalogOf } from "../request-match.js";

// why: ADR 0066 §5: a request with `except` goes only to a worker that slims every excepted name; a request without one passes.
export const keepsExcept: FilterStage = {
  appliesToPhysical: false,
  check(worker, request) {
    if (request.except === undefined) return undefined;
    const slims = catalogOf(worker, request)?.slimCategories ?? [];
    return request.except.every((name) => slims.includes(name))
      ? undefined
      : { reason: "cannot-keep-except" };
  },
  kind: "filter",
};
