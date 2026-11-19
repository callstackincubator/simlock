import type {
  CapacityDecision,
  CapacityDevice,
  CapacityPlatform,
  CapacityStrategy,
  PlannedCapacityDevice,
  RunningCapacity,
} from "./strategy.js";

const PLATFORMS: readonly CapacityPlatform[] = ["ios", "android"];

/**
 * why: a platform with no driver on this host (iOS on Windows or Linux) can never run a device, so
 * it gets no device or running slot and the global running limit counts only the platforms that can
 * (#1689). A platform whose driver was refused still serves: its devices hold slots.
 */
export function servingOnly(
  strategy: CapacityStrategy,
  serves: (platform: CapacityPlatform) => boolean,
): CapacityStrategy {
  const unserved = PLATFORMS.filter((platform) => !serves(platform));
  if (unserved.length === 0) return strategy;
  const refused = (platform: CapacityPlatform): boolean => unserved.includes(platform);

  const runningCapacity = (
    devices: readonly CapacityDevice[],
    reservations: readonly CapacityPlatform[],
  ): RunningCapacity => {
    const inner = strategy.runningCapacity(devices, reservations);
    const entry = (platform: CapacityPlatform) =>
      refused(platform)
        ? {
            ...inner[platform],
            maxRunning: 0,
            overLimit: inner[platform].running + inner[platform].reserved > 0,
          }
        : inner[platform];
    const ios = entry("ios");
    const android = entry("android");
    const maxRunning = Math.min(inner.global.maxRunning, ios.maxRunning + android.maxRunning);
    return {
      android,
      global: {
        ...inner.global,
        maxRunning,
        overLimit: inner.global.running + inner.global.reserved > maxRunning,
      },
      ios,
    };
  };

  return {
    canBoot: (device, devices) =>
      refused(device.platform)
        ? { ok: false, reason: "device-limit" }
        : strategy.canBoot(device, devices),
    canProvision: (device: PlannedCapacityDevice, devices) =>
      refused(device.platform)
        ? { ok: false, reason: "device-limit" }
        : strategy.canProvision(device, devices),
    canReserveRunning: (platform, devices, reservations): CapacityDecision => {
      if (refused(platform)) return { ok: false, reason: "platform-running-limit" };
      const { global } = runningCapacity(devices, reservations);
      if (global.running + global.reserved >= global.maxRunning) {
        return { ok: false, reason: "global-running-limit" };
      }
      return strategy.canReserveRunning(platform, devices, reservations);
    },
    deviceLimit: (platform) => (refused(platform) ? 0 : strategy.deviceLimit(platform)),
    ramBudget: (devices) => strategy.ramBudget(devices),
    runningCapacity,
  };
}
