import { describe, expect, it } from "vitest";

import { SimlockError } from "../client/index.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";
import { McpSession, toMcpErrorResult } from "./session.js";

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
    const session = new McpSession({ connect: async () => client });

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
    const session = new McpSession({ connect: async () => client });

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
    const session = new McpSession({ connect: async () => client });

    await expect(session.release({ leaseId: "lease-1" })).resolves.toEqual({
      leaseId: "lease-1",
      released: true,
    });
  });

  it("forwards list_devices straight to getCatalog", async () => {
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    const session = new McpSession({ connect: async () => client });

    await session.listDevices({ platform: "ios" });
    expect(client.calls).toEqual([{ input: { platform: "ios" }, method: "getCatalog" }]);
  });

  it("answers lease_status with one lease.list call each time, not a cache", async () => {
    const client = new FakeSimlockClient();
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
    const session = new McpSession({ connect: async () => client });

    await expect(session.status()).resolves.toEqual({ held: false });
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
    const session = new McpSession({ connect });

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
    const session = new McpSession({ connect: async () => client });

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
    const session = new McpSession({ connect: () => pendingClient });

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
    const session = new McpSession({ connect: async () => client });
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

  it("relays the client's lease-lost, device-unhealthy, and device-recovered pushes to session listeners", async () => {
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    const session = new McpSession({ connect: async () => client });
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
