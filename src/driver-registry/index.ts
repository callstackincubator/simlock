import { selectedBackendDefinition, type BackendDefinition, type Config } from "../core/index.js";
import { androidDriverConfig } from "../drivers/android/definition.js";
import { androidAdcDefinition } from "../drivers/android/adc/definition.js";
import { iosDriverConfig } from "../drivers/ios/definition.js";

export const backendDefinitions: readonly BackendDefinition<unknown>[] = [
  androidDriverConfig,
  androidAdcDefinition,
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
  for (const platform of ["android", "ios"] as const) {
    const settings = drivers[platform] ?? {};
    const entry = selectedBackendDefinition(backendDefinitions, platform, settings);
    const defaults = entry.settingDefaults?.(simlockHome, settings) ?? {};
    const merged = {
      ...defaults,
      ...(entry.settings.defaults as Record<string, string | number | boolean>),
      backend: entry.id,
      ...settings,
    };
    if (Object.keys(merged).length > 0) result[entry.platform] = merged;
  }
  return result;
}
