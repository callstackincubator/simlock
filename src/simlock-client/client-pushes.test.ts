import { describe, expect, it, vi } from "vitest";
import { connectSimlockAdmin } from "../admin/index.js";
import { connectSimlock } from "../client/index.js";
import { completeHello, ScriptedConnection } from "./test-support.js";
import { flushMicrotasks, sampleGrant } from "./test-client.js";

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

  it("routes component-progress pushes to that installComponent call's onProgress, and stops at its reply", async () => {
    // ADR 0010 §6: `component-progress` is request-scoped like `progress`.
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const onProgress = vi.fn();
    const installPromise = client.installComponent(
      { platform: "android", version: "35" },
      { onProgress },
    );
    await flushMicrotasks();
    const installCall = connection.lastSentOf("component.install")!;
    expect(installCall.payload).toEqual({ platform: "android", version: "35" });

    connection.push("component-progress", {
      progress: { stage: "waiting" },
      requestId: installCall.id,
    });
    connection.push("component-progress", {
      progress: { fraction: 0.41, stage: "downloading" },
      requestId: installCall.id,
    });
    const result = { component: "35", outcome: "installed", platform: "android", version: "35" };
    connection.reply(installCall.id, result);

    await expect(installPromise).resolves.toEqual(result);
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { stage: "waiting" },
      { fraction: 0.41, stage: "downloading" },
    ]);
    connection.push("component-progress", {
      progress: { stage: "downloading" },
      requestId: installCall.id,
    });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("hands installComponentOnWorkers each relayed update with its workerId, and drops one that names no worker", async () => {
    // ADR 0010 §7: a gateway sets `workerId` on every `component-progress` push it relays.
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const onProgress = vi.fn();
    const installPromise = client.installComponentOnWorkers(
      { platform: "android", version: "35", workers: "all" },
      { onProgress },
    );
    await flushMicrotasks();
    const call = connection.lastSentOf("worker.install-component")!;
    expect(call.payload).toEqual({ platform: "android", version: "35", workers: "all" });

    connection.push("component-progress", {
      progress: { stage: "waiting" },
      requestId: call.id,
      workerId: "wrk_a",
    });
    connection.push("component-progress", { progress: { stage: "waiting" }, requestId: call.id });
    connection.push("component-progress", {
      progress: { fraction: 0.5, stage: "downloading" },
      requestId: call.id,
      workerId: "wrk_b",
    });
    const result = { results: [{ outcome: "installed", version: "35", workerId: "wrk_a" }] };
    connection.reply(call.id, result);

    await expect(installPromise).resolves.toEqual(result);
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { stage: "waiting", workerId: "wrk_a" },
      { fraction: 0.5, stage: "downloading", workerId: "wrk_b" },
    ]);
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
    const execPromise = client.exec(
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

  it("rotate sends device.rotate for the lease and answers its output, or throws the daemon's typed refusal", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const rotated = client.rotate("lease_1", "landscape_left");
    await flushMicrotasks();
    expect(connection.sent.map((frame) => frame.type)).toContain("device.rotate");
    const call = connection.lastSentOf("device.rotate")!;
    expect(call.payload).toEqual({ leaseId: "lease_1", orientation: "landscape_left" });
    connection.reply(call.id, { leaseId: "lease_1", orientation: "landscape_left" });
    await expect(rotated).resolves.toEqual({ leaseId: "lease_1", orientation: "landscape_left" });

    const refused = client.rotate("lease_2", "portrait", { requesterId: "agent-1" });
    await flushMicrotasks();
    const refusedCall = connection.lastSentOf("device.rotate")!;
    expect(refusedCall.payload).toEqual({
      leaseId: "lease_2",
      orientation: "portrait",
      requesterId: "agent-1",
    });
    const details = { class: "tv", leaseId: "lease_2", physical: false, platform: "ios" };
    connection.fail(
      refusedCall.id,
      "ROTATION_UNSUPPORTED",
      "Lease lease_2 is on an Apple TV simulator; only an iOS simulator can be rotated",
      details,
    );
    await expect(refused).rejects.toMatchObject({
      code: "ROTATION_UNSUPPORTED",
      details,
      kind: "domain",
    });
  });

  it("routes a device.exec started push to that call's onStarted, once, before output, and not to another call in flight", async () => {
    // ADR 0005 §19a: `started` is request-scoped like `output` -- the fact a transport chooses
    // its response shape on. Round 5 review: the send site and this route could both be deleted
    // with the whole suite green, because every test of this frame stopped at the coordinator's
    // own callback. This one exercises the wire.
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const first = { onOutput: vi.fn(), onStarted: vi.fn() };
    const second = { onOutput: vi.fn(), onStarted: vi.fn() };
    const firstPromise = client.exec({ args: ["list"], leaseId: "lease_1", tool: "simctl" }, first);
    const secondPromise = client.exec(
      { args: ["devices"], leaseId: "lease_2", tool: "adb" },
      second,
    );
    await flushMicrotasks();
    const calls = connection.sent.filter((frame) => frame.type === "device.exec");
    expect(calls).toHaveLength(2);
    const [firstCall, secondCall] = calls as [(typeof calls)[0], (typeof calls)[0]];

    connection.push("started", { requestId: firstCall.id });
    connection.push("output", { chunk: "one", requestId: firstCall.id, stream: "stdout" });

    // Only the call it names, and before that call's own output.
    expect(first.onStarted).toHaveBeenCalledTimes(1);
    expect(second.onStarted).not.toHaveBeenCalled();
    expect(first.onStarted.mock.invocationCallOrder[0]).toBeLessThan(
      first.onOutput.mock.invocationCallOrder[0] as number,
    );

    connection.reply(firstCall.id, { exitCode: 0 });
    connection.reply(secondCall.id, { exitCode: 0 });
    await expect(firstPromise).resolves.toEqual({ exitCode: 0 });
    await expect(secondPromise).resolves.toEqual({ exitCode: 0 });

    // Settled calls are no longer tracked, so a late frame is dropped rather than delivered.
    connection.push("started", { requestId: firstCall.id });
    expect(first.onStarted).toHaveBeenCalledTimes(1);
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

describe("event pushes", () => {
  it("a worker push with a malformed id or timestamp never reaches the gateway's bus", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const client = await connectPromise;
    const listener = vi.fn();
    const subscribed = client.subscribeEvents(listener);
    await flushMicrotasks();
    const subscribe = connection.lastSentOf("events.subscribe");
    if (subscribe === undefined) throw new Error("the client never sent events.subscribe");
    connection.reply(subscribe.id, { subscribed: true, subscriptionId: "sub_1" });
    await subscribed;
    const valid = {
      event: "lease.expired",
      id: "evt_ok",
      module: "leases",
      payload: {},
      seq: 1,
      timestamp: 5,
    };

    for (const bad of [
      { ...valid, id: "no-prefix" },
      { ...valid, id: `evt_${"a".repeat(65)}` },
      { ...valid, id: 7 },
      { ...valid, timestamp: null },
      { ...valid, timestamp: "5" },
    ]) {
      connection.push("event", { subscriptionId: "sub_1", event: bad });
    }
    // `1e999` is valid JSON that parses to Infinity, a value JSON.stringify cannot emit; the
    // same raw channel carries the well-formed twin, which proves the line is delivered at all.
    const rawPush = (timestamp: string) =>
      JSON.stringify({
        payload: { subscriptionId: "sub_1", event: { ...valid, timestamp: "__timestamp__" } },
        push: "event",
      }).replace('"__timestamp__"', timestamp);
    connection.receiveLine(rawPush("1e999"));
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();

    connection.receiveLine(rawPush("5"));
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("a worker push with a timestamp outside the date range never reaches the gateway's bus", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const client = await connectPromise;
    const listener = vi.fn();
    const subscribed = client.subscribeEvents(listener);
    await flushMicrotasks();
    const subscribe = connection.lastSentOf("events.subscribe");
    if (subscribe === undefined) throw new Error("the client never sent events.subscribe");
    connection.reply(subscribe.id, { subscribed: true, subscriptionId: "sub_1" });
    await subscribed;
    const push = (timestamp: number) =>
      connection.push("event", {
        subscriptionId: "sub_1",
        event: {
          event: "lease.expired",
          id: "evt_ok",
          module: "leases",
          payload: {},
          seq: 1,
          timestamp,
        },
      });

    for (const outside of [8.64e15 + 2, -8.64e15 - 2, 1e300, -1e300]) push(outside);
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();

    push(8.64e15);
    push(-8.64e15);
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(2);
    await client.close();
  });
});
