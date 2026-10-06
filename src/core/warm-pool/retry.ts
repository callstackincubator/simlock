import type { DeviceSpec } from "../domain.js";

/** The wait after a spec's first failure; each further failure in a row doubles it. */
export const RETRY_FIRST_MS = 60_000;
/** The longest the wait grows to. */
export const RETRY_MAX_MS = 600_000;

interface Failure {
  /** Failures in a row since the last success. */
  readonly count: number;
  /** The first moment a try is allowed again. */
  readonly retryAt: number;
}

/**
 * The one place a failed pool boot or creation is remembered, keyed by the resolved spec: a
 * failure records the attempt and when the next try is allowed (one minute after the first,
 * doubling per failure in a row, never more than ten minutes), and a success forgets it. The
 * policy asks one question (`mayAttempt`), the converger reports two facts (`failed`,
 * `succeeded`) and asks when to look again (`nextAttemptAt`); nothing else knows there is a
 * retry, so a later schedule (an attempt limit, a delay per reason) replaces this file.
 */
export class RetrySchedule {
  readonly #failures = new Map<string, Failure>();

  mayAttempt(spec: DeviceSpec, now: number): boolean {
    const failure = this.#failures.get(keyOf(spec));
    return failure === undefined || now >= failure.retryAt;
  }

  failed(spec: DeviceSpec, now: number): void {
    const key = keyOf(spec);
    const count = (this.#failures.get(key)?.count ?? 0) + 1;
    const delay = Math.min(RETRY_FIRST_MS * 2 ** (count - 1), RETRY_MAX_MS);
    this.#failures.set(key, { count, retryAt: now + delay });
  }

  succeeded(spec: DeviceSpec): void {
    this.#failures.delete(keyOf(spec));
  }

  /** The earliest moment after `now` that a spec held back may be tried again. */
  nextAttemptAt(now: number): number | undefined {
    let earliest: number | undefined;
    for (const { retryAt } of this.#failures.values()) {
      if (retryAt > now && (earliest === undefined || retryAt < earliest)) earliest = retryAt;
    }
    return earliest;
  }
}

/** The spec's identity as `sameSpec` reads it: a slim and a full spec are two keys. */
function keyOf(spec: DeviceSpec): string {
  return JSON.stringify([
    spec.platform,
    spec.model,
    spec.osVersion,
    spec.mode ?? "full",
    spec.imageTag ?? null,
  ]);
}
