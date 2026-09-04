import { describe, expect, it, vi } from "vitest";

import { connectSimlockAdmin } from "../admin/index.js";
import { connectSimlock } from "../client/index.js";
import type { LeaseGrant } from "./types.js";
import { completeHello, ScriptedConnection } from "./test-support.js";

async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function sampleGrant(
  overrides: {
    readonly leaseId?: string;
    readonly deviceId?: string;
    readonly mode?: "held" | "detached";
  } = {},
): LeaseGrant {
  const leaseId = overrides.leaseId ?? "lease_1";
  const deviceId = overrides.deviceId ?? "device_1";
  return {
    device: {
      createdAt: 0,
      driverData: null,
      driverDeviceId: "sim-1",
      id: deviceId,
      spec: { model: "iPhone 17", osVersion: "18.0", platform: "ios" },
      state: "leased",
    },
    lease: {
      deviceId,
      grantedAt: 0,
      id: leaseId,
      mode: overrides.mode ?? "held",
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlDeadline: 1_000,
    },
    timing: {
      estimatedBootMs: 1,
      estimatedProvisionMs: 1,
      estimatedReadyMs: 1,
      estimatedReclaimMs: 1,
    },
  };
}

describe("connectSimlock: handshake", () => {
  it("rejects a version mismatch before any other request is sent", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello");
    expect(hello).toBeDefined();
    connection.fail(hello!.id, "PROTOCOL_VERSION_UNSUPPORTED", "no overlap", {
      client: { max: 3, min: 3 },
      daemon: { max: 5, min: 5 },
      daemonVersion: "9.9.9",
    });

    await expect(connectPromise).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      details: { daemon: { max: 5, min: 5 }, daemonVersion: "9.9.9" },
    });
    expect(connection.sent).toHaveLength(1);
  });

  it("maps a legacy protocol-2 daemon's mismatch code onto the contract's shape", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello")!;
    connection.fail(hello.id, "PROTOCOL_VERSION_MISMATCH", "old daemon says no");

    await expect(connectPromise).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      details: { daemon: { max: 2, min: 2 }, daemonVersion: "unknown" },
    });
    expect(connection.sent).toHaveLength(1);
  });

  it("a bad admin credential causes zero requests after hello", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "wrong" });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello")!;
    expect((hello.payload as { credential?: string }).credential).toBe("wrong");
    connection.fail(hello.id, "ADMIN_AUTHENTICATION_FAILED", "nope");

    await expect(connectPromise).rejects.toMatchObject({ code: "ADMIN_AUTHENTICATION_FAILED" });
    expect(connection.sent).toHaveLength(1);
  });

  it("agent role: a FORBIDDEN reply from the daemon surfaces as a typed error", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection, { role: "agent" });
    const client = await connectPromise;

    const callPromise = client.cancelLease();
    await flushMicrotasks();
    const call = connection.lastSentOf("lease.cancel")!;
    connection.fail(call.id, "FORBIDDEN", "agents cannot do this");

    await expect(callPromise).rejects.toMatchObject({ code: "FORBIDDEN", kind: "protocol" });
  });

  it("rejects client-side invalid input without sending a frame", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const before = connection.sent.length;
    // `model` is required and non-empty per the contract's input schema.
    await expect(client.requestLease({ model: "", platform: "ios" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(connection.sent).toHaveLength(before);
  });

  it("wraps a malformed daemon response instead of throwing a raw parse failure", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const callPromise = client.getCatalog();
    await flushMicrotasks();
    const call = connection.lastSentOf("catalog.get")!;
    connection.reply(call.id, { notPlatforms: true });

    await expect(callPromise).rejects.toMatchObject({ code: "BAD_FRAME" });
  });

  it("wraps an error code it does not recognize as UNKNOWN_DAEMON_ERROR", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const callPromise = client.getStatus();
    await flushMicrotasks();
    const call = connection.lastSentOf("status.get")!;
    connection.fail(call.id, "SOME_FUTURE_CODE", "a newer daemon said so");

    await expect(callPromise).rejects.toMatchObject({
      code: "UNKNOWN_DAEMON_ERROR",
      details: { code: "SOME_FUTURE_CODE" },
    });
  });
});

describe("connection death", () => {
  it("rejects in-flight calls and fires onLeaseLost for held leases", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const leaseLost = vi.fn();
    client.onLeaseLost(leaseLost);
    const connectionLost = vi.fn();
    client.onConnectionLost(connectionLost);

    const grantPromise = client.requestLease({ model: "iPhone 17", platform: "ios" });
    await flushMicrotasks();
    const requestCall = connection.lastSentOf("lease.request")!;
    connection.reply(requestCall.id, sampleGrant({ leaseId: "lease_held" }));
    await grantPromise;

    const statusPromise = client.getStatus();
    await flushMicrotasks();

    connection.simulateDeath();

    await expect(statusPromise).rejects.toMatchObject({ code: "DAEMON_CONNECTION_LOST" });
    expect(leaseLost).toHaveBeenCalledWith({
      deviceId: "device_1",
      leaseId: "lease_held",
      reason: "daemon-connection-lost",
    });
    expect(connectionLost).toHaveBeenCalledTimes(1);

    await expect(client.getStatus()).rejects.toMatchObject({ code: "DAEMON_CONNECTION_LOST" });
    expect(connection.sent.filter((f) => f.type === "status.get")).toHaveLength(1);
  });
});

describe("pushes", () => {
  it("routes progress to the originating call and drops it once the call is no longer tracked", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const onProgress = vi.fn();
    const grantPromise = client.requestLease(
      { model: "iPhone 17", platform: "ios" },
      { onProgress },
    );
    await flushMicrotasks();
    const requestCall = connection.lastSentOf("lease.request")!;

    // A push can arrive before the response to the request that caused it (ADR §8).
    connection.push("progress", {
      progress: { etaMs: 500, stage: "provisioning" },
      requestId: requestCall.id,
    });
    connection.reply(requestCall.id, sampleGrant());
    await grantPromise;

    expect(onProgress).toHaveBeenCalledWith({ etaMs: 500, stage: "provisioning" });

    // Dropped: no call is tracked under this id any more.
    connection.push("progress", {
      progress: { etaMs: 1, stage: "booting" },
      requestId: requestCall.id,
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates lease-scoped pushes by lease id", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const unhealthy = vi.fn();
    client.onDeviceUnhealthy(unhealthy);

    connection.push("device-unhealthy", {
      deviceId: "device_1",
      leaseId: "lease_1",
      reason: "crashed",
    });
    connection.push("device-unhealthy", {
      deviceId: "device_1",
      leaseId: "lease_1",
      reason: "crashed",
    });

    expect(unhealthy).toHaveBeenCalledTimes(1);
  });

  it("never fires onLeaseLost for a release this client itself asked for", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const leaseLost = vi.fn();
    client.onLeaseLost(leaseLost);

    const grantPromise = client.requestLease({ model: "iPhone 17", platform: "ios" });
    await flushMicrotasks();
    connection.reply(
      connection.lastSentOf("lease.request")!.id,
      sampleGrant({ leaseId: "lease_1" }),
    );
    await grantPromise;

    const releasePromise = client.releaseLease({ leaseId: "lease_1" });
    await flushMicrotasks();
    const releaseCall = connection.lastSentOf("lease.release")!;
    // The daemon pushes lease-lost for the same release the client itself just asked for --
    // this must be swallowed, not surfaced.
    connection.push("lease-lost", { deviceId: "device_1", leaseId: "lease_1", reason: "explicit" });
    connection.reply(releaseCall.id, { leaseId: "lease_1" });
    await releasePromise;

    expect(leaseLost).not.toHaveBeenCalled();
  });
});

describe("requestLease abort (ADR §10)", () => {
  it("before the request is sent: rejects CANCELLED, nothing sent", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const controller = new AbortController();
    controller.abort();
    const before = connection.sent.length;

    await expect(
      client.requestLease({ model: "iPhone 17", platform: "ios" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(connection.sent).toHaveLength(before);
  });

  it("while queued: sends lease.cancel, waits for the original to reject, surfaces CANCELLED", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const controller = new AbortController();
    const leasePromise = client.requestLease(
      { model: "iPhone 17", platform: "ios" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    const requestCall = connection.lastSentOf("lease.request")!;

    controller.abort();
    await flushMicrotasks();
    const cancelCall = connection.lastSentOf("lease.cancel")!;
    expect(cancelCall).toBeDefined();

    connection.reply(cancelCall.id, { result: "cancelled" });
    await flushMicrotasks();
    connection.fail(requestCall.id, "QUEUE_TIMEOUT", "cancelled by request", { requestId: "r1" });

    await expect(leasePromise).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("while device work is in flight: releases a grant that still arrives, then rejects CANCELLED", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const controller = new AbortController();
    const leasePromise = client.requestLease(
      { model: "iPhone 17", platform: "ios" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    const requestCall = connection.lastSentOf("lease.request")!;

    controller.abort();
    await flushMicrotasks();
    const cancelCall = connection.lastSentOf("lease.cancel")!;
    connection.reply(cancelCall.id, { result: "not-cancellable" });
    await flushMicrotasks();

    connection.reply(requestCall.id, sampleGrant({ leaseId: "lease_abandoned" }));
    await flushMicrotasks();
    const releaseCall = connection.lastSentOf("lease.release")!;
    expect(releaseCall).toBeDefined();
    expect((releaseCall.payload as { leaseId: string }).leaseId).toBe("lease_abandoned");
    connection.reply(releaseCall.id, { leaseId: "lease_abandoned" });

    await expect(leasePromise).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("after the grant resolved: abort is ignored", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const controller = new AbortController();
    const leasePromise = client.requestLease(
      { model: "iPhone 17", platform: "ios" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    const requestCall = connection.lastSentOf("lease.request")!;
    connection.reply(requestCall.id, sampleGrant({ leaseId: "lease_kept" }));

    const grant = await leasePromise;
    expect(grant.lease.id).toBe("lease_kept");

    const before = connection.sent.length;
    controller.abort();
    await flushMicrotasks();

    // No lease.cancel was ever sent for an already-resolved request.
    expect(connection.sent).toHaveLength(before);
  });
});

describe("simlock/admin", () => {
  it("exposes the admin operations and sends daemon.stop like any other request", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const admin = await connectPromise;
    expect(admin.role).toBe("admin");

    const stopPromise = admin.stopDaemon();
    await flushMicrotasks();
    const stopCall = connection.lastSentOf("daemon.stop")!;
    connection.reply(stopCall.id, { stopping: true });
    await expect(stopPromise).resolves.toEqual({ stopping: true });
  });
});
