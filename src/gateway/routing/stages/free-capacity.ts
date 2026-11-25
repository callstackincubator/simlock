import type { RankStage } from "../pipeline.js";
import { freeRunning } from "./free-running.js";

export const freeCapacity: RankStage = {
  appliesToPhysical: false,
  kind: "rank",
  name: "free-capacity",
  score(worker, request) {
    const entry = worker.capacity?.[request.platform];
    if (entry === undefined) return 0;
    return Math.max(0, freeRunning(entry));
  },
  settles: false,
};
