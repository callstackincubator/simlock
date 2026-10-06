import { type Logger, NoopLogger } from "../ports/index.js";
import {
  type DeviceOperationClaims,
  type LeaseRecord,
  type ReleasedLease,
  type SerializedDecision,
  type ReclaimCoordinator,
} from "../core/index.js";

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

/**
 * What a daemon start does about the device of a lease it ends. `reclaim` wipes it in the
 * background and returns it to the pool; `wait` leaves it `reclaiming` with no reclaim started, for
 * a platform that could not be listed; `missing` marks it missing, for a device gone from a platform
 * that could.
 */
export type StartupDeviceOutcome = "reclaim" | "wait" | "missing";

/** How a lease is ended at startup: `expired` for one whose deadline passed, else `device-lost`. */
export interface StartupEnding {
  readonly device: StartupDeviceOutcome;
  readonly reason: "device-lost" | "expired";
}

/** The release a daemon start performs on a lease whose device is not running. */
export interface StartupLeaseEnder {
  endAtStartup(leaseId: string, ending: StartupEnding): Promise<void>;
}

export interface LeaseReleaseLifecycle {
  beginRelease(
    leaseId: string,
    reason: LeaseReleaseReason | "expired",
    options?: { readonly deferReclaim?: boolean },
  ): Promise<ReleasedLease>;
  endForMissingDevice(leaseId: string, reason: "expired" | "device-lost"): Promise<ReleasedLease>;
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
  readonly reclaim: Pick<ReclaimCoordinator, "reclaim">;
}

/**
 * How a release sequences its driver-side reclaim against its own caller.
 *
 * `background` is the default for every release a client or a timer can reach:
 * the registry-only half (lease gone, device `reclaiming`) is what the caller
 * actually needs, and the purge behind it is the slow part. `await` exists for
 * the one caller that needs the device settled before it continues -- the
 * maintenance-authorized release an operator reset runs (see
 * `releaseAllDuringMaintenance`). `none` starts no reclaim at all: the device stays
 * `reclaiming` for a later start to recover, which is what a lease ended on a platform that
 * could not be listed needs (see `endAtStartup`).
 */
type ReclaimMode = "await" | "background" | "none";

/**
 * Coordinates lease-side commands. Lease commits happen in the serialized
 * decision section; reclaiming is intentionally outside it, and -- except under
 * maintenance -- outside the caller's await as well (see `ReclaimMode`).
 *
 * releaseAll preserves the snapshot-and-parallel behavior it always had. Concurrent
 * calls are not idempotent: overlapping snapshots can yield UnknownLeaseError.
 */
export class LeaseReleaseCoordinator
  implements LeaseReleaseCommands, LeaseExpirationAdmin, LeaseReleaseMaintenance, StartupLeaseEnder
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
   * reclaim as every other one.
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
   * Ends a lease at daemon start, because its device is not running. An ordinary release in every
   * way but the device: `reclaim` starts the usual background reclaim, `wait` starts none and
   * takes no claim (a driver that just failed or hung on its listing would likely hang the
   * reclaim too, and a hung reclaim holds its claim with no end), and `missing` removes the lease
   * and marks the device missing in one write, with nothing to wipe.
   */
  async endAtStartup(leaseId: string, ending: StartupEnding): Promise<void> {
    await this.#runNormal(async () => {
      switch (ending.device) {
        case "missing":
          await this.options.decisions.run(() =>
            this.options.lifecycle.endForMissingDevice(leaseId, ending.reason),
          );
          return;
        case "reclaim":
          await this.#release(leaseId, ending.reason, { reclaim: "background" });
          return;
        case "wait":
          await this.#release(leaseId, ending.reason, { reclaim: "none" });
          return;
        default:
          throw new Error(`Unknown startup ending for ${leaseId}: ${String(ending.device)}`);
      }
    });
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
      // `none` is a wipe put off, not one given up: the device records it, so a later start
      // that can read its platform runs the full reclaim (ADR 0019 §2).
      return this.options.lifecycle.beginRelease(
        leaseId,
        reason,
        options.reclaim === "none" ? { deferReclaim: true } : {},
      );
    });
    if (released === undefined || options.reclaim === "none") return;
    if (options.reclaim === "background") {
      // The registry-only half committed above is the whole of what a releasing
      // caller needs: the lease record is gone, `lease.released` has been emitted,
      // and the device is `reclaiming` and therefore already ungrantable
      // (AcquisitionPlanner only ever selects `ready`). The slow part -- the
      // driver-side purge, where an iOS erase runs tens of seconds -- carries no
      // information the caller can act on, so it proceeds in the background and the
      // caller gets its turn back immediately. That matters most for an agent
      // releasing through MCP or the CLI, which would otherwise sit on a tool call
      // waiting for a device it has already given up, and for an operator's
      // `release --all` or `nuke`, where N leases would otherwise cost N serial
      // erases before the command answers (#43). Startup is the third such caller, for a
      // lease it ends because its device is not running (`endAtStartup`, ADR 0019).
      //
      // Kicked off here rather than queued, so every device's reclaim starts
      // immediately (not one-after-another): queuing would let a healthy reclaim sit
      // idle in `reclaiming` waiting its turn, which is exactly the state age a
      // stalled-transition detector would misread as a stall.
      this.#reclaimInBackground(released);
      return;
    }
    await this.options.reclaim.reclaim(released);
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
   * handled inside `ReclaimCoordinator#reclaim`, which quarantines the device
   * instead of rejecting, and stays visible in `simlock status` and
   * `device.purge-failed`.
   */
  #reclaimInBackground(released: ReleasedLease): void {
    const claim = this.options.claims.tryClaim(released.device.id, "reclaim");
    const reclaim = this.options.reclaim
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
        // `ReclaimCoordinator` already wakes the queue on every path that frees a
        // device, and it does so before this claim is released, so the wake-up here is a
        // safety net, not the one that serves a waiter: it runs after the claim is gone,
        // so matching sees the device even if an earlier wake-up raced the release.
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
