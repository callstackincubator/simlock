import type { LeaseRecord } from "./domain.js";
import type { ReleasedLease } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import type { WarmPoolCoordinator } from "./warm-pool-coordinator.js";

export type LeaseReleaseReason = "closed" | "explicit" | "killed";

export interface LeaseReleaseCommands {
  release(leaseId: string, reason: LeaseReleaseReason): Promise<void>;
  releaseAll(reason: Exclude<LeaseReleaseReason, "closed">): Promise<readonly string[]>;
  renew(leaseId: string, ttlMs: number): Promise<LeaseRecord>;
}

export interface LeaseExpirationAdmin {
  expire(leaseId: string): Promise<void>;
}

export interface LeaseReleaseLifecycle {
  beginRelease(leaseId: string, reason: LeaseReleaseReason | "expired"): Promise<ReleasedLease>;
  renew(leaseId: string, ttlMs: number): Promise<LeaseRecord>;
}

export interface LeaseReleaseRegistry {
  readonly snapshot: { readonly leases: readonly LeaseRecord[] };
}

export interface LeaseReleaseCoordinatorOptions {
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly lifecycle: LeaseReleaseLifecycle;
  readonly registry: LeaseReleaseRegistry;
  readonly warmPool: Pick<WarmPoolCoordinator, "reclaim">;
}

/**
 * Coordinates lease-side commands. Lease commits happen in the serialized
 * decision section; reclaiming is intentionally outside it.
 *
 * releaseAll preserves the engine's snapshot-and-parallel behavior. Concurrent
 * calls are not idempotent: overlapping snapshots can yield UnknownLeaseError.
 */
export class LeaseReleaseCoordinator implements LeaseReleaseCommands, LeaseExpirationAdmin {
  constructor(private readonly options: LeaseReleaseCoordinatorOptions) {}

  async release(leaseId: string, reason: LeaseReleaseReason): Promise<void> {
    await this.#release(leaseId, reason);
  }

  async releaseAll(reason: "explicit" | "killed"): Promise<readonly string[]> {
    const leaseIds = this.options.registry.snapshot.leases.map((lease) => lease.id);
    await Promise.all(leaseIds.map(async (leaseId) => this.release(leaseId, reason)));
    return leaseIds;
  }

  async expire(leaseId: string): Promise<void> {
    await this.#release(leaseId, "expired");
  }

  renew(leaseId: string, ttlMs: number): Promise<LeaseRecord> {
    return this.options.decisions.run(() => this.options.lifecycle.renew(leaseId, ttlMs));
  }

  async #release(leaseId: string, reason: LeaseReleaseReason | "expired"): Promise<void> {
    const released = await this.options.decisions.run(() =>
      this.options.lifecycle.beginRelease(leaseId, reason),
    );
    await this.options.warmPool.reclaim(released);
  }
}
