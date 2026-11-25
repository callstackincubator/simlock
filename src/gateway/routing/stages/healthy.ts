import type { FilterStage } from "../pipeline.js";

export const healthy: FilterStage = {
  check(worker) {
    return worker.health === "running" ? undefined : { reason: "unhealthy" };
  },
  appliesToPhysical: true,
  kind: "filter",
};
