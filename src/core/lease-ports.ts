import type { CapacityPlatform, RunningCapacity } from "./capacity/index.js";
import type { LeaseRecord, Platform } from "./domain.js";
import type { DeviceRequest } from "./driver.js";
import type { PlatformCatalog } from "./driver-catalog.js";
import type { LeaseGrant, LeaseRequestOptions } from "./wait-queue.js";

/** Client-requestable subset only -- deliberately excludes internally-originated reasons
 * like `orphaned` (startup orphan cleanup), which no client can ask for. */
export type LeaseReleaseReason = "closed" | "explicit" | "killed";

/** Lease commands used by daemon request handlers. */
export interface LeaseCommands {
  request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant>;
  release(leaseId: string, reason: LeaseReleaseReason): Promise<void>;
  releaseAll(reason: Exclude<LeaseReleaseReason, "closed">): Promise<readonly string[]>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
  heartbeat(leaseId: string): Promise<LeaseRecord>;
}

/** Pending-demand operations used by status and connection cleanup. */
export interface QueueControl {
  readonly queueDepth: number;
  detachQueuedProgress(requesterId: string): Promise<void>;
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

/** Operator reset capability used by the nuke command facade. */
export interface NukeExecutor {
  nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }>;
}
