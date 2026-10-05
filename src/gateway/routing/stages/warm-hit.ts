import { type DeviceSpec, fits } from "../../../core/domain.js";
import type { WorkerView } from "../../worker-registry.js";
import { classOfModel, requirementOf } from "../request-match.js";
import type { RankStage } from "../pipeline.js";

/**
 * Prefers a worker with an unleased `ready` device that fits the request (ADR 0009 §6, ADR 0015
 * §8): the core's `fits` over the worker's own catalog, for the requirement the request has on
 * that worker -- the worker's own name for an exact model or the class, the runtime the worker
 * would pick (an exact request naming none: the one it requested, else its default) or any
 * installed one (a class request naming none), the range when the request has one, and the image
 * tag. The mode is the one rule kept here: a `full` request needs a device reporting `full`, a
 * `slim` one a device reporting `slim`, and one naming no mode a device that serves the worker's
 * default mode. A worker the catalog does not match has no warm device for it. A miss costs a
 * cold boot, never a wrong device -- the worker still applies its own rules. Settles: once a warm
 * worker exists, no later stage looks at capacity.
 */
export const warmHit: RankStage = {
  kind: "rank",
  name: "warm-hit",
  score(worker, request) {
    const requirement = requirementOf(worker, request);
    if (requirement === undefined) return 0;
    const classOf = classOfModel(worker, request);
    const warm = worker.devices.some(
      (device) =>
        device.state === "ready" &&
        fits(requirement, deviceSpec(device.spec), classOf) &&
        (request.mode === undefined ? device.servesDefaultMode : device.mode === request.mode),
    );
    return warm ? 1 : 0;
  },
  settles: true,
};

/** The view's device spec in the core's shape, which leaves an absent image tag out. */
function deviceSpec(spec: WorkerView["devices"][number]["spec"]): DeviceSpec {
  const { imageTag, ...rest } = spec;
  return imageTag === undefined ? rest : { ...rest, imageTag };
}
