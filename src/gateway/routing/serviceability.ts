/**
 * The fast-fail table of ADR 0009 §4: whether a request can be served at all, asked before any
 * stage runs. It is the one place that table lives (architecture rule 10); the coordinator asks
 * it and acts on the answer, and the stages never see a request this table has rejected.
 */
import type { Platform } from "../../contract/index.js";
import type { DeviceClass } from "../../core/domain.js";
import type { WorkerView } from "../worker-registry.js";
import type { RoutableRequest } from "./pipeline.js";
import { hasPlatform, listsModel, matchRequest, wantedClass } from "./request-match.js";
import { takesRequests } from "./stages/takes-requests.js";

export type RejectionCode = "NO_CAPACITY" | "NO_DRIVER" | "UNKNOWN_MODEL" | "RUNTIME_MISSING";

/** What a request the fleet cannot serve is told: the code and details a worker gives the same
 * request, and the `lease.rejected` reason the gateway records it under. */
export interface Rejection {
  readonly kind: "reject";
  readonly code: RejectionCode;
  readonly message: string;
  readonly details?: {
    readonly platform: Platform;
    readonly model?: string;
    readonly class?: DeviceClass;
    readonly osVersion?: string;
    readonly downloadable?: false;
  };
  readonly reason: "no-worker" | "unresolvable-spec";
}

export type Assessment = { readonly kind: "route-or-wait" } | Rejection;

/**
 * Walks the table of ADR 0009 §4 in order over every view, busy or not: a worker that is merely
 * busy still makes a request servable, so it never reaches a rejection here.
 *
 * Two terms. A worker *takes requests* when it passes `takes-requests`. The gateway *knows* a
 * worker when it holds a catalog read from it and the worker is not `incompatible`; the view
 * keeps its last catalog across a lost uplink, so a disconnected worker stays known until
 * retention removes it. A worker connecting for the first time, with no catalog yet, is neither.
 */
export function assess(request: RoutableRequest, views: readonly WorkerView[]): Assessment {
  const takers = views.filter((worker) => takesRequests.keeps(worker, request));
  if (takers.length === 0) return noWorker();

  const known = views.filter(isKnown);
  const platform = request.platform;
  if (!known.some((worker) => hasPlatform(worker, request))) {
    return {
      code: "NO_DRIVER",
      details: { platform },
      kind: "reject",
      message: `No driver registered for platform: ${platform}`,
      reason: "unresolvable-spec",
    };
  }
  if (!known.some((worker) => listsModel(worker, request))) return unknownModel(request);
  if (!known.some((worker) => matchRequest(worker, request) !== undefined)) {
    const osVersion = request.osVersion ?? "default";
    return {
      code: "RUNTIME_MISSING",
      details: { downloadable: false, osVersion, platform },
      kind: "reject",
      message: `Runtime missing for ${platform} ${osVersion}`,
      reason: "unresolvable-spec",
    };
  }
  if (!takers.some((worker) => matchRequest(worker, request) !== undefined)) return noWorker();
  return { kind: "route-or-wait" };
}

/** A worker whose catalog was never read holds an empty one, which says nothing about any
 * platform or model, so only `incompatible` needs ruling out here. */
function isKnown(worker: WorkerView): boolean {
  return worker.connection !== "incompatible";
}

/** A model no worker lists, or, for a class request, a class none lists a model of. */
function unknownModel(request: RoutableRequest): Rejection {
  const { platform } = request;
  if (request.model === undefined) {
    const deviceClass = wantedClass(request);
    return {
      code: "UNKNOWN_MODEL",
      details: { class: deviceClass, platform },
      kind: "reject",
      message:
        `No ${platform} model of class ${deviceClass} is listed by any worker in the fleet; ` +
        `name one in ${platform}.defaultModels.${deviceClass} on a worker`,
      reason: "unresolvable-spec",
    };
  }
  return {
    code: "UNKNOWN_MODEL",
    details: { model: request.model, platform },
    kind: "reject",
    message: `Unknown ${platform} model: ${request.model}`,
    reason: "unresolvable-spec",
  };
}

function noWorker(): Rejection {
  return {
    code: "NO_CAPACITY",
    kind: "reject",
    message: "No worker in the fleet can currently serve this request",
    reason: "no-worker",
  };
}
