import type {
  CapacityDecision,
  CapacityDevice,
  CapacityPlatform,
  RunningCapacity,
  RunningCapacityEntry,
} from "./strategy.js";

/**
 * The running/device ceilings every strategy ultimately reduces to. Strategies
 * differ in how they arrive at these numbers and in what extra gates they apply
 * on top, not in how the ceilings themselves are enforced.
 */
export interface CapacityLimits {
  readonly maxRunning: number;
  readonly ios: { readonly maxDevices: number; readonly maxRunning: number };
  readonly android: { readonly maxDevices: number; readonly maxRunning: number };
}

const RUNNING_STATES = new Set(["ready", "leased", "reclaiming", "quarantined"]);

export function runningCapacity(
  devices: readonly CapacityDevice[],
  reservations: readonly CapacityPlatform[],
  limits: CapacityLimits,
): RunningCapacity {
  const entry = (platform?: CapacityPlatform): RunningCapacityEntry => {
    const running = devices.filter(
      (device) =>
        RUNNING_STATES.has(device.state) &&
        (platform === undefined || device.platform === platform),
    ).length;
    const reserved = reservations.filter(
      (reservation) => platform === undefined || reservation === platform,
    ).length;
    const maxRunning = platform === undefined ? limits.maxRunning : limits[platform].maxRunning;
    return { maxRunning, overLimit: running + reserved > maxRunning, reserved, running };
  };
  return { android: entry("android"), global: entry(), ios: entry("ios") };
}

export function canReserveRunning(
  platform: CapacityPlatform,
  devices: readonly CapacityDevice[],
  reservations: readonly CapacityPlatform[],
  limits: CapacityLimits,
): CapacityDecision {
  const capacity = runningCapacity(devices, reservations, limits);
  if (capacity.global.running + capacity.global.reserved >= capacity.global.maxRunning) {
    return { ok: false, reason: "global-running-limit" };
  }
  const platformCapacity = capacity[platform];
  if (platformCapacity.running + platformCapacity.reserved >= platformCapacity.maxRunning) {
    return { ok: false, reason: "platform-running-limit" };
  }
  return { ok: true };
}

export function withinDeviceLimit(
  platform: CapacityPlatform,
  devices: readonly CapacityDevice[],
  limits: CapacityLimits,
): boolean {
  return (
    activeDevices(devices).filter((device) => device.platform === platform).length <
    limits[platform].maxDevices
  );
}

export function activeDevices(devices: readonly CapacityDevice[]): readonly CapacityDevice[] {
  return devices.filter((device) => device.state !== "deleted");
}
