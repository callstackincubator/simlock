import { describe, expect, it, vi } from "vitest";

import { tokenIdentity } from "../../auth/testing.js";
import type { Identity } from "../../auth/index.js";
import { FakeClock } from "../../ports/index.js";
import { FrontMap } from "./front-map.js";

const agent: Identity = tokenIdentity("tok_a");
const ttlMs = 60_000;

function entry(deadline: number) {
  return { address: "device-addr", deadline, identity: agent, ttlMs };
}

describe("the front map", () => {
  it("drops an ended entry one TTL after it ended, at the next read or write", () => {
    const clock = new FakeClock(1_000);
    const map = new FrontMap(clock);
    map.add("lease-a", entry(70_000));
    map.markEnded("lease-a");

    clock.advance(ttlMs - 1);
    expect(map.get("lease-a")).toMatchObject({ endedAt: 1_000 });

    clock.advance(1);
    map.add("lease-b", entry(500_000));
    expect(map.get("lease-a")).toBeUndefined();
    expect(map.get("lease-b")).toBeDefined();
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("at an allocate marks an entry past its latest deadline ended when lease.list no longer shows its lease, and lets one it still shows take the listed deadline", async () => {
    const clock = new FakeClock(1_000);
    const map = new FrontMap(clock);
    map.add("gone", entry(2_000));
    map.add("kept", entry(2_000));
    map.add("fresh", entry(9_000_000));
    clock.advance(10_000);
    const list = vi.fn(async () => [{ id: "kept", ttlDeadline: 500_000 }]);

    await map.refresh(list);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(agent);
    expect(map.get("gone")?.endedAt).toBe(11_000);
    expect(map.get("kept")).toMatchObject({ deadline: 500_000 });
    expect(map.get("kept")?.endedAt).toBeUndefined();
    expect(map.get("fresh")).toMatchObject({ deadline: 9_000_000 });
    expect(map.get("fresh")?.endedAt).toBeUndefined();
  });

  it("keeps a lease ID in the waiting list while any allocate with it still waits", () => {
    const map = new FrontMap(new FakeClock(1_000));
    map.startWaiting("lease-a");
    map.startWaiting("lease-a");
    map.startWaiting("lease-b");

    map.stopWaiting("lease-a");
    expect(map.waitingIds()).toEqual(["lease-a", "lease-b"]);

    map.stopWaiting("lease-a");
    map.stopWaiting("lease-b");
    expect(map.waitingIds()).toEqual([]);
  });

  it("leaves every entry unchanged when lease.list fails for its principal", async () => {
    const clock = new FakeClock(1_000);
    const map = new FrontMap(clock);
    map.add("lease-a", entry(2_000));
    clock.advance(10_000);

    await map.refresh(async () => {
      throw new Error("lease.list refused");
    });

    expect(map.get("lease-a")).toMatchObject({ deadline: 2_000 });
    expect(map.get("lease-a")?.endedAt).toBeUndefined();
  });

  it("asks lease.list for at most 100 principals, the ones holding the oldest deadlines", async () => {
    const clock = new FakeClock(1_000);
    const map = new FrontMap(clock);
    for (let n = 0; n < 101; n += 1) {
      const identity: Identity = tokenIdentity(`tok_${n}`);
      map.add(`lease-${n}`, { address: "a", deadline: 2_100 - n, identity, ttlMs });
    }
    clock.advance(10_000);
    const asked: string[] = [];

    await map.refresh(async (who) => {
      asked.push(who.principal);
      return [];
    });

    expect(asked).toHaveLength(100);
    expect(asked).toContain("tok_100");
    expect(asked).not.toContain("tok_0");
    expect(map.get("lease-100")?.endedAt).toBeDefined();
    expect(map.get("lease-0")?.endedAt).toBeUndefined();
  });
});
