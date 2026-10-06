import type { Clock } from "../ports/index.js";
import type { DeviceRecord, LeaseRecord, ObservedDevice, StartupRead } from "../core/index.js";
import type { StartupDeviceOutcome, StartupLeaseEnder } from "./lease-release-coordinator.js";

export interface LeaseReconcilerRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

export interface LeaseReconcilerOptions {
  readonly clock: Pick<Clock, "now">;
  readonly ender: StartupLeaseEnder;
  readonly registry: LeaseReconcilerRegistry;
}

/**
 * ADR 0019 §2: checks every lease on disk against the startup read, and ends those whose device
 * is not running. A device that is `running` keeps its lease, whatever its deadline: restoring
 * the expiry timers afterwards expires an overdue one through the ordinary path. Any other
 * reading ends the lease, as `lease.expired` when its deadline passed while no daemon ran and as
 * `lease.released` with reason `device-lost` otherwise, and the device follows from what the read
 * says of it:
 *
 * - `stopped` or `transitioning` (booting, shutting down, or an Android emulator `adb` cannot
 *   attribute): wiped and returned to the pool by the ordinary reclaim;
 * - absent from a platform that could be read: marked missing in the same write, nothing to wipe;
 * - on a platform that could not be read: left `reclaiming` with no reclaim started, because "I
 *   could not look" is not "the device is gone" and a driver that just failed would likely hang
 *   the reclaim. A later start whose read succeeds recovers it.
 *
 * A device is judged by its registry `driverDeviceId`, on its own platform, the key doctor uses.
 */
export class LeaseReconciler {
  constructor(private readonly options: LeaseReconcilerOptions) {}

  // fallow-ignore-next-line unused-class-member -- reached through LeaseStartup's reconciler port.
  async run(read: StartupRead): Promise<void> {
    const { devices, leases } = this.options.registry.snapshot;
    const now = this.options.clock.now();
    for (const lease of [...leases].sort(byDeadline)) {
      const device = devices.find((candidate) => candidate.id === lease.deviceId);
      if (device === undefined) continue;
      const outcome = deviceOutcome(device, read);
      if (outcome === undefined) continue;
      await this.options.ender.endAtStartup(lease.id, {
        device: outcome,
        reason: lease.ttlDeadline <= now ? "expired" : "device-lost",
      });
    }
  }
}

/** What becomes of a lease's device, or undefined when the device is running and the lease stays. */
function deviceOutcome(device: DeviceRecord, read: StartupRead): StartupDeviceOutcome | undefined {
  const reality = read.reality(device.spec.platform);
  if (reality === undefined) return "wait";
  const observed: ObservedDevice | undefined = reality.devices.find(
    (candidate) => candidate.deviceId === device.driverDeviceId,
  );
  if (observed === undefined) return "missing";
  return observed.runState === "running" ? undefined : "reclaim";
}

function byDeadline(left: LeaseRecord, right: LeaseRecord): number {
  return left.ttlDeadline - right.ttlDeadline || left.id.localeCompare(right.id);
}
