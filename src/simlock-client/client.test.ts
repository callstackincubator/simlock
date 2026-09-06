import { describe, expect, it, vi } from "vitest";

import { connectSimlockAdmin } from "../admin/index.js";
import { connectSimlock } from "../client/index.js";
import type { LeaseGrant } from "./types.js";
import { completeHello, ScriptedConnection } from "./test-support.js";

async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function sampleGrant(
  overrides: { readonly leaseId?: string; readonly deviceId?: string } = {},
): LeaseGrant {
  const leaseId = overrides.leaseId ?? "lease_1";
  const deviceId = overrides.deviceId ?? "device_1";
  return {
    device: {
      driverDeviceId: "sim-1",
      id: deviceId,
      spec: { model: "iPhone 17", osVersion: "18.0", platform: "ios" },
    },
    environment: {},
    lease: {
      deviceId,
      grantedAt: 0,
      id: leaseId,
      lastRenewedAt: 0,
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlMs: 1_000,
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
  it("a version mismatch leaves the connection open and usable for stopDaemon() only (ADR §6)", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello");
    expect(hello).toBeDefined();
    connection.fail(hello!.id, "PROTOCOL_VERSION_UNSUPPORTED", "no overlap", {
      client: { max: 3, min: 3 },
      daemon: { max: 5, min: 5 },
      daemonVersion: "9.9.9",
    });

    // The daemon deliberately keeps this connection open after a failed range negotiation
    // (ADR §6, see the comments in `daemon/server.ts#handleHello`) so an admin client can
    // still send `daemon.stop` on it instead of restarting the daemon -- closing here, what
    // this client used to do unconditionally, made that escape hatch dead on arrival.
    const client = await connectPromise;
    expect(connection.closed).toBe(false);

    // Every other operation rejects with the captured mismatch error, never reaching the wire.
    const before = connection.sent.length;
    await expect(client.getStatus()).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    await expect(client.runCleanup()).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    expect(connection.sent).toHaveLength(before);

    const stopPromise = client.stopDaemon();
    await flushMicrotasks();
    const stopCall = connection.lastSentOf("daemon.stop")!;
    expect(stopCall).toBeDefined();
    connection.reply(stopCall.id, { stopping: true });
    await expect(stopPromise).resolves.toEqual({ stopping: true });

    await client.close();
    expect(connection.closed).toBe(true);
  });

  it("maps a legacy protocol-2 daemon's mismatch code onto the contract's shape, and still leaves the connection open (ADR §6)", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello")!;
    connection.fail(hello.id, "PROTOCOL_VERSION_MISMATCH", "old daemon says no");

    // Resolves rather than rejects: this maps onto the same `PROTOCOL_VERSION_UNSUPPORTED`
    // code as a modern range mismatch, so it gets the same ADR §6 treatment -- the connection
    // stays open, and the returned client's every operation rejects with the mapped error.
    const client = await connectPromise;
    expect(connection.closed).toBe(false);
    expect(connection.sent).toHaveLength(1);

    await expect(client.getStatus()).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      details: { daemon: { max: 2, min: 2 }, daemonVersion: "unknown" },
    });
    expect(connection.sent).toHaveLength(1);
  });

  it("declares no capabilities at all, and starts no renew timer of its own (ADR 0004 §2/§4)", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello")!;
    // ADR 0004 §4 removed the daemon-initiated heartbeat and the capability that gated it;
    // a lease stays alive because a client calls `lease.renew`, and nothing else.
    expect((hello.payload as { capabilities?: unknown }).capabilities).toBeUndefined();
    completeHello(connection);
    const client = await connectPromise;

    // Renew policy stays a frontend's (ADR 0003 §10): connecting alone sends nothing further.
    const sentAfterHello = connection.sent.length;
    await flushMicrotasks();
    expect(connection.sent).toHaveLength(sentAfterHello);
    await client.close();
  });

  it("a bad admin credential causes zero requests after hello, and closes the connection", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "wrong" });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello")!;
    expect((hello.payload as { credential?: string }).credential).toBe("wrong");
    connection.fail(hello.id, "ADMIN_AUTHENTICATION_FAILED", "nope");

    await expect(connectPromise).rejects.toMatchObject({ code: "ADMIN_AUTHENTICATION_FAILED" });
    expect(connection.sent).toHaveLength(1);
    // Unlike a protocol-version mismatch (ADR §6's frozen exception), a bad credential is not
    // the escape hatch -- the connection closes and serves nothing.
    expect(connection.closed).toBe(true);
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
  it("rejects in-flight calls, fires onConnectionLost, and reports no lost lease", async () => {
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
    // ADR 0004 §3 narrows ADR 0003 §10: a dead connection is not a dead lease. The daemon
    // released nothing, so `lease_held` is still granted and still counting down -- there is
    // nothing to report through `onLeaseLost`, which now only ever carries a lease the daemon
    // actually ended.
    expect(leaseLost).not.toHaveBeenCalled();
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

  it("routes device.exec output chunks to that call's onOutput, in order, and stops at its reply", async () => {
    // ADR 0005 §19a: `output` is request-scoped like `progress`, so it reaches the call that is
    // still waiting on its frame id and nothing else.
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const onOutput = vi.fn();
    const execPromise = client.execDevice(
      { args: ["list", "devices"], leaseId: "lease_1", tool: "simctl" },
      { onOutput },
    );
    await flushMicrotasks();
    const execCall = connection.lastSentOf("device.exec")!;
    expect(execCall.payload).toEqual({
      args: ["list", "devices"],
      leaseId: "lease_1",
      tool: "simctl",
    });

    connection.push("output", { chunk: "one", requestId: execCall.id, stream: "stdout" });
    connection.push("output", { chunk: "two", requestId: execCall.id, stream: "stderr" });
    connection.reply(execCall.id, { exitCode: 7 });

    await expect(execPromise).resolves.toEqual({ exitCode: 7 });
    expect(onOutput.mock.calls.map(([chunk]) => chunk)).toEqual([
      { chunk: "one", stream: "stdout" },
      { chunk: "two", stream: "stderr" },
    ]);

    // The call is no longer tracked, so a late chunk is dropped rather than delivered to a
    // caller that has already been told the command finished.
    connection.push("output", { chunk: "late", requestId: execCall.id, stream: "stdout" });
    expect(onOutput).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates a repeated device-unhealthy push for the same lease (same state twice in a row)", async () => {
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

  it("delivers a second device-unhealthy for the same lease once a device-recovered came between the two (S2: a second crash is not a duplicate)", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const unhealthy = vi.fn();
    const recovered = vi.fn();
    client.onDeviceUnhealthy(unhealthy);
    client.onDeviceRecovered(recovered);

    connection.push("device-unhealthy", {
      deviceId: "device_1",
      leaseId: "lease_1",
      reason: "crashed",
    });
    connection.push("device-recovered", { attempts: 1, deviceId: "device_1", leaseId: "lease_1" });
    // A genuine second crash on the same lease -- `LeaseHealthMonitor` clears its recovery
    // bookkeeping after a successful recovery, so this is a real, distinct fact, not a
    // redundant re-push of the first one.
    connection.push("device-unhealthy", {
      deviceId: "device_1",
      leaseId: "lease_1",
      reason: "crashed",
    });

    expect(unhealthy).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("still de-duplicates a repeated device-recovered push for the same lease", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const recovered = vi.fn();
    client.onDeviceRecovered(recovered);

    connection.push("device-unhealthy", {
      deviceId: "device_1",
      leaseId: "lease_1",
      reason: "crashed",
    });
    connection.push("device-recovered", { attempts: 1, deviceId: "device_1", leaseId: "lease_1" });
    // The owner-routed fan-out re-delivering the same recovered fact must still be suppressed.
    connection.push("device-recovered", { attempts: 1, deviceId: "device_1", leaseId: "lease_1" });

    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates a repeated lease-lost push for the same lease (permanent -- loss is terminal)", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const leaseLost = vi.fn();
    client.onLeaseLost(leaseLost);

    connection.push("lease-lost", { deviceId: "device_1", leaseId: "lease_1", reason: "crashed" });
    connection.push("lease-lost", { deviceId: "device_1", leaseId: "lease_1", reason: "crashed" });

    expect(leaseLost).toHaveBeenCalledTimes(1);
  });

  it("a successful release never fires onLeaseLost, because the daemon suppresses the push at the source (ADR §8)", async () => {
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
    // Unlike the real daemon (which never sends this push to the releasing connection), the
    // scripted connection sends nothing here either -- this asserts the client does not
    // itself need to remember and swallow a self-initiated release.
    connection.reply(releaseCall.id, { leaseId: "lease_1" });
    await releasePromise;

    expect(leaseLost).not.toHaveBeenCalled();
  });

  it("S3: a lease-lost push for a lease id whose earlier release attempt failed is still delivered, not permanently muted", async () => {
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

    // The release itself fails -- e.g. an agent-role client hitting FORBIDDEN.
    const releasePromise = client.releaseLease({ leaseId: "lease_1" });
    await flushMicrotasks();
    const releaseCall = connection.lastSentOf("lease.release")!;
    connection.fail(releaseCall.id, "FORBIDDEN", "not authorized");
    await expect(releasePromise).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The lease later genuinely expires/crashes -- this is a real loss the client must
    // still surface, not residue from the earlier failed release attempt.
    connection.push("lease-lost", {
      deviceId: "device_1",
      leaseId: "lease_1",
      reason: "expired",
    });

    expect(leaseLost).toHaveBeenCalledWith({
      deviceId: "device_1",
      leaseId: "lease_1",
      reason: "expired",
    });
  });

  it("ignores an unknown push kind such as a protocol-3 daemon's lease.heartbeat", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    // Not reachable against a protocol-4 daemon (the ranges do not overlap, so `hello` fails
    // first), but the wire must not answer a push it no longer understands.
    connection.push("lease.heartbeat", { nonce: 12345 });
    await flushMicrotasks();

    expect(connection.lastSentOf("lease.heartbeat")).toBeUndefined();
    await client.close();
  });

  it("silently drops malformed lease-scoped and event pushes instead of throwing", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const leaseLost = vi.fn();
    const unhealthy = vi.fn();
    const recovered = vi.fn();
    client.onLeaseLost(leaseLost);
    client.onDeviceUnhealthy(unhealthy);
    client.onDeviceRecovered(recovered);

    expect(() => connection.push("lease-lost", { leaseId: "lease_1" })).not.toThrow();
    expect(() => connection.push("device-unhealthy", { leaseId: "lease_1" })).not.toThrow();
    expect(() =>
      connection.push("device-recovered", { deviceId: "device_1", leaseId: "lease_1" }),
    ).not.toThrow();
    expect(() => connection.push("event", { not: "a valid event shape" })).not.toThrow();

    expect(leaseLost).not.toHaveBeenCalled();
    expect(unhealthy).not.toHaveBeenCalled();
    expect(recovered).not.toHaveBeenCalled();
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

describe("principal resolution (ADR §4, B3)", () => {
  it('adopts the daemon-resolved principal from hello\'s reply, never defaulting to ""', async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello")!;
    // No principal was supplied -- the daemon resolves its own default (a pid, in practice).
    expect((hello.payload as { principal?: string }).principal).toBeUndefined();
    connection.reply(hello.id, {
      daemonProtocolRange: { max: 3, min: 3 },
      principal: "48213",
      protocolVersion: 3,
      role: "agent",
      version: "0.3.0",
    });
    const client = await connectPromise;

    expect(client.principal).toBe("48213");
  });
});

describe("requestLease abort: ADR §4 identity cases (B3)", () => {
  it("no principal supplied: abort while queued cancels with the daemon-resolved principal, and leaves no lease held", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello")!;
    connection.reply(hello.id, {
      daemonProtocolRange: { max: 3, min: 3 },
      principal: "48213",
      protocolVersion: 3,
      role: "agent",
      version: "0.3.0",
    });
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
    // Before this fix, this was always "" -- the daemon fixes the connection's principal to
    // its own default, and the client had no way to learn it. Sent as the resolved principal
    // now, never "".
    expect((cancelCall.payload as { requesterId?: string }).requesterId).toBe("48213");

    connection.reply(cancelCall.id, { result: "cancelled" });
    await flushMicrotasks();
    connection.fail(requestCall.id, "QUEUE_TIMEOUT", "cancelled by request");

    await expect(leasePromise).rejects.toMatchObject({ code: "CANCELLED" });

    // No lease is held: connection death fires no onLeaseLost for anything.
    const leaseLost = vi.fn();
    client.onLeaseLost(leaseLost);
    connection.simulateDeath();
    await flushMicrotasks();
    expect(leaseLost).not.toHaveBeenCalled();
  });

  it('ADR §4 proxy case (principal "host", requesterId "agent-7"): abort in flight releases the grant and leaves no lease held', async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection, principal: "host" });
    await flushMicrotasks();
    completeHello(connection, { principal: "host" });
    const client = await connectPromise;
    expect(client.principal).toBe("host");

    const controller = new AbortController();
    const leasePromise = client.requestLease(
      { model: "iPhone 17", platform: "ios", requesterId: "agent-7" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    const requestCall = connection.lastSentOf("lease.request")!;

    controller.abort();
    await flushMicrotasks();
    const cancelCall = connection.lastSentOf("lease.cancel")!;
    // Before this fix, the daemon's `authorize` hook compared this `requesterId` straight to
    // the principal and rejected FORBIDDEN outright -- exactly ADR §4's proxy case. The
    // request is still sent with the proxied requesterId (attribution); the daemon now
    // authorizes the cancel against the pending request's recorded *owner* instead.
    expect((cancelCall.payload as { requesterId?: string }).requesterId).toBe("agent-7");
    connection.reply(cancelCall.id, { result: "not-cancellable" });
    await flushMicrotasks();

    connection.reply(requestCall.id, sampleGrant({ leaseId: "lease_proxy_abandoned" }));
    await flushMicrotasks();
    const releaseCall = connection.lastSentOf("lease.release")!;
    expect((releaseCall.payload as { leaseId: string }).leaseId).toBe("lease_proxy_abandoned");
    connection.reply(releaseCall.id, { leaseId: "lease_proxy_abandoned" });

    await expect(leasePromise).rejects.toMatchObject({ code: "CANCELLED" });

    // Already released via the abandoned-grant path -- not tracked as held any more.
    const leaseLost = vi.fn();
    client.onLeaseLost(leaseLost);
    connection.simulateDeath();
    await flushMicrotasks();
    expect(leaseLost).not.toHaveBeenCalled();
  });

  it("a FORBIDDEN from the abort's lease.cancel surfaces instead of being read as a dead connection", async () => {
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

    controller.abort();
    await flushMicrotasks();
    const cancelCall = connection.lastSentOf("lease.cancel")!;
    connection.fail(cancelCall.id, "FORBIDDEN", "not authorized");

    await expect(leasePromise).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Not misread as the connection dying -- it's still alive and usable for another call.
    expect(connection.closed).toBe(false);
    const anotherCall = client.cancelLease();
    await flushMicrotasks();
    const anotherCancelCall = connection.lastSentOf("lease.cancel")!;
    expect(anotherCancelCall.id).not.toBe(cancelCall.id);
    connection.reply(anotherCancelCall.id, { result: "not-found" });
    await expect(anotherCall).resolves.toMatchObject({ result: "not-found" });
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

  it("releaseAllLeases clears every held lease id and connection death afterwards fires no onLeaseLost", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const admin = await connectPromise;

    const firstGrant = admin.requestLease({ model: "iPhone 17", platform: "ios" });
    await flushMicrotasks();
    connection.reply(
      connection.lastSentOf("lease.request")!.id,
      sampleGrant({ leaseId: "lease_a" }),
    );
    await firstGrant;

    const secondGrant = admin.requestLease({ model: "iPhone 17", platform: "ios" });
    await flushMicrotasks();
    connection.reply(
      connection.lastSentOf("lease.request")!.id,
      sampleGrant({ leaseId: "lease_b" }),
    );
    await secondGrant;

    const releaseAllPromise = admin.releaseAllLeases();
    await flushMicrotasks();
    const releaseAllCall = connection.lastSentOf("lease.release-all")!;
    connection.reply(releaseAllCall.id, { leaseIds: ["lease_a", "lease_b"] });
    await expect(releaseAllPromise).resolves.toMatchObject({
      leaseIds: ["lease_a", "lease_b"],
    });

    // Both leases are no longer tracked as held -- a later connection death synthesizes no
    // onLeaseLost for either of them.
    const leaseLost = vi.fn();
    admin.onLeaseLost(leaseLost);
    connection.simulateDeath();
    await flushMicrotasks();
    expect(leaseLost).not.toHaveBeenCalled();
  });
});
