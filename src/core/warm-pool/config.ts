import { booleanValue, type Validator } from "../validation.js";

/** The warm pool's operator-facing settings, the `warmPool` keys beside `quarantine`. */
export interface WarmPoolConfig {
  /** `false` keeps nothing warm: every idle running device is shut down. */
  readonly enabled: boolean;
  /** Running slots per platform that idle warm devices may not fill. */
  readonly reserveRunning: { readonly ios: number; readonly android: number };
}

export const defaultWarmPoolConfig: WarmPoolConfig = {
  enabled: true,
  reserveRunning: { android: 0, ios: 0 },
};

/** The validators for the keys this module owns, composed into the `warmPool` object. */
export const warmPoolConfigValidator: Readonly<Record<keyof WarmPoolConfig, Validator>> = {
  enabled: booleanValue,
  reserveRunning: (value) => value,
};
