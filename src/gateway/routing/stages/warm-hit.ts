import { matchRequest, pickedRuntime } from "../request-match.js";
import type { RankStage } from "../pipeline.js";

/**
 * Prefers a worker with an unleased `ready` device that fits the request (ADR 0009 §6): the
 * worker's own name for the model, the runtime the worker would pick (the one requested, else its
 * default), and the mode. A `full` request needs a device reporting `full`, a `slim` one a device
 * reporting `slim`, and one naming no mode a device that serves the worker's default mode. The
 * device's image tag must be the request's, or both absent: the worker would not hand any other
 * device to the request. A worker the catalog does not match has no warm device for it. A miss
 * costs a cold boot, never a wrong device -- the worker still applies its own rules. Settles:
 * once a warm worker exists, no later stage looks at capacity.
 */
export const warmHit: RankStage = {
  kind: "rank",
  name: "warm-hit",
  score(worker, request) {
    const model = matchRequest(worker, request);
    const runtime = pickedRuntime(worker, request);
    const warm = worker.devices.some(
      (device) =>
        device.state === "ready" &&
        device.spec.platform === request.platform &&
        device.spec.model === model &&
        device.spec.imageTag === request.imageTag &&
        device.spec.osVersion === runtime &&
        (request.mode === undefined ? device.servesDefaultMode : device.mode === request.mode),
    );
    return warm ? 1 : 0;
  },
  settles: true,
};
