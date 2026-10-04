import type { FilterStage } from "../pipeline.js";

/** Keeps a worker with free running capacity above zero, for the request's platform and
 * globally (ADR 0009 §2, stage 6). Free is `maxRunning - running - reserved`. */
export const freeSlot: FilterStage = {
  keeps(worker, request) {
    const capacity = worker.capacity;
    if (capacity === undefined) return false;
    const platform = capacity[request.platform];
    const global = capacity.global;
    return (
      platform.maxRunning - platform.running - platform.reserved > 0 &&
      global.maxRunning - global.running - global.reserved > 0
    );
  },
  kind: "filter",
  name: "free-slot",
};
