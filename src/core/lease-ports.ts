import type { CapacityPlatform, RunningCapacity } from "./capacity/index.js";
import type { LeaseRecord, Platform } from "./domain.js";
import type { DeviceRequest, PassthroughCommand, PassthroughContext } from "./driver.js";
import type { PlatformCatalog } from "./driver-catalog.js";
import type { LeaseGrant, LeaseRequestOptions } from "./wait-queue.js";

/** Client-requestable subset only -- deliberately excludes the internally-originated
 * `device-lost` (crash recovery giving up), which no client can ask for. Narrowed with
 * `LeaseReleaseCoordinator`'s own union under ADR 0004 §3: `closed` is gone because a closing
 * connection is not a release, and `orphaned` because there is no startup sweep left. */
export type LeaseReleaseReason = "explicit" | "killed";

/** Lease commands used by daemon request handlers. */
export interface LeaseCommands {
  request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant>;
  release(leaseId: string, reason: LeaseReleaseReason): Promise<void>;
  releaseAll(reason: LeaseReleaseReason): Promise<readonly string[]>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
}

/** Pending-demand operations used by status and connection cleanup. */
export interface QueueControl {
  readonly queueDepth: number;
  detachQueuedProgress(requesterId: string): Promise<void>;
  cancelPending(requesterId: string): Promise<"cancelled" | "not-found" | "not-cancellable">;
  /** ADR §4: the session principal a pending request was created under -- always the creating
   * session's principal (`LeaseRequestOptions.ownerId`), never the caller-suppliable
   * `requesterId`. `undefined` when no pending request exists for this requester id. Used by
   * `lease.cancel`'s `authorize` hook so a proxy connection (one principal, many
   * `requesterId`s) can cancel what it created, per ADR §4/§9. */
  pendingRequestOwner(requesterId: string): string | undefined;
}

/** Read-only capacity view used by daemon status. */
export interface CapacityReader {
  readonly runningCapacity: RunningCapacity;
  /** Managed-device ceiling, taken from the live strategy rather than from config. */
  deviceLimit(platform: CapacityPlatform): number;
}

/** Administrative lease expiry used by doctor reconciliation. */
export interface LeaseExpirer {
  expire(leaseId: string): Promise<void>;
}

/** Read-only device catalog used by the `simlock catalog` command and MCP tool. */
export interface CatalogReader {
  listCatalog(platform?: Platform): Promise<readonly PlatformCatalog[]>;
}

/**
 * Resolves `simlock <tool> <args>` into the scoped command its owning driver builds, for
 * the daemon request handler. Separate from `CatalogReader` because it answers about
 * tooling rather than about devices, and nothing on the lease path needs it.
 */
export interface PassthroughResolver {
  passthrough(
    tool: string,
    args: readonly string[],
    context?: PassthroughContext,
  ): PassthroughCommand;
}

/** Operator reset capability used by the nuke command facade. */
export interface NukeExecutor {
  nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }>;
}
