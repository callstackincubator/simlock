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
 * already very close (or in the past) -- a misconfigured `lease.heldTtlBackstopMs`, a clock
 * that jumped, or a renewal that raced its own expiry. Without it, a non-positive remaining
 * TTL would turn the timer into an unbounded renew-per-tick loop against the daemon. The
 * renewal still happens; it is only kept from becoming a hot loop.
 */
const MINIMUM_RENEW_DELAY_MS = 250;

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
   * Reports the failure that stopped renewal (see `LeaseRenewal#stop` for why renewal ends
   * there). Never called after `stop()`.
   */
  readonly onError?: (error: unknown) => void;
}

export interface LeaseRenewal {
  /**
   * Cancels the pending timer and guarantees no further `renew` call, `onError` call, or
   * reschedule -- including from a renewal that is already in flight. Idempotent, and the one
   * thing a holder must do before releasing, so a renew cannot race its own release.
   */
  stop(): void;
}

/** The delay before the next renewal, given how much of the TTL is left. */
function renewDelayMs(remainingMs: number): number {
  return Math.max(MINIMUM_RENEW_DELAY_MS, Math.floor(remainingMs / RENEW_DIVISOR));
}

/**
 * Starts renewing `leaseId` at a third of the remaining TTL, rescheduling off each renewal's
 * own returned deadline, until `stop()`.
 *
 * A failed renewal ends renewal rather than retrying: the typed client never reconnects (ADR
 * 0003 §10), so a rejection is either a dead connection -- on which no later call would
 * succeed either -- or the daemon saying this lease is no longer renewable (it expired, or
 * was force-released). Both end this holder's claim; retrying would only turn one honest
 * error into a stream of them. The caller learns through `onError` and through the
 * `lease-lost` push that accompanies the second case.
 */
export function startLeaseRenewal(options: LeaseRenewalOptions): LeaseRenewal {
  const { clock, leaseId, onError, renew } = options;
  let timer: TimerHandle | undefined;
  let stopped = false;

  const schedule = (ttlDeadline: number): void => {
    if (stopped) return;
    timer = clock.setTimer(renewDelayMs(ttlDeadline - clock.now()), () => {
      timer = undefined;
      void tick();
    });
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const renewed = await renew(leaseId);
      schedule(renewed.ttlDeadline);
    } catch (error: unknown) {
      if (stopped) return;
      stopped = true;
      onError?.(error);
    }
  };

  schedule(options.ttlDeadline);

  return {
    stop: (): void => {
      stopped = true;
      if (timer === undefined) return;
      clock.cancel(timer);
      timer = undefined;
    },
  };
}
