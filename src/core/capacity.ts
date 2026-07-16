import type { SystemStats } from "../ports/index.js";
import type { Config } from "./config.js";

const OS_RAM_RESERVE_BYTES = 4 * 1024 ** 3;

export type CapacityPlatform = "ios" | "android";

export interface CapacityDevice {
  readonly platform: CapacityPlatform;
  readonly state: string;
}

export type CapacityDecision = { readonly ok: true } | CapacityRefusal;

interface CapacityRefusal {
  readonly ok: false;
  readonly reason: "device-limit" | "ram-budget";
}

export function canProvision(
  platform: CapacityPlatform,
  devices: readonly CapacityDevice[],
  config: Config,
  systemStats: SystemStats,
): CapacityDecision {
  const activeDevices = devices.filter((device) => device.state !== "deleted");

  if (
    activeDevices.filter((device) => device.platform === platform).length >=
    maxDevices(platform, config)
  ) {
    return { ok: false, reason: "device-limit" };
  }

  const usedRamBytes = activeDevices.reduce(
    (total, device) => total + ramBudget(device.platform, config),
    0,
  );
  const availableRamBytes = systemStats.totalRamBytes() - OS_RAM_RESERVE_BYTES;

  if (usedRamBytes + ramBudget(platform, config) > availableRamBytes) {
    return { ok: false, reason: "ram-budget" };
  }

  return { ok: true };
}

function maxDevices(platform: CapacityPlatform, config: Config): number {
  return config.limits[platform].maxDevices;
}

function ramBudget(platform: CapacityPlatform, config: Config): number {
  return platform === "ios"
    ? config.ramBudget.iosBytesPerDevice
    : config.ramBudget.androidBytesPerDevice;
}
