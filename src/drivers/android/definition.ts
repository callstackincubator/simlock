import {
  booleanValue,
  type DriverConfigEntry,
  nonEmptyString,
  objectValidator,
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
  readonly emulator: AndroidEmulatorLaunchOptions;
}

export const androidDriverConfig: DriverConfigEntry<AndroidDriverConfig> = {
  platform: "android",
  defaults: {
    emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
  },
  validators: {
    emulator: objectValidator({
      headless: booleanValue,
      gpu: nonEmptyString,
      audio: booleanValue,
      bootAnimation: booleanValue,
    }),
  },
};
