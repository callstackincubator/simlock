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

  it("ends renewal on the first failure, reporting it exactly once", async () => {
    const clock = new FakeClock(0);
    const failure = new Error("UNKNOWN_LEASE");
    const errors: unknown[] = [];
    let calls = 0;
    startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      onError: (error) => errors.push(error),
      renew: () => {
        calls += 1;
        return Promise.reject(failure);
      },
      ttlDeadline: 3_000,
    });

    clock.advance(1_000);
    await flushMicrotasks();
    expect(errors).toEqual([failure]);
    expect(clock.pendingTimerCount).toBe(0);

    clock.advance(60_000);
    await flushMicrotasks();
    expect(calls, "a failed renewal is not retried on a timer").toBe(1);
    expect(errors).toHaveLength(1);
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

  it("still renews a deadline that is already in the past, without becoming a hot loop", async () => {
    const clock = new FakeClock(1_000);
    const renewedAt: number[] = [];
    const renewal = startLeaseRenewal({
      clock,
      leaseId: "lse_1",
      renew: () => {
        renewedAt.push(clock.now());
        // A daemon that keeps answering with an expired deadline: without the floor this
        // would renew once per tick forever.
        return Promise.resolve({ ttlDeadline: clock.now() });
      },
      ttlDeadline: 500,
    });

    clock.advance(249);
    await flushMicrotasks();
    expect(renewedAt).toEqual([]);
    clock.advance(1);
    await flushMicrotasks();
    expect(renewedAt).toEqual([1_250]);

    clock.advance(250);
    await flushMicrotasks();
    expect(renewedAt).toEqual([1_250, 1_500]);

    renewal.stop();
  });
});
