import type { DeviceRequest, DeviceSpec, LeaseGrant, LeaseRecord } from "../core/index.js";
import type { WaitingRequest } from "./lease-request-book.js";
import type { LeaseReleaseReason } from "./lease-release-coordinator.js";
import type { LeaseRequestOptions } from "./wait-queue.js";

/** Client-requestable subset only -- deliberately excludes the internally-originated
 * `device-lost` (crash recovery giving up), which no client can ask for. Narrowed from
 * `LeaseReleaseReason` under ADR 0004 §3: `closed` is gone because a closing connection is not a
 * release, and `orphaned` because there is no startup sweep left. */
export type ClientReleaseReason = Exclude<LeaseReleaseReason, "device-lost">;

/** Lease commands used by daemon request handlers. */
export interface LeaseCommands {
  request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant>;
  release(leaseId: string, reason: ClientReleaseReason): Promise<void>;
  releaseAll(reason: ClientReleaseReason): Promise<readonly string[]>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
}

/** Pending-demand operations used by status and connection cleanup. */
export interface QueueControl {
  readonly queueDepth: number;
  cancelPending(requesterId: string): Promise<"cancelled" | "not-found" | "not-cancellable">;
  /** ADR §4: the session principal a pending request was created under -- always the creating
   * session's principal (`LeaseRequestOptions.ownerId`), never the caller-suppliable
   * `requesterId`. `undefined` when no pending request exists for this requester id. Used by
   * `lease.cancel`'s `authorize` hook so a proxy connection (one principal, many
   * `requesterId`s) can cancel what it created, per ADR §4/§9. */
  pendingRequestOwner(requesterId: string): string | undefined;
  /** Every request still waiting for a device, oldest first (`LeaseRequestBook#waiting`). */
  waitingRequests(): readonly WaitingRequest[];
}

/**
 * Whether a device's pool is the one a request naming no mode draws from. Answered where the
 * default mode is resolved (ADR 0007 §2), so status never re-derives it.
 */
export interface DeviceModeReader {
  servesDefaultMode(spec: DeviceSpec): boolean;
}
