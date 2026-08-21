import { type Logger, NoopLogger } from "../ports/index.js";
import type { DeviceOperationClaims } from "./device-operation-claims.js";
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
  /** Claims the reclaiming device for the duration of a backgrounded (orphaned) reclaim. */
  readonly claims: Pick<DeviceOperationClaims, "tryClaim">;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly lifecycle: LeaseReleaseLifecycle;
  readonly logger?: Logger;
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
  /**
   * Reclaims started by `#release`'s `orphaned` branch, tracked only so tests can
   * observe them settling; nothing in this class awaits the set itself. A daemon
   * that exits while one is in flight relies on `StartupConverger#recoverInterruptedReclaims`
   * to finish it on the next start (see the `orphaned` branch of `#release`).
   */
  readonly #backgroundReclaims = new Set<Promise<void>>();
  readonly #logger: Logger;
  readonly #maintenanceWaiters: (() => void)[] = [];
  #maintenanceDepth = 0;

  constructor(private readonly options: LeaseReleaseCoordinatorOptions) {
    this.#logger = options.logger?.child("lease-release-coordinator") ?? new NoopLogger();
  }

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
    if (reason === "orphaned") {
      // Startup convergence (StartupConverger#releaseOrphanedHeldLeases) only awaits
      // the registry-only release committed above -- the device is already
      // `reclaiming` and therefore already ungrantable (AcquisitionPlanner only ever
      // selects `ready`). The slow part, the driver-side reclaim (an erase can run
      // tens of seconds), proceeds in the background instead of blocking convergence,
      // so N orphaned leases no longer cost N serial erases on the startup critical
      // path (#43). Kicked off here rather than queued, so every orphaned device's
      // reclaim starts immediately (not one-after-another): queuing would let a
      // healthy reclaim sit idle in `reclaiming` waiting its turn, which is exactly
      // the state age a stalled-transition detector would misread as a stall.
      this.#reclaimInBackground(released);
      return;
    }
    await this.options.warmPool.reclaim(released);
  }

  /**
   * Claims the device before starting its reclaim so `StartupConverger
   * #recoverInterruptedReclaims`, which runs immediately afterward in the same
   * startup pass, does not mistake a reclaim this process just started for one
   * orphaned by a *previous* crash (that check excludes claimed devices
   * precisely so a live, in-process operation is never treated as interrupted).
   * The claim is released, and the failure logged rather than thrown, once the
   * reclaim settles -- nothing is awaiting this promise, so a rejection here
   * would otherwise be unhandled.
   */
  #reclaimInBackground(released: ReleasedLease): void {
    const claim = this.options.claims.tryClaim(released.device.id, "reclaim");
    const reclaim = this.options.warmPool
      .reclaim(released)
      .catch((error: unknown) => {
        this.#logger.error("background reclaim failed", {
          deviceId: released.device.id,
          error: error instanceof Error ? error.message : String(error),
          leaseId: released.lease.id,
        });
      })
      .finally(() => claim?.release());
    this.#backgroundReclaims.add(reclaim);
    void reclaim.finally(() => this.#backgroundReclaims.delete(reclaim));
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
