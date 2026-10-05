import type { DeviceRecord } from "../domain.js";
import type {
  CapacityPlatform,
  RamBudget,
  RunningCapacity,
  RunningCapacityEntry,
} from "./strategy.js";

/** What the figures are read from: the live strategy, through the engine. */
export interface CapacityFiguresSource {
  readonly runningCapacity: RunningCapacity;
  /** Managed-device ceiling, taken from the live strategy rather than from config. */
  deviceLimit(platform: CapacityPlatform): number;
  /** `undefined` when the strategy keeps no RAM budget. */
  readonly ramBudget: RamBudget | undefined;
  atRamBudget(platform: CapacityPlatform): boolean;
}

export interface PlatformCapacityFigures extends RunningCapacityEntry {
  readonly limit: number;
  readonly atRamBudget: boolean;
  readonly warm: number;
  readonly used: number;
}

export interface CapacityFigures {
  readonly ios: PlatformCapacityFigures;
  readonly android: PlatformCapacityFigures;
  readonly global: RunningCapacityEntry & { readonly warm: number };
  readonly ramBudget?: RamBudget | undefined;
}

/**
 * The one place the capacity figures are built from a registry snapshot and the live strategy.
 * `status.get` reports them as they are; `capacity.changed` carries the part of them an event
 * history needs (`capacityChangedPayload`), so what an operator sees and what the history holds
 * cannot disagree.
 */
export function buildCapacityFigures(
  devices: readonly DeviceRecord[],
  source: CapacityFiguresSource,
): CapacityFigures {
  const running = source.runningCapacity;
  const warmDevices = devices.filter((device) => device.state === "ready");
  const forPlatform = (platform: CapacityPlatform): PlatformCapacityFigures => ({
    limit: source.deviceLimit(platform),
    ...running[platform],
    atRamBudget: source.atRamBudget(platform),
    warm: warmDevices.filter((device) => device.spec.platform === platform).length,
    used: devices.filter(
      (device) => device.spec.platform === platform && device.state !== "deleted",
    ).length,
  });
  const ramBudget = source.ramBudget;
  return {
    ios: forPlatform("ios"),
    android: forPlatform("android"),
    global: { ...running.global, warm: warmDevices.length },
    ...(ramBudget === undefined ? {} : { ramBudget }),
  };
}
