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
  readonly reason:
    | "device-limit"
    | "ram-budget"
    | "global-running-limit"
    | "platform-running-limit";
}

export interface RunningCapacityEntry {
  readonly running: number;
  readonly maxRunning: number;
  readonly reserved: number;
  readonly overLimit: boolean;
}

export interface RunningCapacity {
  readonly global: RunningCapacityEntry;
  readonly ios: RunningCapacityEntry;
  readonly android: RunningCapacityEntry;
}

const RUNNING_STATES = new Set(["ready", "leased", "reclaiming", "quarantined"]);

export function runningCapacity(
  devices: readonly CapacityDevice[],
  reservations: readonly CapacityPlatform[],
  config: Config,
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
    const maxRunning =
      platform === undefined ? config.limits.maxRunning : config.limits[platform].maxRunning;
    return { maxRunning, overLimit: running + reserved > maxRunning, reserved, running };
  };
  return { android: entry("android"), global: entry(), ios: entry("ios") };
}

export function canReserveRunning(
  platform: CapacityPlatform,
  devices: readonly CapacityDevice[],
  reservations: readonly CapacityPlatform[],
  config: Config,
): CapacityDecision {
  const capacity = runningCapacity(devices, reservations, config);
  const globalUsed = capacity.global.running + capacity.global.reserved;
  if (globalUsed >= capacity.global.maxRunning) {
    return { ok: false, reason: "global-running-limit" };
  }
  const platformCapacity = capacity[platform];
  if (platformCapacity.running + platformCapacity.reserved >= platformCapacity.maxRunning) {
    return { ok: false, reason: "platform-running-limit" };
  }
  return { ok: true };
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
