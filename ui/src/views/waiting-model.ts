/**
 * The facts the Waiting view shows, computed from `GET /v1/lease-requests` and `GET /v1/workers`.
 * Pure, so the view stays rendering and these stay tested. The types are the contract's, imported
 * type-only (ADR 0011 §1).
 */
import type { z } from "zod";

import type { waitingRequestSchema } from "../../../src/contract/schemas";
import { platformName, type WorkerView } from "./workers-model";

export type WaitingRequest = z.infer<typeof waitingRequestSchema>;

export interface WaitingList {
  readonly requests: readonly WaitingRequest[];
}

/**
 * The device a request asked for, with only the fields it named: `iOS iPhone 16, runtime 18.4,
 * mode slim, image tag google_apis`.
 */
export function requestedDevice(spec: WaitingRequest["spec"]): string {
  return [
    `${platformName(spec.platform)} ${spec.model}`,
    spec.osVersion === undefined ? undefined : `runtime ${spec.osVersion}`,
    spec.mode === undefined ? undefined : `mode ${spec.mode}`,
    spec.imageTag === undefined ? undefined : `image tag ${spec.imageTag}`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

/**
 * The worker whose own queue a request waits in: the one it names, or on a single host the one
 * worker whose view lists it. `undefined` for a request in a gateway's queue, which no worker
 * holds yet, and for a worker the console has no view of.
 */
export function waitingOn(
  request: WaitingRequest,
  workers: readonly WorkerView[],
): WorkerView | undefined {
  if (request.workerId !== undefined) {
    return workers.find((worker) => worker.id === request.workerId);
  }
  return workers.find((worker) => worker.waiting?.some((entry) => entry.id === request.id));
}
