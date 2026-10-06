import { type DeviceSpec, sameSpec } from "../domain.js";

/** The wait after a spec's first failure; each further failure in a row doubles it. */
export const RETRY_FIRST_MS = 60_000;
/** The longest the wait grows to. */
export const RETRY_MAX_MS = 600_000;

interface Failure {
  readonly spec: DeviceSpec;
  /** Failures in a row since the last success. */
  readonly count: number;
  /** The first moment a try is allowed again. */
  readonly retryAt: number;
}

/**
 * Where a target's failed boot or creation is remembered, keyed by the resolved spec (`sameSpec`
 * says which specs are one): a failure records the attempt and when the next try is allowed (one
 * minute after the first, doubling per failure in a row, never more than ten minutes), and a
 * success forgets it. The policy asks one question (`mayAttempt`), the converger reports two facts
 * (`failed`, `succeeded`) and asks when to look again (`nextAttemptAt`); nothing else knows how a
 * target is held back, so a later schedule (an attempt limit, a delay per reason) replaces this
 * file. A device's own short pause after a failed step is the converger's, not a target's.
 */
export class RetrySchedule {
  #failures: Failure[] = [];

  mayAttempt(spec: DeviceSpec, now: number): boolean {
    const failure = this.#failureOf(spec);
    return failure === undefined || now >= failure.retryAt;
  }

  failed(spec: DeviceSpec, now: number): void {
    const count = (this.#failureOf(spec)?.count ?? 0) + 1;
    const delay = Math.min(RETRY_FIRST_MS * 2 ** (count - 1), RETRY_MAX_MS);
    this.succeeded(spec);
    this.#failures.push({ count, retryAt: now + delay, spec });
  }

  succeeded(spec: DeviceSpec): void {
    this.#failures = this.#failures.filter((failure) => !sameSpec(failure.spec, spec));
  }

  /** The earliest moment after `now` that a spec held back may be tried again. */
  nextAttemptAt(now: number): number | undefined {
    let earliest: number | undefined;
    for (const { retryAt } of this.#failures) {
      if (retryAt > now && (earliest === undefined || retryAt < earliest)) earliest = retryAt;
    }
    return earliest;
  }

  #failureOf(spec: DeviceSpec): Failure | undefined {
    return this.#failures.find((failure) => sameSpec(failure.spec, spec));
  }
}
