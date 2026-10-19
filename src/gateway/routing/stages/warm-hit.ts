import type { FittableSpec } from "../../../core/index.js";
import type { WorkerView } from "../../worker-registry.js";
import { deviceFit, physicalMatch } from "../request-match.js";
import type { RankStage } from "../pipeline.js";

export const warmHit: RankStage = {
  appliesToPhysical: true,
  kind: "rank",
  name: "warm-hit",
  score(worker, request) {
    // why: a physical request has no mode rule, and a device last read not present is skipped so the request never goes to a worker whose only match is unplugged.
    if (request.physical === true) return physicalMatch(worker, request, "pickable") ? 1 : 0;
    const fitsRequest = deviceFit(worker, request);
    if (fitsRequest === undefined) return 0;
    const warm = (worker.devices ?? []).some(
      (device) =>
        device.state === "ready" &&
        fitsRequest(deviceSpec(device.spec)) &&
        (request.mode === undefined ? device.servesDefaultMode : device.mode === request.mode),
    );
    return warm ? 1 : 0;
  },
  settles: true,
  zeroReason(worker, request) {
    if (request.physical !== true) return undefined;
    return physicalMatch(worker, request, "pickable") ? undefined : { reason: "no-free-physical" };
  },
};

/** The view's device spec in the core's shape, which leaves an absent image tag out. */
function deviceSpec(spec: NonNullable<WorkerView["devices"]>[number]["spec"]): FittableSpec {
  const { imageTag, ...rest } = spec;
  return imageTag === undefined ? rest : { ...rest, imageTag };
}
