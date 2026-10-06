import { describe, expect, it } from "vitest";

import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";

const lease = (id: string, ttlDeadline: number) => ({
  deviceId: `dev_${id}`,
  grantedAt: 0,
  id,
  lastRenewedAt: 0,
  requesterId: "agent",
  ownerId: "agent",
  ttlMs: ttlDeadline,
  ttlDeadline,
});

describe("LeaseExpiryScheduler", () => {
  it("replaces and cancels timers", async () => {
    const clock = new FakeClock(100);
    const expired: string[] = [];
    const scheduler = new LeaseExpiryScheduler(clock, async (leaseId) => {
      expired.push(leaseId);
    });

    scheduler.arm(lease("one", 110));
    scheduler.replace(lease("one", 120));
    scheduler.arm(lease("two", 115));
    scheduler.cancel("two");
    clock.advance(20);
    await Promise.resolve();

    expect(expired).toEqual(["one"]);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("restores future leases and handles already-expired leases in deterministic order", async () => {
    const clock = new FakeClock(100);
    const expired: string[] = [];
    const scheduler = new LeaseExpiryScheduler(clock, async (leaseId) => {
      expired.push(leaseId);
    });

    await scheduler.restore([
      lease("z", 90),
      lease("b", 100),
      lease("a", 100),
      lease("later", 120),
    ]);

    expect(expired).toEqual(["z", "a", "b"]);
    expect(clock.pendingTimerCount).toBe(1);
    clock.advance(20);
    await Promise.resolve();
    expect(expired).toEqual(["z", "a", "b", "later"]);
  });

  it("cancels every armed timer on dispose, and expires nothing afterwards", async () => {
    const clock = new FakeClock();
    const expired: string[] = [];
    const scheduler = new LeaseExpiryScheduler(clock, async (leaseId) => {
      expired.push(leaseId);
    });
    scheduler.arm(lease("one", 10));
    scheduler.arm(lease("two", 20));

    scheduler.dispose();

    // Cancelled, not merely left to fire into a no-op: a live timer keeps the daemon's event loop
    // open for the rest of the lease's TTL.
    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(20);
    await Promise.resolve();
    expect(expired).toEqual([]);
  });

  it("A lease expiry that throws logs at error with the lease id.", async () => {
    const clock = new FakeClock(100);
    const sink = new MemoryLogSink();
    const scheduler = new LeaseExpiryScheduler(
      clock,
      async () => {
        throw new Error("release exploded");
      },
      new JsonLinesLogger({ clock, sink }),
    );

    scheduler.arm(lease("one", 110));
    clock.advance(10);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "error",
        module: "daemon.lease-expiry-scheduler",
        fields: { error: "Error: release exploded", leaseId: "one", step: "expire" },
      }),
    ]);
  });
});
