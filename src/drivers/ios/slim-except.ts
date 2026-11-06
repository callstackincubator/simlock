import { labelsFor, type resolveSlimCategories, type SlimCategory } from "./slim-labels.js";

type ResolvedCategories = ReturnType<typeof resolveSlimCategories>;

/**
 * why: A lease's except list (ADR 0066 §2) takes categories out of the worker's slim set: the
 * categories left are the ones to turn off, the excepted ones are the ones to keep on.
 */
export function splitByExcept(
  configured: ResolvedCategories,
  except: readonly string[],
): { readonly kept: readonly SlimCategory[]; readonly resolved: ResolvedCategories } {
  const { categories, unknown } = configured;
  return {
    kept: categories.filter((category) => except.includes(category.name)),
    resolved: {
      categories: categories.filter((category) => !except.includes(category.name)),
      unknown,
    },
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
