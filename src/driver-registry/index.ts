import type { DriverConfigEntry } from "../core/index.js";
import { androidDriverConfig } from "../drivers/android/definition.js";
import { iosDriverConfig } from "../drivers/ios/definition.js";

export const driverConfigEntries: readonly DriverConfigEntry[] = [
  androidDriverConfig,
  iosDriverConfig,
];
