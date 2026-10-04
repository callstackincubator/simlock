import type { FilterStage } from "../pipeline.js";
import { freeOrEvictableRunning } from "./free-running.js";

/** Keeps a worker with a free running slot above zero, for the request's platform and globally
 * (ADR 0009 §2, stage 6). A running device that is not leased counts as free: the planner evicts
 * it for a request no warm device fits, so passing the worker over would only make the request
 * wait for the idle shutdown. A slot held by a lease or a reservation is taken. */
export const freeSlot: FilterStage = {
  keeps(worker, request) {
    const capacity = worker.capacity;
    if (capacity === undefined) return false;
    const platform = capacity[request.platform];
    const global = capacity.global;
    return freeOrEvictableRunning(platform) > 0 && freeOrEvictableRunning(global) > 0;
  },
  kind: "filter",
};
