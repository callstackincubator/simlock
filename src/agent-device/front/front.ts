import type { HttpMount } from "../../http/app.js";
import type { TokenIdentity } from "../../http/token-store.js";
import { FRONT_MOUNT, FRONT_PREFIX } from "../shared/paths.js";
import { failure, frontReply, notAvailable, refusal } from "../shared/replies.js";
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
import type { FrontContext } from "./context.js";
import { filterDevices } from "./devices-filter.js";
import { heartbeat } from "./heartbeat.js";
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
  if (status.state === "unavailable") return frontReply(notAvailable(status.reason), read);
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

// why: agent-device answers `devices` with everything its daemon sees, so the answer is cut down before the CLI gets it.
async function forwardCommand(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
  read: RpcRequest,
  leaseId: string | undefined,
): Promise<Response> {
  const response = await passThrough(context, request, identity, read, leaseId);
  const isDevices =
    methodName(read.method) === "command" &&
    commandName(asRecord(read.params)?.["command"]) === "devices";
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

export function createFront(context: FrontContext): HttpMount {
  return {
    handle: async (request, identity) => {
      const isRpc =
        request.method === "POST" && new URL(request.url).pathname === `${FRONT_PREFIX}/rpc`;
      if (identity.role !== "agent") {
        return frontReply(refusal(AGENT_TOKEN_ONLY, 403), isRpc ? { id: null } : undefined);
      }
      if (isRpc) return handleRpc(context, request, identity);
      const status = await context.link.status();
      const path = new URL(request.url).pathname.slice(FRONT_PREFIX.length);
      const probe = request.method === "GET" && path === "/health";
      if (status.state === "unavailable") {
        const reply = notAvailable(status.reason);
        return frontReply(probe ? { ...reply, status: HEALTH_STATUS } : reply, undefined);
      }
      if (!isKnownRoute(request.method, path)) {
        return frontReply(
          refusal(`refused: unknown route ${request.method} ${path}`, 404),
          undefined,
        );
      }
      return passThrough(context, request, identity, undefined, undefined, probe);
    },
    prefix: FRONT_MOUNT,
  };
}
