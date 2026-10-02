import { objectValidator, positiveInteger } from "../../../validation.js";
import {
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
  type RunningCapacity,
} from "../../strategy.js";

/**
 * A pinned number of devices, with no machine inspection at all: no RAM budget,
 * no CPU-derived defaults. `maxRunning` alone is a complete configuration --
 * the per-platform blocks exist only to carve that budget up, and each field
 * falls back to the global number when omitted.
 */
export interface FixedStrategyOptions {
  readonly maxRunning: number;
  readonly ios?: PlatformOptions;
  readonly android?: PlatformOptions;
}

interface PlatformOptions {
  readonly maxDevices?: number;
  readonly maxRunning?: number;
}

class FixedCapacityStrategy implements CapacityStrategy {
  readonly #limits: CapacityLimits;

  constructor(options: FixedStrategyOptions) {
    this.#limits = resolveLimits(options);
  }

  /** One slot per device, whatever its mode. */
  canProvision(
    device: PlannedCapacityDevice,
    devices: readonly CapacityDevice[],
  ): CapacityDecision {
    return withinDeviceLimit(device.platform, devices, this.#limits)
      ? { ok: true }
      : { ok: false, reason: "device-limit" };
  }

  canReserveRunning(
    platform: CapacityPlatform,
    devices: readonly CapacityDevice[],
    reservations: readonly CapacityPlatform[],
  ): CapacityDecision {
    return canReserveRunning(platform, devices, reservations, this.#limits);
  }

  runningCapacity(
    devices: readonly CapacityDevice[],
    reservations: readonly CapacityPlatform[],
  ): RunningCapacity {
    return runningCapacity(devices, reservations, this.#limits);
  }

  deviceLimit(platform: CapacityPlatform): number {
    return this.#limits[platform].maxDevices;
  }

  ramBudget(): undefined {
    return undefined;
  }
}

function resolveLimits(options: FixedStrategyOptions): CapacityLimits {
  const platform = (overrides: PlatformOptions | undefined) => {
    const maxRunning = overrides?.maxRunning ?? options.maxRunning;
    return { maxDevices: overrides?.maxDevices ?? maxRunning, maxRunning };
  };

  return {
    maxRunning: options.maxRunning,
    ios: platform(options.ios),
    android: platform(options.android),
  };
}

const platformValidator = objectValidator({
  maxDevices: positiveInteger,
  maxRunning: positiveInteger,
});

export const fixedStrategy = defineCapacityStrategy({
  name: "fixed" as const,

  defaults(): FixedStrategyOptions {
    return { maxRunning: 2 };
  },

  validator: objectValidator({
    maxRunning: positiveInteger,
    ios: platformValidator,
    android: platformValidator,
  }),

  create(options: FixedStrategyOptions): CapacityStrategy {
    return new FixedCapacityStrategy(options);
  },
});
