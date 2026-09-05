/**
 * Client-side lease renewal: the timer half of ADR 0004 §2 ("'Held' is a client policy, not a
 * daemon mode ... what it does while alive is renew on a timer (one third of the TTL) and
 * release on exit, parent death, or a catchable signal").
 *
 * It lives in its own module, outside both frontends and outside `simlock/client`, for two
 * reasons:
 *
 * - the CLI's held mode and the MCP session follow the *same* policy, and a second copy of a
 *   liveness loop is exactly the duplication ADR 0004 exists to remove;
 * - the typed client deliberately owns no renew loop (ADR 0003 §10, `docs/CLIENT.md`): renew
 *   and reconnect policy is a frontend concern, so this is a helper frontends *choose*, never
 *   something `connectSimlock` starts on their behalf. Nothing here is exported from
 *   `simlock/client` or `simlock/admin`.
 *
 * The cadence is computed only from the deadline the daemon returned with the grant (and with
 * every renewal since), never from a TTL config value: a client does not have the daemon's
 * config, and the daemon is free to hand back a shorter deadline than the one asked for.
 */
import type { Clock, TimerHandle } from "../ports/index.js";

/** ADR 0004 §2's "one third of the TTL". */
const RENEW_DIVISOR = 3;

/**
 * Floor on the scheduled delay. Only reachable when the daemon returns a deadline that is
 * already very close (or in the past) -- a daemon configured with a zero-length TTL, a clock
 * that jumped, or a renewal that raced its own expiry. Without it, a non-positive remaining
 * TTL would turn the timer into an unbounded renew-per-tick loop against the daemon.
 */
const MINIMUM_RENEW_DELAY_MS = 250;

/**
 * How long a holder waits for its farewell `lease.release` before giving up and closing the
 * connection anyway. The daemon is a local process answering a local socket, so this is not a
 * latency budget -- it is the bound that keeps an unresponsive daemon from hanging the exit of
 * a CLI holder or an MCP server. Exceeding it costs nothing but the wait: the lease then ends
 * the way every unreleased lease ends, at its deadline.
 */
export const RELEASE_TIMEOUT_MS = 5_000;

/**
 * Resolves with `work`, or rejects once `timeoutMs` has passed on `clock`. The timer is always
 * cancelled, so it never holds a process open by itself, and a rejection from an abandoned
 * `work` is swallowed rather than surfacing as an unhandled rejection.
 */
export async function awaitWithin<T>(
  clock: Clock,
  timeoutMs: number,
  work: Promise<T>,
  timeoutMessage: string,
): Promise<T> {
  work.catch(() => undefined);
  let timer: TimerHandle | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimer(timeoutMs, () => {
      timer = undefined;
      reject(new Error(timeoutMessage));
    });
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clock.cancel(timer);
  }
}

/** The subset of a `LeaseRecord` renewal needs back: the daemon's new deadline. */
export interface RenewedLease {
  readonly ttlDeadline: number;
}

export interface LeaseRenewalOptions {
  readonly clock: Clock;
  readonly leaseId: string;
  /** The deadline the grant (or a previous renewal) returned, in `clock.now()`'s epoch. */
  readonly ttlDeadline: number;
  /** Calls `lease.renew` for this lease -- `client.renewLease({ leaseId })`, in practice. */
  readonly renew: (leaseId: string) => Promise<RenewedLease>;
  /**
   * Reports every failed attempt, and the failure that finally ends renewal. Never called
   * after `stop()`.
   */
  readonly onError?: (error: unknown) => void;
}

export interface LeaseRenewal {
  /**
   * Cancels whatever timer is armed -- the wait between renewals, or the bound on an attempt
   * already in flight -- and guarantees no further `renew` call, `onError` call, or reschedule.
   * Idempotent, and the one thing a holder must do before releasing, so a renew cannot race its
   * own release.
   */
  stop(): void;
}

/** The delay before the next renewal, given how much of the TTL is left. */
function renewDelayMs(remainingMs: number): number {
  return Math.max(MINIMUM_RENEW_DELAY_MS, Math.floor(remainingMs / RENEW_DIVISOR));
}

type Attempt =
  | { readonly ok: true; readonly renewed: RenewedLease }
  | { readonly ok: false; readonly error: unknown };

/**
 * Starts renewing `leaseId` at a third of the remaining TTL, rescheduling off each renewal's
 * own returned deadline, until `stop()`.
 *
 * Renewing at a third of the TTL exists to leave room for two more tries before the deadline,
 * so a failed attempt is retried on the same cadence rather than ending the lease: the daemon
 * may have failed to persist one renewal (`INTERNAL`) and still be perfectly willing to serve
 * the next. Renewal ends only when the lease can no longer be saved -- its last known deadline
 * has passed, or the daemon answered with one that is not in the future. A holder whose
 * connection died, or whose lease was force-released, stops sooner than that through its
 * `lease-lost` handler (ADR 0003 §10), which is the signal that actually means "this lease is
 * over"; the retries in between are cheap and bounded by the deadline.
 *
 * Each attempt is bounded by the same interval it was scheduled on, so a daemon that accepts
 * `lease.renew` and never answers costs one interval rather than the whole lease: the wire has
 * no request timeout of its own, and an abandoned request cannot slide the deadline anywhere
 * but forward.
 */
export function startLeaseRenewal(options: LeaseRenewalOptions): LeaseRenewal {
  const { clock, leaseId, onError, renew } = options;
  /** The last deadline the daemon actually gave us -- the only input to the cadence. */
  let deadline = options.ttlDeadline;
  /** Whichever timer is armed right now: the wait between renewals, or an attempt's bound. */
  let timer: TimerHandle | undefined;
  let stopped = false;

  const cancelTimer = (): void => {
    if (timer === undefined) return;
    clock.cancel(timer);
    timer = undefined;
  };

  /** Isolated: a holder that cannot report a failure must still keep holding. */
  const report = (error: unknown): void => {
    if (onError === undefined) return;
    try {
      onError(error);
    } catch {
      // A `stderr` that throws (a closed pipe, say) must not take the release path down with
      // it -- see the `void tick()` below, which nothing awaits.
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = clock.setTimer(renewDelayMs(deadline - clock.now()), () => {
      timer = undefined;
      // Nothing awaits this: an unhandled rejection here would take the whole process down,
      // and with it the release the holder still owes.
      void tick().catch(() => undefined);
    });
  };

  /** One renewal attempt, bounded by the interval it was scheduled on. */
  const attemptRenew = async (): Promise<Attempt> => {
    const request = renew(leaseId);
    // An abandoned request still reaches the daemon: if it succeeds after this attempt has
    // been given up on, its deadline is real and worth keeping -- discarding it would let the
    // give-up test below fire against a deadline the daemon has already moved. (It also keeps
    // a late rejection from surfacing as an unhandled rejection.)
    request.then(
      (renewed) => {
        // `Math.max`, not a plain assignment: this answer belongs to a request older than
        // whatever has happened since, so it may only ever push the deadline forward.
        if (!stopped) deadline = Math.max(deadline, renewed.ttlDeadline);
      },
      () => undefined,
    );
    return Promise.race<Attempt>([
      request.then(
        (renewed) => ({ ok: true, renewed }),
        (error: unknown) => ({ error, ok: false }),
      ),
      new Promise<Attempt>((resolve) => {
        timer = clock.setTimer(renewDelayMs(deadline - clock.now()), () => {
          timer = undefined;
          resolve({
            error: new Error(`Timed out renewing lease ${leaseId}`),
            ok: false,
          });
        });
      }),
    ]);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const attempt = await attemptRenew();
    cancelTimer();
    if (stopped) return;

    if (!attempt.ok) {
      report(attempt.error);
      // Out of runway: the lease is gone (or about to be), and another attempt would only
      // produce another error. Reported separately from the attempt that failed, because
      // "this one did not work" and "this lease will not be renewed again" are different
      // things for a holder to read.
      if (clock.now() >= deadline) {
        stopped = true;
        report(new Error(`Gave up renewing lease ${leaseId}: its deadline has passed`));
        return;
      }
      schedule();
      return;
    }

    if (attempt.renewed.ttlDeadline <= clock.now()) {
      // A deadline that is not in the future cannot be renewed towards -- scheduling off it
      // would be a hot loop against a lease that is already over.
      stopped = true;
      report(new Error(`Lease ${leaseId} was renewed to a deadline that has already passed`));
      return;
    }
    // The daemon's answer is authoritative, in both directions: it may hand back a shorter
    // deadline than the one that was asked for, and the cadence follows it.
    deadline = attempt.renewed.ttlDeadline;
    schedule();
  };

  schedule();

  return {
    stop: (): void => {
      stopped = true;
      cancelTimer();
    },
  };
}
