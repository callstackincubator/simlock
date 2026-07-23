import type { RunningCapacity } from "./capacity.js";
import type { LeaseRecord } from "./domain.js";
import type { DeviceRequest } from "./driver.js";
import type { LeaseGrant, LeaseRequestOptions } from "./wait-queue.js";

export type LeaseReleaseReason = "closed" | "explicit" | "killed";

/** Lease commands used by daemon request handlers. */
export interface LeaseCommands {
  request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant>;
  release(leaseId: string, reason: LeaseReleaseReason): Promise<void>;
  releaseAll(reason: Exclude<LeaseReleaseReason, "closed">): Promise<readonly string[]>;
  renew(leaseId: string, ttlMs: number): Promise<LeaseRecord>;
}

/** Pending-demand operations used by status and connection cleanup. */
export interface QueueControl {
  readonly queueDepth: number;
  detachQueuedProgress(requesterId: string): Promise<void>;
}

/** Read-only capacity view used by daemon status. */
export interface CapacityReader {
  readonly runningCapacity: RunningCapacity;
}

/** Administrative lease expiry used by doctor reconciliation. */
export interface LeaseExpirer {
  expire(leaseId: string): Promise<void>;
}

/** Operator reset capability used by the nuke command facade. */
export interface NukeExecutor {
  nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }>;
}
