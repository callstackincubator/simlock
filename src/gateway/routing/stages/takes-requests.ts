import type { FilterStage } from "../pipeline.js";

/**
 * why: keeps a worker that is connected, not drained, not updating (ADR 0042 §3), and whose capacity and catalog have been read
 * (ADR 0009 §2, stage 1). A policy that cannot see free capacity must not guess it has some, and
 * a worker whose catalog has not been read since it connected is carrying the last session's.
 *
 * A worker that answers `starting` is kept too, as long as the gateway holds a catalog for it:
 * it is not unable, it is not ready, and `healthy` is the stage that makes its requests wait
 * (ADR 0009 §2, stage 3). One never read at all has no catalog, and fails here as before.
 */
export const takesRequests: FilterStage = {
  check(worker) {
    if (worker.connection !== "connected") return { reason: worker.connection };
    if (worker.drained) return { reason: "drained" };
    if (worker.update != null) return { reason: "updating" };
    const ready =
      worker.health === "starting"
        ? worker.catalog !== undefined
        : worker.capacity !== undefined && worker.catalogReadAt !== undefined;
    return ready ? undefined : { reason: "not-ready" };
  },
  appliesToPhysical: true,
  kind: "filter",
};
