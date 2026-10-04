import type { RankStage } from "../pipeline.js";

/** Ranks a worker under its RAM budget for the request's platform above one at it (ADR 0009 §7).
 * A rank, so a worker at its budget is still asked when it is the only one left. Reads the flag
 * the worker reports; the gateway knows nothing about how a worker counts RAM. */
export const ramBudget: RankStage = {
  kind: "rank",
  name: "ram-budget",
  score(worker, request) {
    return worker.capacity?.[request.platform].atRamBudget === true ? 0 : 1;
  },
  settles: false,
};
