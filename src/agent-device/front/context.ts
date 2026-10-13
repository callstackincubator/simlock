import type { HttpDispatch } from "../../http/dispatcher-session.js";
import type { TokenIdentity } from "../../http/token-store.js";
import type { Clock, Logger } from "../../ports/index.js";
import { buildHttpSession } from "../../http/dispatcher-session.js";
import { mapError } from "../../http/errors.js";
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

export interface Exchange {
  readonly response: Response | undefined;
  readonly text: string | undefined;
  readonly reading: ReplyReading;
}

export async function exchange(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
  call?: CallClass,
): Promise<Exchange> {
  try {
    const response = await context.link.forward(request, identity);
    const text = await response.text();
    return { reading: readReply(text, call), response, text };
  } catch (error) {
    context.logger.warn("agent-device lease call got no usable reply", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { reading: { kind: "unusable" }, response: undefined, text: undefined };
  }
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
  identity: TokenIdentity,
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
  identity: TokenIdentity,
  leaseId: string,
  scope: Record<string, unknown>,
) {
  return exchange(
    context,
    leaseCall(request, "agent_device.lease.release", { ...scope, leaseId }, "simlock-release"),
    identity,
  );
}
