import { describe, expect, it } from "vitest";

import { DaemonClientError, type DaemonConnection } from "../daemon-client/protocol.js";
import { leaseSimulatorInputSchema } from "./contracts.js";
import { McpSession, toMcpErrorResult } from "./session.js";

const input = leaseSimulatorInputSchema.parse({ device: "iPhone 17 Pro", platform: "ios" });
const rawGrant = {
  device: {
    driverDeviceId: "ABCD",
    spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" as const },
  },
  lease: { id: "lse_9f2c", mode: "held" as const, ttlDeadline: 61_000 },
  timing: {
    estimatedBootMs: 20,
    estimatedProvisionMs: 10,
    estimatedReclaimMs: 0,
    estimatedReadyMs: 30,
  },
};

describe("McpSession", () => {
  it("maps safe defaults and grants to the public result", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    await expect(session.lease(input)).resolves.toEqual({
      device: "iPhone 17 Pro",
      device_id: "ABCD",
      expires_at_ms: 61_000,
      lease_id: "lse_9f2c",
      mode: "held",
      os: "26.5",
      platform: "ios",
      state: "leased",
      timing: {
        estimated_boot_ms: 20,
        estimated_provision_ms: 10,
        estimated_reclaim_ms: 0,
        estimated_ready_ms: 30,
      },
    });
    expect(connection.requests).toEqual([
      {
        payload: {
          allowDownload: false,
          mode: "held",
          noWait: false,
          requesterId: "mcp-session-1",
          request: { model: "iPhone 17 Pro", platform: "ios" },
        },
        type: "lease.request",
      },
    ]);
  });

  it("converts timeout seconds and optional fields for the daemon", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(
      leaseSimulatorInputSchema.parse({
        allow_download: true,
        device: "iPhone 17 Pro",
        no_wait: true,
        os: "26.5",
        platform: "ios",
        timeout_seconds: 1.25,
      }),
    );
    expect(connection.requests[0]?.payload).toEqual({
      allowDownload: true,
      mode: "held",
      noWait: true,
      requesterId: "mcp-session-1",
      request: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      timeoutMs: 1_250,
    });
  });

  it("rejects timeout values that would overflow milliseconds before requesting the daemon", async () => {
    const connection = new StubConnection();
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    await expect(
      session.lease({ ...input, timeout_seconds: Number.MAX_VALUE }),
    ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
    expect(connection.requests).toEqual([]);
  });

  it("rejects releases that this session does not own without calling the daemon", async () => {
    const connection = new StubConnection();
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await expect(session.release({ lease_id: "other" })).rejects.toMatchObject({
      code: "LEASE_NOT_OWNED",
    });
    expect(connection.requests).toEqual([]);
  });

  it("preserves expected daemon errors and sanitizes unexpected ones", async () => {
    const connection = new StubConnection();
    connection.responses.push(
      new DaemonClientError("NO_CAPACITY", "No matching devices are available"),
    );
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await expect(session.lease(input)).rejects.toBeInstanceOf(DaemonClientError);
    expect(
      toMcpErrorResult(new DaemonClientError("NO_CAPACITY", "No matching devices are available")),
    ).toEqual({
      code: "NO_CAPACITY",
      message: "No matching devices are available",
    });
    expect(toMcpErrorResult(new Error("/private/secret"))).toEqual({
      code: "INTERNAL",
      message: "Pitlane could not complete the request",
    });
  });

  it("defers repeat lease ownership decisions to the daemon and replaces stale local ownership", async () => {
    const connection = new StubConnection();
    const activeError = new DaemonClientError("REQUESTER_ALREADY_LEASED", "Lease is active");
    const replacementGrant = {
      ...rawGrant,
      lease: { ...rawGrant.lease, id: "lse_replacement" },
    };
    connection.responses.push(rawGrant, activeError, replacementGrant, {
      leaseId: "lse_replacement",
    });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    await session.lease(input);
    await expect(session.lease(input)).rejects.toBe(activeError);
    await expect(session.lease(input)).resolves.toMatchObject({ lease_id: "lse_replacement" });
    await session.release({ lease_id: "lse_replacement" });
    expect(connection.requests.map((request) => request.type)).toEqual([
      "lease.request",
      "lease.request",
      "lease.request",
      "lease.release",
    ]);
  });

  it("rejects malformed and non-held daemon grants", async () => {
    const malformed = new StubConnection();
    malformed.responses.push({ nope: true });
    await expect(
      new McpSession({ connect: async () => malformed, requesterId: "mcp-session-1" }).lease(input),
    ).rejects.toThrow("Daemon returned an invalid lease grant");
    expect(malformed.closeCalls).toBe(1);

    const detached = new StubConnection();
    detached.responses.push(
      { ...rawGrant, lease: { ...rawGrant.lease, mode: "detached" } },
      new DaemonClientError("UNKNOWN_LEASE", "Lease was already gone"),
    );
    await expect(
      new McpSession({ connect: async () => detached, requesterId: "mcp-session-1" }).lease(input),
    ).rejects.toMatchObject({ code: "INVALID_LEASE_GRANT" });
    expect(detached.requests).toEqual([
      expect.objectContaining({ type: "lease.request" }),
      { payload: { leaseId: "lse_9f2c" }, type: "lease.release" },
    ]);
    expect(detached.closeCalls).toBe(1);
  });

  it("closes the active connection when cancelled so a late grant cannot be orphaned", async () => {
    const connection = new StubConnection();
    const lateGrant = deferred<unknown>();
    connection.responses.push(lateGrant.promise);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    try {
      const lease = session.lease(input, controller.signal);
      await waitFor(() => connection.requests.length === 1);
      controller.abort();
      await expect(lease).rejects.toMatchObject({ code: "CANCELLED" });
      expect(connection.closeCalls).toBe(1);
      lateGrant.resolve(rawGrant);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(connection.closeCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  it("closes promptly during a pending lease and makes the session terminal", async () => {
    const connection = new StubConnection();
    const lateGrant = deferred<unknown>();
    connection.responses.push(lateGrant.promise);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    try {
      const lease = session.lease(input);
      await waitFor(() => connection.requests.length === 1);
      await session.close();
      expect(connection.closeCalls).toBe(1);
      await expect(lease).rejects.toMatchObject({ code: "SESSION_CLOSED" });
      await expect(session.lease(input)).rejects.toMatchObject({ code: "SESSION_CLOSED" });
      await expect(session.release({ lease_id: "lse_9f2c" })).rejects.toMatchObject({
        code: "SESSION_CLOSED",
      });
      lateGrant.resolve(rawGrant);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  it("closes a connection that finishes establishing after session shutdown", async () => {
    const connection = new StubConnection();
    const connectionDeferred = deferred<DaemonConnection>();
    let connectCalls = 0;
    const session = new McpSession({
      connect: async () => {
        connectCalls += 1;
        return connectionDeferred.promise;
      },
      requesterId: "mcp-session-1",
    });
    const lease = session.lease(input);

    await waitFor(() => connectCalls === 1);
    await session.close();
    connectionDeferred.resolve(connection);
    await expect(lease).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    await waitFor(() => connection.closeCalls === 1);
    expect(connection.requests).toEqual([]);
  });

  it("serializes lease and release mutations", async () => {
    const connection = new StubConnection();
    const grant = deferred<unknown>();
    connection.responses.push(grant.promise, { leaseId: "lse_9f2c" });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    const lease = session.lease(input);
    const release = session.release({ lease_id: "lse_9f2c" });

    await waitFor(() => connection.requests.length === 1);
    expect(connection.requests).toHaveLength(1);
    grant.resolve(rawGrant);
    await lease;
    await release;
    expect(connection.requests.map((request) => request.type)).toEqual([
      "lease.request",
      "lease.release",
    ]);
  });

  it("releases explicitly, clears expired ownership, and closes idempotently", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant, { leaseId: "lse_9f2c" });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);
    await expect(session.release({ lease_id: "lse_9f2c" })).resolves.toEqual({
      lease_id: "lse_9f2c",
      released: true,
    });
    await expect(session.release({ lease_id: "lse_9f2c" })).rejects.toMatchObject({
      code: "LEASE_NOT_OWNED",
    });
    await Promise.all([session.close(), session.close(), session.close()]);
    expect(connection.closeCalls).toBe(1);
  });

  it("forgets ownership when the daemon says a lease is unknown or expired", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant, new DaemonClientError("UNKNOWN_LEASE", "Lease expired"));
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);
    await expect(session.release({ lease_id: "lse_9f2c" })).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });
    await expect(session.release({ lease_id: "lse_9f2c" })).rejects.toMatchObject({
      code: "LEASE_NOT_OWNED",
    });
  });

  it("maps the daemon catalog to snake_case tool output", async () => {
    const connection = new StubConnection();
    connection.responses.push({
      platforms: [
        {
          defaultRuntime: "26.5",
          models: ["iPhone 16"],
          platform: "ios",
          runtimes: ["18.4", "26.5"],
        },
        { defaultRuntime: undefined, models: ["Pixel 8"], platform: "android", runtimes: [] },
      ],
    });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    await expect(session.listDevices({})).resolves.toEqual({
      platforms: [
        {
          default_runtime: "26.5",
          models: ["iPhone 16"],
          platform: "ios",
          runtimes: ["18.4", "26.5"],
        },
        { default_runtime: undefined, models: ["Pixel 8"], platform: "android", runtimes: [] },
      ],
    });
    expect(connection.requests).toEqual([{ payload: {}, type: "catalog.get" }]);
  });

  it("forwards the platform filter without leasing or releasing anything", async () => {
    const connection = new StubConnection();
    connection.responses.push({ platforms: [] });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    await expect(session.listDevices({ platform: "android" })).resolves.toEqual({ platforms: [] });
    expect(connection.requests).toEqual([
      { payload: { platform: "android" }, type: "catalog.get" },
    ]);
  });

  it("rejects listDevices after the session is closed without contacting the daemon", async () => {
    const connection = new StubConnection();
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.close();

    await expect(session.listDevices({})).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(connection.requests).toEqual([]);
  });

  it("reports no lease held until a lease is granted, and the held lease's details after", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant, { leaseId: "lse_9f2c" });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    expect(session.status()).toEqual({ held: false });

    await session.lease(input);
    expect(session.status()).toEqual({
      device: "iPhone 17 Pro",
      device_id: "ABCD",
      expires_at_ms: 61_000,
      held: true,
      lease_id: "lse_9f2c",
      os: "26.5",
      platform: "ios",
      state: "leased",
    });

    await session.release({ lease_id: "lse_9f2c" });
    expect(session.status()).toEqual({ held: false });
  });

  it("throws when status is queried on a closed session", async () => {
    const connection = new StubConnection();
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.close();
    expect(() => session.status()).toThrowError(
      expect.objectContaining({ code: "SESSION_CLOSED" }),
    );
  });

  it("clears ownership and notifies listeners when the daemon pushes a lease-lost fact", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    connection.pushLeaseLost({ deviceId: "ABCD", leaseId: "lse_9f2c", reason: "expired" });

    expect(session.status()).toEqual({ held: false });
    expect(notices).toEqual([{ deviceId: "ABCD", leaseId: "lse_9f2c", reason: "expired" }]);
    await expect(session.release({ lease_id: "lse_9f2c" })).rejects.toMatchObject({
      code: "LEASE_NOT_OWNED",
    });
  });

  it("ignores a lease-lost push for a lease id this session does not currently own", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    connection.pushLeaseLost({ deviceId: "other", leaseId: "some-other-lease", reason: "killed" });

    expect(notices).toEqual([]);
    expect(session.status()).toMatchObject({ held: true, lease_id: "lse_9f2c" });
  });

  it("ignores malformed lease-lost pushes without throwing", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    expect(() => connection.pushLeaseLost({} as never)).not.toThrow();

    expect(notices).toEqual([]);
    expect(session.status()).toMatchObject({ held: true, lease_id: "lse_9f2c" });
  });

  it("ignores a lease-lost push that arrives for a lease this session already released itself", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant, { leaseId: "lse_9f2c" });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);
    await session.release({ lease_id: "lse_9f2c" });

    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    // The daemon suppresses this in practice (issue #15), but the client stays
    // defensive: a stale push for an id this session no longer owns is a no-op.
    connection.pushLeaseLost({ deviceId: "ABCD", leaseId: "lse_9f2c", reason: "expired" });
    expect(notices).toEqual([]);
  });
});

class StubConnection implements DaemonConnection {
  readonly requests: Array<{ readonly payload: unknown; readonly type: string }> = [];
  readonly responses: unknown[] = [];
  closeCalls = 0;
  readonly #listeners = new Set<(kind: string, payload: unknown) => void>();

  async request(type: string, payload: unknown): Promise<unknown> {
    this.requests.push({ payload, type });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response instanceof Promise ? response : response;
  }

  onPush(listener: (kind: string, payload: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pushLeaseLost(payload: {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly reason: string;
  }): void {
    for (const listener of this.#listeners) listener("lease-lost", payload);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 0));
}
