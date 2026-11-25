import { leaseEndedError } from "../contract/index.js";
import { type DeviceRequest } from "../core/index.js";
import { type LeaseAcquisitionCoordinatorOptions } from "./acquisition-ports.js";
import { emitLeaseRefusal } from "./lease-refusal.js";
import {
  LeaseIdTakenError,
  type LeaseRequestOptions,
  requesterLimitDecision,
} from "./wait-queue.js";

export type AcquisitionAdmissionOptions = Pick<
  LeaseAcquisitionCoordinatorOptions,
  "eventBus" | "maxPerRequester" | "queue" | "registry" | "requests"
>;

/** why: the admission checks that refuse a request before it queues; each emits its refusal and then throws, and the class holds no state. */
export class AcquisitionAdmission {
  constructor(private readonly options: AcquisitionAdmissionOptions) {}

  refuseIfRequesterAtLimit(
    request: DeviceRequest,
    options: LeaseRequestOptions,
    requestId: string,
  ): void {
    const { devices, leases } = this.options.registry.snapshot;
    const held = leases
      .filter((lease) => lease.requesterId === options.requesterId)
      .map((lease) => {
        const platform = devices.find((device) => device.id === lease.deviceId)?.spec.platform;
        return {
          grantedAt: lease.grantedAt,
          id: lease.id,
          ...(platform === undefined ? {} : { platform }),
        };
      });
    const waiting = this.options.queue.pendingPlatforms(options.requesterId);
    // why: a probe's held leases were counted by the gateway, fleet-wide; only its waiting
    // request is checked here (ADR 0023 §2).
    const refusal = requesterLimitDecision({
      held,
      maxPerRequester: this.options.maxPerRequester,
      platform: request.platform,
      probe: options.fleetRequestId !== undefined,
      requesterId: options.requesterId,
      waiting,
    });
    if (refusal === undefined) return;
    emitLeaseRefusal(
      this.options.eventBus,
      {
        requestId,
        requester: options.requesterId,
        requestSpec: request,
        reason: "already-leased",
        fleetRequestId: options.fleetRequestId,
      },
      "lease-acquisition-coordinator",
    );
    throw refusal;
  }

  /**
   * why: ADR 0020: the one clash check on a host, inside the same admission section as the
   * one-lease-per-requester check and after it. An ID is held by an active lease and by a
   * request still waiting, so a restart, which fails every waiting request, frees it.
   */
  refuseIfLeaseIdTaken(
    request: DeviceRequest,
    options: LeaseRequestOptions,
    requestId: string,
  ): void {
    const { leaseId } = options;
    if (leaseId === undefined) return;
    if (
      !this.options.registry.snapshot.leases.some((lease) => lease.id === leaseId) &&
      !this.options.requests.holdsLeaseId(leaseId)
    ) {
      return;
    }
    emitLeaseRefusal(
      this.options.eventBus,
      {
        requestId,
        requester: options.requesterId,
        requestSpec: request,
        reason: "lease-id-taken",
        fleetRequestId: options.fleetRequestId,
      },
      "lease-acquisition-coordinator",
    );
    throw new LeaseIdTakenError(leaseId);
  }

  /** why: ADR 0074 §4: a chosen id whose lease ended within `lease.endedIdRetentionMs` is refused, after the taken-id check so a live id stays `LEASE_ID_TAKEN`. */
  refuseIfLeaseIdEnded(
    request: DeviceRequest,
    options: LeaseRequestOptions,
    requestId: string,
  ): void {
    const { leaseId } = options;
    if (leaseId === undefined) return;
    const endedAt = this.options.registry.endedLeaseId(leaseId);
    if (endedAt === undefined) return;
    emitLeaseRefusal(
      this.options.eventBus,
      {
        requestId,
        requester: options.requesterId,
        requestSpec: request,
        reason: "lease-ended",
        fleetRequestId: options.fleetRequestId,
      },
      "lease-acquisition-coordinator",
    );
    throw leaseEndedError(leaseId, endedAt);
  }

  refuseForUpdate(
    requestId: string,
    request: DeviceRequest,
    options: Pick<LeaseRequestOptions, "requesterId" | "fleetRequestId">,
  ): void {
    emitLeaseRefusal(
      this.options.eventBus,
      {
        requestId,
        requester: options.requesterId,
        requestSpec: request,
        reason: "updating",
        fleetRequestId: options.fleetRequestId,
      },
      "lease-acquisition-coordinator",
    );
  }
}
