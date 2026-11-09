import type { z } from "zod";

import { requestedClass, waitingRequestSchema } from "../../contract/index.js";
import { connectDaemonClient } from "../connect.js";
import { escapeControl as esc } from "../escape.js";
import { commandArgs, UsageError, writeResult } from "../args.js";
import type { CommandContext } from "../tree.js";

type WaitingRequestEntry = z.infer<typeof waitingRequestSchema>;

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    devices: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    leases: { type: "boolean" },
    requests: { type: "boolean" },
    rules: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock list [--devices|--leases|--rules|--requests]\n");
    return 0;
  }
  if ([values.devices, values.leases, values.rules, values.requests].filter(Boolean).length > 1)
    throw new UsageError("list accepts only one of --devices, --leases, --rules, or --requests");
  const client = await connectDaemonClient(environment, token);
  try {
    if (values.requests) {
      const requests = waitingRequestSchema.array().parse(await client.list({ kind: "requests" }));
      const names = requests.some((request) => request.workers !== undefined)
        ? new Map((await client.listWorkers()).workers.map((worker) => [worker.id, worker.label]))
        : new Map<string, string | undefined>();
      environment.stdout.write(
        `${formatWaitingRequests(requests, environment.clock.now(), names)}\n`,
      );
      return 0;
    }
    const kind = values.leases ? "leases" : values.rules ? "rules" : "devices";
    writeResult((value) => environment.stdout.write(value), await client.list({ kind }));
    return 0;
  } finally {
    await client.close();
  }
}

type WaitingReasonWord = NonNullable<WaitingRequestEntry["reason"]>;

const WAITING_REASON_TEXT: Readonly<Record<WaitingReasonWord, (platform: string) => string>> = {
  "behind-earlier-request": () => "Behind an earlier request",
  "device-limit": () => "Full: device limit",
  "global-running-limit": () => "Full: running limit",
  "no-free-physical": () => "Every matching device is leased or absent",
  "platform-running-limit": (platform) =>
    `Full: running limit for ${platform === "ios" ? "iOS" : "Android"}`,
  "memory-pressure": () => "Full: host memory pressure",
  "ram-budget": () => "Full: RAM budget",
  "waiting-for-device": () => "A matching device is starting",
};

type GatewayWaitingReason = NonNullable<WaitingRequestEntry["workers"]>[number]["reason"];

const GATEWAY_REASON_TEXT: Readonly<
  Record<Exclude<GatewayWaitingReason, "full">, (platform: string) => string>
> = {
  busy: () => "Busy with its own queue",
  "cannot-keep-except": () => "Cannot keep these slim categories",
  "capability-missing": () => "Missing capability",
  disconnected: () => "Not connected",
  drained: () => "Drained",
  incompatible: () => "Protocol mismatch",
  "baseline-mismatch": () => "Baseline is for another device",
  "baseline-stale": () => "Baseline is stale",
  "no-baseline": () => "Does not hold the baseline",
  "no-driver": (platform) => `No ${platform === "ios" ? "iOS" : "Android"} support`,
  "no-free-physical": () => WAITING_REASON_TEXT["no-free-physical"](""),
  "not-chosen": () => "Not chosen this time",
  "not-ready": () => "Not ready yet",
  "runtime-missing": () => "OS not installed",
  unhealthy: () => "Not running",
  updating: () => "Updating",
  "unknown-model": () => "Model not offered",
};

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function waitingReasonText(request: WaitingRequestEntry): string | undefined {
  if (request.reason === undefined) return undefined;
  return lowerFirst(WAITING_REASON_TEXT[request.reason](request.spec.platform));
}

function workerReasonLines(
  request: WaitingRequestEntry,
  names: ReadonlyMap<string, string | undefined>,
): string[] {
  return (request.workers ?? []).map((worker) => {
    const { platform } = request.spec;
    const text =
      worker.reason !== "full"
        ? GATEWAY_REASON_TEXT[worker.reason](platform)
        : worker.capacityReason === undefined
          ? "Full"
          : WAITING_REASON_TEXT[worker.capacityReason](platform);
    return `  ${esc(names.get(worker.workerId) ?? worker.workerId)}: ${lowerFirst(text)}`;
  });
}

// why: a request naming a baseline names no model or class, so it gets no class word.
function requestedDeviceText(spec: WaitingRequestEntry["spec"]): string {
  return [
    spec.platform,
    spec.physical === true ? "physical" : undefined,
    spec.model ??
      (spec.baseline === undefined ? `class ${String(requestedClass(spec))}` : undefined),
    spec.osVersion,
    spec.mode === undefined ? undefined : `mode ${spec.mode}`,
    spec.imageTag === undefined ? undefined : `image tag ${spec.imageTag}`,
    spec.baseline === undefined ? undefined : `baseline ${spec.baseline}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}

function formatWaitingRequests(
  requests: readonly WaitingRequestEntry[],
  now: number,
  names: ReadonlyMap<string, string | undefined>,
): string {
  if (requests.length === 0) return "No requests are waiting.";
  return requests
    .map((request) => {
      const device = requestedDeviceText(request.spec);
      const where = request.workerId === undefined ? "" : ` on ${esc(request.workerId)}`;
      const stage =
        request.queuePosition === undefined
          ? request.stage
          : `${request.stage} at ${String(request.queuePosition)}`;
      const waited = Math.max(0, Math.round((now - request.createdAt) / 1000));
      const why = waitingReasonText(request);
      const line = `Request ${esc(request.id)}: ${esc(request.requesterId)}${where}, ${esc(device)}, ${stage}, waiting ${String(waited)}s${why === undefined ? "" : ` — ${why}`}`;
      return [line, ...workerReasonLines(request, names)].join("\n");
    })
    .join("\n");
}

export { run };
