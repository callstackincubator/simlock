import type { EventBus, EventMap } from "../bus/index.js";

/** What a worker records when it refuses or fails a request that never reached a grant. */
export interface LeaseRefusal {
  readonly requestId: string;
  readonly requester: string;
  readonly requestSpec: unknown;
  readonly reason: EventMap["lease.rejected"]["reason"];
  /** The gateway's request id, when the request is a probe (ADR 0021). */
  readonly fleetRequestId?: string | undefined;
}

/**
 * The one place a worker decides between `lease.rejected` and `lease.declined` (ADR 0021 §2). A
 * request carrying a `fleetRequestId` is a gateway's dispatch: the gateway owns its outcome, so
 * the worker only declines it. Any other request is rejected, as before. The decision depends on
 * nothing else -- not the reason, not how far the work got -- so every site that refuses a
 * request, startup included, goes through here.
 */
export function emitLeaseRefusal(
  eventBus: Pick<EventBus, "emit">,
  refusal: LeaseRefusal,
  module: string,
): void {
  const { fleetRequestId, ...fields } = refusal;
  if (fleetRequestId === undefined) {
    eventBus.emit("lease.rejected", fields, module);
    return;
  }
  eventBus.emit("lease.declined", { ...fields, fleetRequestId }, module);
}
