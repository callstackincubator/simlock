import { type Logger, NoopLogger } from "../ports/index.js";
import type { DeviceOperationClaims } from "./device-operation-claims.js";
import type { LeaseRecord } from "./domain.js";
import type { ReleasedLease } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import type { WarmPoolCoordinator } from "./warm-pool-coordinator.js";

export type LeaseReleaseReason = "explicit" | "killed" | "device-lost";

export interface LeaseReleaseCommands {
  release(leaseId: string, reason: LeaseReleaseReason): Promise<void>;
  releaseAll(reason: Exclude<LeaseReleaseReason, "device-lost">): Promise<readonly string[]>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
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
}

export interface LeaseReleaseRegistry {
  readonly snapshot: { readonly leases: readonly LeaseRecord[] };
}

export interface LeaseReleaseCoordinatorOptions {
  /** Claims the reclaiming device for the duration of a backgrounded reclaim. */
  readonly claims: Pick<DeviceOperationClaims, "tryClaim">;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly lifecycle: LeaseReleaseLifecycle;
  readonly logger?: Logger;
  /**
   * Re-kicks acquisition once a backgrounded reclaim has fully settled *and* given
   * up its claim. Load-bearing rather than belt-and-braces: see `#reclaimInBackground`.
   */
  readonly notifyAvailability: () => void;
  readonly registry: LeaseReleaseRegistry;
  readonly warmPool: Pick<WarmPoolCoordinator, "reclaim">;
}

/**
 * How a release sequences its driver-side reclaim against its own caller.
 *
 * `background` is the default for every release a client or a timer can reach:
 * the registry-only half (lease gone, device `reclaiming`) is what the caller
 * actually needs, and the purge behind it is the slow part. `await` exists for
 * the one caller that needs the device settled before it continues -- the
 * maintenance-authorized release an operator reset runs (see
 * `releaseAllDuringMaintenance`).
 */
type ReclaimMode = "await" | "background";

/**
 * Coordinates lease-side commands. Lease commits happen in the serialized
 * decision section; reclaiming is intentionally outside it, and -- except under
 * maintenance -- outside the caller's await as well (see `ReclaimMode`).
 *
 * releaseAll preserves the engine's snapshot-and-parallel behavior. Concurrent
 * calls are not idempotent: overlapping snapshots can yield UnknownLeaseError.
 */
export class LeaseReleaseCoordinator
  implements LeaseReleaseCommands, LeaseExpirationAdmin, LeaseReleaseMaintenance
{
  readonly #activeWorkflows = new Set<Promise<void>>();
  /**
   * Every reclaim `#release` handed off instead of awaiting. Ordinary release
   * callers never wait on this set -- that is the point of it -- but two callers
   * that cannot proceed against a half-reclaimed device do: `beginMaintenance`
   * (an operator reset must see settled devices) and `settleBackgroundReclaims`
   * (graceful daemon shutdown). A daemon that dies without that drain leaves its
   * in-flight reclaims for `StartupConverger#recoverInterruptedReclaims` to
   * finish on the next start.
   */
  readonly #backgroundReclaims = new Set<Promise<void>>();
  readonly #logger: Logger;
  readonly #maintenanceWaiters: (() => void)[] = [];
  #maintenanceDepth = 0;

  constructor(private readonly options: LeaseReleaseCoordinatorOptions) {
    this.#logger = options.logger?.child("lease-release-coordinator") ?? new NoopLogger();
  }

  async release(leaseId: string, reason: LeaseReleaseReason): Promise<void> {
    await this.#runNormal(() => this.#release(leaseId, reason, { reclaim: "background" }));
  }

  async releaseAll(reason: "explicit" | "killed"): Promise<readonly string[]> {
    return this.#runNormal(() => this.#releaseAll(reason, "background"));
  }

  /**
   * Gives up a lease whose device could not be brought back. Internally
   * originated only -- no client can ask for it -- but it is an ordinary
   * release otherwise, so it takes the same maintenance admission and the same
   * warm-pool reclaim as every other one.
   */
  async releaseDeviceLost(leaseId: string): Promise<void> {
    await this.#runNormal(() => this.#release(leaseId, "device-lost", { reclaim: "background" }));
  }

  async expire(leaseId: string, expectedDeadline?: number): Promise<void> {
    await this.#runNormal(() =>
      this.#release(leaseId, "expired", {
        ...(expectedDeadline === undefined ? {} : { expectedDeadline }),
        reclaim: "background",
      }),
    );
  }

  /**
   * Awaits every reclaim currently running in the background. Nothing on a
   * client's path calls this -- a graceful daemon shutdown does, so a `simlock
   * daemon stop` still leaves the pool in the same settled shape an inline
   * reclaim used to. An ungraceful death instead leaves those devices
   * `reclaiming` for `StartupConverger#recoverInterruptedReclaims`.
   */
  async settleBackgroundReclaims(): Promise<void> {
    while (this.#backgroundReclaims.size > 0) {
      await Promise.allSettled(this.#backgroundReclaims);
    }
  }

  async renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord> {
    return this.#runNormal(() =>
      this.options.decisions.run(() => this.options.lifecycle.renew(leaseId, ttlMs)),
    );
  }

  // fallow-ignore-next-line unused-class-member -- called through LeaseMaintenance by NukeService.
  async beginMaintenance(): Promise<void> {
    await this.options.decisions.run(() => {
      this.#maintenanceDepth += 1;
    });
    // Backgrounded reclaims are drained alongside the workflows that started them:
    // a device still `reclaiming` is neither `ready` nor `shutdown`, so an operator
    // reset would silently skip it (`NukeService#canOperate`) and leave a device
    // running that the reset was supposed to take down.
    while (this.#activeWorkflows.size > 0 || this.#backgroundReclaims.size > 0) {
      await Promise.allSettled([...this.#activeWorkflows, ...this.#backgroundReclaims]);
    }
  }

  // fallow-ignore-next-line unused-class-member -- called through LeaseMaintenance by NukeService.
  async releaseAllDuringMaintenance(reason: "killed"): Promise<readonly string[]> {
    await this.options.decisions.run(() => {
      if (this.#maintenanceDepth === 0) {
        throw new Error("Maintenance-authorized release requires active maintenance");
      }
    });
    // Awaited rather than backgrounded: the reset walks the device list straight
    // afterwards and only acts on `ready`/`shutdown` records, so a reclaim still in
    // flight would take its device out of that walk entirely.
    return this.#releaseAll(reason, "await");
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
    options: { readonly expectedDeadline?: number; readonly reclaim: ReclaimMode },
  ): Promise<void> {
    const { expectedDeadline } = options;
    const released = await this.options.decisions.run(() => {
      if (expectedDeadline !== undefined) {
        const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
        if (current?.ttlDeadline !== expectedDeadline) return undefined;
      }
      return this.options.lifecycle.beginRelease(leaseId, reason);
    });
    if (released === undefined) return;
    if (options.reclaim === "background") {
      // The registry-only half committed above is the whole of what a releasing
      // caller needs: the lease record is gone, `lease.released` has been emitted,
      // and the device is `reclaiming` and therefore already ungrantable
      // (AcquisitionPlanner only ever selects `ready`). The slow part -- the
      // driver-side purge, where an iOS erase runs tens of seconds -- carries no
      // information the caller can act on, so it proceeds in the background and the
      // caller gets its turn back immediately. That matters most for an agent
      // releasing through MCP or the CLI, which would otherwise sit on a tool call
      // waiting for a device it has already given up, and for startup convergence
      // (StartupConverger#releaseOrphanedHeldLeases), where N orphaned leases used
      // to cost N serial erases on the critical path (#43).
      //
      // Kicked off here rather than queued, so every device's reclaim starts
      // immediately (not one-after-another): queuing would let a healthy reclaim sit
      // idle in `reclaiming` waiting its turn, which is exactly the state age a
      // stalled-transition detector would misread as a stall.
      this.#reclaimInBackground(released);
      return;
    }
    await this.options.warmPool.reclaim(released);
  }

  /**
   * Claims the device for the reclaim's duration. Two readers depend on that claim
   * to tell a live in-process reclaim apart from an abandoned one: `StartupConverger
   * #recoverInterruptedReclaims`, which must not mistake a reclaim this process just
   * started for one orphaned by a *previous* crash, and `simlock doctor`'s
   * stalled-transition finding, which must not read a legitimately long erase as a
   * driver call that never returned. Both exclude claimed devices for exactly this
   * reason; a reclaim orphaned by a crash carries no claim in the new process, so
   * neither check loses the case it exists for.
   *
   * The claim is released, and the failure logged rather than thrown, once the
   * reclaim settles -- no caller is awaiting this promise, so a rejection here would
   * otherwise be unhandled. A purge that fails at the driver is not that case: it is
   * handled inside `WarmPoolCoordinator#reclaim`, which quarantines the device
   * instead of rejecting, and stays visible in `simlock status` and
   * `device.purge-failed`.
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
      .finally(() => {
        claim?.release();
        // `WarmPoolCoordinator#reclaim` fires its own availability notification while
        // this claim is still held, and a claimed device is invisible to
        // `AcquisitionPlanner` -- so a waiter queued for exactly this device would
        // sleep through it and sit there until some unrelated event kicked the queue.
        // Notifying again here, after the claim is gone, is what closes that window.
        this.options.notifyAvailability();
      });
    this.#backgroundReclaims.add(reclaim);
    void reclaim.finally(() => this.#backgroundReclaims.delete(reclaim));
  }

  async #releaseAll(
    reason: "explicit" | "killed",
    reclaim: ReclaimMode,
  ): Promise<readonly string[]> {
    const leaseIds = this.options.registry.snapshot.leases.map((lease) => lease.id);
    await Promise.all(leaseIds.map(async (leaseId) => this.#release(leaseId, reason, { reclaim })));
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
