import { matchRequest } from "../request-match.js";
import type { RankStage } from "../pipeline.js";

/**
 * Prefers a worker with an unleased `ready` device matching the request, compared against the
 * worker's own name for the model (ADR 0009 §3). A worker the catalog does not match keeps the
 * exact compare; only the legacy `eligible` stage lets such a worker reach here. Settles: once a
 * warm worker exists, no later stage looks at capacity.
 */
export const warmHit: RankStage = {
  kind: "rank",
  name: "warm-hit",
  score(worker, request) {
    const model = matchRequest(worker, request) ?? request.model;
    const warm = worker.devices.some(
      (device) =>
        device.state === "ready" &&
        device.spec.platform === request.platform &&
        device.spec.model === model &&
        (request.osVersion === undefined || device.spec.osVersion === request.osVersion),
    );
    return warm ? 1 : 0;
  },
  settles: true,
};
