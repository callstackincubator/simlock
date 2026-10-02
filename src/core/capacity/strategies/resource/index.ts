import type { SystemStats } from "../../../../ports/index.js";
import { nonNegativeNumber, objectValidator, positiveInteger } from "../../../validation.js";
import {
  activeDevices,
  canReserveRunning,
  runningCapacity,
  withinDeviceLimit,
  type CapacityLimits,
} from "../../limits.js";
import {
  defineCapacityStrategy,
  type CapacityDecision,
  type CapacityDevice,
  type CapacityPlatform,
  type CapacityStrategy,
  type PlannedCapacityDevice,
  type RamBudget,
  type RunningCapacity,
} from "../../strategy.js";

const GIBIBYTE = 1024 ** 3;
const OS_RAM_RESERVE_BYTES = 4 * GIBIBYTE;

/**
 * Device and running ceilings derived from the machine, with a RAM budget gate
 * on top: a device may be created only if its budgeted RAM still fits under the
 * machine's total minus a reserve left for the OS. Each device counts by its own
 * mode; a slim size left unset means the platform's full size.
 */
export interface ResourceStrategyOptions {
  readonly limits: CapacityLimits;
  readonly ramBudget: {
    readonly iosBytesPerDevice: number;
    readonly iosSlimBytesPerDevice?: number;
    readonly androidBytesPerDevice: number;
    readonly androidSlimBytesPerDevice?: number;
  };
}

class ResourceCapacityStrategy implements CapacityStrategy {
  constructor(
    private readonly options: ResourceStrategyOptions,
    private readonly systemStats: SystemStats,
  ) {}

  canProvision(
    device: PlannedCapacityDevice,
    devices: readonly CapacityDevice[],
  ): CapacityDecision {
    if (!withinDeviceLimit(device.platform, devices, this.options.limits)) {
      return { ok: false, reason: "device-limit" };
    }

    if (this.#usedBytes(devices) + this.#bytesPerDevice(device) > this.#limitBytes()) {
      return { ok: false, reason: "ram-budget" };
    }

    return { ok: true };
  }

  canReserveRunning(
    platform: CapacityPlatform,
    devices: readonly CapacityDevice[],
    reservations: readonly CapacityPlatform[],
  ): CapacityDecision {
    return canReserveRunning(platform, devices, reservations, this.options.limits);
  }

  runningCapacity(
    devices: readonly CapacityDevice[],
    reservations: readonly CapacityPlatform[],
  ): RunningCapacity {
    return runningCapacity(devices, reservations, this.options.limits);
  }

  deviceLimit(platform: CapacityPlatform): number {
    return this.options.limits[platform].maxDevices;
  }

  ramBudget(devices: readonly CapacityDevice[]): RamBudget {
    const limitBytes = this.#limitBytes();
    const usedBytes = this.#usedBytes(devices);
    return { limitBytes, overLimit: usedBytes > limitBytes, usedBytes };
  }

  #limitBytes(): number {
    return this.systemStats.totalRamBytes() - OS_RAM_RESERVE_BYTES;
  }

  #usedBytes(devices: readonly CapacityDevice[]): number {
    return activeDevices(devices).reduce(
      (total, device) => total + this.#bytesPerDevice(device),
      0,
    );
  }

  #bytesPerDevice({ platform, mode }: PlannedCapacityDevice): number {
    const budget = this.options.ramBudget;
    const full = platform === "ios" ? budget.iosBytesPerDevice : budget.androidBytesPerDevice;
    if (mode === "full") return full;
    return (
      (platform === "ios" ? budget.iosSlimBytesPerDevice : budget.androidSlimBytesPerDevice) ?? full
    );
  }
}

const limitsValidator = objectValidator({
  maxRunning: positiveInteger,
  ios: objectValidator({ maxDevices: positiveInteger, maxRunning: positiveInteger }),
  android: objectValidator({ maxDevices: positiveInteger, maxRunning: positiveInteger }),
});

const ramBudgetValidator = objectValidator({
  iosBytesPerDevice: nonNegativeNumber,
  iosSlimBytesPerDevice: nonNegativeNumber,
  androidBytesPerDevice: nonNegativeNumber,
  androidSlimBytesPerDevice: nonNegativeNumber,
});

/** Exported for the legacy top-level `limits` / `ramBudget` keys in `config.ts`. */
export const resourceOptionValidators = {
  limits: limitsValidator,
  ramBudget: ramBudgetValidator,
};

export const resourceStrategy = defineCapacityStrategy({
  name: "resource" as const,

  defaults(systemStats: SystemStats): ResourceStrategyOptions {
    const cpuCount = systemStats.cpuCount();
    const totalRamGb = systemStats.totalRamBytes() / GIBIBYTE;

    const iosMaxDevices = Math.max(1, Math.floor(cpuCount / 2));
    const androidMaxDevices = Math.max(
      1,
      Math.min(Math.floor(cpuCount / 4), Math.floor(totalRamGb / 8)),
    );

    return {
      limits: {
        maxRunning: iosMaxDevices + androidMaxDevices,
        ios: { maxDevices: iosMaxDevices, maxRunning: iosMaxDevices },
        android: { maxDevices: androidMaxDevices, maxRunning: androidMaxDevices },
      },
      ramBudget: {
        iosBytesPerDevice: 1.5 * GIBIBYTE,
        androidBytesPerDevice: 4 * GIBIBYTE,
      },
    };
  },

  validator: objectValidator(resourceOptionValidators),

  create(options: ResourceStrategyOptions, systemStats: SystemStats): CapacityStrategy {
    return new ResourceCapacityStrategy(options, systemStats);
  },
});
