/**
 * Client-side lease renewal: the timer half of ADR 0004 §2 ("'Held' is a client policy, not a
 * daemon mode ... what it does while alive is renew on a timer (one third of the TTL) and
 * release on exit, parent death, or a catchable signal").
 *
 * It lives in its own module, outside both frontends and outside `simlock/client`, for two
 * reasons:
 *
 * - the CLI's holder and the MCP session follow the *same* policy, and a second copy of a
 *   liveness loop is exactly the duplication ADR 0004 exists to remove;
 * - the typed client deliberately owns no renew loop (ADR 0003 §10, `docs/CLIENT.md`): renew
 *   and reconnect policy is a frontend concern, so this is a helper frontends *choose*, never
 *   something `connectSimlock` starts on their behalf. Nothing here is exported from
 *   `simlock/client` or `simlock/admin`.
 *
 * The cadence is computed only from the deadline the daemon returned with the grant (and with
 * every renewal since), never from a TTL config value: a client does not have the daemon's
 * config, and the daemon is free to hand back a shorter deadline than the one asked for.
 *
 * Two things follow from deriving the interval as `ttlDeadline - clock.now()`:
 *
 * - it assumes the daemon and this client read the same wall clock. True on the unix socket,
 *   where they are processes on one machine, and the reason `ttlDeadline` is usable as-is
 *   today. It is not true across a network hop, where a client's clock may sit minutes from
 *   the daemon's and this arithmetic would renew far too early or far too late.
 * - the fix for that is ADR 0004's own: once a lease record carries `ttlMs` (PR B), the
 *   cadence becomes `ttlMs / 3` -- a duration, which needs no shared epoch -- and the deadline
 *   is left as what it really is, a bound to stop renewing at rather than a clock to schedule
 *   from. This module is where that change lands; nothing above it has to move.
 */
import { isSimlockError } from "../contract/index.js";
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
 * Ceiling on the scheduled delay: the largest delay a Node timer can express (~24.9 days).
 * Anything above it silently truncates to 1ms, which would turn a very distant deadline into
 * exactly the hot loop the floor above exists to prevent. Renewing early costs one round trip.
 */
const MAXIMUM_RENEW_DELAY_MS = 2_147_483_647;

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

/**
 * Why renewal ended for good. Both mean "this holder no longer has a lease", and both are told
 * to `onLeaseGone`; they differ in what a reader should conclude:
 *
 * - `renew-rejected`: the daemon answered `UNKNOWN_LEASE`/`FORBIDDEN` -- the lease is gone, or
 *   was never this principal's. Nothing was lost by this client.
 * - `renew-failed`: renewal never got an answer it could use before the lease's own deadline
 *   passed (or the daemon answered with a deadline already behind us). The lease may still be
 *   alive on the daemon for a moment, but nothing here can keep it, and it will expire.
 */
export type LeaseGoneReason = "renew-rejected" | "renew-failed";

export interface LeaseRenewalOptions {
  readonly clock: Clock;
  readonly leaseId: string;
  /** The deadline the grant (or a previous renewal) returned, in `clock.now()`'s epoch. */
  readonly ttlDeadline: number;
  /** Calls `lease.renew` for this lease -- `client.renewLease({ leaseId })`, in practice. */
  readonly renew: (leaseId: string) => Promise<RenewedLease>;
  /**
   * Reports each answer this renewal adopts, so a holder that shows the deadline to somebody
   * can keep saying something true. The CLI's `DAEMON_CONNECTION_LOST` line names it, to say
   * how long the lease that outlived the connection has left; without this hook that line
   * would still quote the grant-time deadline, which after roughly one TTL of uptime is a
   * moment in the past on a lease that is perfectly alive.
   *
   * Called on every adopted answer -- which is every answer from the newest attempt, and whose
   * deadline may be equal to or *earlier* than the previous one, since the daemon's newest
   * word wins in both directions (a body-less renew re-applying a narrower stored width, say).
   * Never called after `stop()`.
   */
  readonly onRenewed?: (renewed: RenewedLease) => void;
  /**
   * Reports every failed attempt that is worth retrying, and the failure that finally ends
   * renewal. Never called after `stop()`, and never for the terminal answers `onLeaseGone`
   * covers.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * The lease is over, for either of the reasons `LeaseGoneReason` names. Renewal has already
   * stopped by the time this runs, and nothing it could do would bring the lease back -- so a
   * holder should treat this exactly like the `lease-lost` push (ADR 0003 §8) it may or may
   * not also receive: stop holding, and do not try to release what is no longer there. Called
   * at most once, and it is the *only* end-of-lease signal this module raises: `onError`
   * reports attempts that failed while the lease was still savable.
   */
  readonly onLeaseGone?: (reason: LeaseGoneReason, error: unknown) => void;
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
  const delay = Math.max(MINIMUM_RENEW_DELAY_MS, Math.floor(remainingMs / RENEW_DIVISOR));
  return Math.min(MAXIMUM_RENEW_DELAY_MS, delay);
}

type Attempt =
  | { readonly attemptId: number; readonly ok: true; readonly renewed: RenewedLease }
  | { readonly attemptId: number; readonly ok: false; readonly error: unknown };

/**
 * A rejection that answers "this lease is not yours to renew" rather than "that attempt did
 * not work". Both codes are the daemon's final word: `UNKNOWN_LEASE` means the record is gone
 * (expired, released, force-released), `FORBIDDEN` that it belongs to another principal
 * (`ownsLease` in `src/contract/operations.ts`). Retrying either just prints the same answer
 * until the deadline.
 */
function isLeaseGone(error: unknown): boolean {
  return isSimlockError(error) && (error.code === "UNKNOWN_LEASE" || error.code === "FORBIDDEN");
}

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
 * Each attempt is bounded by a third of what is left of the TTL when it starts, so a daemon
 * that accepts `lease.renew` and never answers costs one interval rather than the whole lease:
 * the wire has no request timeout of its own, and an abandoned request cannot slide the
 * deadline anywhere but forward.
 *
 * A daemon answering `UNKNOWN_LEASE` or `FORBIDDEN` is not a failed attempt at all -- the lease
 * is over, or was never this holder's -- so renewal stops at once and `onLeaseGone` says so.
 */
export function startLeaseRenewal(options: LeaseRenewalOptions): LeaseRenewal {
  const { clock, leaseId, onError, onLeaseGone, onRenewed, renew } = options;
  /** The last deadline the daemon actually gave us -- the only input to the cadence. */
  let deadline = options.ttlDeadline;
  /** Whichever timer is armed right now: the wait between renewals, or an attempt's bound. */
  let timer: TimerHandle | undefined;
  let stopped = false;
  /** Every attempt is numbered, and every *answer* is applied by that number: two abandoned
   * attempts can answer in either order, and only the newer one's deadline is the truth. */
  let attempts = 0;
  let newestAnswered = 0;

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
  /** Ends renewal and says why, once. Isolated for the same reason `report` is. */
  const giveUp = (reason: LeaseGoneReason, error: unknown): void => {
    stopped = true;
    if (onLeaseGone === undefined) return;
    try {
      onLeaseGone(reason, error);
    } catch {
      // A holder that cannot handle the news still has to stop renewing, which it now has.
    }
  };

  /** The one place `deadline` moves, so `onRenewed` can never drift from what the cadence
   * itself is scheduling against. Callers apply the newest-answer-wins rule before calling it;
   * this only records the answer and reports it, isolated for the same reason `report` is. */
  const adoptDeadline = (renewed: RenewedLease): void => {
    deadline = renewed.ttlDeadline;
    if (onRenewed === undefined) return;
    try {
      onRenewed(renewed);
    } catch {
      // A holder that cannot record the new deadline must still keep renewing towards it.
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

  /** One renewal attempt, bounded by a third of what is left of the TTL when it starts. */
  const attemptRenew = async (): Promise<Attempt> => {
    attempts += 1;
    const attemptId = attempts;
    // `Promise.resolve().then` rather than a bare call: a `renew` that throws *synchronously*
    // (a client that rejects a malformed input before it ever reaches the wire) is a failed
    // attempt like any other, not something that should escape into the unawaited `tick()`.
    // The `stopped` check inside it is what makes `stop()`'s "no further `renew` call"
    // guarantee true even for a stop that lands in the microtask between the timer firing and
    // the request going out.
    const request = Promise.resolve().then(() =>
      stopped
        ? Promise.reject(new Error(`Renewal of lease ${leaseId} was stopped before it was sent`))
        : renew(leaseId),
    );
    // An abandoned request still reaches the daemon: if it succeeds after this attempt has
    // been given up on, its deadline is real and worth keeping -- discarding it would let the
    // give-up test below fire against a deadline the daemon has already moved. (It also keeps
    // a late rejection from surfacing as an unhandled rejection.)
    request.then(
      (renewed) => {
        // Newest answer wins, by attempt number rather than by arrival order or by which
        // deadline is larger: an older attempt's answer is not "better" for being further
        // out, it is out of date, and taking it would leave this holder renewing towards a
        // deadline the daemon has already replaced.
        if (stopped || attemptId <= newestAnswered) return;
        newestAnswered = attemptId;
        adoptDeadline(renewed);
      },
      () => undefined,
    );
    return Promise.race<Attempt>([
      request.then(
        (renewed) => ({ attemptId, ok: true, renewed }),
        (error: unknown) => ({ attemptId, error, ok: false }),
      ),
      new Promise<Attempt>((resolve) => {
        timer = clock.setTimer(renewDelayMs(deadline - clock.now()), () => {
          timer = undefined;
          resolve({
            attemptId,
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
      if (isLeaseGone(attempt.error)) {
        // Terminal, not transient: this lease is over, and the holder needs to hear that once
        // rather than read the same rejection on every retry until the deadline.
        giveUp("renew-rejected", attempt.error);
        return;
      }
      report(attempt.error);
      // Out of runway: the deadline has passed, so another attempt would only produce another
      // error against a lease that is expiring. That is the end of this lease as far as any
      // holder is concerned -- reported as such, not as one more failed attempt, so a frontend
      // stops holding instead of sitting alive with no timer.
      if (clock.now() >= deadline) {
        giveUp(
          "renew-failed",
          new Error(`Gave up renewing lease ${leaseId}: its deadline has passed`),
        );
        return;
      }
      schedule();
      return;
    }

    // Applied by this attempt's own number, exactly as a late answer is (`attemptRenew` above
    // has usually already done it for this very answer; both paths agree, and both go through
    // `adoptDeadline`, so `onRenewed` sees each adopted answer exactly once).
    if (attempt.attemptId > newestAnswered) {
      newestAnswered = attempt.attemptId;
      adoptDeadline(attempt.renewed);
    }
    if (attempt.renewed.ttlDeadline <= clock.now()) {
      // A deadline that is not in the future cannot be renewed towards -- scheduling off it
      // would be a hot loop against a lease that is already over, so this is an ending too.
      giveUp(
        "renew-failed",
        new Error(`Lease ${leaseId} was renewed to a deadline that has already passed`),
      );
      return;
    }
    // The cadence follows the newest answer in both directions: the daemon may hand back a
    // *shorter* deadline than the one asked for -- a body-less renew re-applying a narrower
    // stored width, say -- and a longer, older belief does not override it.
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
