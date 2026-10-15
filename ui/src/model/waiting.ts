import type { z } from "zod";

import type { waitingRequestSchema } from "../../../src/contract/schemas";
import type { Stat } from "./stat";
import { formatDuration } from "./time";
import { platformName, type WorkerView } from "./workers";

export type WaitingRequest = z.infer<typeof waitingRequestSchema>;

export interface WaitingList {
  readonly requests: readonly WaitingRequest[];
}

export function requestedDevice(spec: WaitingRequest["spec"]): string {
  return [
    [platformName(spec.platform), spec.model ?? spec.class]
      .filter((part) => part !== undefined)
      .join(" "),
    spec.osVersion === undefined ? undefined : `runtime ${spec.osVersion}`,
    spec.mode === undefined ? undefined : `mode ${spec.mode}`,
    spec.imageTag === undefined ? undefined : `image tag ${spec.imageTag}`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

// why: a single host names no worker on its requests, so the request is found in the host's view by
// its id and requester. A gateway's own request never matches a worker's: its id comes from the
// gateway, and a worker lists the copy the gateway sent it under the gateway's requester id.
export function waitingOn(
  request: WaitingRequest,
  workers: readonly WorkerView[],
): WorkerView | undefined {
  if (request.workerId !== undefined) {
    return workers.find((worker) => worker.id === request.workerId);
  }
  return workers.find((worker) =>
    worker.waiting?.some(
      (entry) => entry.id === request.id && entry.requesterId === request.requesterId,
    ),
  );
}

export function waitingStats(requests: readonly WaitingRequest[], now: number): readonly Stat[] {
  const oldest = Math.min(...requests.map((request) => request.createdAt));
  return [
    { caption: "for a device", label: "Requests waiting", value: String(requests.length) },
    {
      caption: requests.length === 0 ? "no request is waiting" : "the oldest request so far",
      label: "Longest wait",
      value: requests.length === 0 ? "—" : formatDuration(now - oldest),
    },
  ];
}
