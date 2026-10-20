import type { FilterStage } from "../pipeline.js";
import { freeOrEvictableRunning } from "./free-running.js";

/** Keeps a worker with a free running slot above zero, for the request's platform and globally
 * (ADR 0009 §2, stage 6). A running device that is not leased counts as free: the planner evicts
 * it for a request no warm device fits, so passing the worker over would only make the request
 * wait for the idle shutdown. A slot held by a lease or a reservation is taken. */
export const freeSlot: FilterStage = {
  check(worker, request) {
    const capacity = worker.capacity;
    // why: a worker whose capacity was not read has no slot to count; `takes-requests` already drops it.
    if (capacity === undefined) return { reason: "full" };
    if (freeOrEvictableRunning(capacity[request.platform]) <= 0) {
      return { capacityReason: "platform-running-limit", reason: "full" };
    }
    if (freeOrEvictableRunning(capacity.global) <= 0) {
      return { capacityReason: "global-running-limit", reason: "full" };
    }
    return undefined;
  },
  appliesToPhysical: false,
  kind: "filter",
};
