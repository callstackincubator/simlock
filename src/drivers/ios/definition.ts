import { join } from "node:path";

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
    /** why: one `simctl` command that creates, copies, boots, shuts down or deletes a simulator may take this long; a busy Mac is slow at each. */
    readonly lifecycleTimeoutMs: number;
  };
}

export function defaultIosDeviceRoot(simlockHome: string): string {
  return join(simlockHome, "devices", "ios");
}

export const iosDriverConfig: DriverConfigEntry<IosDriverConfig> = {
  platform: "ios",
  // why: Xcode's own set (`default`) has no owned root, so it shows no deviceRoot.
  settingDefaults: (simlockHome, settings) =>
    settings["deviceSet"] === "default"
      ? {}
      : { deviceRoot: defaultIosDeviceRoot(simlockHome), deviceSet: "simlock" },
  defaults: {
    slim: { bootTimeoutMs: 600_000 },
    full: { bootTimeoutMs: 300_000 },
    simulator: { audio: true, headless: true, lifecycleTimeoutMs: 30_000 },
  },
  validators: {
    slim: objectValidator({ categories: stringArray, bootTimeoutMs: positiveNumber }),
    full: objectValidator({ bootTimeoutMs: positiveNumber }),
    simulator: objectValidator({
      audio: booleanValue,
      headless: booleanValue,
      lifecycleTimeoutMs: positiveNumber,
    }),
  },
};
