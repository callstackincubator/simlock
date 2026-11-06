/**
 * The fast-fail table of ADR 0009 §4: whether a request can be served at all, asked before any
 * stage runs. It is the one place that table lives (architecture rule 10); the coordinator asks
 * it and acts on the answer, and the stages never see a request this table has rejected.
 */
import type { Platform } from "../../contract/index.js";
import { type DeviceClass, noPhysicalMatch } from "../../core/index.js";
import type { WorkerView } from "../worker-registry.js";
import type { RoutableRequest } from "./pipeline.js";
import {
  baselineEntry,
  baselineMismatchOf,
  catalogOf,
  hasPlatform,
  listsModel,
  matchRequest,
  physicalMatch,
  wantedClass,
} from "./request-match.js";
import { hasCapabilities } from "./stages/has-capabilities.js";
import { keepsExcept } from "./stages/keeps-except.js";
import { takesRequests } from "./stages/takes-requests.js";

export type RejectionCode =
  | "NO_CAPACITY"
  | "NO_DRIVER"
  | "UNKNOWN_MODEL"
  | "RUNTIME_MISSING"
  | "CAPABILITY_MISSING"
  | "UNKNOWN_BASELINE"
  | "BASELINE_MISMATCH"
  | "BASELINE_STALE"
  | "BAD_REQUEST";

/** What a request the fleet cannot serve is told: the code and details a worker gives the same
 * request, and the `lease.rejected` reason the gateway records it under. */
export interface Rejection {
  readonly kind: "reject";
  readonly code: RejectionCode;
  readonly message: string;
  readonly details?:
    | {
        readonly platform: Platform;
        readonly model?: string;
        readonly class?: DeviceClass;
        readonly osVersion?: string;
        readonly downloadable?: false;
      }
    | { readonly capabilities: readonly string[] }
    | { readonly name: string }
    | { readonly baseline: string; readonly field: string }
    | { readonly baseline: string; readonly reason: string };
  readonly reason: "no-worker" | "unresolvable-spec";
}

export type Assessment = { readonly kind: "route-or-wait" } | Rejection;

export function assess(request: RoutableRequest, views: readonly WorkerView[]): Assessment {
  if (request.baseline === undefined) return assessFleet(request, views);
  const holders = baselineHolders(request, views);
  return holders.kind === "reject" ? holders : assessFleet(request, holders.views);
}

type Holders = { readonly kind: "holders"; readonly views: readonly WorkerView[] } | Rejection;

/**
 * why: ADR 0061 §6: before the table, a request naming a baseline is checked against the workers
 * that hold it: none holds it, none fits it, or no fitting one is fresh. The first holder in
 * worker id order gives the message. The table then runs over the fitting, fresh holders.
 */
function baselineHolders(request: RoutableRequest, views: readonly WorkerView[]): Holders {
  const name = request.baseline ?? "";
  const holders = views
    .filter((worker) => isKnown(worker) && baselineEntry(worker, request) !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (holders.length === 0) {
    return {
      code: "UNKNOWN_BASELINE",
      details: { name },
      kind: "reject",
      message: `no worker holds a baseline named "${name}"`,
      reason: "unresolvable-spec",
    };
  }
  const mismatches = holders.map((worker) => baselineMismatchOf(worker, request));
  const fitting = holders.filter((_worker, index) => mismatches[index] === undefined);
  const firstMismatch = mismatches[0];
  if (fitting.length === 0 && firstMismatch !== undefined) {
    return {
      code: "BASELINE_MISMATCH",
      details: { baseline: name, field: firstMismatch.field },
      kind: "reject",
      message: firstMismatch.message,
      reason: "unresolvable-spec",
    };
  }
  const fresh = fitting.filter(
    (worker) => baselineEntry(worker, request)?.staleReason === undefined,
  );
  if (fresh.length === 0) {
    const first = fitting[0];
    const reason = (first && baselineEntry(first, request)?.staleReason) ?? "";
    return {
      code: "BASELINE_STALE",
      details: { baseline: name, reason },
      kind: "reject",
      message: `baseline ${name} is stale: ${reason}`,
      reason: "unresolvable-spec",
    };
  }
  return { kind: "holders", views: fresh };
}

function assessFleet(request: RoutableRequest, views: readonly WorkerView[]): Assessment {
  const answer = assessTable(request, views);
  if (answer.kind === "reject") return answer;
  const except = assessExcept(request, views);
  if (except !== undefined) return except;
  const requires = request.requires;
  if (requires === undefined || requires.length === 0) return answer;
  const capable = views.filter((worker) => hasCapabilities.check(worker, request) === undefined);
  if (assessTable(request, capable).kind === "route-or-wait") return answer;
  return {
    code: "CAPABILITY_MISSING",
    details: { capabilities: requires },
    kind: "reject",
    message: `No worker connected to this gateway can serve ${requires.join(", ")} for this request`,
    reason: "unresolvable-spec",
  };
}

/**
 * why: ADR 0066 §5: like `requires`, the table runs again over the workers that keep the `except`
 * list; when none can serve, the request is told whether no worker slims the names or none would
 * give a slim device (the default mode, or the baseline's mode, is full).
 */
function assessExcept(
  request: RoutableRequest,
  views: readonly WorkerView[],
): Rejection | undefined {
  const except = request.except;
  if (except === undefined) return undefined;
  const keeping = views.filter((worker) => keepsExcept.check(worker, request) === undefined);
  if (assessTable(request, keeping).kind === "route-or-wait") return undefined;
  const names = except.join(", ");
  const slimmers = views.filter((worker) =>
    except.every((name) => catalogOf(worker, request)?.slimCategories?.includes(name) === true),
  );
  const message =
    slimmers.length === 0
      ? `no worker slims every category in except: ${names}`
      : `no worker can keep slim categories ${names} (${whyNotSlim(request)})`;
  return { code: "BAD_REQUEST", kind: "reject", message, reason: "unresolvable-spec" };
}

function whyNotSlim(request: RoutableRequest): string {
  if (request.baseline !== undefined) return `baseline "${request.baseline}" is full`;
  return request.mode === "slim"
    ? "no worker that slims them can serve the request"
    : "default mode is full on every worker";
}

function assessTable(request: RoutableRequest, views: readonly WorkerView[]): Assessment {
  // why: an updating worker comes back by itself (ADR 0042 §3), so a request that only it can serve waits instead of failing.
  const takers = views.filter((worker) => {
    const refusal = takesRequests.check(worker, request);
    return refusal === undefined || refusal.reason === "updating";
  });
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
  if (request.physical === true) return assessPhysical(request, known, takers);
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

// why: `presence` plays no part in the table: a device last read not present makes the request wait, not fail.
function assessPhysical(
  request: RoutableRequest,
  known: readonly WorkerView[],
  takers: readonly WorkerView[],
): Assessment {
  if (!known.some((worker) => physicalMatch(worker, request, "enrolled"))) {
    return {
      ...noPhysicalMatch(request),
      code: "UNKNOWN_MODEL",
      kind: "reject",
      reason: "unresolvable-spec",
    };
  }
  if (!takers.some((worker) => physicalMatch(worker, request, "enrolled"))) return noWorker();
  return { kind: "route-or-wait" };
}

function isKnown(worker: WorkerView): boolean {
  return worker.connection !== "incompatible";
}

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
