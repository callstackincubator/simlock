import type { Identity } from "../../auth/index.js";
import { failure, frontReply, leaseEndedByHost, notAvailable, refusal } from "../shared/replies.js";
import {
  leaseCallFields,
  leaseGoneReason,
  leaseIdOf,
  type ReplyReading,
  type RpcRead,
} from "../shared/rpc.js";
import { addressField } from "../shared/selectors.js";
import {
  REPLY_SCOPE_KEYS,
  exchange,
  leaseCall,
  listLeases,
  heldForAnother,
  releaseAgentDevice,
  releaseSimlock,
  relay,
  unreachableReply,
  scopeOf,
  type Exchange,
  type FrontContext,
} from "./context.js";
import { BACKEND_OF_PLATFORM } from "./allocate.js";
import type { HeldView } from "./front-map.js";
import { renewLease } from "./renewals.js";
import { chosenTtl } from "./ttl.js";

const RESTORING = "the lease is being restored after an agent-device restart; try again";

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
  identity: Identity,
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
  { request, identity, call }: { request: Request; identity: Identity; call: Call },
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
  // why: the gateway's list trails a grant, and agent-device already answered; the next tick or heartbeat renews.
  if (outcome.kind === "unlisted") return relay(reply);
  if (ttl !== undefined && ttl !== entry.ttlMs) {
    context.map.setTtl(leaseId, ttl);
    context.renewals.rearm(context, leaseId);
  }
  return relay(reply);
}

const RESTORE_TIMEOUT_MS = 10_000;

type Restore =
  | { readonly kind: "restored"; readonly reply: Exchange }
  | { readonly kind: "ended" }
  | { readonly kind: "retry" }
  | { readonly kind: "relay"; readonly reply: Exchange };

async function allocateAgain(
  context: FrontContext,
  { request, identity, call, leaseMaxTtlMs }: HeartbeatArguments,
  entry: HeldView & { readonly platform: "ios" | "android" },
  leaseId: string,
): Promise<Exchange> {
  const params = {
    ...call.params,
    // why: agent-device's heartbeat RPC carries no backend, and an allocate without one gets ios-simulator, which refuses every later command naming the real backend.
    backend: BACKEND_OF_PLATFORM[entry.platform],
    leaseId,
    ttlMs: leaseMaxTtlMs ?? entry.ttlMs,
    ...(entry.retainOnClose === true ? { retainOnClose: true } : {}),
    [addressField(entry.platform)]: entry.address,
  };
  const abort = new AbortController();
  const timer = context.clock.setTimer(RESTORE_TIMEOUT_MS, () => abort.abort());
  // why: a proxy that ignores the abort would leave the heartbeat waiting for its own five-minute default, so the bound is also a race.
  const silent = new Promise<Exchange>((resolve) => {
    abort.signal.addEventListener(
      "abort",
      () =>
        resolve({
          reading: { kind: "unusable" },
          response: undefined,
          text: undefined,
          unreachable: RESTORING,
        }),
      { once: true },
    );
  });
  try {
    return await Promise.race([
      exchange(
        context,
        leaseCall(request, "agent_device.lease.allocate", params, call.id, abort.signal),
        identity,
        "allocate",
        leaseId,
      ),
      silent,
    ]);
  } finally {
    context.clock.cancel(timer);
  }
}

async function stillHeld(
  context: FrontContext,
  identity: Identity,
  leaseId: string,
  deadline: number,
): Promise<boolean | undefined> {
  try {
    const listed = (await listLeases(context, identity)).some((lease) => lease.id === leaseId);
    if (listed) return true;
    // why: a gateway's list trails a worker that is still starting, so a lease its index holds is not gone; one past its deadline is, whatever the index still says.
    const indexed = context.link.stillHeld?.(leaseId) === true;
    return indexed && deadline > context.clock.now() ? undefined : false;
  } catch {
    return undefined;
  }
}

// why: agent-device keeps its leases in memory, so after its restart the front allocates the lease again, on the device simlock still holds for it, before it answers the heartbeat.
async function restoreLease(
  context: FrontContext,
  arguments_: HeartbeatArguments,
  entry: HeldView,
  leaseId: string,
): Promise<Restore> {
  const { request, identity, call, leaseMaxTtlMs } = arguments_;
  if (entry.platform === undefined || entry.releasing === true) return { kind: "ended" };
  const held = await stillHeld(context, identity, leaseId, entry.deadline);
  if (held === undefined) return { kind: "retry" };
  if (!held) return { kind: "ended" };
  const allocated = await allocateAgain(
    context,
    arguments_,
    { ...entry, platform: entry.platform },
    leaseId,
  );
  if (allocated.reading.kind !== "success") return { kind: "retry" };
  context.map.markRestored(leaseId);
  const again = await exchange(
    context,
    forwardedHeartbeat(request, call, leaseMaxTtlMs),
    identity,
    undefined,
    leaseId,
  );
  if (again.reading.kind === "success") return { kind: "restored", reply: again };
  return leaseGoneReason(again.reading) === undefined
    ? { kind: "relay", reply: again }
    : { kind: "retry" };
}

const restoring = new WeakMap<FrontContext, Map<string, Promise<Restore>>>();

// why: heartbeats that arrive while one re-allocate runs wait for it, so agent-device sees one allocate and none waits past its bound.
function sharedRestore(
  context: FrontContext,
  arguments_: HeartbeatArguments,
  entry: HeldView,
  leaseId: string,
): Promise<Restore> {
  let running = restoring.get(context);
  if (running === undefined) {
    running = new Map();
    restoring.set(context, running);
  }
  const live = running.get(leaseId);
  if (live !== undefined) return live;
  const started = restoreLease(context, arguments_, entry, leaseId).finally(() => {
    running.delete(leaseId);
  });
  running.set(leaseId, started);
  return started;
}

async function restored(
  context: FrontContext,
  arguments_: HeartbeatArguments,
  entry: HeldView,
  leaseId: string,
): Promise<Response> {
  const { call, identity } = arguments_;
  const outcome = await sharedRestore(context, arguments_, entry, leaseId);
  if (outcome.kind === "restored") {
    return renewHeld(context, call, entry, leaseId, outcome.reply);
  }
  if (outcome.kind === "relay") return relay(outcome.reply);
  if (outcome.kind === "retry") return frontReply(notAvailable(RESTORING), call);
  return releaseOurs(context, identity, leaseId, call, true);
}

function ownEntry(context: FrontContext, leaseId: string, identity: Identity) {
  const entry = context.map.get(leaseId);
  return entry?.identity.principal === identity.principal ? entry : undefined;
}

function badTtl(call: Call): boolean {
  const sent = leaseCallFields(call.params).ttlMs;
  return (
    sent !== undefined &&
    sent !== null &&
    !(typeof sent === "number" && Number.isFinite(sent) && sent > 0)
  );
}

interface HeartbeatArguments {
  readonly request: Request;
  readonly identity: Identity;
  readonly call: Call;
  readonly leaseMaxTtlMs: number | undefined;
}

export async function heartbeat(
  context: FrontContext,
  arguments_: HeartbeatArguments,
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
  const gone = leaseGoneReason(reading);
  if (gone === undefined) return relay(reply);
  return leaseGone(context, arguments_, { entry, gone, leaseId, reply });
}

async function leaseGone(
  context: FrontContext,
  arguments_: HeartbeatArguments,
  found: {
    readonly entry: HeldView | undefined;
    readonly gone: string;
    readonly leaseId: string;
    readonly reply: Exchange;
  },
): Promise<Response> {
  const { identity, call } = arguments_;
  const { entry, gone, leaseId, reply } = found;
  if (entry?.endedBy === "agent") return relay(reply);
  if (gone === "LEASE_NOT_FOUND" && entry !== undefined) {
    return restored(context, arguments_, entry, leaseId);
  }
  if (entry === undefined && (await heldForAnother(context, identity, leaseId))) {
    return relay(reply);
  }
  return releaseOurs(context, identity, leaseId, call, entry !== undefined);
}
