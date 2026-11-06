import { BadDeviceRequestError, KeptCategoriesError } from "../../core/index.js";
import {
  labelsFor,
  SLIM_CATEGORIES,
  type resolveSlimCategories,
  type SlimCategory,
} from "./slim-labels.js";

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
 * why: A kept category's service must be running (ADR 0066 §2): the device is refused when the
 * readback does not show every kept label enabled.
 */
export function assertKeptEnabled(
  kept: readonly SlimCategory[],
  read: ReadonlyMap<string, boolean>,
): void {
  const notEnabled = labelsFor(kept).filter((label) => read.get(label) === true);
  if (notEnabled.length > 0) {
    throw new KeptCategoriesError(
      `${String(notEnabled.length)} kept labels are not enabled; first: ${notEnabled[0] ?? ""}`,
    );
  }
}

/**
 * why: A lease's except list is checked at resolve (ADR 0066 §2), before any device is made: a
 * name no category has, or a category this worker does not slim, can never be served.
 */
export function checkExcept(except: readonly string[], slimSet: ResolvedCategories): void {
  const slimmed = slimSet.categories.map((category) => category.name);
  for (const name of except) {
    if (!SLIM_CATEGORIES.some((category) => category.name === name)) {
      throw new BadDeviceRequestError(`unknown slim category "${name}"`);
    }
    if (!slimmed.includes(name)) {
      throw new BadDeviceRequestError(
        `"${name}" is not in this worker's slim categories (${slimmed.join(", ")})`,
      );
    }
  }
}
