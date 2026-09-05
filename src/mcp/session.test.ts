import { describe, expect, it } from "vitest";

import { SimlockError } from "../client/index.js";
import { RELEASE_TIMEOUT_MS } from "../lease-policy/index.js";
import { FakeClock } from "../ports/index.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";
import { McpSession, toMcpErrorResult } from "./session.js";

/** Lets an awaited renewal settle; the fake clock never moves on its own. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

describe("McpSession", () => {
  it("requests a held lease with the tool input as-is, and returns the grant unchanged", async () => {
    const client = new FakeSimlockClient();
    let seenInput: unknown;
    let seenOptions: unknown;
    const grant = sampleGrant();
    client.requestLeaseImpl = (input, options) => {
      seenInput = input;
      seenOptions = options;
      return Promise.resolve(grant);
    };
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });

    const signal = new AbortController().signal;
    const onProgress = () => undefined;
    const result = await session.lease(
      { model: "iPhone 17 Pro", platform: "ios" },
      signal,
      onProgress,
    );

    expect(result).toBe(grant);
    expect(seenInput).toEqual({ model: "iPhone 17 Pro", platform: "ios" });
    expect(seenOptions).toEqual({ onProgress, signal });
  });

  it("releases without any client-side ownership check -- a FORBIDDEN from the daemon passes straight through", async () => {
    const client = new FakeSimlockClient();
    client.releaseLeaseImpl = () =>
      Promise.reject(new SimlockError("FORBIDDEN", "protocol", "not your lease", {}));
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });

    await expect(session.release({ leaseId: "someone-elses-lease" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(client.calls).toEqual([
      { input: { leaseId: "someone-elses-lease" }, method: "releaseLease" },
    ]);
  });

  it("adds released: true to a successful release without otherwise reshaping the result", async () => {
    const client = new FakeSimlockClient();
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });

    await expect(session.release({ leaseId: "lease-1" })).resolves.toEqual({
      leaseId: "lease-1",
      released: true,
    });
  });

  it("forwards list_devices straight to getCatalog", async () => {
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });

    await session.listDevices({ platform: "ios" });
    expect(client.calls).toEqual([{ input: { platform: "ios" }, method: "getCatalog" }]);
  });

  it("answers lease_status with one lease.list call each time, not a cache", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    let call = 0;
    client.listLeasesImpl = () => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? { leases: [] }
          : {
              leases: [
                {
                  deviceId: "device-1",
                  grantedAt: 0,
                  id: "lease-1",
                  ownerId: "mcp-test",
                  requesterId: "mcp-test",
                  lastRenewedAt: 0,
                  ttlMs: 60_000,
                  ttlDeadline: 5_000,
                },
              ],
            },
      );
    };
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });

    await expect(session.status()).resolves.toEqual({ held: false });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    await expect(session.status()).resolves.toEqual({
      deviceId: "device-1",
      grantedAt: 0,
      held: true,
      id: "lease-1",
      ownerId: "mcp-test",
      requesterId: "mcp-test",
      lastRenewedAt: 0,
      ttlMs: 60_000,
      ttlDeadline: 5_000,
    });
    expect(client.calls.filter((c) => c.method === "listLeases")).toHaveLength(2);
  });

  it("does not report a foreign lease under the same owner principal that this session never requested (B8)", async () => {
    // `lease.list` filters by owner principal only -- no mode, no connection filter -- so it
    // can return a lease this session's connection never asked for: here, a `detached` lease
    // the CLI holds under the same `SIMLOCK_AGENT_ID` principal. `lease_status` must not report
    // it as held, since this session never requested it and will not release it on close.
    const client = new FakeSimlockClient();
    client.listLeasesImpl = () =>
      Promise.resolve({
        leases: [
          {
            deviceId: "device-9",
            grantedAt: 0,
            id: "lse_foreign",
            ownerId: "mcp-test",
            requesterId: "mcp-test",
            lastRenewedAt: 0,
            ttlMs: 60_000,
            ttlDeadline: 99_999,
          },
        ],
      });
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });

    await expect(session.status()).resolves.toEqual({ held: false });
  });

  it("stops reporting a lease as held once lease.release-lost or a lease-lost push arrives", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.listLeasesImpl = () =>
      Promise.resolve({
        leases: [
          {
            deviceId: "device-1",
            grantedAt: 0,
            id: "lease-1",
            ownerId: "mcp-test",
            requesterId: "mcp-test",
            lastRenewedAt: 0,
            ttlMs: 60_000,
            ttlDeadline: 5_000,
          },
        ],
      });
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });

    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    await expect(session.status()).resolves.toMatchObject({ held: true, id: "lease-1" });

    client.emitLeaseLost({ deviceId: "device-1", leaseId: "lease-1", reason: "expired" });
    await expect(session.status()).resolves.toEqual({ held: false });
  });

  it("reconnects lazily: builds a new client only after the current one's connection is lost", async () => {
    const clients: FakeSimlockClient[] = [];
    let connectCalls = 0;
    const connect = async () => {
      connectCalls += 1;
      const client = new FakeSimlockClient();
      client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
      clients.push(client);
      return client;
    };
    const session = new McpSession({ clock: new FakeClock(), connect, connectForRenew: connect });

    await session.listDevices({});
    await session.listDevices({});
    expect(connectCalls).toBe(1);

    clients[0]!.emitConnectionLost();
    await session.listDevices({});
    expect(connectCalls).toBe(2);
    expect(clients[1]).not.toBe(clients[0]);
  });

  it("serializes tool calls: a slower lease still completes before a release issued after it", async () => {
    const client = new FakeSimlockClient();
    const order: string[] = [];
    let releaseGrant: (() => void) | undefined;
    client.requestLeaseImpl = () =>
      new Promise((resolve) => {
        releaseGrant = () => {
          order.push("lease");
          resolve(sampleGrant());
        };
      });
    client.releaseLeaseImpl = (input) => {
      order.push("release");
      return Promise.resolve({ leaseId: input.leaseId });
    };
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });

    const leaseCall = session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    const releaseCall = session.release({ leaseId: "lease-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]); // release is queued behind the still-pending lease
    releaseGrant?.();
    await Promise.all([leaseCall, releaseCall]);

    expect(order).toEqual(["lease", "release"]);
  });

  it("closes the current client exactly once, and closes a client that finishes connecting after close", async () => {
    let resolveConnect!: (client: FakeSimlockClient) => void;
    const pendingClient = new Promise<FakeSimlockClient>((resolve) => {
      resolveConnect = resolve;
    });
    const session = new McpSession({
      clock: new FakeClock(),
      connect: () => pendingClient,
      connectForRenew: () => pendingClient,
    });

    const listDevicesCall = session.listDevices({});
    await Promise.resolve(); // let the queued mutation reach #clientForUse() and start connecting
    const closeCall = session.close();
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    resolveConnect(client);

    await closeCall;
    await expect(listDevicesCall).rejects.toBeTruthy();
    expect(client.closeCalls).toBe(1);

    await session.close();
    expect(client.closeCalls).toBe(1);
  });

  it("rejects every tool call with SESSION_CLOSED, without contacting the client, once closed", async () => {
    const client = new FakeSimlockClient();
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.close();

    await expect(session.lease({ model: "x", platform: "ios" })).rejects.toMatchObject({
      code: "SESSION_CLOSED",
    });
    await expect(session.release({ leaseId: "l" })).rejects.toMatchObject({
      code: "SESSION_CLOSED",
    });
    await expect(session.listDevices({})).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    await expect(session.status()).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(client.calls).toEqual([]);
  });

  /**
   * ADR 0004 §2: the session's lease lives on its own `lease.renew` timer, at a third of the
   * remaining TTL, and is released explicitly when the session ends -- not left to the socket.
   */
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
        ttlMs: 60_000,
        ttlDeadline: clock.now() + 3_000,
      });
    };
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });

    // `sampleGrant`'s deadline is 12_345, so the first renewal is due at 4_115.
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    clock.advance(4_114);
    await flushMicrotasks();
    expect(renewals).toEqual([]);
    clock.advance(1);
    await flushMicrotasks();
    expect(renewals).toEqual([{ at: 4_115, leaseId: "lease-1" }]);

    // 3_000ms came back, so the next one is 1_000ms later -- off the renewal's own deadline.
    clock.advance(1_000);
    await flushMicrotasks();
    expect(renewals).toHaveLength(2);
    expect(renewals[1]).toEqual({ at: 5_115, leaseId: "lease-1" });

    await session.close();
  });

  it("releases the session's lease explicitly on close, before closing the connection", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await session.close();

    expect(client.calls.map((call) => call.method)).toEqual(["requestLease", "releaseLease"]);
    expect(client.calls.at(-1)?.input).toEqual({ leaseId: "lease-1" });
    expect(client.closeCalls).toBe(1);
    expect(clock.pendingTimerCount, "the renew timer must not outlive the session").toBe(0);
  });

  it("closes cleanly even when the farewell release fails", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = () =>
      Promise.reject(new SimlockError("UNKNOWN_LEASE", "domain", "gone", { leaseId: "lease-1" }));
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await expect(session.close()).resolves.toBeUndefined();
    expect(client.closeCalls).toBe(1);
  });

  it("does not release on close when the lease was already released by a tool call", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await session.release({ leaseId: "lease-1" });
    // The timer goes with the lease, so nothing can renew what was just given up.
    expect(clock.pendingTimerCount).toBe(0);

    await session.close();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toHaveLength(1);
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
        mode: "held" as const,
        ownerId: "mcp-test",
        requesterId: "mcp-test",
        ttlDeadline: clock.now() + 12_345,
      });
    };
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({ clock, connect: async () => client });

    // Nothing here limits a session to one lease -- the daemon's one-lease-per-requester rule
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

  it("still sends its own release when a tool call's release is already in flight", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    const pending: Array<(result: { leaseId: string }) => void> = [];
    client.releaseLeaseImpl = () =>
      new Promise<{ leaseId: string }>((resolve) => {
        pending.push(resolve);
      });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    // `close()` does not queue behind the tool-call serializer, so it can land while a
    // `release_simulator` call is still waiting on the daemon. It waits for that call, then
    // sends its own release anyway: deferring to the in-flight one would mean no release at
    // all if the wire died first, and a duplicate only costs an `UNKNOWN_LEASE` it swallows.
    const releasing = session.release({ leaseId: "lease-1" });
    await flushMicrotasks();
    const closing = session.close();
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toHaveLength(1);

    pending[0]?.({ leaseId: "lease-1" }); // the tool call's own release is answered
    await expect(releasing).resolves.toMatchObject({ leaseId: "lease-1", released: true });
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toHaveLength(2);

    pending[1]?.({ leaseId: "lease-1" });
    await closing;
    expect(client.closeCalls).toBe(1);
    expect(clock.pendingTimerCount, "no bound outlives the close").toBe(0);
  });

  it("spends one shutdown budget in total, not one per step", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    // A daemon that answers nothing: neither the tool call in flight nor the release that
    // would follow it ever comes back.
    client.listLeasesImpl = () => new Promise(() => {});
    client.releaseLeaseImpl = () => new Promise(() => {});
    const session = new McpSession({ clock, connect: async () => client });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    void session.status().catch(() => undefined); // in flight, never answered
    await flushMicrotasks();

    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await flushMicrotasks();

    // A budget per step -- one for the in-flight call, then one more for the lease -- would
    // leave `simlock mcp` sitting here for a multiple of this after stdin EOF.
    clock.advance(RELEASE_TIMEOUT_MS - 1);
    await flushMicrotasks();
    expect(closed).toBe(false);

    clock.advance(1);
    await closing;
    expect(closed).toBe(true);
    expect(client.closeCalls, "the wire closes when the budget is spent").toBe(1);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("releases a grant that lands after the session closed, and arms no timer for it", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    let answerGrant!: (grant: ReturnType<typeof sampleGrant>) => void;
    client.requestLeaseImpl = () =>
      new Promise((resolve) => {
        answerGrant = resolve;
      });
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({ clock, connect: async () => client });

    const leasing = session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    await flushMicrotasks();
    const closing = session.close();
    await flushMicrotasks();

    // The daemon finishes provisioning just after the session ended. `close()` is still
    // waiting on that call (bounded), so the wire is alive: the device goes straight back
    // rather than being renewed by a session that no longer exists -- or stranded until its
    // deadline because the connection was already gone.
    answerGrant(sampleGrant({ leaseId: "lease-1" }));
    await expect(leasing).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    await closing;

    expect(client.calls.filter((call) => call.method === "releaseLease")).toEqual([
      { input: { leaseId: "lease-1" }, method: "releaseLease" },
    ]);
    expect(client.calls.filter((call) => call.method === "renewLease")).toEqual([]);
    expect(clock.pendingTimerCount, "a closed session must leave no timer behind").toBe(0);
  });

  it("keeps renewing when a release fails, because the session still holds the device", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = () =>
      Promise.reject(new SimlockError("INTERNAL", "domain", "could not release", {}));
    let renewals = 0;
    client.renewLeaseImpl = (input) => {
      renewals += 1;
      return Promise.resolve({
        deviceId: "device-1",
        grantedAt: 0,
        id: input.leaseId,
        ownerId: "mcp-test",
        requesterId: "mcp-test",
        lastRenewedAt: 0,
        ttlMs: 60_000,
        ttlDeadline: clock.now() + 12_000,
      });
    };
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await expect(session.release({ leaseId: "lease-1" })).rejects.toMatchObject({
      code: "INTERNAL",
    });

    // The daemon still has the lease, so the timer that keeps it must still be running --
    // otherwise the device is reclaimed at the deadline under a session that was told its
    // release failed.
    clock.advance(4_115);
    await flushMicrotasks();
    expect(renewals).toBe(1);
    await session.close();
  });

  it("reports a lease the daemon says is gone as lease-lost, and releases nothing on close", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.renewLeaseImpl = () =>
      Promise.reject(
        new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", { leaseId: "lease-1" }),
      );
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    // A lease that expired while this session was idle may never produce a push -- the
    // renewal's own answer is what tells the agent.
    clock.advance(4_115);
    await flushMicrotasks();
    expect(notices).toEqual([
      { deviceId: "device-1", leaseId: "lease-1", reason: "renew-rejected" },
    ]);
    expect(clock.pendingTimerCount).toBe(0);

    await session.close();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toEqual([]);
    expect(client.calls.filter((call) => call.method === "renewLease")).toHaveLength(1);
  });

  it("reports a lease it could not keep alive as lost, and releases nothing for it on close", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    // Never terminal, never successful: the ladder retries until `sampleGrant`'s own 12_345
    // deadline passes and renewal gives up.
    client.renewLeaseImpl = () =>
      Promise.reject(new SimlockError("INTERNAL", "domain", "could not persist", {}));
    const session = new McpSession({ clock, connect: async () => client });
    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    clock.advance(4_115);
    await flushMicrotasks();
    clock.advance(20_000); // the retry lands past the deadline
    await flushMicrotasks();

    expect(notices).toEqual([{ deviceId: "device-1", leaseId: "lease-1", reason: "renew-failed" }]);
    expect(clock.pendingTimerCount).toBe(0);

    await session.close();
    expect(
      client.calls.filter((call) => call.method === "releaseLease"),
      "a lease that expired is not the session's to release",
    ).toEqual([]);
  });

  it("announces one ending once, even when the renewal and the daemon both report it", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.renewLeaseImpl = () =>
      Promise.reject(
        new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", { leaseId: "lease-1" }),
      );
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    clock.advance(4_115);
    await flushMicrotasks();
    // The daemon's own push for the same lease arrives a moment later; an agent must not read
    // that as a second device lost.
    client.emitLeaseLost({ deviceId: "device-1", leaseId: "lease-1", reason: "expired" });

    expect(notices).toEqual([
      { deviceId: "device-1", leaseId: "lease-1", reason: "renew-rejected" },
    ]);

    await session.close();
  });

  it("renews over connectForRenew after a dead connection, and never over connect", async () => {
    // ADR 0004 §2's named safety property: the renew timer reconnects so an idle session does
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
        return first;
      },
      connectForRenew: async () => {
        renewConnects += 1;
        return second;
      },
    });

    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    expect(toolCallConnects).toBe(1);
    expect(renewConnects).toBe(0);

    // The connection under the session dies with no tool call in sight.
    first.emitConnectionLost();

    // The renew tick fires against it: one reconnect, through the non-launching path only.
    clock.advance(4_115);
    await flushMicrotasks();
    expect(renewConnects).toBe(1);
    expect(toolCallConnects).toBe(1);
    expect(second.calls.map((call) => call.method)).toEqual(["renewLease"]);

    await session.close();
  });

  it("stops renewing a lease that ended elsewhere", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    client.emitLeaseLost({ deviceId: "device-1", leaseId: "lease-1", reason: "expired" });

    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "renewLease")).toEqual([]);

    await session.close();
    // Nothing to release either: the daemon already ended it.
    expect(client.calls.filter((call) => call.method === "releaseLease")).toEqual([]);
  });

  it("relays the client's lease-lost, device-unhealthy, and device-recovered pushes to session listeners", async () => {
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.listDevices({}); // forces the client to connect and wire up push relays

    const leaseLost: unknown[] = [];
    const deviceHealth: unknown[] = [];
    session.onLeaseLost((notice) => leaseLost.push(notice));
    session.onDeviceHealth((notice) => deviceHealth.push(notice));

    client.emitLeaseLost({ deviceId: "SIM-1", leaseId: "lease-1", reason: "expired" });
    client.emitDeviceUnhealthy({ deviceId: "SIM-1", leaseId: "lease-1" });
    client.emitDeviceRecovered({ attempts: 2, deviceId: "SIM-1", leaseId: "lease-1" });

    expect(leaseLost).toEqual([{ deviceId: "SIM-1", leaseId: "lease-1", reason: "expired" }]);
    expect(deviceHealth).toEqual([
      { deviceId: "SIM-1", kind: "unhealthy", leaseId: "lease-1", reason: "crashed" },
      { attempts: 2, deviceId: "SIM-1", kind: "recovered", leaseId: "lease-1" },
    ]);
  });
});

describe("toMcpErrorResult", () => {
  it("maps a SimlockError to its code and message", () => {
    expect(
      toMcpErrorResult(new SimlockError("NO_CAPACITY", "domain", "No matching devices", {})),
    ).toEqual({ code: "NO_CAPACITY", message: "No matching devices" });
  });

  it("sanitizes any other error to a generic INTERNAL result", () => {
    expect(toMcpErrorResult(new Error("/private/secret-stack-path"))).toEqual({
      code: "INTERNAL",
      message: "Simlock could not complete the request",
    });
  });
});

/**
 * The double itself: MCP's tests are only worth what it is faithful to, and the one thing it
 * has to get right is that a closed connection is dead (ADR 0003 §10) -- a fake that kept
 * answering would let a test pass on a wire the real session had already closed.
 */
describe("FakeSimlockClient", () => {
  it("rejects every call once closed, the way the wire does", async () => {
    const client = new FakeSimlockClient();
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });

    await expect(client.releaseLease({ leaseId: "lease-1" })).resolves.toEqual({
      leaseId: "lease-1",
    });

    await client.close();

    await expect(client.releaseLease({ leaseId: "lease-1" })).rejects.toMatchObject({
      code: "DAEMON_CONNECTION_LOST",
    });
    await expect(client.getCatalog({})).rejects.toMatchObject({
      code: "DAEMON_CONNECTION_LOST",
    });
  });
});
