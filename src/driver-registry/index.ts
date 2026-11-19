import type { Config, DriverConfigEntry } from "../core/index.js";
import { androidDriverConfig } from "../drivers/android/definition.js";
import { iosDriverConfig } from "../drivers/ios/definition.js";

export const driverConfigEntries: readonly DriverConfigEntry[] = [
  androidDriverConfig,
  iosDriverConfig,
];

// why: what `config.get` answers under `drivers`: each driver's own value for a key config.json leaves unset, then the set keys as written.
export function driversWithDefaults(
  drivers: Config["drivers"],
  simlockHome: string,
): Config["drivers"] {
  const result: Record<string, Readonly<Record<string, string | number | boolean>>> = {
    ...drivers,
  };
  for (const entry of driverConfigEntries) {
    const settings = drivers[entry.platform] ?? {};
    const defaults = entry.settingDefaults?.(simlockHome, settings) ?? {};
    const merged = { ...defaults, ...settings };
    if (Object.keys(merged).length > 0) result[entry.platform] = merged;
  }
  return result;
}
