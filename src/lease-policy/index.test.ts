/**
 * The renew cadence ADR 0004 §2 specifies, exercised on a hand-advanced `FakeClock`: a third of
 * the *remaining* TTL, recomputed from the deadline the daemon returned every time, and nothing
 * at all after `stop()`.
 */
import { describe, expect, it } from "vitest";

import { FakeClock } from "../ports/index.js";
import { startLeaseRenewal } from "./index.js";

/** Lets the awaited `renew` call settle; the fake clock never moves on its own. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

describe("startLeaseRenewal", () => {
  it("renews at a third of the remaining TTL and reschedules off each renewal's own deadline", async () => {
    const clock = new FakeClock(1_000);
    const renewedAt: number[] = [];
    const seenLeaseIds: string[] = [];
    const renewal = startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      renew: (leaseId) => {
        renewedAt.push(clock.now());
        seenLeaseIds.push(leaseId);
        // The daemon's answer -- deliberately a *different* TTL than the grant's, so a
        // cadence computed from anything but this deadline shows up as a wrong timestamp.
        return Promise.resolve({ ttlDeadline: clock.now() + 6_000 });
      },
      ttlDeadline: 1_000 + 9_000,
    });

    clock.advance(2_999);
    await flushMicrotasks();
    expect(renewedAt, "must not renew before a third of the TTL has passed").toEqual([]);

    clock.advance(1);
    await flushMicrotasks();
    expect(renewedAt).toEqual([4_000]);
    expect(seenLeaseIds).toEqual(["lse_1"]);

    // 6_000ms of TTL came back, so the next renewal is 2_000ms out -- not the 3_000ms the
    // grant's own TTL would imply, and not 3_000ms after the previous *scheduled* time either.
    clock.advance(1_999);
    await flushMicrotasks();
    expect(renewedAt).toEqual([4_000]);
    clock.advance(1);
    await flushMicrotasks();
    expect(renewedAt).toEqual([4_000, 6_000]);

    renewal.stop();
  });

  it("stops cleanly: the pending timer is cancelled and no renewal follows", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const renewal = startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      renew: () => {
        calls += 1;
        return Promise.resolve({ ttlDeadline: clock.now() + 3_000 });
      },
      ttlDeadline: 3_000,
    });
    expect(clock.pendingTimerCount).toBe(1);

    renewal.stop();

    expect(clock.pendingTimerCount, "a stopped renewal leaves no timer behind").toBe(0);
    clock.advance(60_000);
    await flushMicrotasks();
    expect(calls).toBe(0);
  });

  it("does not reschedule when a renewal that was already in flight comes back after stop()", async () => {
    const clock = new FakeClock(0);
    let resolveRenew!: (renewed: { ttlDeadline: number }) => void;
    let calls = 0;
    const renewal = startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      renew: () => {
        calls += 1;
        return new Promise<{ ttlDeadline: number }>((resolve) => {
          resolveRenew = resolve;
        });
      },
      ttlDeadline: 3_000,
    });

    clock.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);

    renewal.stop();
    resolveRenew({ ttlDeadline: 60_000 });
    await flushMicrotasks();

    expect(clock.pendingTimerCount, "a late renewal must not re-arm a stopped timer").toBe(0);
    clock.advance(60_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  it("retries a failed renewal while the lease can still be saved, and reports every attempt", async () => {
    const clock = new FakeClock(0);
    const failure = new Error("INTERNAL");
    const errors: unknown[] = [];
    const attemptsAt: number[] = [];
    let failuresLeft = 1;
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onError: (error) => errors.push(error),
      renew: () => {
        attemptsAt.push(clock.now());
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Promise.reject(failure);
        }
        return Promise.resolve({ ttlDeadline: clock.now() + 3_000 });
      },
      ttlDeadline: 3_000,
    });

    // A daemon that failed to persist one renewal is still willing to serve the next, and the
    // one-third cadence exists precisely to leave room for the retry.
    clock.advance(1_000);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000]);
    expect(errors).toEqual([failure]);

    clock.advance(666);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000, 1_666]);
    expect(errors).toHaveLength(1);
    // The successful retry put the lease back on a full TTL: renewal continues from there.
    expect(clock.pendingTimerCount).toBe(1);
  });

  it("gives up once the lease's own deadline has passed", async () => {
    const clock = new FakeClock(0);
    const errors: unknown[] = [];
    let calls = 0;
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onError: (error) => errors.push(error),
      renew: () => {
        calls += 1;
        return Promise.reject(new Error("DAEMON_CONNECTION_LOST"));
      },
      ttlDeadline: 3_000,
    });

    // Retries keep shrinking with what is left of the TTL; once the deadline is behind us
    // there is nothing left to save, and the timer is gone for good.
    clock.advance(60_000);
    await flushMicrotasks();
    expect(clock.pendingTimerCount).toBe(0);
    const attemptsBefore = calls;
    expect(errors).toHaveLength(attemptsBefore);

    clock.advance(600_000);
    await flushMicrotasks();
    expect(calls).toBe(attemptsBefore);
  });

  it("abandons a renewal the daemon never answers, and retries it", async () => {
    const clock = new FakeClock(0);
    const errors: unknown[] = [];
    let calls = 0;
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onError: (error) => errors.push(error),
      renew: () => {
        calls += 1;
        // Accepted and never answered: the wire has no request timeout of its own.
        return new Promise<{ ttlDeadline: number }>(() => {});
      },
      ttlDeadline: 9_000,
    });

    clock.advance(3_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(errors).toEqual([]);

    // The attempt is bounded by the interval it was scheduled on (2_000ms of the 6_000ms
    // left), so it does not swallow the rest of the TTL in silence.
    clock.advance(2_000);
    await flushMicrotasks();
    expect(errors).toHaveLength(1);
    expect(calls).toBe(1);

    clock.advance(1_333);
    await flushMicrotasks();
    expect(calls).toBe(2);
  });

  it("never reports a failure that arrives after stop()", async () => {
    const clock = new FakeClock(0);
    let rejectRenew!: (error: Error) => void;
    const errors: unknown[] = [];
    const renewal = startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onError: (error) => errors.push(error),
      renew: () =>
        new Promise<{ ttlDeadline: number }>((_resolve, reject) => {
          rejectRenew = reject;
        }),
      ttlDeadline: 3_000,
    });

    clock.advance(1_000);
    await flushMicrotasks();
    renewal.stop();
    rejectRenew(new Error("connection lost"));
    await flushMicrotasks();

    expect(errors).toEqual([]);
  });

  it("tries a deadline that is already in the past once, then stops instead of hot-looping", async () => {
    const clock = new FakeClock(1_000);
    const renewedAt: number[] = [];
    const errors: unknown[] = [];
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onError: (error) => errors.push(error),
      renew: () => {
        renewedAt.push(clock.now());
        // A daemon answering with a deadline that is not in the future -- reachable with
        // `lease.heldTtlBackstopMs: 0`, which the config validator allows.
        return Promise.resolve({ ttlDeadline: clock.now() });
      },
      // Already expired at the grant: the floor keeps even this from being an instant loop.
      ttlDeadline: 500,
    });

    clock.advance(249);
    await flushMicrotasks();
    expect(renewedAt).toEqual([]);
    clock.advance(1);
    await flushMicrotasks();
    expect(renewedAt).toEqual([1_250]);

    // Nothing to renew towards: renewal ends rather than spinning at the floor forever.
    expect(clock.pendingTimerCount).toBe(0);
    expect(errors).toHaveLength(1);
    clock.advance(600_000);
    await flushMicrotasks();
    expect(renewedAt).toEqual([1_250]);
  });
});
