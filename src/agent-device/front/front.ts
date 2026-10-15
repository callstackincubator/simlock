import type { HttpMount } from "../../http/app.js";
import type { TokenIdentity } from "../../http/token-store.js";
import { FRONT_MOUNT, FRONT_PREFIX, LEASE_HEADER } from "../shared/paths.js";
import {
  failure,
  frontReply,
  isUnreachableAnswer,
  notAvailable,
  refusal,
  workerUnreachable,
} from "../shared/replies.js";
import { isKnownRoute } from "../shared/routes.js";
import { commandName, asRecord } from "../shared/selectors.js";
import {
  classifyCall,
  commandLeaseId,
  leaseCallFields,
  leaseIdOf,
  methodName,
  readRpcBody,
  type CallClass,
  type RpcRead,
} from "../shared/rpc.js";
import { allocate } from "./allocate.js";
import { relay, type FrontContext } from "./context.js";
import { anyUnreachable, devicesThroughGateway, filterDevices } from "./devices-filter.js";
import { heartbeat } from "./heartbeat.js";
import type { LinkStatus } from "./host-link.js";
import { releaseEndedLeases } from "./ended.js";
import { release } from "./release.js";
import { checkRequest } from "./request-rules.js";

type RpcRequest = RpcRead & { readonly kind: "request" };

interface Routed {
  readonly identity: TokenIdentity;
  readonly kind: CallClass;
  readonly leaseMaxTtlMs: number | undefined;
  readonly read: RpcRequest;
  readonly request: Request;
}

// why: the lease id the link's status and a command's route are read with; a new lease has none yet, so its status is read without one.
function leaseOf(
  kind: CallClass,
  read: RpcRead & { readonly kind: "request" },
): string | undefined {
  if (kind === "heartbeat" || kind === "release") {
    return leaseIdOf(leaseCallFields(read.params).leaseId);
  }
  return kind === "command" ? commandLeaseId(read.params) : undefined;
}

const AGENT_TOKEN_ONLY = "refused: agent-device through simlock needs an agent token";
const CLIENT_GONE = 499;
// why: the agent-device CLI counts a /health answer of 500 or more as an unreachable daemon and prints only "Remote daemon is unavailable"; a lower status lets its first RPC run and print the reason.
const HEALTH_STATUS = 200;

function carry(request: Request, body: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    body,
    headers,
    method: request.method,
    signal: request.signal,
  });
}

// why: the allocate keeps cleaning up (cancel, release) after the CLI hung up, while the handler answers at once.
function untilHangUp(signal: AbortSignal, work: Promise<Response | undefined>): Promise<Response> {
  const gone = new Promise<Response>((resolve) => {
    const answer = () => resolve(new Response(null, { status: CLIENT_GONE }));
    if (signal.aborted) answer();
    else signal.addEventListener("abort", answer, { once: true });
  });
  return Promise.race([work.then((response) => response ?? gone), gone]);
}

const FAILED_BODY_LOG_CHARS = 500;

// why: `devices` names no lease, so a gateway with no capable worker still answers "try again" when one of the token's own leases is only unreachable.
async function notRunning(
  context: FrontContext,
  identity: TokenIdentity,
  read: RpcRequest,
  status: Exclude<LinkStatus, { state: "running" }>,
): Promise<Response> {
  if (
    status.state === "unavailable" &&
    !(
      isDevicesCall(read) &&
      context.link.readsLeaseHeader &&
      (await anyUnreachable(context, identity, context.map.liveOf(identity.requesterId)))
    )
  ) {
    return frontReply(notAvailable(status.reason), read);
  }
  return frontReply(workerUnreachable(), read);
}

async function handleRpc(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
): Promise<Response> {
  const read = await readRpcBody(request);
  if (read.kind === "too-large") {
    return frontReply(refusal("refused: request body over 1 MiB"), { id: null });
  }
  if (read.kind === "malformed") {
    return frontReply(refusal("refused: send one JSON-RPC request"), { id: null });
  }
  const kind = classifyCall(read.method, read.params);
  const status = await context.link.status(leaseOf(kind, read), identity);
  if (status.state !== "running") return notRunning(context, identity, read, status);
  if (kind === "wrapped-lease") {
    return frontReply(refusal("refused: send lease calls as lease RPCs"), read);
  }
  const checked = await checkRequest(context, identity, read, status.platforms);
  if (checked.kind === "refused") return frontReply(checked.reply, read);
  return routeCall(context, {
    identity,
    kind,
    leaseMaxTtlMs: status.leaseMaxTtlMs,
    read: checked.read,
    request,
  });
}

async function routeCall(
  context: FrontContext,
  { identity, kind, leaseMaxTtlMs, read, request }: Routed,
): Promise<Response> {
  if (kind === "allocate") {
    const work = allocate(context, { call: read, identity, request }).catch((error: unknown) => {
      context.logger.error("agent-device allocate failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return frontReply(failure("agent-device allocate failed"), read);
    });
    return untilHangUp(request.signal, work);
  }
  const forwarded = carry(request, read.text);
  if (kind === "heartbeat") {
    return heartbeat(context, { call: read, identity, leaseMaxTtlMs, request: forwarded });
  }
  if (kind === "release") return release(context, identity, read, forwarded);
  const leaseId = leaseOf(kind, read);
  if (leaseId === undefined) return forwardCommand(context, forwarded, identity, read, leaseId);
  return runCommand(context, request, identity, read, leaseId);
}

async function runCommand(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
  read: RpcRequest,
  leaseId: string,
): Promise<Response> {
  const end = context.renewals.begin(context, leaseId, identity.requesterId, context.maxRunMs);
  request.signal.addEventListener("abort", end, { once: true });
  let response: Response;
  try {
    response = await forwardCommand(context, carry(request, read.text), identity, read, leaseId);
  } catch (error) {
    end();
    throw error;
  }
  if (isUnreachableAnswer(response)) return response;
  releaseEndedLeases(context, identity, response);
  return untilBodyEnds(response, end);
}

// why: a command counts as running until its body has gone out, since the stream is what the CLI waits on.
function untilBodyEnds(response: Response, end: () => void): Response {
  if (response.body === null) {
    end();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      end();
      await reader.cancel(reason);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          end();
        } else controller.enqueue(value);
      } catch (error) {
        end();
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function isDevicesCall(read: RpcRequest): boolean {
  return (
    methodName(read.method) === "command" &&
    commandName(asRecord(read.params)?.["command"]) === "devices"
  );
}

// why: agent-device answers `devices` with everything its daemon sees, so the answer is cut down before the CLI gets it.
async function forwardCommand(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
  read: RpcRequest,
  leaseId: string | undefined,
): Promise<Response> {
  const isDevices = isDevicesCall(read);
  if (isDevices && context.link.readsLeaseHeader) {
    return devicesThroughGateway(context, {
      forward: (forwarded, held) => passThrough(context, forwarded, identity, read, held),
      identity,
      read,
      request,
    });
  }
  const response = await passThrough(context, request, identity, read, leaseId);
  return isDevices ? filterDevices(context, identity, response, read) : response;
}

// why: a 5xx from agent-device reaches the CLI as it is, so the reason is only in the body; a copy is read in the background and cut short, so the stream the CLI waits on is not held.
function logFailedReply(context: FrontContext, response: Response): void {
  const status = response.status;
  void readStart(response.clone(), FAILED_BODY_LOG_CHARS)
    .catch(() => "")
    .then((body) => {
      context.logger.warn("agent-device answered a passed-through call with a 5xx", {
        body,
        status,
      });
    });
}

async function readStart(response: Response, chars: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (text.length < chars) {
    const { done, value } = await reader.read();
    if (done) break;
    text += value;
  }
  await reader.cancel().catch(() => undefined);
  return text.slice(0, chars);
}

async function passThrough(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
  rpc: { readonly id: unknown } | undefined,
  leaseId?: string,
  probe = false,
): Promise<Response> {
  try {
    const response = await context.link.forward(request, identity, leaseId);
    if (response.status >= 500) logFailedReply(context, response);
    return response;
  } catch (error) {
    const reply = notAvailable(error instanceof Error ? error.message : String(error));
    return frontReply(probe ? { ...reply, status: HEALTH_STATUS } : reply, rpc);
  }
}

const TICKET_HEADERS = ["authorization", "x-agent-device-token"] as const;

// why: the relay drops the caller's credentials, so the worker's ticket has none; the CLI sends the ticket's headers with its PUT, which reaches the gateway.
async function withCallerCredentials(request: Request, response: Response): Promise<Response> {
  const text = await response.text();
  try {
    const body: unknown = JSON.parse(text);
    const upload = asRecord(asRecord(body)?.["upload"]);
    if (upload === undefined) return relay({ response, text });
    const headers = { ...asRecord(upload["headers"]) };
    for (const name of TICKET_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    upload["headers"] = headers;
    return relay({ response, text: JSON.stringify(body) });
  } catch {
    return relay({ response, text });
  }
}

type HeaderLease = { readonly leaseId: string | undefined } | { readonly refused: Response };

function readLeaseHeader(request: Request): HeaderLease {
  const header = request.headers.get(LEASE_HEADER);
  if (header === null || header === "") return { leaseId: undefined };
  const leaseId = leaseIdOf(header);
  if (leaseId !== undefined) return { leaseId };
  return {
    refused: frontReply(
      refusal("refused: the x-agent-device-lease-id header is not a lease id"),
      undefined,
    ),
  };
}

async function routeByHeader(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
): Promise<Response> {
  const read = readLeaseHeader(request);
  if ("refused" in read) return read.refused;
  const { leaseId } = read;
  if (leaseId === undefined) return passThrough(context, request, identity, undefined);
  const status = await context.link.status(leaseId, identity);
  if (status.state === "unavailable") return frontReply(notAvailable(status.reason), undefined);
  if (status.state === "unreachable") return frontReply(workerUnreachable(), undefined);
  const response = await passThrough(context, request, identity, undefined, leaseId);
  const path = new URL(request.url).pathname.slice(FRONT_PREFIX.length);
  const preflight = request.method === "POST" && path === "/upload/preflight";
  return preflight && response.ok ? withCallerCredentials(request, response) : response;
}

// why: a request naming a lease is judged by that lease's worker, which may be the one that is gone.
function namesLease(context: FrontContext, request: Request, probe: boolean): boolean {
  return (
    context.link.readsLeaseHeader && !probe && (request.headers.get(LEASE_HEADER) ?? "") !== ""
  );
}

async function handlePlain(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
): Promise<Response> {
  const status = await context.link.status();
  const path = new URL(request.url).pathname.slice(FRONT_PREFIX.length);
  const probe = request.method === "GET" && path === "/health";
  if (status.state === "unavailable" && !namesLease(context, request, probe)) {
    const reply = notAvailable(status.reason);
    return frontReply(probe ? { ...reply, status: HEALTH_STATUS } : reply, undefined);
  }
  if (!isKnownRoute(request.method, path)) {
    return frontReply(refusal(`refused: unknown route ${request.method} ${path}`, 404), undefined);
  }
  if (probe || !context.link.readsLeaseHeader) {
    return passThrough(context, request, identity, undefined, undefined, probe);
  }
  return routeByHeader(context, request, identity);
}

// why: after a gateway restart the map is empty, so the token's leases are rebuilt from what the gateway knows before any rule reads the map.
function adoptLeases(context: FrontContext, identity: TokenIdentity): void {
  for (const lease of context.link.adoptable?.(identity) ?? []) {
    if (context.map.get(lease.leaseId) !== undefined) continue;
    context.map.add(lease.leaseId, {
      address: lease.address,
      adopted: true,
      deadline: lease.ttlDeadline,
      identity,
      model: lease.model,
      platform: lease.platform,
      target: lease.target,
      ttlMs: lease.ttlMs,
    });
  }
}

export function createFront(context: FrontContext): HttpMount {
  return {
    handle: async (request, identity) => {
      const isRpc =
        request.method === "POST" && new URL(request.url).pathname === `${FRONT_PREFIX}/rpc`;
      if (identity.role !== "agent") {
        return frontReply(refusal(AGENT_TOKEN_ONLY, 403), isRpc ? { id: null } : undefined);
      }
      adoptLeases(context, identity);
      if (isRpc) return handleRpc(context, request, identity);
      return handlePlain(context, request, identity);
    },
    prefix: FRONT_MOUNT,
  };
}
