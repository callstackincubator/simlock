import type { CleanupActionExecutor } from "./cleanup-executor.js";
import type { CapacityReader } from "./core-ports.js";
import { type DeviceRecord, type LeaseRecord, mayBeGranted, type Platform } from "./domain.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { compareLeastRecentlyUsed } from "./warm-pool.js";

export interface StartupRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

/** Safely completes a reclaim operation interrupted by daemon shutdown. */
export interface InterruptedReclaimRecovery {
  recoverInterruptedReclaim(device: DeviceRecord): Promise<void>;
}

/** Deletes a spent fresh device the previous process shut down but did not delete. */
export interface SpentDeviceDeletion {
  deleteSpent(device: DeviceRecord): Promise<void>;
}

/** Re-arms retry timers for devices still `quarantined` at startup, from persisted state. */
export interface QuarantineRestorer {
  restore(): void;
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
  readonly spentDeviceDeletion: SpentDeviceDeletion;
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
 * One limit on that, deliberate and not silent: a dark platform's devices still count toward
 * capacity (see `capacity/limits.ts`), so a large refused inventory can make the *healthy*
 * platform look over budget; excess selection below excludes them from the candidates, not from
 * the count.
 *
 * Only the device steps live here. Settling the requests a restart left open and restoring
 * every lease's expiry timer are leasing's, and the daemon runs them first (ADR 0018 §1).
 */
export class StartupConverger {
  constructor(private readonly options: StartupConvergerOptions) {}

  async converge(): Promise<void> {
    // A `quarantined` device already finished its release-time reclaim, so re-arming its retry
    // timer never races the reclaim recovery below.
    this.options.quarantineRestore.restore();
    await this.#recoverInterruptedReclaims();
    // After interrupted reclaims: a spent fresh device found `reclaiming` has just been shut
    // down there, and is deleted here along with any the previous process left `shutdown`.
    await this.#deleteSpentDevices();

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
    const interrupted = await this.options.decisions.run(() =>
      this.#actionableDevices("reclaiming"),
    );
    for (const device of interrupted) {
      await this.options.interruptedReclaimRecovery.recoverInterruptedReclaim(device);
    }
  }

  async #deleteSpentDevices(): Promise<void> {
    const spent = await this.options.decisions.run(() =>
      this.#actionableDevices("shutdown").filter((device) => !mayBeGranted(device)),
    );
    for (const device of spent) {
      await this.options.spentDeviceDeletion.deleteSpent(device);
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

    return this.#actionableDevices("ready")
      .filter(
        (device) =>
          !refused.has(device.id) &&
          (overPlatforms.length === 0 || overPlatforms.includes(device.spec.platform)),
      )
      .sort(compareLeastRecentlyUsed)[0];
  }

  /**
   * Devices in `state` that startup may act on: their platform has a driver, no lease holds
   * them, and no in-process operation has claimed them. Read inside a decision section.
   */
  #actionableDevices(state: DeviceRecord["state"]): DeviceRecord[] {
    const snapshot = this.options.registry.snapshot;
    const leasedDeviceIds = new Set(snapshot.leases.map((lease) => lease.deviceId));
    return snapshot.devices.filter(
      (device) =>
        device.state === state &&
        this.options.drivers.has(device.spec.platform) &&
        !leasedDeviceIds.has(device.id) &&
        !this.options.claims.isClaimed(device.id),
    );
  }
}
