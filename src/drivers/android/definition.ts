import { join } from "node:path";

import {
  booleanValue,
  type DriverConfigEntry,
  nonEmptyString,
  objectValidator,
  positiveNumber,
} from "../../core/index.js";

/**
 * why: How this machine's emulators are launched (`android.emulator` in config). Operator-only: it
 * reaches the driver at construction and never from a lease request. Only these four settings
 * exist, each mapped to one fixed emulator flag by `emulatorLaunchFlags`, so config cannot add
 * `-port`, a different AVD home, or any other argument that would break containment.
 */
export interface AndroidEmulatorLaunchOptions {
  readonly headless: boolean;
  /** why: an emulator GPU mode; `"auto"` leaves the emulator's own default. */
  readonly gpu: string;
  readonly audio: boolean;
  readonly bootAnimation: boolean;
}

export interface AndroidDriverConfig {
  /** why: an emulator boot may take this long, counted from its spawn, before it is given up. */
  readonly bootTimeoutMs: number;
  readonly emulator: AndroidEmulatorLaunchOptions;
}

export const DEFAULT_ADB_SERVER_PORT = 5038;

export function defaultAndroidDeviceRoot(simlockHome: string): string {
  return join(simlockHome, "devices", "android");
}

export const androidDriverConfig: DriverConfigEntry<AndroidDriverConfig> = {
  platform: "android",
  settingDefaults: (simlockHome) => ({
    adbServerPort: DEFAULT_ADB_SERVER_PORT,
    deviceRoot: defaultAndroidDeviceRoot(simlockHome),
  }),
  defaults: {
    bootTimeoutMs: 300_000,
    emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
  },
  validators: {
    bootTimeoutMs: positiveNumber,
    emulator: objectValidator({
      headless: booleanValue,
      gpu: nonEmptyString,
      audio: booleanValue,
      bootAnimation: booleanValue,
    }),
  },
};
