import {
  booleanValue,
  type DriverConfigEntry,
  objectValidator,
  positiveNumber,
  stringArray,
} from "../../core/index.js";

export interface IosDriverConfig {
  readonly slim: {
    /** why: undefined disables every category the driver knows. */
    readonly categories?: readonly string[];
    /** why: a slim device gets its own boot deadline, because CI runners are slow. */
    readonly bootTimeoutMs: number;
  };
  readonly full: {
    /** why: a full simulator boot (and a recovery or seed boot) may take this long before it is given up. */
    readonly bootTimeoutMs: number;
  };
  readonly simulator: {
    /** why: `false` sets each simulator's volume to 0 after every boot. */
    readonly audio: boolean;
    /** why: `false` shows each simulator Simlock boots in DeviceHub or Simulator.app; it needs `drivers.ios.deviceSet: default`. */
    readonly headless: boolean;
  };
}

export const iosDriverConfig: DriverConfigEntry<IosDriverConfig> = {
  platform: "ios",
  defaults: {
    slim: { bootTimeoutMs: 600_000 },
    full: { bootTimeoutMs: 300_000 },
    simulator: { audio: true, headless: true },
  },
  validators: {
    slim: objectValidator({ categories: stringArray, bootTimeoutMs: positiveNumber }),
    full: objectValidator({ bootTimeoutMs: positiveNumber }),
    simulator: objectValidator({ audio: booleanValue, headless: booleanValue }),
  },
};
