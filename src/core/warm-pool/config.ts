import {
  booleanValue,
  nonNegativeInteger,
  objectValidator,
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
  /** The most target boots and creations that run at once. */
  readonly maxConcurrentBoots: number;
}

export const defaultWarmPoolConfig: WarmPoolConfig = {
  enabled: true,
  maxConcurrentBoots: 1,
  reserveRunning: { android: 0, ios: 0 },
  targets: [],
};

/** The validators for the keys this module owns, composed into the `warmPool` object. */
export const warmPoolConfigValidator: Readonly<Record<keyof WarmPoolConfig, Validator>> = {
  enabled: booleanValue,
  maxConcurrentBoots: (value) => value,
  reserveRunning: objectValidator({ android: nonNegativeInteger, ios: nonNegativeInteger }),
  targets: () => [],
};
