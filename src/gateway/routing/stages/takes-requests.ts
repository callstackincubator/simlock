import type { FilterStage } from "../pipeline.js";

/**
 * Keeps a worker that is connected, not drained, and whose capacity and catalog have been read
 * (ADR 0009 §2, stage 1). A policy that cannot see free capacity must not guess it has some, and
 * a worker whose catalog has not been read since it connected is carrying the last session's.
 *
 * A worker that answers `starting` is kept too, as long as the gateway holds a catalog for it:
 * it is not unable, it is not ready, and `healthy` is the stage that makes its requests wait
 * (ADR 0009 §2, stage 3). One never read at all has no catalog, and fails here as before.
 */
export const takesRequests: FilterStage = {
  keeps(worker) {
    if (worker.connection !== "connected" || worker.drained) return false;
    if (worker.health === "starting") return worker.catalog !== undefined;
    return worker.capacity !== undefined && worker.catalogReadAt !== undefined;
  },
  kind: "filter",
};
