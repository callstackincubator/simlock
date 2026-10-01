import type { RankStage } from "../pipeline.js";

/**
 * Prefers a worker with an unleased `ready` device matching the request. Settles: once a warm
 * worker exists, no later stage looks at capacity.
 */
export const warmHit: RankStage = {
  kind: "rank",
  name: "warm-hit",
  score(worker, request) {
    const warm = worker.devices.some(
      (device) =>
        device.state === "ready" &&
        device.spec.platform === request.platform &&
        device.spec.model === request.model &&
        (request.osVersion === undefined || device.spec.osVersion === request.osVersion),
    );
    return warm ? 1 : 0;
  },
  settles: true,
};
