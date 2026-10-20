import { describe, expect, it } from "vitest";

import { tokenIdentity } from "../../auth/testing.js";
import type { Identity } from "../../auth/index.js";
import { FakeClock } from "../../ports/index.js";
import type { FrontContext } from "./context.js";
import { FrontMap } from "./front-map.js";
import { Renewals } from "./renewals.js";

const agent: Identity = tokenIdentity("tok_a");
const longestTimerDelayMs = 2 ** 31 - 1;

describe("the renewals", () => {
  it("never asks the clock for a delay past the longest a timer can run, so a huge `lease.maxTtlMs` does not end a running call at once", () => {
    const clock = new FakeClock(1_000);
    const delays: number[] = [];
    const setTimer = clock.setTimer.bind(clock);
    clock.setTimer = (ms, callback) => {
      delays.push(ms);
      return setTimer(ms, callback);
    };
    const map = new FrontMap(clock);
    map.add("lease-a", { address: "addr", deadline: 9e12, identity: agent, ttlMs: 2 ** 33 });
    const renewals = new Renewals(clock);
    const context = { map } as unknown as FrontContext;

    renewals.begin(context, "lease-a", agent.principal, 2 ** 40);

    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...delays)).toBeLessThanOrEqual(longestTimerDelayMs);
    renewals.dispose();
  });

  it("stops the renewal timer of a lease that ended, leaving only the running call's own limit timer", () => {
    const clock = new FakeClock(1_000);
    const map = new FrontMap(clock);
    map.add("lease-a", { address: "addr", deadline: 9e12, identity: agent, ttlMs: 60_000 });
    const renewals = new Renewals(clock);
    const context = { map } as unknown as FrontContext;
    renewals.begin(context, "lease-a", agent.principal, 1_800_000);
    expect(clock.pendingTimerCount).toBe(2);

    map.markEnded("lease-a");
    renewals.cancelIfEnded(context, "lease-a");

    expect(clock.pendingTimerCount).toBe(1);
    renewals.dispose();
  });
});
