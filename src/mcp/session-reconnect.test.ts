import { describe, expect, it } from "vitest";
import { SimlockError } from "../client/index.js";
import { FakeClock } from "../ports/index.js";
import { FakeSimlockClient, sampleGrant, startingStatus } from "./test-support.js";
import { McpSession } from "./session.js";
import { flushMicrotasks } from "./test-session.js";

describe("McpSession", () => {
  it("renews over connectForRenew after a dead connection, and never over connect", async () => {
    // why: ADR 0004 §2's named safety property: the renew timer reconnects so an idle session does
    // not lose its lease waiting for a tool call, but it reaches only a daemon that is already
    // listening. `connect` is the trigger that may auto-launch one, so an operator's `simlock
    // daemon stop` staying done depends on the timer never reaching for it.
    const clock = new FakeClock(0);
    const first = new FakeSimlockClient();
    first.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    const second = new FakeSimlockClient();
    second.renewLeaseImpl = (input) =>
      Promise.resolve({
        deviceId: "device-1",
        grantedAt: 0,
        id: input.leaseId,
        lastRenewedAt: clock.now(),
        idChosenByRequester: false,
        ownerId: "agent-1",
        requesterId: "agent-1",
        ttlMs: 1_000,
        ttlDeadline: clock.now() + 1_000,
      });

    let toolCallConnects = 0;
    let renewConnects = 0;
    const session = new McpSession({
      clock,
      connect: async () => {
        toolCallConnects += 1;
        // why: Reached a second time only by a timer taking the launching path -- which would be
        // the bug, so it fails loudly here rather than quietly handing back a client.
        if (toolCallConnects > 1) throw new Error("the renew timer reached the launching connect");
        return first;
      },
      connectForRenew: async () => {
        renewConnects += 1;
        return second;
      },
    });
    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));

    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    expect(toolCallConnects).toBe(1);
    expect(renewConnects).toBe(0);

    first.emitConnectionLost();

    clock.advance(4_115);
    await flushMicrotasks();
    expect(renewConnects).toBe(1);
    expect(toolCallConnects).toBe(1);
    expect(second.calls.map((call) => call.method)).toEqual(["renewLease"]);

    // why: And the session listens to the connection it just built, not only to the one it started
    // with: a lease-lost over the new wire is the agent's only warning that the device is
    // gone, and a session that forgot to re-wire would sit silent through it.
    second.emitLeaseLost({ deviceId: "device-1", leaseId: "lease-1", reason: "expired" });
    expect(notices).toEqual([{ deviceId: "device-1", leaseId: "lease-1", reason: "expired" }]);

    await session.close();
  });

  it("retries alone with the launching connect when a tool call joined a renew's attempt", async () => {
    // why: The CLI reference and the client guide promise a tool call may start a daemon that is not
    // running. Sharing `#connecting` with the renew timer is free in the other direction, but
    // here it would hand the tool call the timer's weaker attempt -- and "nothing is
    // listening" for something it was allowed to fix.
    const clock = new FakeClock(0);
    const first = new FakeSimlockClient();
    first.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    const second = new FakeSimlockClient();
    second.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    second.getStatusImpl = () => Promise.resolve(startingStatus());
    let toolCallConnects = 0;
    let failRenewConnect!: (error: unknown) => void;
    const session = new McpSession({
      clock,
      connect: async () => {
        toolCallConnects += 1;
        return toolCallConnects === 1 ? first : second;
      },
      connectForRenew: () =>
        new Promise((_resolve, reject) => {
          failRenewConnect = reject;
        }),
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    first.emitConnectionLost();

    clock.advance(4_115);
    await flushMicrotasks();
    const listing = session.listDevices({});
    await flushMicrotasks();
    expect(toolCallConnects).toBe(1);

    // why: Nothing is listening, so that attempt fails -- for the timer, which will try again on
    // its own cadence, and for the tool call, which instead tries once more with the connect
    // that may start a daemon.
    failRenewConnect(
      new SimlockError("DAEMON_CONNECTION_LOST", "transport", "nothing is listening", {}),
    );

    await expect(listing).resolves.toEqual({ platforms: [], physicalDevices: [] });
    expect(toolCallConnects, "the tool call's own attempt, made alone").toBe(2);

    await session.close();
  });

  it("lets a renew tick share a tool call's connect, which is the direction that costs nothing", async () => {
    // why: The timer wanted a connection and got one. That the tool call was going to launch a
    // daemon anyway is the tool call's business, not the timer's doing -- so this direction
    // stays shared, and the session ends up with one connection rather than two.
    const clock = new FakeClock(0);
    const first = new FakeSimlockClient();
    first.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    const second = new FakeSimlockClient();
    second.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    second.getStatusImpl = () => Promise.resolve(startingStatus());
    second.renewLeaseImpl = (input) =>
      Promise.resolve({
        deviceId: "device-1",
        grantedAt: 0,
        id: input.leaseId,
        lastRenewedAt: clock.now(),
        idChosenByRequester: false,
        ownerId: "mcp-test",
        requesterId: "mcp-test",
        ttlMs: 60_000,
        ttlDeadline: clock.now() + 60_000,
      });
    let toolCallConnects = 0;
    let renewConnects = 0;
    let answerToolCallConnect!: (client: FakeSimlockClient) => void;
    const session = new McpSession({
      clock,
      connect: () => {
        toolCallConnects += 1;
        if (toolCallConnects === 1) return Promise.resolve(first);
        return new Promise((resolve) => {
          answerToolCallConnect = resolve;
        });
      },
      connectForRenew: async () => {
        renewConnects += 1;
        return second;
      },
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    first.emitConnectionLost();

    const listing = session.listDevices({});
    await flushMicrotasks();
    expect(toolCallConnects).toBe(2);
    clock.advance(4_115);
    await flushMicrotasks();
    expect(renewConnects, "it joined the attempt already in flight").toBe(0);

    answerToolCallConnect(second);
    await expect(listing).resolves.toEqual({ platforms: [], physicalDevices: [] });
    await flushMicrotasks();

    expect(renewConnects).toBe(0);
    expect(toolCallConnects).toBe(2);
    expect(second.calls.filter((call) => call.method === "renewLease")).toHaveLength(1);

    // why: Both callers came back holding this client, and exactly one of them may wire it up: a
    // second set of push relays would strand the first (only the latest can be unsubscribed),
    // and every push would reach the agent twice for one thing that happened.
    const deviceHealth: unknown[] = [];
    session.onDeviceHealth((notice) => deviceHealth.push(notice));
    second.emitDeviceUnhealthy({ deviceId: "device-1", leaseId: "lease-1" });
    expect(deviceHealth).toHaveLength(1);

    await session.close();
  });
});
