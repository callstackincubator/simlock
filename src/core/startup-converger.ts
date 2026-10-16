import { type DeviceRecord, type LeaseRecord, mayBeGranted, type VirtualDevice } from "./domain.js";
import type { SerializedDecision } from "./serialized-decision.js";
import type { StartupRead } from "./startup-read.js";

export interface StartupRegistry {
  readonly snapshot: {
    readonly virtualDevices: readonly VirtualDevice[];
    readonly leases: readonly LeaseRecord[];
  };
}

export interface InterruptedReclaimRecovery {
  recoverInterruptedReclaim(device: VirtualDevice): Promise<void>;
}

export interface SpentDeviceDeletion {
  deleteSpent(device: VirtualDevice): Promise<void>;
}

export interface QuarantineRestorer {
  restore(include: (device: DeviceRecord) => boolean): void;
}

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
 * Convergence never acts on a platform the startup read could not list: a `NoDriverError` out of
 * convergence would stop the whole daemon, costing the healthy platform too.
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
   * Devices in `state` that startup may act on: virtual (a physical record is never booted,
   * shut down or destroyed), their platform was read, no lease holds them, and no in-process
   * operation has claimed them. Read inside a decision section.
   */
  #actionableDevices(state: DeviceRecord["state"], read: StartupRead): VirtualDevice[] {
    const snapshot = this.options.registry.snapshot;
    const leasedDeviceIds = new Set(snapshot.leases.map((lease) => lease.deviceId));
    return snapshot.virtualDevices.filter(
      (device) =>
        device.state === state &&
        read.isReadable(device.spec.platform) &&
        !leasedDeviceIds.has(device.id) &&
        !this.options.claims.isClaimed(device.id),
    );
  }
}
