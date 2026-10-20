import { hasPlatform, listsModel, matchRequest, physicalMatch } from "../request-match.js";
import type { FilterStage } from "../pipeline.js";

export const canServe: FilterStage = {
  check(worker, request) {
    const physical = request.physical === true;
    if (physical ? physicalMatch(worker, request, "enrolled") : matchRequest(worker, request)) {
      return undefined;
    }
    if (!hasPlatform(worker, request)) return { reason: "no-driver" };
    if (physical || !listsModel(worker, request)) return { reason: "unknown-model" };
    return { reason: "runtime-missing" };
  },
  appliesToPhysical: true,
  kind: "filter",
};
