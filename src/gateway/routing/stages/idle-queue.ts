import type { FilterStage } from "../pipeline.js";

/** `queueDepth` counts the virtual line, so a worker with only physical waiters still takes a virtual request. */
export const idleQueue: FilterStage = {
  keeps(worker) {
    return worker.queueDepth === 0;
  },
  appliesToPhysical: false,
  kind: "filter",
};
