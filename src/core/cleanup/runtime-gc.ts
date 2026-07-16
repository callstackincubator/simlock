import type { CleanupRule, Proposal, RegistryView } from "./types.js";

/**
 * Runtime GC is deliberately explicit. iOS runtimes are Xcode-managed; Android
 * inventory is exposed by the driver and will only yield registry-unreferenced images.
 */
export const runtimeGcRule: CleanupRule = {
  evaluate(_view: RegistryView): readonly Proposal[] {
    return [];
  },
  name: "runtime-gc",
};
