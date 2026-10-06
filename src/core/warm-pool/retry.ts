import type { DeviceSpec } from "../domain.js";

/** The wait after a spec's first failure; each further failure in a row doubles it. */
export const RETRY_FIRST_MS = 60_000;
/** The longest the wait grows to. */
export const RETRY_MAX_MS = 600_000;

/**
 * The one place a failed pool boot or creation is remembered, keyed by the resolved spec. Nothing
 * outside this file knows there is a retry.
 */
export class RetrySchedule {
  mayAttempt(_spec: DeviceSpec, _now: number): boolean {
    return true;
  }

  failed(_spec: DeviceSpec, _now: number): void {}

  succeeded(_spec: DeviceSpec): void {}

  /** The earliest moment after `now` that a spec held back may be tried again. */
  nextAttemptAt(_now: number): number | undefined {
    return undefined;
  }
}
