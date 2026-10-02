import type { FilterStage } from "../pipeline.js";

/**
 * Keeps a worker that is connected, not drained, and whose capacity has been read (ADR 0009 §2,
 * stage 1). A policy that cannot see free capacity must not guess it has some.
 */
export const takesRequests: FilterStage = {
  keeps(worker) {
    return worker.connection === "connected" && !worker.drained && worker.capacity !== undefined;
  },
  kind: "filter",
  name: "takes-requests",
};
