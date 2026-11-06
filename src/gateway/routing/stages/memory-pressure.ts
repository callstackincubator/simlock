import type { RankStage } from "../pipeline.js";

export const memoryPressure: RankStage = {
  appliesToPhysical: false,
  kind: "rank",
  name: "memory-pressure",
  score() {
    return 1;
  },
  settles: false,
  zeroReason() {
    return undefined;
  },
};
