import type { FilterStage } from "../pipeline.js";

/**
 * Keeps a worker that is connected, not drained, and whose capacity and catalog have been read
 * (ADR 0009 §2, stage 1). A policy that cannot see free capacity must not guess it has some, and
 * a worker whose catalog has not been read since it connected is carrying the last session's.
 */
export const takesRequests: FilterStage = {
  keeps(worker) {
    return (
      worker.connection === "connected" &&
      !worker.drained &&
      worker.capacity !== undefined &&
      worker.catalogReadAt !== undefined
    );
  },
  kind: "filter",
};
