import { booleanValue, type Validator } from "../validation.js";

/** The warm pool's operator-facing settings, the `warmPool` keys beside `quarantine`. */
export interface WarmPoolConfig {
  /** `false` keeps nothing warm: every idle running device is shut down. */
  readonly enabled: boolean;
}

export const defaultWarmPoolConfig: WarmPoolConfig = { enabled: true };

/** The validators for the keys this module owns, composed into the `warmPool` object. */
export const warmPoolConfigValidator: Readonly<Record<keyof WarmPoolConfig, Validator>> = {
  enabled: booleanValue,
};
