import type { CleanupRule, Proposal, RegistryView } from "./types.js";

/**
 * Runtime inventory and platform deletion arrive with the real drivers in stage 13.
 * The rule is registered now so the cleanup command can explicitly target it.
 */
export const runtimeGcRule: CleanupRule = {
  evaluate(_view: RegistryView): readonly Proposal[] {
    // TODO(stage-13): propose registered, unreferenced Android system images from driver inventory.
    return [];
  },
  name: "runtime-gc",
};
