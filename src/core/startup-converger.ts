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

/** Restores every persisted lease's TTL timer before any startup device work begins. */
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
  readonly quarantineRestore: QuarantineRestorer;
  readonly registry: StartupRegistry;
  readonly timers: LeaseTimerRestorer;
}

/**
 * Directly coordinates the required startup recovery sequence. It emits no
 * events itself; recovery and cleanup own their post-commit lifecycle facts.
 */
export class StartupConverger {
  constructor(private readonly options: StartupConvergerOptions) {}

  async converge(): Promise<void> {
    // ADR 0004: every lease's timer is restored from its own persisted deadline, and nothing
    // is swept -- a restart does not prove a holder is dead, so no lease is released on the
    // strength of one. A lease whose deadline already passed while no daemon was running
    // expires here, through the ordinary expiry path `restore` drives.
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
