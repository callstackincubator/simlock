import type { FilterStage } from "../pipeline.js";

export const idleQueue: FilterStage = {
  check(worker) {
    return worker.queueDepth === 0 ? undefined : { reason: "busy" };
  },
  appliesToPhysical: false,
  kind: "filter",
};
