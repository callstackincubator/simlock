import type { CleanupActionExecutor } from "./cleanup-executor.js";
import type { DeviceRecord, LeaseRecord } from "./domain.js";
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

export interface StartupConvergerOptions {
  readonly capacity: CapacityReader;
  readonly claims: DeviceClaimReader;
  readonly cleanup: CleanupActionExecutor;
  readonly decisions: SerializedDecision;
  readonly interruptedReclaimRecovery: InterruptedReclaimRecovery;
  readonly registry: StartupRegistry;
  readonly releases: OrphanedLeaseRelease;
  readonly timers: LeaseTimerRestorer;
}

/**
 * Directly coordinates the required startup recovery sequence. It emits no
 * events itself; recovery and cleanup own their post-commit lifecycle facts.
 */
export class StartupConverger {
  constructor(private readonly options: StartupConvergerOptions) {}

  async converge(): Promise<void> {
    await this.#releaseOrphanedHeldLeases();
    await this.options.timers.restoreExpiryTimers();
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
          !leasedDeviceIds.has(device.id) &&
          !this.options.claims.isClaimed(device.id) &&
          !refused.has(device.id) &&
          (overPlatforms.length === 0 || overPlatforms.includes(device.spec.platform)),
      )
      .sort(compareLeastRecentlyUsed)[0];
  }
}
