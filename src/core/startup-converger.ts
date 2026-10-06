import { type DeviceRecord, type LeaseRecord, mayBeGranted } from "./domain.js";
import type { SerializedDecision } from "./serialized-decision.js";
import type { StartupRead } from "./startup-read.js";

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
  restore(include: (device: DeviceRecord) => boolean): void;
}

/** Read-only operation claim view used to avoid an in-flight device operation. */
export interface DeviceClaimReader {
  isClaimed(deviceId: string): boolean;
}

export interface StartupConvergerOptions {
  readonly claims: DeviceClaimReader;
  readonly decisions: SerializedDecision;
  readonly interruptedReclaimRecovery: InterruptedReclaimRecovery;
  readonly quarantineRestore: QuarantineRestorer;
  readonly registry: StartupRegistry;
  readonly spentDeviceDeletion: SpentDeviceDeletion;
}

/**
 * Directly coordinates the required startup recovery sequence. It emits no
 * events itself; recovery and cleanup own their post-commit lifecycle facts.
 *
 * Convergence never acts on a platform the startup read could not list: a platform whose driver
 * was refused at discovery, or whose listing failed or hung. Recovering or shutting a
 * device down needs a driver call there is no driver for, and a `NoDriverError` out of
 * convergence stops the whole daemon -- costing the healthy platform for a root the other one
 * rejected, which is the opposite of the per-platform fail-closed behaviour discovery
 * promises. `simlock doctor` reports the rejection; the inventory waits for the driver to
 * come back. That includes a quarantined device's retry timer: a retry already due would drive
 * a driver the read just found failing or hung.
 *
 * A device a daemon start left `reclaiming` with its wipe put off, because it could not read the
 * device's platform (ADR 0019 §2), has its full reclaim started here once a start reads that
 * platform, in the background under a claim: startup does not wait for the erase. Any other
 * interrupted reclaim is only shut down.
 *
 * Only the device steps live here. Settling the requests a restart left open, ending the leases
 * whose device is not running and restoring the expiry timers of the leases left are leasing's,
 * and the daemon runs them first (ADR 0018 §1, ADR 0019 §1).
 */
export class StartupConverger {
  constructor(private readonly options: StartupConvergerOptions) {}

  async converge(read: StartupRead): Promise<void> {
    // A `quarantined` device already finished its release-time reclaim, so re-arming its retry
    // timer never races the reclaim recovery below. A device on a platform the read could not
    // list is skipped: a retry that is already due would drive that platform's driver now.
    this.options.quarantineRestore.restore((device) => read.isReadable(device.spec.platform));
    await this.#recoverInterruptedReclaims(read);
    // After interrupted reclaims: a spent fresh device found `reclaiming` has just been shut
    // down there, and is deleted here along with any the previous process left `shutdown`.
    await this.#deleteSpentDevices(read);
  }

  async #recoverInterruptedReclaims(read: StartupRead): Promise<void> {
    const interrupted = await this.options.decisions.run(() =>
      this.#actionableDevices("reclaiming", read),
    );
    for (const device of interrupted) {
      await this.options.interruptedReclaimRecovery.recoverInterruptedReclaim(device);
    }
  }

  async #deleteSpentDevices(read: StartupRead): Promise<void> {
    const spent = await this.options.decisions.run(() =>
      this.#actionableDevices("shutdown", read).filter((device) => !mayBeGranted(device)),
    );
    for (const device of spent) {
      await this.options.spentDeviceDeletion.deleteSpent(device);
    }
  }

  /**
   * Devices in `state` that startup may act on: their platform was read, no lease holds
   * them, and no in-process operation has claimed them. Read inside a decision section.
   */
  #actionableDevices(state: DeviceRecord["state"], read: StartupRead): DeviceRecord[] {
    const snapshot = this.options.registry.snapshot;
    const leasedDeviceIds = new Set(snapshot.leases.map((lease) => lease.deviceId));
    return snapshot.devices.filter(
      (device) =>
        device.state === state &&
        read.isReadable(device.spec.platform) &&
        !leasedDeviceIds.has(device.id) &&
        !this.options.claims.isClaimed(device.id),
    );
  }
}
