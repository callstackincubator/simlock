import { describe, expect, it } from "vitest";

import { SimlockError } from "../client/index.js";
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
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });

    const signal = new AbortController().signal;
    const onProgress = () => undefined;
    const result = await session.lease(
      { model: "iPhone 17 Pro", platform: "ios" },
      signal,
      onProgress,
    );

    expect(result).toBe(grant);
    expect(seenInput).toEqual({ model: "iPhone 17 Pro", mode: "held", platform: "ios" });
    expect(seenOptions).toEqual({ onProgress, signal });
  });

  it("releases without any client-side ownership check -- a FORBIDDEN from the daemon passes straight through", async () => {
    const client = new FakeSimlockClient();
    client.releaseLeaseImpl = () =>
      Promise.reject(new SimlockError("FORBIDDEN", "protocol", "not your lease", {}));
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });

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
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });

    await expect(session.release({ leaseId: "lease-1" })).resolves.toEqual({
      leaseId: "lease-1",
      released: true,
    });
  });

  it("forwards list_devices straight to getCatalog", async () => {
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });

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
                  mode: "held" as const,
                  ownerId: "mcp-test",
                  requesterId: "mcp-test",
                  ttlDeadline: 5_000,
                },
              ],
            },
      );
    };
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });

    await expect(session.status()).resolves.toEqual({ held: false });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    await expect(session.status()).resolves.toEqual({
      deviceId: "device-1",
      grantedAt: 0,
      held: true,
      id: "lease-1",
      mode: "held",
      ownerId: "mcp-test",
      requesterId: "mcp-test",
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
            mode: "detached" as const,
            ownerId: "mcp-test",
            requesterId: "mcp-test",
            ttlDeadline: 99_999,
          },
        ],
      });
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });

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
            mode: "held" as const,
            ownerId: "mcp-test",
            requesterId: "mcp-test",
            ttlDeadline: 5_000,
          },
        ],
      });
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });

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
    const session = new McpSession({ clock: new FakeClock(), connect });

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
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });

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
    const session = new McpSession({ clock: new FakeClock(), connect: () => pendingClient });

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
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });
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
        mode: "held" as const,
        ownerId: "mcp-test",
        requesterId: "mcp-test",
        ttlDeadline: clock.now() + 3_000,
      });
    };
    const session = new McpSession({ clock, connect: async () => client });

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
    const session = new McpSession({ clock, connect: async () => client });
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
    const session = new McpSession({ clock, connect: async () => client });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await expect(session.close()).resolves.toBeUndefined();
    expect(client.closeCalls).toBe(1);
  });

  it("does not release on close when the lease was already released by a tool call", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({ clock, connect: async () => client });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await session.release({ leaseId: "lease-1" });
    // The timer goes with the lease, so nothing can renew what was just given up.
    expect(clock.pendingTimerCount).toBe(0);

    await session.close();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toHaveLength(1);
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
        mode: "held" as const,
        ownerId: "mcp-test",
        requesterId: "mcp-test",
        ttlDeadline: clock.now() + 12_000,
      });
    };
    const session = new McpSession({ clock, connect: async () => client });
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

  it("stops renewing a lease that ended elsewhere", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    const session = new McpSession({ clock, connect: async () => client });
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
    const session = new McpSession({ clock: new FakeClock(), connect: async () => client });
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
