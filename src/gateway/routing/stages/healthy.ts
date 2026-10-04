import type { FilterStage } from "../pipeline.js";

/** Keeps a worker whose health is `running` (ADR 0009 §2, stage 3). One that has not reported
 * its health is not known to be healthy. A worker dropped here is busy, not unable: its requests
 * wait. */
export const healthy: FilterStage = {
  keeps(worker) {
    return worker.health === "running";
  },
  kind: "filter",
};
