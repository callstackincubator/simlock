import type { CleanupActionExecutor } from "./cleanup-executor.js";
import type { DeviceRecord, LeaseRecord, Platform } from "./domain.js";
import type { CapacityReader } from "./lease-ports.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { compareLeastRecentlyUsed } from "./warm-pool.js";

export interface StartupRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

/** Restores persisted lease deadlines before any startup device work begins. */
export interface LeaseTimerRestorer {
  restoreExpiryTimers(): Promise<void>;
}

/** Safely completes a reclaim operation interrupted by daemon shutdown. */
export interface InterruptedReclaimRecovery {
  recoverInterruptedReclaim(device: DeviceRecord): Promise<void>;
}

/** Re-arms retry timers for devices still `quarantined` at startup, from persisted state. */
export interface QuarantineRestorer {
  restore(): void;
}

/**
 * Releases a lease orphaned by a daemon restart. A held lease's liveness is
 * its daemon connection, so any held lease found at startup has no holder by
 * definition; this port drives it through the normal release path (reason
 * `orphaned`) so the device is reclaimed and `lease.released` is emitted.
 */
export interface OrphanedLeaseRelease {
  releaseOrphaned(leaseId: string): Promise<void>;
}

/** Read-only operation claim view used to avoid an in-flight device operation. */
export interface DeviceClaimReader {
  isClaimed(deviceId: string): boolean;
}

/** Which platforms have a driver this daemon can drive devices through. */
export interface StartupDriverAvailability {
  has(platform: Platform): boolean;
}

export interface StartupConvergerOptions {
  readonly capacity: CapacityReader;
  readonly claims: DeviceClaimReader;
  readonly cleanup: CleanupActionExecutor;
  readonly decisions: SerializedDecision;
  readonly drivers: StartupDriverAvailability;
  readonly interruptedReclaimRecovery: InterruptedReclaimRecovery;
  readonly quarantineRestore: QuarantineRestorer;
  readonly registry: StartupRegistry;
  readonly releases: OrphanedLeaseRelease;
  readonly timers: LeaseTimerRestorer;
}

/**
 * Directly coordinates the required startup recovery sequence. It emits no
 * events itself; recovery and cleanup own their post-commit lifecycle facts.
 *
 * Convergence never calls a driver that was refused at discovery. Recovering or shutting a
 * device down needs a driver call there is no driver for, and a `NoDriverError` out of
 * convergence stops the whole daemon -- costing the healthy platform for a root the other one
 * rejected, which is the opposite of the per-platform fail-closed behaviour discovery
 * promises. `simlock doctor` reports the rejection; the inventory waits for the driver to
 * come back.
 *
 * Two limits on that, both deliberate and neither silent. `#releaseOrphanedHeldLeases` runs
 * first and unguarded: a held lease cannot have a live holder across a restart, so it is
 * released whatever its platform, which moves the device to `reclaiming` and leaves the
 * background reclaim to fail into its own catch. The device is then stuck in `reclaiming`
 * until its driver returns -- worse than untouched, better than a phantom lease pinning a
 * device nobody holds. And a dark platform's devices still count toward capacity (see
 * `capacity/limits.ts`), so a large refused inventory can make the *healthy* platform look
 * over budget; excess selection below excludes them from the candidates, not from the count.
 */
export class StartupConverger {
  constructor(private readonly options: StartupConvergerOptions) {}

  async converge(): Promise<void> {
    await this.#releaseOrphanedHeldLeases();
    await this.options.timers.restoreExpiryTimers();
    // Independent of lease/reclaim recovery above: a `quarantined` device already
    // finished its release-time reclaim, so re-arming its retry timer never races
    // either step.
    this.options.quarantineRestore.restore();
    await this.#recoverInterruptedReclaims();

    const refused = new Set<string>();
    for (;;) {
      const candidate = await this.options.decisions.run(() => this.#nextExcessCandidate(refused));
      if (candidate === undefined) return;

      const executed = await this.options.cleanup.execute({
        action: "shutdown",
        reason: "running capacity exceeds configured maxRunning",
        rule: "startup-max-running",
        target: candidate.id,
      });
      if (!executed) refused.add(candidate.id);
    }
  }

  /**
   * A held lease's liveness is its daemon connection, so any lease still in
   * `held` mode at startup is orphaned by definition — it cannot have a live
   * holder across a restart. Release it (reason `orphaned`) before timers are
   * restored, so its timer is never re-armed, and before capacity
   * convergence, so the freed device is visible to it. Detached leases are
   * untouched here; their liveness is the TTL, not a connection.
   */
  async #releaseOrphanedHeldLeases(): Promise<void> {
    const orphanedLeaseIds = await this.options.decisions.run(() =>
      this.options.registry.snapshot.leases
        .filter((lease) => lease.mode === "held")
        .map((lease) => lease.id),
    );
    for (const leaseId of orphanedLeaseIds) {
      await this.options.releases.releaseOrphaned(leaseId);
    }
  }

  async #recoverInterruptedReclaims(): Promise<void> {
    const interrupted = await this.options.decisions.run(() => {
      const snapshot = this.options.registry.snapshot;
      const leasedDeviceIds = new Set(snapshot.leases.map((lease) => lease.deviceId));
      return snapshot.devices.filter(
        (device) =>
          device.state === "reclaiming" &&
          this.options.drivers.has(device.spec.platform) &&
          !leasedDeviceIds.has(device.id) &&
          !this.options.claims.isClaimed(device.id),
      );
    });
    for (const device of interrupted) {
      await this.options.interruptedReclaimRecovery.recoverInterruptedReclaim(device);
    }
  }

  #nextExcessCandidate(refused: ReadonlySet<string>): DeviceRecord | undefined {
    const capacity = this.options.capacity.runningCapacity;
    const overPlatforms = (["ios", "android"] as const).filter(
      (platform) => capacity[platform].running > capacity[platform].maxRunning,
    );
    if (capacity.global.running <= capacity.global.maxRunning && overPlatforms.length === 0) {
      return undefined;
    }

    const snapshot = this.options.registry.snapshot;
    const leasedDeviceIds = new Set(snapshot.leases.map((lease) => lease.deviceId));
    return snapshot.devices
      .filter(
        (device) =>
          device.state === "ready" &&
          this.options.drivers.has(device.spec.platform) &&
          !leasedDeviceIds.has(device.id) &&
          !this.options.claims.isClaimed(device.id) &&
          !refused.has(device.id) &&
          (overPlatforms.length === 0 || overPlatforms.includes(device.spec.platform)),
      )
      .sort(compareLeastRecentlyUsed)[0];
  }
}
