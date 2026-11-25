import type {
  DeviceRequest,
  DeviceSpec,
  LeaseGrant,
  LeaseRecord,
  Platform,
} from "../core/index.js";
import type { WaitingRequest } from "./lease-request-book.js";
import type { LeaseReleaseReason } from "./lease-release-coordinator.js";
import type { LeaseRequestOptions } from "./wait-queue.js";

export type ClientReleaseReason = Exclude<LeaseReleaseReason, "device-lost">;

/** why: the ids a run release ended or cancelled: the leases, and the waiting requests it stopped. */
export interface RunRelease {
  readonly leaseIds: readonly string[];
  readonly requestIds: readonly string[];
}

export interface LeaseCommands {
  request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant>;
  /** why: a read outside the decision lock: the handler skips its capability check when the request is a replay (ADR 0091 §3). */
  hasRequest(requesterId: string, idempotencyKey: string | undefined): boolean;
  release(leaseId: string, reason: ClientReleaseReason): Promise<void>;
  releaseAll(reason: ClientReleaseReason): Promise<readonly string[]>;
  releaseRun(runId: string, ownerId: string | undefined): Promise<RunRelease>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
}

export interface QueueControl {
  readonly queueDepth: number;
  readonly physicalQueueDepth: number;
  cancelPending(
    requesterId: string,
    platform?: Platform,
  ): Promise<"cancelled" | "not-found" | "not-cancellable">;
  pendingRequestOwner(requesterId: string, platform?: Platform): string | undefined;
  waitingRequests(): readonly WaitingRequest[];
}

export interface EndedLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly platform: Platform;
  // why: with the lease id it names the grant, so a file folder of an earlier lease with the same id is never touched.
  readonly grantedAt: number;
  readonly reason: "explicit" | "killed" | "expired" | "device-lost";
}

export interface LeaseEndParticipant {
  leaseEnded(ended: EndedLease, signal: AbortSignal): Promise<void>;
}

export interface DeviceModeReader {
  servesDefaultMode(spec: DeviceSpec): boolean;
}
