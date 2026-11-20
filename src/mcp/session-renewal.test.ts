import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";
import { McpSession } from "./session.js";
import { flushMicrotasks } from "./test-session.js";

describe("McpSession", () => {
  it("renews its lease at a third of the TTL, re-deriving the cadence from each renewal", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    const renewals: Array<{ leaseId: string; at: number }> = [];
    client.renewLeaseImpl = (input) => {
      renewals.push({ at: clock.now(), leaseId: input.leaseId });
      return Promise.resolve({
        deviceId: "device-1",
        grantedAt: 0,
        id: input.leaseId,
        ownerId: "mcp-test",
        requesterId: "mcp-test",
        lastRenewedAt: 0,
        idChosenByRequester: false,
        ttlMs: 60_000,
        ttlDeadline: clock.now() + 3_000,
      });
    };
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });

    // why: `sampleGrant`'s deadline is 12_345, so the first renewal is due at 4_115.
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    clock.advance(4_114);
    await flushMicrotasks();
    expect(renewals).toEqual([]);
    clock.advance(1);
    await flushMicrotasks();
    expect(renewals).toEqual([{ at: 4_115, leaseId: "lease-1" }]);

    // why: 3_000ms came back, so the next one is 1_000ms later -- off the renewal's own deadline.
    clock.advance(1_000);
    await flushMicrotasks();
    expect(renewals).toHaveLength(2);
    expect(renewals[1]).toEqual({ at: 5_115, leaseId: "lease-1" });

    await session.close();
  });

  it("renews on the lease's own width, not on the time left to its deadline", async () => {
    // why: The session passes `ttlMs` as well as `ttlDeadline` (see `startLeaseRenewal`): the width
    // sets the cadence, the deadline only bounds it. A lease granted narrow against a distant
    // deadline is where the two visibly differ -- 10_000 apart, not 100_000.
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    const grant = sampleGrant({ leaseId: "lease-1" });
    client.requestLeaseImpl = () =>
      Promise.resolve({
        ...grant,
        lease: { ...grant.lease, ttlDeadline: 300_000, ttlMs: 30_000 },
      });
    const renewedAt: number[] = [];
    client.renewLeaseImpl = (input) => {
      renewedAt.push(clock.now());
      return Promise.resolve({
        ...grant.lease,
        id: input.leaseId,
        lastRenewedAt: clock.now(),
        idChosenByRequester: false,
        ttlDeadline: clock.now() + 300_000,
        ttlMs: 30_000,
      });
    };
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    clock.advance(10_000);
    await flushMicrotasks();
    expect(renewedAt).toEqual([10_000]);

    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    await session.close();
  });

  it("renews and releases every lease it obtained, not only the latest", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    let granted = 0;
    client.requestLeaseImpl = () => {
      granted += 1;
      return Promise.resolve(sampleGrant({ leaseId: `lease-${granted}` }));
    };
    const renewed: string[] = [];
    client.renewLeaseImpl = (input) => {
      renewed.push(input.leaseId);
      return Promise.resolve({
        deviceId: "device-1",
        grantedAt: 0,
        id: input.leaseId,
        lastRenewedAt: clock.now(),
        idChosenByRequester: false,
        ownerId: "mcp-test",
        requesterId: "mcp-test",
        ttlMs: 12_345,
        ttlDeadline: clock.now() + 12_345,
      });
    };
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });

    // why: Nothing here limits a session to one lease -- the daemon's one-lease-per-requester rule
    // is the authority (ADR 0003 §11). Whatever it grants, this session has to keep alive and
    // hand back; the second grant must not silently strand the first.
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    clock.advance(4_115);
    await flushMicrotasks();
    expect(renewed.slice().sort()).toEqual(["lease-1", "lease-2"]);

    await session.close();
    expect(
      client.calls
        .filter((call) => call.method === "releaseLease")
        .map((call) => (call.input as { leaseId: string }).leaseId)
        .sort(),
    ).toEqual(["lease-1", "lease-2"]);
    expect(clock.pendingTimerCount).toBe(0);
  });
});
