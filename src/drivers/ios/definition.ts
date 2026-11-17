import { join } from "node:path";

import {
  booleanValue,
  invalidValue,
  type DriverConfigEntry,
  objectValidator,
  positiveNumber,
  stringArray,
} from "../../core/index.js";

export interface IosDriverConfig {
  readonly slim: {
    /** why: undefined disables every category the driver knows. */
    readonly categories?: readonly string[];
    /** why: services a slim device keeps running whatever the categories turn off (ADR 0083 §2). */
    readonly include?: readonly string[];
    /** why: services a slim device turns off beside the categories (ADR 0083 §2). */
    readonly exclude?: readonly string[];
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
    /** why: a `simctl clone` or `simctl create` of a whole simulator may take this long before the driver stops waiting. */
    readonly createTimeoutMs: number;
    /** why: `false` shows each simulator Simlock boots in DeviceHub or Simulator.app; it needs `drivers.ios.deviceSet: default`. */
    readonly headless: boolean;
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
    simulator: { audio: true, createTimeoutMs: 30_000, headless: true },
  },
  // why: ADR 0083 §1: the two lists are checked on the merged config, because the file and the overrides are validated one layer at a time.
  check: (section: IosDriverConfig) => {
    const { exclude = [], include = [] } = section.slim;
    const both = [...new Set(include.filter((name) => exclude.includes(name)))].sort();
    if (both.length > 0) {
      throw invalidValue("ios.slim", `no service in both include and exclude (${both.join(", ")})`);
    }
  },
  validators: {
    slim: objectValidator({
      categories: stringArray,
      bootTimeoutMs: positiveNumber,
      include: stringArray,
      exclude: stringArray,
    }),
    full: objectValidator({ bootTimeoutMs: positiveNumber }),
    simulator: objectValidator({
      audio: booleanValue,
      createTimeoutMs: positiveNumber,
      headless: booleanValue,
    }),
  },
};
