import type { RankStage } from "../pipeline.js";

/** why: ADR 0068 §6 -- a rank, so a paused worker is still asked when it is the only one or holds a
 * warm device. It reads only the step the worker reports; `warming-paused` ranks as calm because
 * that worker still takes leases. */
export const memoryPressure: RankStage = {
  appliesToPhysical: false,
  kind: "rank",
  name: "memory-pressure",
  score(worker) {
    return worker.capacity?.memoryPressure?.step === "new-devices-paused" ? 0 : 1;
  },
  settles: false,
  zeroReason(worker) {
    return worker.capacity?.memoryPressure?.step === "new-devices-paused"
      ? { capacityReason: "memory-pressure", reason: "full" }
      : undefined;
  },
};
