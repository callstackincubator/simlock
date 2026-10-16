import { matchRequest, physicalMatch } from "../request-match.js";
import type { FilterStage } from "../pipeline.js";

export const canServe: FilterStage = {
  keeps(worker, request) {
    if (request.physical === true) return physicalMatch(worker, request, "enrolled");
    return matchRequest(worker, request) !== undefined;
  },
  appliesToPhysical: true,
  kind: "filter",
};
