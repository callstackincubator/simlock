/**
 * The fast-fail table of ADR 0009 §4: whether a request can be served at all, asked before any
 * stage runs. It is the one place that table lives (architecture rule 10); the coordinator asks
 * it and acts on the answer, and the stages never see a request this table has rejected.
 */
import type { Platform } from "../../contract/index.js";
import type { WorkerView } from "../worker-registry.js";
import type { RoutableRequest } from "./pipeline.js";

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
    readonly osVersion?: string;
    readonly downloadable?: false;
  };
  readonly reason: "no-worker" | "unresolvable-spec";
}

export type Assessment = { readonly kind: "route-or-wait" } | Rejection;

export function assess(_request: RoutableRequest, _views: readonly WorkerView[]): Assessment {
  return { kind: "route-or-wait" };
}
