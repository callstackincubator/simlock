import type { SlimCategory } from "./slim-labels.js";

/**
 * why: A lease's except list (ADR 0066 §2) takes categories out of the worker's slim set: the
 * categories left are the ones to turn off, the excepted ones are the ones to keep on.
 */
export function splitByExcept(
  categories: readonly SlimCategory[],
  except: readonly string[],
): { readonly slimmed: readonly SlimCategory[]; readonly kept: readonly SlimCategory[] } {
  return {
    kept: categories.filter((category) => except.includes(category.name)),
    slimmed: categories.filter((category) => !except.includes(category.name)),
  };
}
