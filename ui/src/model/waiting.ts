import type { z } from "zod";

import type { waitingRequestSchema } from "../../../src/contract/schemas";
import { itemPath } from "./paths";
import { formatDuration } from "./time";
import { type Toned, waitingStageStatus } from "./tones";
import { platformName, type WorkerView, workerName, workerPath } from "./workers";

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
function waitingOn(
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

export type WaitingQueue =
  | { readonly kind: "worker"; readonly name: string; readonly to: string }
  | { readonly kind: "unseen"; readonly id: string }
  | { readonly kind: "gateway" };

export interface WaitingRow {
  readonly key: string;
  readonly id: string;
  readonly to: string;
  readonly requester: string;
  readonly device: string;
  readonly stage: Toned;
  readonly waited: string;
  readonly place: string;
  readonly placeOf: string;
  readonly physicalQueue: boolean;
  readonly created: string;
  readonly queue: WaitingQueue;
  readonly why?: string;
  readonly workers?: readonly { readonly name: string; readonly text: string }[];
}

export interface WaitingTable {
  readonly meta: string;
  readonly rows: readonly WaitingRow[];
}

const WHY_TEXT: Readonly<
  Record<NonNullable<WaitingRequest["reason"]>, (platform: string) => string>
> = {
  "behind-earlier-request": () => "Behind an earlier request",
  "device-limit": () => "Full: device limit",
  "global-running-limit": () => "Full: running limit",
  "no-free-physical": () => "Every matching device is leased or absent",
  "platform-running-limit": (platform) => `Full: running limit for ${platform}`,
  "ram-budget": () => "Full: RAM budget",
  "waiting-for-device": () => "A matching device is starting",
};

// why: a daemon newer than this console may send a reason it has no text for; the word shows as it is, as an unknown stage does.
function whyOf(request: WaitingRequest): string | undefined {
  if (request.reason === undefined) return undefined;
  const text: ((platform: string) => string) | undefined = (
    WHY_TEXT as Readonly<Record<string, (platform: string) => string>>
  )[request.reason];
  return text === undefined ? request.reason : text(platformName(request.spec.platform));
}

type GatewayReason = NonNullable<WaitingRequest["workers"]>[number]["reason"];

const WORKER_WHY_TEXT: Readonly<
  Record<Exclude<GatewayReason, "full">, (platform: string) => string>
> = {
  busy: () => "Busy with its own queue",
  "capability-missing": () => "Missing capability",
  disconnected: () => "Not connected",
  drained: () => "Drained",
  incompatible: () => "Protocol mismatch",
  "no-driver": (platform) => `No ${platform} support`,
  "no-free-physical": () => WHY_TEXT["no-free-physical"](""),
  "not-chosen": () => "Not chosen this time",
  "not-ready": () => "Not ready yet",
  "runtime-missing": () => "OS not installed",
  unhealthy: () => "Not running",
  "unknown-model": () => "Model not offered",
};

// why: a daemon newer than this console may send a worker reason it has no text for; the word shows as it is.
function workerWhyText(
  entry: NonNullable<WaitingRequest["workers"]>[number],
  platform: string,
): string {
  if (entry.reason === "full") {
    return entry.capacityReason === undefined ? "Full" : WHY_TEXT[entry.capacityReason](platform);
  }
  const text: ((platform: string) => string) | undefined = (
    WORKER_WHY_TEXT as Readonly<Record<string, (platform: string) => string>>
  )[entry.reason];
  return text === undefined ? entry.reason : text(platform);
}

function workersOf(
  request: WaitingRequest,
  entries: NonNullable<WaitingRequest["workers"]>,
  workers: readonly WorkerView[],
): NonNullable<WaitingRow["workers"]> {
  const platform = platformName(request.spec.platform);
  return entries.map((entry) => {
    const known = workers.find((worker) => worker.id === entry.workerId);
    return {
      name: known === undefined ? entry.workerId : workerName(known),
      text: workerWhyText(entry, platform),
    };
  });
}

function queueOf(request: WaitingRequest, workers: readonly WorkerView[]): WaitingQueue {
  const worker = waitingOn(request, workers);
  if (worker !== undefined) {
    return { kind: "worker", name: workerName(worker), to: workerPath(worker.id) };
  }
  return request.workerId === undefined
    ? { kind: "gateway" }
    : { id: request.workerId, kind: "unseen" };
}

// why: a place in the queue means something only among the requests of the same queue: one holder
// (a worker or the gateway), and the physical queue apart from the virtual one.
function queueKey(request: WaitingRequest, workers: readonly WorkerView[]): string {
  const holder = waitingOn(request, workers)?.id ?? request.workerId ?? "";
  return `${holder}/${request.spec.physical === true ? "physical" : "virtual"}`;
}

// why: UTC and ISO-shaped, so the same instant reads the same on every operator's machine.
function createdAtOf(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// why: the rows keep the order the daemon lists them in (a gateway's own queue, then each worker's),
// which is oldest first within a queue.
export function waitingTable(
  requests: readonly WaitingRequest[],
  workers: readonly WorkerView[],
  now: number,
): WaitingTable {
  const sizes = new Map<string, number>();
  for (const request of requests) {
    const key = queueKey(request, workers);
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const rows = requests.map((request): WaitingRow => {
    const position = request.queuePosition;
    const inQueue = sizes.get(queueKey(request, workers)) ?? 0;
    const why = whyOf(request);
    return {
      created: createdAtOf(request.createdAt),
      device: requestedDevice(request.spec),
      id: request.id,
      key: `${request.workerId ?? ""}/${request.id}`,
      physicalQueue: request.spec.physical === true,
      place: position === undefined ? "—" : `#${String(position)}`,
      placeOf:
        position === undefined
          ? "—"
          : `${String(position)} of ${String(Math.max(position, inQueue))}`,
      queue: queueOf(request, workers),
      requester: request.requesterId,
      stage: waitingStageStatus(request.stage),
      to: itemPath("/waiting", request.id),
      waited: formatDuration(now - request.createdAt),
      ...(why === undefined ? {} : { why }),
      ...(request.workers === undefined
        ? {}
        : { workers: workersOf(request, request.workers, workers) }),
    };
  });
  const oldest = Math.min(...requests.map((request) => request.createdAt));
  return {
    meta:
      requests.length === 0
        ? "0 waiting"
        : `${String(requests.length)} waiting · longest ${formatDuration(now - oldest)}`,
    rows,
  };
}

export interface WaitingChoice {
  readonly chosen: WaitingRow | undefined;
  readonly gone: boolean;
}

// why: with no id in the URL a wide screen shows the first row of the page; an id that matches no
// waiting request is "gone", whatever page it would have been on.
export function chooseWaiting(
  all: readonly WaitingRow[],
  id: string | undefined,
  pageRows: readonly WaitingRow[],
): WaitingChoice {
  if (id === undefined) return { chosen: pageRows[0], gone: false };
  const chosen = all.find((row) => row.id === id);
  return { chosen, gone: chosen === undefined };
}
