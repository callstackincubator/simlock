import type { RankStage } from "../pipeline.js";

/** Prefers the worker with the most free running capacity for the platform
 * (`maxRunning - running - reserved`). A worker with none scores zero, so a fleet with no free
 * slot anywhere makes this stage abstain. */
export const freeCapacity: RankStage = {
  kind: "rank",
  name: "free-capacity",
  score(worker, request) {
    const entry = worker.capacity?.[request.platform];
    if (entry === undefined) return 0;
    return Math.max(0, entry.maxRunning - entry.running - entry.reserved);
  },
  settles: false,
};
