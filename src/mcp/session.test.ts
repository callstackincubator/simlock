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
      slim: false,
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
          model: "iPhone 17 Pro",
          noWait: false,
          platform: "ios",
          requesterId: "mcp-session-1",
        },
        type: "lease.request",
      },
    ]);
  });

  it("sends full: true on the request when full is set, and slim: true when the grant reports a reduced feature profile", async () => {
    const connection = new StubConnection();
    connection.responses.push({
      ...rawGrant,
      device: { ...rawGrant.device, featureProfile: "reduced" },
    });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    await expect(
      session.lease(leaseSimulatorInputSchema.parse({ ...input, full: true })),
    ).resolves.toMatchObject({ slim: true });
    expect(connection.requests).toEqual([
      {
        payload: {
          allowDownload: false,
          full: true,
          mode: "held",
          model: "iPhone 17 Pro",
          noWait: false,
          platform: "ios",
          requesterId: "mcp-session-1",
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
      model: "iPhone 17 Pro",
      noWait: true,
      osVersion: "26.5",
      platform: "ios",
      requesterId: "mcp-session-1",
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
      message: "Simlock could not complete the request",
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

  it("reports the slid expiry after a heartbeat ack, with no daemon round-trip from status() itself", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);
    expect(session.status()).toMatchObject({ expires_at_ms: 61_000, held: true });

    const requestsBeforeStatus = connection.requests.length;
    connection.pushHeartbeatAck({ leases: [{ leaseId: "lse_9f2c", ttlDeadline: 65_000 }] });

    expect(session.status()).toMatchObject({ expires_at_ms: 65_000, held: true });
    // status() is a synchronous local read; the ack refreshed the cache, not a round-trip.
    expect(connection.requests).toHaveLength(requestsBeforeStatus);
  });

  it("ignores a heartbeat ack for a lease id this session does not currently own", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    connection.pushHeartbeatAck({ leases: [{ leaseId: "some-other-lease", ttlDeadline: 99_999 }] });
    expect(session.status()).toMatchObject({ expires_at_ms: 61_000, held: true });
  });

  it("tolerates a malformed heartbeat ack without throwing", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    expect(() => connection.pushHeartbeatAck({ leases: "not-an-array" })).not.toThrow();
    expect(() => connection.pushHeartbeatAck(null)).not.toThrow();
    expect(session.status()).toMatchObject({ expires_at_ms: 61_000, held: true });
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

  it("notifies onDeviceHealth without ending the lease when the daemon pushes device-unhealthy", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    const notices: unknown[] = [];
    session.onDeviceHealth((notice) => notices.push(notice));
    connection.pushDeviceUnhealthy({ deviceId: "ABCD", leaseId: "lse_9f2c", reason: "crashed" });

    expect(notices).toEqual([
      { deviceId: "ABCD", kind: "unhealthy", leaseId: "lse_9f2c", reason: "crashed" },
    ]);
    // Still owned: unlike a lease-lost push, this does not end the lease.
    expect(session.status()).toMatchObject({ held: true, lease_id: "lse_9f2c" });
  });

  it("notifies onDeviceHealth without ending the lease when the daemon pushes device-recovered", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    const notices: unknown[] = [];
    session.onDeviceHealth((notice) => notices.push(notice));
    connection.pushDeviceRecovered({ attempts: 2, deviceId: "ABCD", leaseId: "lse_9f2c" });

    expect(notices).toEqual([
      { attempts: 2, deviceId: "ABCD", kind: "recovered", leaseId: "lse_9f2c" },
    ]);
    expect(session.status()).toMatchObject({ held: true, lease_id: "lse_9f2c" });
  });

  it("ignores device-unhealthy/device-recovered pushes for a lease id this session does not currently own", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    const notices: unknown[] = [];
    session.onDeviceHealth((notice) => notices.push(notice));
    connection.pushDeviceUnhealthy({
      deviceId: "other",
      leaseId: "some-other-lease",
      reason: "crashed",
    });
    connection.pushDeviceRecovered({ attempts: 1, deviceId: "other", leaseId: "some-other-lease" });

    expect(notices).toEqual([]);
  });

  it("ignores malformed device-unhealthy/device-recovered pushes without throwing", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    const notices: unknown[] = [];
    session.onDeviceHealth((notice) => notices.push(notice));
    expect(() => connection.pushDeviceUnhealthy({} as never)).not.toThrow();
    expect(() => connection.pushDeviceRecovered(null)).not.toThrow();

    expect(notices).toEqual([]);
    expect(session.status()).toMatchObject({ held: true, lease_id: "lse_9f2c" });
  });

  it("stops delivering onDeviceHealth notices once the session is closed", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    const notices: unknown[] = [];
    session.onDeviceHealth((notice) => notices.push(notice));
    await session.close();

    // Closing unsubscribes the push listener, so a push arriving after close (a race
    // between shutdown and an in-flight daemon message) is simply never delivered.
    connection.pushDeviceUnhealthy({ deviceId: "ABCD", leaseId: "lse_9f2c", reason: "crashed" });
    expect(notices).toEqual([]);
  });

  it("relays progress pushes to the in-flight lease request's onProgress callback", async () => {
    const connection = new StubConnection();
    const grant = deferred<unknown>();
    connection.responses.push(grant.promise);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    const progressEvents: unknown[] = [];
    const lease = session.lease(input, undefined, (progress) => progressEvents.push(progress));
    await waitFor(() => connection.requests.length === 1);

    connection.pushProgress({ queuePosition: 2, stage: "queued" });
    connection.pushProgress({ etaMs: 9_000, stage: "provisioning" });

    expect(progressEvents).toEqual([
      { queuePosition: 2, stage: "queued" },
      { etaMs: 9_000, stage: "provisioning" },
    ]);

    grant.resolve(rawGrant);
    await lease;
  });

  it("does nothing when a lease request has no onProgress callback", async () => {
    const connection = new StubConnection();
    const grant = deferred<unknown>();
    connection.responses.push(grant.promise);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    const lease = session.lease(input);
    await waitFor(() => connection.requests.length === 1);
    expect(() => connection.pushProgress({ queuePosition: 3, stage: "queued" })).not.toThrow();

    grant.resolve(rawGrant);
    await lease;
  });

  it("stops relaying progress once the lease request has settled", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    const progressEvents: unknown[] = [];
    await session.lease(input, undefined, (progress) => progressEvents.push(progress));
    connection.pushProgress({ etaMs: 5_000, stage: "booting" });

    expect(progressEvents).toEqual([]);
  });

  it("scopes the progress listener to one request: no leakage across sequential lease calls", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant, { leaseId: "lse_9f2c" });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    const firstProgress: unknown[] = [];
    await session.lease(input, undefined, (progress) => firstProgress.push(progress));
    await session.release({ lease_id: "lse_9f2c" });

    const secondGrant = deferred<unknown>();
    connection.responses.push(secondGrant.promise);
    const secondProgress: unknown[] = [];
    const secondLease = session.lease(input, undefined, (progress) =>
      secondProgress.push(progress),
    );
    await waitFor(() => connection.requests.length === 3);

    connection.pushProgress({ etaMs: 1_000, stage: "booting" });

    expect(firstProgress).toEqual([]);
    expect(secondProgress).toEqual([{ etaMs: 1_000, stage: "booting" }]);

    secondGrant.resolve({ ...rawGrant, lease: { ...rawGrant.lease, id: "lse_second" } });
    await secondLease;
  });

  it("stops relaying progress once a cancelled lease request tears down", async () => {
    const connection = new StubConnection();
    const grant = deferred<unknown>();
    connection.responses.push(grant.promise);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    const controller = new AbortController();
    const progressEvents: unknown[] = [];
    const lease = session.lease(input, controller.signal, (progress) =>
      progressEvents.push(progress),
    );
    await waitFor(() => connection.requests.length === 1);

    controller.abort();
    await expect(lease).rejects.toMatchObject({ code: "CANCELLED" });
    connection.pushProgress({ etaMs: 1_000, stage: "booting" });

    expect(progressEvents).toEqual([]);
    grant.resolve(rawGrant);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("stops relaying progress once the session closes", async () => {
    const connection = new StubConnection();
    const grant = deferred<unknown>();
    connection.responses.push(grant.promise);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    const progressEvents: unknown[] = [];
    const lease = session.lease(input, undefined, (progress) => progressEvents.push(progress));
    await waitFor(() => connection.requests.length === 1);

    await session.close();
    connection.pushProgress({ queuePosition: 1, stage: "queued" });

    expect(progressEvents).toEqual([]);
    await expect(lease).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    grant.resolve(rawGrant);
  });

  it("ignores malformed progress pushes without throwing", async () => {
    const connection = new StubConnection();
    const grant = deferred<unknown>();
    connection.responses.push(grant.promise);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    const progressEvents: unknown[] = [];
    const lease = session.lease(input, undefined, (progress) => progressEvents.push(progress));
    await waitFor(() => connection.requests.length === 1);

    expect(() => connection.pushProgress({ stage: "not-a-stage" })).not.toThrow();
    expect(() => connection.pushProgress({ stage: "queued" })).not.toThrow();
    expect(() => connection.pushProgress({ stage: "provisioning" })).not.toThrow();
    expect(() => connection.pushProgress(null)).not.toThrow();

    expect(progressEvents).toEqual([]);
    grant.resolve(rawGrant);
    await lease;
  });

  it("reconnects lazily after a daemon restart between two calls", async () => {
    const connectionA = new StubConnection();
    connectionA.responses.push({ platforms: [] });
    const connectionB = new StubConnection();
    connectionB.responses.push({ platforms: [] });
    const connections = [connectionA, connectionB];
    let connectCalls = 0;
    const session = new McpSession({
      connect: async () => {
        connectCalls += 1;
        return connections.shift()!;
      },
      requesterId: "mcp-session-1",
    });

    await expect(session.listDevices({})).resolves.toEqual({ platforms: [] });
    expect(connectCalls).toBe(1);

    // The daemon restarts: the socket underneath the cached connection dies.
    connectionA.emitClose();

    await expect(session.listDevices({})).resolves.toEqual({ platforms: [] });
    expect(connectCalls).toBe(2);
    expect(connectionA.requests).toEqual([{ payload: {}, type: "catalog.get" }]);
    expect(connectionB.requests).toEqual([{ payload: {}, type: "catalog.get" }]);
  });

  it("surfaces DAEMON_CONNECTION_LOST, without retrying, when the connection dies mid lease request", async () => {
    const connection = new StubConnection();
    const grant = deferred<unknown>();
    connection.responses.push(grant.promise);
    let connectCalls = 0;
    const session = new McpSession({
      connect: async () => {
        connectCalls += 1;
        return connection;
      },
      requesterId: "mcp-session-1",
    });

    const lease = session.lease(input);
    await waitFor(() => connection.requests.length === 1);

    // The socket dies while the daemon is still deciding on the lease request.
    connection.emitClose();
    grant.reject(new DaemonClientError("DAEMON_CONNECTION_LOST", "Daemon connection closed"));

    await expect(lease).rejects.toMatchObject({ code: "DAEMON_CONNECTION_LOST" });
    // A retry here could provision and grant a second device -- must never happen.
    expect(connectCalls).toBe(1);
    expect(connection.requests).toHaveLength(1);
    expect(session.status()).toEqual({ held: false });
  });

  it("retries a read-only catalog.get once after the connection dies mid-request", async () => {
    const connection = new StubConnection();
    const firstResponse = deferred<unknown>();
    connection.responses.push(firstResponse.promise);
    connection.responses.push({ platforms: [] });
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });

    const listing = session.listDevices({});
    await waitFor(() => connection.requests.length === 1);
    connection.emitClose();
    firstResponse.reject(
      new DaemonClientError("DAEMON_CONNECTION_LOST", "Daemon connection closed"),
    );

    await expect(listing).resolves.toEqual({ platforms: [] });
    expect(connection.requests).toEqual([
      { payload: {}, type: "catalog.get" },
      { payload: {}, type: "catalog.get" },
    ]);
  });

  it("forces a fresh connection on retry when DAEMON_CONNECTION_LOST arrives without #connection having been cleared yet", async () => {
    // This pins the ordering IpcDaemonConnection.request() also rejects synchronously once it
    // observes the transport already closed, which can race ahead of the underlying `onClose`
    // propagating back to `#handleConnectionClosed`. `connectionA` here rejects the same way but
    // deliberately never calls `emitClose()`, so `#connection` is still set to it when the retry
    // runs -- the retry must not just hand back the same dead connection.
    const connectionA = new StubConnection();
    connectionA.responses.push(
      new DaemonClientError("DAEMON_CONNECTION_LOST", "Daemon connection is closed"),
    );
    const connectionB = new StubConnection();
    connectionB.responses.push({ platforms: [] });
    const connections = [connectionA, connectionB];
    let connectCalls = 0;
    const session = new McpSession({
      connect: async () => {
        connectCalls += 1;
        return connections.shift()!;
      },
      requesterId: "mcp-session-1",
    });

    await expect(session.listDevices({})).resolves.toEqual({ platforms: [] });
    expect(connectCalls).toBe(2);
    expect(connectionA.requests).toEqual([{ payload: {}, type: "catalog.get" }]);
    expect(connectionB.requests).toEqual([{ payload: {}, type: "catalog.get" }]);
  });

  it("clears an owned lease and notifies onLeaseLost when the connection dies across a restart", async () => {
    const connection = new StubConnection();
    connection.responses.push(rawGrant);
    const session = new McpSession({
      connect: async () => connection,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);
    expect(session.status()).toMatchObject({ held: true, lease_id: "lse_9f2c" });

    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));

    // A graceful stop or an ungraceful crash both release the held lease daemon-side (see
    // DaemonServer#stop / the startup path's orphan sweep) -- the reconnect never asks.
    connection.emitClose();

    expect(notices).toEqual([
      { deviceId: "ABCD", leaseId: "lse_9f2c", reason: "daemon-connection-lost" },
    ]);
    expect(session.status()).toEqual({ held: false });
  });

  it("keeps an onDeviceHealth listener registered across a reconnect after the connection dies", async () => {
    const connectionA = new StubConnection();
    connectionA.responses.push(rawGrant);
    const connectionB = new StubConnection();
    const connections = [connectionA, connectionB];
    const session = new McpSession({
      connect: async () => connections.shift()!,
      requesterId: "mcp-session-1",
    });
    await session.lease(input);

    const notices: unknown[] = [];
    session.onDeviceHealth((notice) => notices.push(notice));

    // The connection dies (daemon restart); `#handleConnectionClosed` drops the push
    // subscription along with the owned lease, so a stale push on the dead connection
    // must not reach the listener.
    connectionA.emitClose();
    connectionA.pushDeviceUnhealthy({ deviceId: "ABCD", leaseId: "lse_9f2c", reason: "crashed" });
    expect(notices).toEqual([]);

    // A fresh lease through the lazily-reconnected session (connectionB) is owned
    // again, and the *same* onDeviceHealth listener -- never re-registered by this
    // test -- still fires for it: registration survives the reconnect without leaking.
    connectionB.responses.push({
      ...rawGrant,
      lease: { ...rawGrant.lease, id: "lse_after_reconnect" },
    });
    await session.lease(input);
    connectionB.pushDeviceUnhealthy({
      deviceId: "ABCD",
      leaseId: "lse_after_reconnect",
      reason: "crashed",
    });

    expect(notices).toEqual([
      { deviceId: "ABCD", kind: "unhealthy", leaseId: "lse_after_reconnect", reason: "crashed" },
    ]);
  });

  it("surfaces DAEMON_UNAVAILABLE when reconnecting after a restart fails", async () => {
    const connection = new StubConnection();
    connection.responses.push({ platforms: [] });
    let connectCalls = 0;
    const session = new McpSession({
      connect: async () => {
        connectCalls += 1;
        if (connectCalls === 1) return connection;
        throw new Error("ECONNREFUSED");
      },
      requesterId: "mcp-session-1",
    });

    await expect(session.listDevices({})).resolves.toEqual({ platforms: [] });
    connection.emitClose();

    await expect(session.listDevices({})).rejects.toMatchObject({
      code: "DAEMON_UNAVAILABLE",
    });
    expect(connectCalls).toBe(2);
  });
});

class StubConnection implements DaemonConnection {
  readonly requests: Array<{ readonly payload: unknown; readonly type: string }> = [];
  readonly responses: unknown[] = [];
  closeCalls = 0;
  #closed = false;
  readonly #listeners = new Set<(kind: string, payload: unknown) => void>();
  readonly #closeListeners = new Set<() => void>();

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

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** Simulates the socket dying under this connection (daemon restart/crash). */
  emitClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }

  pushLeaseLost(payload: {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly reason: string;
  }): void {
    for (const listener of this.#listeners) listener("lease-lost", payload);
  }

  pushDeviceUnhealthy(payload: unknown): void {
    for (const listener of this.#listeners) listener("device-unhealthy", payload);
  }

  pushDeviceRecovered(payload: unknown): void {
    for (const listener of this.#listeners) listener("device-recovered", payload);
  }

  /**
   * Wraps the given stage payload under `{requestId, progress}` -- ADR 0003 §8's push
   * correlation shape (see `DaemonServer#pushProgress`) -- so callers can keep passing the bare
   * stage object `parseRawLeaseProgress` ultimately unwraps this back to.
   */
  pushProgress(payload: unknown): void {
    for (const listener of this.#listeners)
      listener("progress", { progress: payload, requestId: "test-request" });
  }

  /**
   * Simulates the ack `IpcDaemonConnection` re-surfaces as a push after it auto-answers the
   * server's `lease.heartbeat` push (see `src/daemon-client/connection.ts`).
   */
  pushHeartbeatAck(payload: unknown): void {
    for (const listener of this.#listeners) listener("lease.heartbeat", payload);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  promise.catch(() => undefined);
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 0));
}
