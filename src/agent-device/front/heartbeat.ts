import type { TokenIdentity } from "../../http/token-store.js";
import { failure, frontReply, leaseEndedByHost, refusal } from "../shared/replies.js";
import {
  leaseCallFields,
  leaseGoneReason,
  leaseIdOf,
  type ReplyReading,
  type RpcRead,
} from "../shared/rpc.js";
import {
  REPLY_SCOPE_KEYS,
  exchange,
  heldForAnother,
  releaseAgentDevice,
  releaseSimlock,
  relay,
  unreachableReply,
  scopeOf,
  type Exchange,
  type FrontContext,
} from "./context.js";
import type { HeldView } from "./front-map.js";
import { renewLease } from "./renewals.js";
import { chosenTtl } from "./ttl.js";

type Call = RpcRead & { readonly kind: "request" };

function forwardedHeartbeat(request: Request, call: Call, ceiling: number | undefined): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const params = ceiling === undefined ? call.params : { ...call.params, ttlMs: ceiling };
  return new Request(request.url, {
    body: JSON.stringify({ ...call.body, params }),
    headers,
    method: "POST",
    signal: request.signal,
  });
}

// why: simlock's own ownership check decides about a lease another token holds, so a refusal there is not a failure of the heartbeat.
async function releaseOurs(
  context: FrontContext,
  identity: TokenIdentity,
  leaseId: string,
  call: Call,
  held: boolean,
): Promise<Response> {
  const released = await releaseSimlock(context, identity, leaseId);
  if (released.kind === "failed") return frontReply(failure(released.message), call);
  if (held) {
    context.map.markEnded(leaseId);
    context.renewals.cancelIfEnded(context, leaseId);
  }
  return frontReply(leaseEndedByHost(), call);
}

async function leaseStillThere(
  context: FrontContext,
  { request, identity, call }: { request: Request; identity: TokenIdentity; call: Call },
  leaseId: string,
): Promise<Response> {
  const ended = await releaseAgentDevice(
    context,
    request,
    identity,
    leaseId,
    scopeOf(call.params, REPLY_SCOPE_KEYS),
  );
  if (ended.response === undefined) {
    return unreachableReply(ended, call, "agent-device did not answer the release");
  }
  if (ended.reading.kind !== "success") return relay(ended);
  return releaseOurs(context, identity, leaseId, call, false);
}

async function renewHeld(
  context: FrontContext,
  call: Call,
  entry: HeldView,
  leaseId: string,
  reply: Exchange,
): Promise<Response> {
  const sent = leaseCallFields(call.params).ttlMs;
  const ttl = typeof sent === "number" ? chosenTtl(sent, context.leaseTtlCapMs) : undefined;
  const outcome = await renewLease(context, leaseId, ttl ?? entry.ttlMs);
  if (outcome.kind === "gone") {
    context.map.markEnded(leaseId);
    context.renewals.cancelIfEnded(context, leaseId);
    return frontReply(leaseEndedByHost(), call);
  }
  if (outcome.kind === "failed") return frontReply(failure(outcome.message), call);
  if (ttl !== undefined && ttl !== entry.ttlMs) {
    context.map.setTtl(leaseId, ttl);
    context.renewals.rearm(context, leaseId);
  }
  return relay(reply);
}

function ownEntry(context: FrontContext, leaseId: string, identity: TokenIdentity) {
  const entry = context.map.get(leaseId);
  return entry?.identity.requesterId === identity.requesterId ? entry : undefined;
}

function badTtl(call: Call): boolean {
  const sent = leaseCallFields(call.params).ttlMs;
  return (
    sent !== undefined &&
    sent !== null &&
    !(typeof sent === "number" && Number.isFinite(sent) && sent > 0)
  );
}

export async function heartbeat(
  context: FrontContext,
  arguments_: {
    readonly request: Request;
    readonly identity: TokenIdentity;
    readonly call: Call;
    readonly leaseMaxTtlMs: number | undefined;
  },
): Promise<Response> {
  const { request, identity, call, leaseMaxTtlMs } = arguments_;
  if (badTtl(call)) {
    return frontReply(refusal("refused: ttlMs must be a positive number of milliseconds"), call);
  }
  const leaseId = leaseIdOf(leaseCallFields(call.params).leaseId);
  const entry = leaseId === undefined ? undefined : ownEntry(context, leaseId, identity);
  if (leaseId !== undefined && entry?.endedBy === "simlock") {
    return frontReply(leaseEndedByHost(), call);
  }
  const reply = await exchange(
    context,
    forwardedHeartbeat(request, call, leaseMaxTtlMs),
    identity,
    undefined,
    leaseId,
  );
  if (reply.response === undefined)
    return unreachableReply(reply, call, "agent-device did not answer the heartbeat");
  if (leaseId === undefined) return relay(reply);
  const reading: ReplyReading = reply.reading;
  if (reading.kind === "success") {
    if (entry === undefined) return leaseStillThere(context, arguments_, leaseId);
    if (entry.endedAt !== undefined) return relay(reply);
    return renewHeld(context, call, entry, leaseId, reply);
  }
  if (leaseGoneReason(reading) === undefined) return relay(reply);
  if (entry?.endedBy === "agent") return relay(reply);
  if (entry === undefined && (await heldForAnother(context, identity, leaseId))) {
    return relay(reply);
  }
  return releaseOurs(context, identity, leaseId, call, entry !== undefined);
}
