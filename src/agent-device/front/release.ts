import type { Identity } from "../../auth/index.js";
import { leaseCallFields, leaseIdOf, type RpcRead } from "../shared/rpc.js";
import { exchange, relay, releaseSimlock, unreachableReply, type FrontContext } from "./context.js";

export async function release(
  context: FrontContext,
  identity: Identity,
  call: RpcRead & { readonly kind: "request" },
  forwarded: Request,
): Promise<Response> {
  const leaseId = leaseIdOf(leaseCallFields(call.params).leaseId);
  const reply = await exchange(context, forwarded, identity, undefined, leaseId);
  if (reply.response === undefined) {
    return unreachableReply(reply, call, "agent-device did not answer the release");
  }
  if (leaseId === undefined || reply.reading.kind !== "success") return relay(reply);
  await endSimlockLease(context, identity, leaseId);
  return relay(reply);
}

export async function endSimlockLease(
  context: FrontContext,
  identity: Identity,
  leaseId: string,
): Promise<void> {
  const entry = context.map.get(leaseId);
  if (entry === undefined || entry.identity.principal !== identity.principal) {
    // why: a lease the map does not hold for this token (as after a daemon restart) is freed by simlock's own ownership check, which refuses another token's lease.
    await releaseSimlock(context, identity, leaseId);
  } else if (entry.endedAt === undefined) {
    context.map.beginRelease(leaseId);
    const released = await releaseSimlock(context, entry.identity, leaseId);
    if (released.kind === "released") context.map.markEnded(leaseId, "agent");
    else {
      context.map.cancelRelease(leaseId);
      if (released.kind === "unknown") context.map.markEnded(leaseId, "simlock");
    }
    context.renewals.cancelIfEnded(context, leaseId);
  }
}
