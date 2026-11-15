import type { LeaseGrant } from "../admin/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import type { Logger } from "../ports/index.js";
import type { FleetForwarding } from "./fleet-forwarding.js";
import type { FleetFacts, FleetOutcomes } from "./fleet-facts.js";
import type { FleetLeaseEntry, FleetLeaseIndex } from "./lease-index.js";
import type { FleetLeaseGrant, FleetQueue, FleetWaiter } from "./queue.js";

export interface FleetGrantsOptions {
  readonly forwarding: FleetForwarding;
  readonly leaseIndex: FleetLeaseIndex;
  readonly logger: Logger;
  readonly queue: FleetQueue;
  readonly facts: FleetFacts;
  readonly outcomes: FleetOutcomes;
}

export class FleetGrants {
  constructor(private readonly options: FleetGrantsOptions) {}

  /**
   * why: H6 (round 2 review): the entry's `ownerId` comes from `waiter.options.ownerId` -- what this
   * gateway itself forwarded as `owner` in the `lease.request` a moment ago -- never from the
   * worker's own echo of it (`grant.lease.ownerId`). Everything this gateway authorizes
   * afterwards (`lease.renew`/`release`/`device.exec`) keys on the index's `ownerId`, so a worker
   * that ignored or rewrote the field would otherwise redefine ownership at the gateway; the
   * rebuild path (`FleetLeaseIndex#rebuildFromWorker`) has no better source and must trust the
   * worker, but this path already knows the answer. A mismatched echo is logged -- it means
   * either a worker bug or something worth knowing about, never silently swallowed.
   */
  settle(waiter: FleetWaiter, workerId: string, grant: LeaseGrant): "settled" | "retry" {
    // why: ADR 0020: a forwarded `leaseId` is the gateway lease id, bare, and never the worker's echo
    // of it -- a worker that granted something else is not believed, and its lease is given back.
    const forwardedLeaseId = waiter.options.leaseId;
    if (forwardedLeaseId !== undefined && grant.lease.id !== forwardedLeaseId) {
      this.options.logger.warn(
        "Worker granted a lease ID different from the leaseId the gateway forwarded",
        {
          forwardedLeaseId,
          grantedLeaseId: grant.lease.id,
          workerId,
        },
      );
      this.options.forwarding.releaseOnWorker(workerId, grant.lease.id);
      return "retry";
    }
    const gatewayLeaseId = forwardedLeaseId ?? `${workerId}.${grant.lease.id}`;
    if (grant.lease.ownerId !== waiter.options.ownerId) {
      this.options.logger.warn(
        "Worker echoed an ownerId different from the one the gateway forwarded",
        {
          echoedOwnerId: grant.lease.ownerId,
          forwardedOwnerId: waiter.options.ownerId,
          gatewayLeaseId,
          workerId,
        },
      );
    }
    const entry: FleetLeaseEntry = {
      gatewayLeaseId,
      grantedAt: grant.lease.grantedAt,
      idChosenByRequester: forwardedLeaseId !== undefined,
      ownerId: waiter.options.ownerId,
      requesterId: waiter.options.requesterId,
      workerId,
      workerLeaseId: grant.lease.id,
    };
    if (!this.options.leaseIndex.add(entry, waiter.request.platform)) {
      // why: The index already routes this bare id to another worker, which got it there first: the
      // new worker's lease is given back and the caller is told the id is taken.
      this.options.forwarding.releaseOnWorker(workerId, grant.lease.id);
      this.options.outcomes.reject(waiter, leaseIdTaken(gatewayLeaseId), "lease-id-taken");
      return "settled";
    }
    const fleetGrant: FleetLeaseGrant = {
      device: grant.device,
      environment: grant.environment,
      lease: this.options.forwarding.projectRecord(grant.lease, entry),
      timing: grant.timing,
    };
    // why: ADR 0021 §4: the grant is the request's end only if the waiter was still open. One that
    // landed after a timeout, a cancel or `dispose()` handed nothing to a caller, so it is no fact.
    if (this.options.queue.resolve(waiter, fleetGrant)) {
      this.options.facts.emit("request.granted", {
        leaseId: gatewayLeaseId,
        requestId: waiter.id,
        worker: workerId,
        workerLeaseId: grant.lease.id,
      });
    }
    return "settled";
  }
}

export function leaseIdTaken(leaseId: string): DispatchError {
  return new DispatchError("LEASE_ID_TAKEN", `lease ID ${leaseId} is already in use`, { leaseId });
}
