import type { FilterStage } from "../pipeline.js";

/** Keeps a worker whose own queue is empty (ADR 0009 §2, stage 4), warm device or not: a worker
 * with a local waiter refuses every `noWait` request (ADR 0005 requirement 12). A worker that has
 * not reported its queue depth is not known to be idle. */
export const idleQueue: FilterStage = {
  keeps(worker) {
    return worker.queueDepth === 0;
  },
  kind: "filter",
};
