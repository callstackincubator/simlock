import type { HttpDispatch } from "../../http/dispatcher-session.js";
import type { Identity } from "../../auth/index.js";
import type { Clock, Logger } from "../../ports/index.js";
import { buildHttpSession } from "../../http/dispatcher-session.js";
import { mapError } from "../../http/errors.js";
import { failure, frontReply, notAvailable } from "../shared/replies.js";
import { readReply, type CallClass, type ReplyReading } from "../shared/rpc.js";
import type { FrontMap } from "./front-map.js";
import type { HostLink } from "./host-link.js";
import type { Renewals } from "./renewals.js";

export interface FrontContext {
  readonly leaseTtlCapMs?: number;
  // why: the longest a lease may live (`lease.maxTtlMs`); a running call stops counting as running after it.
  readonly maxRunMs: number;
  readonly renewals: Renewals;
  readonly link: HostLink;
  readonly map: FrontMap;
  readonly dispatch: HttpDispatch;
  readonly clock: Clock;
  readonly logger: Logger;
}

const BODY_LOG_CHARS = 500;

export interface Exchange {
  readonly response: Response | undefined;
  readonly text: string | undefined;
  readonly reading: ReplyReading;
  // why: the link's own reason when it could not carry the call, so the reply names it as a call passed through does.
  readonly unreachable?: string;
}

export async function exchange(
  context: FrontContext,
  request: Request,
  identity: Identity,
  call?: CallClass,
  leaseId?: string,
): Promise<Exchange> {
  try {
    const response = await context.link.forward(request, identity, leaseId);
    const text = await response.text();
    const reading = readReply(text, call);
    // why: the reason for a 5xx or a body that is not a JSON-RPC reply is only in what agent-device sent.
    if (reading.kind === "unusable" || response.status >= 500) {
      context.logger.warn("agent-device lease call got an unusable or failed reply", {
        body: text.slice(0, BODY_LOG_CHARS),
        status: response.status,
      });
    }
    return { reading, response, text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.logger.warn("agent-device lease call got no usable reply", { message });
    return {
      reading: { kind: "unusable" },
      response: undefined,
      text: undefined,
      unreachable: message,
    };
  }
}

// why: a lease call the link could not carry answers the notAvailable reply naming the link's reason, or `fallback` when the link gave none.
export function unreachableReply(
  reply: Exchange,
  call: { readonly id: unknown },
  fallback: string,
): Response {
  return frontReply(
    reply.unreachable === undefined ? failure(fallback) : notAvailable(reply.unreachable),
    call,
  );
}

export function relay(reply: {
  response: Response | undefined;
  text: string | undefined;
}): Response {
  const headers = new Headers(reply.response?.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(reply.text ?? "", { headers, status: reply.response?.status ?? 502 });
}

export function leaseCall(
  origin: Request,
  method: "agent_device.lease.allocate" | "agent_device.lease.release",
  params: Record<string, unknown>,
  id: unknown,
): Request {
  const headers = new Headers(origin.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(origin.url, {
    body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
    headers,
    method: "POST",
  });
}

export type SimlockRelease =
  | { readonly kind: "released" | "unknown" | "forbidden" }
  | { readonly kind: "failed"; readonly message: string };

export async function releaseSimlock(
  context: FrontContext,
  identity: Identity,
  leaseId: string,
): Promise<SimlockRelease> {
  try {
    await context.dispatch("lease.release", { leaseId }, buildHttpSession(identity));
    return { kind: "released" };
  } catch (error) {
    const code = mapError(error).code;
    if (code === "UNKNOWN_LEASE") return { kind: "unknown" };
    if (code === "FORBIDDEN") return { kind: "forbidden" };
    const message = error instanceof Error ? error.message : String(error);
    context.logger.warn("agent-device front could not release a simlock lease", {
      leaseId,
      message,
    });
    return { kind: "failed", message };
  }
}

const CALL_SCOPE_KEYS = ["runId", "leaseProvider", "clientId"] as const;
// why: only agent-device's reply names the device key it gave the lease, since the front stripped the CLI's key from the allocate it forwarded.
export const REPLY_SCOPE_KEYS = [...CALL_SCOPE_KEYS, "deviceKey"] as const;
export const ALLOCATE_SCOPE_KEYS = CALL_SCOPE_KEYS;

export function scopeOf(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) scope[key] = source[key];
  }
  return scope;
}

export async function releaseAgentDevice(
  context: FrontContext,
  request: Request,
  identity: Identity,
  leaseId: string,
  scope: Record<string, unknown>,
) {
  return exchange(
    context,
    leaseCall(request, "agent_device.lease.release", { ...scope, leaseId }, "simlock-release"),
    identity,
    undefined,
    leaseId,
  );
}

// why: a lease the token holds under another requester than its own id was made by something else (a gateway, for a worker's token of the same name), so this front has no claim to end it.
export async function heldForAnother(
  context: FrontContext,
  identity: Identity,
  leaseId: string,
): Promise<boolean> {
  try {
    const { leases } = await context.dispatch("lease.list", {}, buildHttpSession(identity));
    const found = leases.find((lease) => lease.id === leaseId);
    return found !== undefined && found.requesterId !== leaseId;
  } catch {
    return false;
  }
}

const LIST_TIMEOUT_MS = 5_000;

export async function listLeases(context: FrontContext, identity: Identity) {
  let timer: ReturnType<FrontContext["clock"]["setTimer"]> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = context.clock.setTimer(LIST_TIMEOUT_MS, () =>
      reject(new Error("lease.list timed out")),
    );
  });
  try {
    const { leases } = await Promise.race([
      context.dispatch("lease.list", {}, buildHttpSession(identity)),
      timeout,
    ]);
    return leases.map((lease) => ({ id: lease.id, ttlDeadline: lease.ttlDeadline }));
  } finally {
    if (timer !== undefined) context.clock.cancel(timer);
  }
}
