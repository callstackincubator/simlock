import type { LeaseRecord } from "./domain.js";
import type { ReleasedLease } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import type { WarmPoolCoordinator } from "./warm-pool-coordinator.js";

export type LeaseReleaseReason = "closed" | "explicit" | "killed" | "orphaned" | "device-lost";

export interface LeaseReleaseCommands {
  release(leaseId: string, reason: LeaseReleaseReason): Promise<void>;
  releaseAll(reason: Exclude<LeaseReleaseReason, "closed">): Promise<readonly string[]>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
  heartbeat(leaseId: string): Promise<LeaseRecord>;
}

export interface LeaseExpirationAdmin {
  expire(leaseId: string, expectedDeadline?: number): Promise<void>;
}

/** Administrative boundary that fences release/reclaim work during reset. */
export interface LeaseReleaseMaintenance {
  beginMaintenance(): Promise<void>;
  releaseAllDuringMaintenance(reason: "killed"): Promise<readonly string[]>;
  endMaintenance(): Promise<void>;
}

export interface LeaseReleaseLifecycle {
  beginRelease(leaseId: string, reason: LeaseReleaseReason | "expired"): Promise<ReleasedLease>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
  heartbeat(leaseId: string): Promise<LeaseRecord>;
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
export class LeaseReleaseCoordinator
  implements LeaseReleaseCommands, LeaseExpirationAdmin, LeaseReleaseMaintenance
{
  readonly #activeWorkflows = new Set<Promise<void>>();
  readonly #maintenanceWaiters: (() => void)[] = [];
  #maintenanceDepth = 0;

  constructor(private readonly options: LeaseReleaseCoordinatorOptions) {}

  async release(leaseId: string, reason: LeaseReleaseReason): Promise<void> {
    await this.#runNormal(() => this.#release(leaseId, reason));
  }

  async releaseAll(reason: "explicit" | "killed"): Promise<readonly string[]> {
    return this.#runNormal(() => this.#releaseAll(reason));
  }

  /**
   * Gives up a lease whose device could not be brought back. Internally
   * originated only -- no client can ask for it -- but it is an ordinary
   * release otherwise, so it takes the same maintenance admission and the same
   * warm-pool reclaim as every other one.
   */
  async releaseDeviceLost(leaseId: string): Promise<void> {
    await this.#runNormal(() => this.#release(leaseId, "device-lost"));
  }

  async expire(leaseId: string, expectedDeadline?: number): Promise<void> {
    await this.#runNormal(() => this.#release(leaseId, "expired", expectedDeadline));
  }

  async renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord> {
    return this.#runNormal(() =>
      this.options.decisions.run(() => this.options.lifecycle.renew(leaseId, ttlMs)),
    );
  }

  async heartbeat(leaseId: string): Promise<LeaseRecord> {
    return this.#runNormal(() =>
      this.options.decisions.run(() => this.options.lifecycle.heartbeat(leaseId)),
    );
  }

  // fallow-ignore-next-line unused-class-member -- called through LeaseMaintenance by NukeService.
  async beginMaintenance(): Promise<void> {
    await this.options.decisions.run(() => {
      this.#maintenanceDepth += 1;
    });
    while (this.#activeWorkflows.size > 0) {
      await Promise.allSettled(this.#activeWorkflows);
    }
  }

  // fallow-ignore-next-line unused-class-member -- called through LeaseMaintenance by NukeService.
  async releaseAllDuringMaintenance(reason: "killed"): Promise<readonly string[]> {
    await this.options.decisions.run(() => {
      if (this.#maintenanceDepth === 0) {
        throw new Error("Maintenance-authorized release requires active maintenance");
      }
    });
    return this.#releaseAll(reason);
  }

  // fallow-ignore-next-line unused-class-member -- called through LeaseMaintenance by NukeService.
  async endMaintenance(): Promise<void> {
    const waiters = await this.options.decisions.run(() => {
      this.#maintenanceDepth = Math.max(0, this.#maintenanceDepth - 1);
      return this.#maintenanceDepth === 0 ? this.#maintenanceWaiters.splice(0) : [];
    });
    for (const wake of waiters) wake();
  }

  async #release(
    leaseId: string,
    reason: LeaseReleaseReason | "expired",
    expectedDeadline?: number,
  ): Promise<void> {
    const released = await this.options.decisions.run(() => {
      if (expectedDeadline !== undefined) {
        const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
        if (current?.ttlDeadline !== expectedDeadline) return undefined;
      }
      return this.options.lifecycle.beginRelease(leaseId, reason);
    });
    if (released === undefined) return;
    await this.options.warmPool.reclaim(released);
  }

  async #releaseAll(reason: "explicit" | "killed"): Promise<readonly string[]> {
    const leaseIds = this.options.registry.snapshot.leases.map((lease) => lease.id);
    await Promise.all(leaseIds.map(async (leaseId) => this.#release(leaseId, reason)));
    return leaseIds;
  }

  async #runNormal<Result>(workflow: () => Promise<Result>): Promise<Result> {
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await this.#awaitAdmission(completion);

    try {
      return await workflow();
    } finally {
      complete();
      this.#activeWorkflows.delete(completion);
    }
  }

  async #awaitAdmission(completion: Promise<void>): Promise<void> {
    for (;;) {
      let waitForOpen: Promise<void> | undefined;
      const admitted = await this.options.decisions.run(() => {
        if (this.#maintenanceDepth === 0) {
          this.#activeWorkflows.add(completion);
          return true;
        }
        waitForOpen = new Promise<void>((resolve) => this.#maintenanceWaiters.push(resolve));
        return false;
      });
      if (admitted) return;
      await waitForOpen;
    }
  }
}
