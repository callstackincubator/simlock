/**
 * The renew cadence ADR 0004 §2 specifies, exercised on a hand-advanced `FakeClock`: a third of
 * the *remaining* TTL, recomputed from the deadline the daemon returned every time, and nothing
 * at all after `stop()`.
 */
import { describe, expect, it } from "vitest";

import { SimlockError } from "../contract/index.js";
import { FakeClock } from "../ports/index.js";
import { awaitWithin, RELEASE_TIMEOUT_MS, startLeaseRenewal } from "./index.js";

/** Lets the awaited `renew` call settle; the fake clock never moves on its own. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

/** The daemon's two "this lease is not yours to renew" answers, with their real detail shapes. */
function leaseGoneError(code: "UNKNOWN_LEASE" | "FORBIDDEN"): SimlockError {
  return code === "UNKNOWN_LEASE"
    ? new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", { leaseId: "lse_1" })
    : new SimlockError("FORBIDDEN", "protocol", "not your lease", {});
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
        // The daemon's answer -- deliberately a shorter TTL than the grant's, and a
        // deadline the grant's own (10_000) could never produce, so a cadence derived from
        // anything but this value shows up as a wrong timestamp below.
        return Promise.resolve({ ttlDeadline: clock.now() + 3_000 });
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

    // 3_000ms of TTL came back at 4_000, so the next renewal is 1_000ms out -- not the
    // 2_000ms the grant's own deadline would still imply, and not 3_000ms after the previous
    // scheduled time either.
    clock.advance(999);
    await flushMicrotasks();
    expect(renewedAt).toEqual([4_000]);
    clock.advance(1);
    await flushMicrotasks();
    expect(renewedAt).toEqual([4_000, 5_000]);

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

  it.each(["UNKNOWN_LEASE", "FORBIDDEN"] as const)(
    "treats %s as the end of the lease, not a failed attempt",
    async (code) => {
      const clock = new FakeClock(0);
      const gone: Array<{ reason: string; error: unknown }> = [];
      const errors: unknown[] = [];
      let calls = 0;
      startLeaseRenewal({
        clock,
        leaseId: "lse_1",
        onError: (error) => errors.push(error),
        onLeaseGone: (reason, error) => gone.push({ error, reason }),
        renew: () => {
          calls += 1;
          return Promise.reject(leaseGoneError(code));
        },
        ttlDeadline: 30_000,
      });

      clock.advance(10_000);
      await flushMicrotasks();

      expect(gone).toHaveLength(1);
      expect(gone[0]?.reason, "the daemon's answer, not a failure to reach it").toBe(
        "renew-rejected",
      );
      expect(gone[0]?.error).toMatchObject({ code });
      expect(errors, "a lease that is over is not a retryable failure").toEqual([]);
      expect(clock.pendingTimerCount).toBe(0);

      clock.advance(600_000);
      await flushMicrotasks();
      expect(calls, "and it is never retried").toBe(1);
    },
  );

  it("reports and retries a renew that throws synchronously", async () => {
    const clock = new FakeClock(0);
    const errors: unknown[] = [];
    const attemptsAt: number[] = [];
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onError: (error) => errors.push(error),
      renew: () => {
        attemptsAt.push(clock.now());
        // A client that validates its input before it ever reaches the wire throws here
        // rather than rejecting; that must not escape into the unawaited tick.
        if (attemptsAt.length === 1) throw new Error("BAD_REQUEST");
        return Promise.resolve({ ttlDeadline: clock.now() + 3_000 });
      },
      ttlDeadline: 3_000,
    });

    clock.advance(1_000);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000]);
    expect((errors[0] as Error).message).toBe("BAD_REQUEST");

    clock.advance(666);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000, 1_666]);
    expect(clock.pendingTimerCount).toBe(1);
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

  it("retries on a shrinking ladder, then gives up once the lease's own deadline has passed", async () => {
    const clock = new FakeClock(0);
    const errors: Error[] = [];
    const gone: Array<{ reason: string; error: Error }> = [];
    const attemptsAt: number[] = [];
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onError: (error) => errors.push(error as Error),
      onLeaseGone: (reason, error) => gone.push({ error: error as Error, reason }),
      renew: () => {
        attemptsAt.push(clock.now());
        return Promise.reject(new Error("INTERNAL"));
      },
      ttlDeadline: 3_000,
    });

    // Every retry is a third of what is *left* of the TTL, so the ladder shrinks towards the
    // deadline instead of marching past it at a fixed interval.
    clock.advance(1_000);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000]);
    clock.advance(666);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000, 1_666]);
    clock.advance(444);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000, 1_666, 2_110]);
    expect(errors.map((error) => error.message)).toEqual(["INTERNAL", "INTERNAL", "INTERNAL"]);

    // Once the deadline is behind us there is nothing left to save. That is the end of the
    // lease, not one more failed attempt, so it is reported as such -- a holder that only
    // watched `onError` would sit alive holding nothing.
    clock.advance(60_000);
    await flushMicrotasks();
    expect(clock.pendingTimerCount).toBe(0);
    expect(gone).toHaveLength(1);
    expect(gone[0]?.reason).toBe("renew-failed");
    expect(gone[0]?.error.message).toContain("Gave up renewing lease lse_1");

    const attempts = attemptsAt.length;
    clock.advance(600_000);
    await flushMicrotasks();
    expect(attemptsAt).toHaveLength(attempts);
  });

  it("keeps a deadline an abandoned renewal turns out to have moved", async () => {
    const clock = new FakeClock(0);
    const attemptsAt: number[] = [];
    let answerFirst!: (renewed: { ttlDeadline: number }) => void;
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      renew: () => {
        attemptsAt.push(clock.now());
        if (attemptsAt.length > 1) return Promise.reject(new Error("INTERNAL"));
        return new Promise<{ ttlDeadline: number }>((resolve) => {
          answerFirst = resolve;
        });
      },
      ttlDeadline: 3_000,
    });

    clock.advance(1_000);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000]);

    // The attempt is abandoned at its bound (a third of the 2_000ms left), and only then does
    // the daemon answer it. The request still reached the daemon, so that deadline is real.
    clock.advance(666);
    await flushMicrotasks();
    answerFirst({ ttlDeadline: 30_000 });
    await flushMicrotasks();

    clock.advance(444);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000, 2_110]);

    // Working towards 30_000 now, not the stale 3_000: a retry lands long after the deadline
    // this renewal would otherwise have given up at, because the lease has not expired.
    clock.advance(9_296);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([1_000, 2_110, 11_406]);
    expect(clock.pendingTimerCount).toBe(1);
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

    // The attempt is bounded by a third of what is left of the TTL when it starts (2_000ms of
    // the 6_000ms remaining at 3_000), so it does not swallow the rest of the TTL in silence.
    clock.advance(2_000);
    await flushMicrotasks();
    expect(errors).toHaveLength(1);
    expect(calls).toBe(1);

    clock.advance(1_333);
    await flushMicrotasks();
    expect(calls).toBe(2);
  });

  it("ignores an abandoned renewal's answer once a newer one has come back", async () => {
    const clock = new FakeClock(0);
    const errors: Error[] = [];
    const gone: Array<{ reason: string }> = [];
    let answerFirst!: (renewed: { ttlDeadline: number }) => void;
    let attempts = 0;
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onError: (error) => errors.push(error as Error),
      onLeaseGone: (reason) => gone.push({ reason }),
      renew: () => {
        attempts += 1;
        if (attempts === 1)
          return new Promise<{ ttlDeadline: number }>((resolve) => {
            answerFirst = resolve;
          });
        // The second attempt is the daemon's newest word: 3_000ms from now.
        if (attempts === 2) return Promise.resolve({ ttlDeadline: clock.now() + 3_000 });
        return Promise.reject(new Error("INTERNAL"));
      },
      ttlDeadline: 3_000,
    });

    clock.advance(1_000); // attempt 1, abandoned at its bound below
    await flushMicrotasks();
    clock.advance(666);
    await flushMicrotasks();
    clock.advance(444); // attempt 2 at 2_110, answering 5_110
    await flushMicrotasks();
    expect(attempts).toBe(2);

    // Attempt 1 finally answers, with a far longer deadline -- but it is older than attempt 2,
    // whose answer is the daemon's current word. Adopting it would have this holder renewing
    // towards a deadline the daemon never promised.
    answerFirst({ ttlDeadline: 999_999 });
    await flushMicrotasks();

    clock.advance(60_000);
    await flushMicrotasks();
    expect(clock.pendingTimerCount, "renewal works towards 5_110, so it gives up past it").toBe(0);
    expect(gone.at(-1)?.reason).toBe("renew-failed");
  });

  it("applies two late answers newest-first, not largest-first", async () => {
    const clock = new FakeClock(0);
    const attemptsAt: number[] = [];
    const answers: Array<(renewed: { ttlDeadline: number }) => void> = [];
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      renew: () => {
        attemptsAt.push(clock.now());
        // The first two attempts are accepted and left unanswered until the end of the test;
        // everything after fails, so the schedule is driven purely by `deadline`.
        if (attemptsAt.length <= 2)
          return new Promise<{ ttlDeadline: number }>((resolve) => {
            answers.push(resolve);
          });
        return Promise.reject(new Error("INTERNAL"));
      },
      ttlDeadline: 9_000,
    });

    clock.advance(3_000); // attempt 1 starts, bound 2_000
    await flushMicrotasks();
    clock.advance(2_000); // abandoned at 5_000; next attempt at 6_333
    await flushMicrotasks();
    clock.advance(1_333); // attempt 2 starts, bound 889
    await flushMicrotasks();
    clock.advance(889); // abandoned at 7_222; next attempt at 7_814
    await flushMicrotasks();
    expect(attemptsAt).toEqual([3_000, 6_333]);

    // Both abandoned requests did reach the daemon, and answer out of order. Attempt 2 is the
    // newer request, so its 12_000 is the truth; attempt 1's 900_000 is stale, and being the
    // larger number does not make it newer -- adopting it would leave this holder renewing
    // long after the lease was gone.
    answers[1]?.({ ttlDeadline: 12_000 });
    await flushMicrotasks();
    answers[0]?.({ ttlDeadline: 900_000 });
    await flushMicrotasks();

    clock.advance(592); // attempt 3 at 7_814, which fails and reschedules off the deadline
    await flushMicrotasks();
    expect(attemptsAt).toEqual([3_000, 6_333, 7_814]);

    // A third of what is left of 12_000 at 7_814 is 1_395ms -- so the next attempt lands at
    // 9_209. Against the stale 900_000 it would not have come for another five minutes.
    clock.advance(1_395);
    await flushMicrotasks();
    expect(attemptsAt).toEqual([3_000, 6_333, 7_814, 9_209]);
  });

  it("does not send a renewal that stop() beat to the wire", async () => {
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

    // The timer has fired -- the tick is running -- but `stop()` lands before the request
    // leaves. "No further `renew` call" has to mean this too, or a released lease gets one
    // last renewal after its release.
    clock.advance(1_000);
    renewal.stop();
    await flushMicrotasks();

    expect(calls).toBe(0);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("clamps the delay to what a timer can express, for a deadline months away", async () => {
    const clock = new FakeClock(0);
    const renewedAt: number[] = [];
    const ninetyDays = 90 * 24 * 60 * 60 * 1_000;
    const renewal = startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      renew: () => {
        renewedAt.push(clock.now());
        return Promise.resolve({ ttlDeadline: clock.now() + ninetyDays });
      },
      ttlDeadline: ninetyDays,
    });

    // A third of 90 days is past what `setTimeout` can hold, and a truncated delay would fire
    // in a millisecond -- the hot loop the floor exists to prevent, from the other end.
    clock.advance(2_147_483_646);
    await flushMicrotasks();
    expect(renewedAt).toEqual([]);

    clock.advance(1);
    await flushMicrotasks();
    expect(renewedAt).toEqual([2_147_483_647]);

    renewal.stop();
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
    const gone: Array<{ reason: string }> = [];
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onLeaseGone: (reason) => gone.push({ reason }),
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

    // Nothing to renew towards: renewal ends -- and says so, rather than spinning at the floor
    // forever or leaving the holder to infer it.
    expect(clock.pendingTimerCount).toBe(0);
    expect(gone).toEqual([{ reason: "renew-failed" }]);
    clock.advance(600_000);
    await flushMicrotasks();
    expect(renewedAt).toEqual([1_250]);
  });
});

/**
 * The bound both frontends put on their farewell `lease.release`: an unresponsive daemon may
 * cost a holder the wait, never its exit.
 */
describe("awaitWithin", () => {
  it("resolves with the work and leaves no timer behind", async () => {
    const clock = new FakeClock(0);

    await expect(
      awaitWithin(clock, RELEASE_TIMEOUT_MS, Promise.resolve({ leaseId: "lse_1" }), "too slow"),
    ).resolves.toEqual({ leaseId: "lse_1" });
    // A live timer here would keep a real process alive for the whole bound after the work
    // it was guarding had already finished.
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("rejects with the given message once the bound passes, and cleans up after itself", async () => {
    const clock = new FakeClock(0);
    const bounded = awaitWithin(
      clock,
      RELEASE_TIMEOUT_MS,
      new Promise<void>(() => {}),
      "Timed out releasing lease lse_1",
    );
    await flushMicrotasks();
    expect(clock.pendingTimerCount).toBe(1);

    clock.advance(RELEASE_TIMEOUT_MS - 1);
    await flushMicrotasks();
    expect(clock.pendingTimerCount).toBe(1);

    clock.advance(1);
    await expect(bounded).rejects.toThrow("Timed out releasing lease lse_1");
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("propagates the work's own rejection rather than waiting out the bound", async () => {
    const clock = new FakeClock(0);
    const failure = new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", {
      leaseId: "lse_1",
    });

    await expect(
      awaitWithin(clock, RELEASE_TIMEOUT_MS, Promise.reject(failure), "too slow"),
    ).rejects.toBe(failure);
    expect(clock.pendingTimerCount).toBe(0);
  });
});
