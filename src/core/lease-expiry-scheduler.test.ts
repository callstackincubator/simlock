import { describe, expect, it } from "vitest";

import { FakeClock } from "../ports/index.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";

const lease = (id: string, ttlDeadline: number) => ({
  deviceId: `dev_${id}`,
  grantedAt: 0,
  id,
  mode: "detached" as const,
  requesterId: "agent",
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

  it("disposes all timers and never uses the event bus as an expiry command path", () => {
    const clock = new FakeClock();
    const scheduler = new LeaseExpiryScheduler(clock, () => undefined);
    scheduler.arm(lease("one", 10));
    scheduler.dispose();
    clock.advance(10);
    expect(clock.pendingTimerCount).toBe(0);
  });
});
