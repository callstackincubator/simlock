import { parseOsConstraint } from "../../contract/index.js";
import type { SystemStats } from "../../ports/index.js";
import { WARM_POOL_NAME_MAX, WARM_POOL_TARGETS_MAX } from "../../contract/schemas.js";
import {
  booleanValue,
  invalidValue,
  nonEmptyString,
  nonNegativeInteger,
  objectValidator,
  positiveInteger,
  requireObject,
  stringUnion,
  type Validator,
} from "../validation.js";

/**
 * A kind of device the pool keeps booted, clean and unleased: written like a lease request, with
 * a count (`warmPool.targets`). The pool resolves it the way a request is resolved, every pass.
 */
export interface WarmTarget {
  readonly platform: "ios" | "android";
  /** An exact model; a target names no class. */
  readonly model: string;
  /** A version or an OS range, the grammar `src/contract/os-range.ts` owns. */
  readonly osVersion?: string;
  readonly mode?: "slim" | "full";
  readonly count: number;
}

/** The warm pool's operator-facing settings, the `warmPool` keys beside `quarantine`. */
export interface WarmPoolConfig {
  /** `false` keeps nothing warm: every idle running device is shut down. */
  readonly enabled: boolean;
  /** Running slots per platform that idle warm devices may not fill. */
  readonly reserveRunning: { readonly ios: number; readonly android: number };
  /** Kinds of device kept booted ahead of demand. */
  readonly targets: readonly WarmTarget[];
  /** why: the most boots and creations in flight at once: the pool's own, for waiters and targets, and each waiting request's own. */
  readonly maxConcurrentBoots: number;
}

export function defaultWarmPoolConfig(systemStats: SystemStats): WarmPoolConfig {
  return {
    enabled: true,
    maxConcurrentBoots: Math.max(1, Math.floor(systemStats.cpuCount() / 4)),
    reserveRunning: { android: 0, ios: 0 },
    targets: [],
  };
}

/** A non-empty string no longer than the bound the status answer carries. */
function boundedName(value: unknown, path: string): string {
  const text = nonEmptyString(value, path);
  if (text.length > WARM_POOL_NAME_MAX) {
    throw invalidValue(path, `a string of at most ${WARM_POOL_NAME_MAX} characters`);
  }
  return text;
}

const targetPlatform = stringUnion(["ios", "android"] as const);
const targetMode = stringUnion(["slim", "full"] as const);

/** The keys a target may carry; any other fails the load naming it (a class, say). */
const TARGET_VALIDATORS: Readonly<Record<keyof WarmTarget, Validator>> = {
  count: positiveInteger,
  mode: targetMode,
  model: boundedName,
  osVersion: (value, path) => {
    const text = boundedName(value, path);
    if (!parseOsConstraint(text).ok) throw invalidValue(path, "an OS version or an OS range");
    return text;
  },
  platform: targetPlatform,
};

const REQUIRED_TARGET_KEYS: readonly string[] = ["platform", "model", "count"];

/**
 * One target. Unlike the rest of the config an unknown key is an error, not a warning: a target
 * that names a class would otherwise load as something the operator did not write.
 */
const targetValidator: Validator = (value, path, warn) => {
  const object = requireObject(value, path);
  for (const key of Object.keys(object)) {
    if (!Object.hasOwn(TARGET_VALIDATORS, key)) {
      throw invalidValue(`${path}.${key}`, "a known target key");
    }
  }
  const result: Record<string, unknown> = {};
  for (const [key, validate] of Object.entries(TARGET_VALIDATORS)) {
    // `model`, `platform` and `count` are required: validating an absent one names it.
    if (Object.hasOwn(object, key) || REQUIRED_TARGET_KEYS.includes(key)) {
      result[key] = validate(object[key], `${path}.${key}`, warn);
    }
  }
  return result;
};

const targetsValidator: Validator = (value, path, warn) => {
  if (!Array.isArray(value)) throw invalidValue(path, "an array of targets");
  if (value.length > WARM_POOL_TARGETS_MAX) {
    throw invalidValue(path, `an array of at most ${WARM_POOL_TARGETS_MAX} targets`);
  }
  return value.map((target: unknown, index) => targetValidator(target, `${path}[${index}]`, warn));
};

/** The validators for the keys this module owns, composed into the `warmPool` object. */
export const warmPoolConfigValidator: Readonly<Record<keyof WarmPoolConfig, Validator>> = {
  enabled: booleanValue,
  maxConcurrentBoots: positiveInteger,
  reserveRunning: objectValidator({ android: nonNegativeInteger, ios: nonNegativeInteger }),
  targets: targetsValidator,
};
