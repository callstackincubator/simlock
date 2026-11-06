import { labelsFor, type SlimCategory } from "./slim-labels.js";

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

/**
 * why: A kept category's service must be running (ADR 0066 §2): the first kept label the readback
 * does not show enabled, as the message the refusal carries; `undefined` when every one is.
 */
export function keptLabelsFailure(
  kept: readonly SlimCategory[],
  read: ReadonlyMap<string, boolean>,
): string | undefined {
  const notEnabled = labelsFor(kept).filter((label) => read.get(label) === true);
  return notEnabled.length === 0
    ? undefined
    : `${String(notEnabled.length)} kept labels are not enabled; first: ${notEnabled[0] ?? ""}`;
}
