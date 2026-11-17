import { describe, expect, it } from "vitest";
import { SimlockError } from "../client/index.js";
import { FakeClock } from "../ports/index.js";
import { FakeSimlockClient, sampleGrant, startingStatus } from "./test-support.js";
import { McpSession } from "./session.js";

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

  it("forwards list_devices's input to getCatalog and reads getStatus beside it", async () => {
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    client.getStatusImpl = () => Promise.resolve(startingStatus());
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });

    await session.listDevices({ platform: "ios" });
    expect(client.calls).toEqual([
      { input: { platform: "ios" }, method: "getCatalog" },
      { input: undefined, method: "getStatus" },
    ]);
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
                  idChosenByRequester: false,
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
      idChosenByRequester: false,
      ttlMs: 60_000,
      ttlDeadline: 5_000,
    });
    expect(client.calls.filter((c) => c.method === "listLeases")).toHaveLength(2);
  });

  it("does not report a foreign lease under the same owner principal that this session never requested (B8)", async () => {
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
            idChosenByRequester: false,
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
            idChosenByRequester: false,
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
      client.getStatusImpl = () => Promise.resolve(startingStatus());
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
    client.getStatusImpl = () => Promise.resolve(startingStatus());
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
});

/**
 * why: The double itself: MCP's tests are only worth what it is faithful to, and the one thing it
 * has to get right is that a closed connection is dead (ADR 0003 §10) -- a fake that kept
 * answering would let a test pass on a wire the real session had already closed.
 */
describe("FakeSimlockClient", () => {
  it("answers before it is closed", async () => {
    const client = new FakeSimlockClient();
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });

    await expect(client.releaseLease({ leaseId: "lease-1" })).resolves.toEqual({
      leaseId: "lease-1",
    });
  });

  it.each([
    ["getCatalog", (client: FakeSimlockClient) => client.getCatalog({})],
    ["getStatus", (client: FakeSimlockClient) => client.getStatus()],
    [
      "requestLease",
      (client: FakeSimlockClient) =>
        client.requestLease({ model: "iPhone 17 Pro", platform: "ios" }),
    ],
    ["cancelLease", (client: FakeSimlockClient) => client.cancelLease({})],
    ["renewLease", (client: FakeSimlockClient) => client.renewLease({ leaseId: "lease-1" })],
    ["releaseLease", (client: FakeSimlockClient) => client.releaseLease({ leaseId: "lease-1" })],
    ["listLeases", (client: FakeSimlockClient) => client.listLeases()],
    ["runDoctor", (client: FakeSimlockClient) => client.runDoctor({})],
    [
      "resolvePassthrough",
      (client: FakeSimlockClient) => client.resolvePassthrough({ args: ["devices"], tool: "adb" }),
    ],
  ] as const)("rejects %s once closed, the way the wire does", async (_method, call) => {
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    client.getStatusImpl = notReached;
    client.requestLeaseImpl = notReached;
    client.cancelLeaseImpl = notReached;
    client.renewLeaseImpl = notReached;
    client.releaseLeaseImpl = notReached;
    client.listLeasesImpl = notReached;
    client.runDoctorImpl = notReached;
    client.resolvePassthroughImpl = notReached;

    await client.close();

    await expect(call(client)).rejects.toMatchObject({ code: "DAEMON_CONNECTION_LOST" });
  });
});

/** why: Any stub reached after `close()` is the guard failing, so every one of them says so. */
function notReached(): never {
  throw new Error("the fake answered a call over a closed connection");
}
