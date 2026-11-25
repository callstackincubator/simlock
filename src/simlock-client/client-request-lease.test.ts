import { describe, expect, it, vi } from "vitest";
import { connectSimlock } from "../client/index.js";
import { completeHello, ScriptedConnection } from "./test-support.js";
import { flushMicrotasks, sampleGrant } from "./test-client.js";

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

  it("aborting one of two waiting requests of different platforms sends lease.cancel naming that request's platform and leaves the other waiting", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const iosController = new AbortController();
    const androidController = new AbortController();
    const iosLease = client.requestLease(
      { model: "iPhone 17", platform: "ios" },
      { signal: iosController.signal },
    );
    const androidLease = client.requestLease(
      { model: "Pixel 9", platform: "android" },
      { signal: androidController.signal },
    );
    await flushMicrotasks();
    const requestOf = (platform: string) =>
      connection.sent
        .filter((frame) => frame.type === "lease.request")
        .find((frame) => (frame.payload as { platform: string }).platform === platform)!;
    const androidCall = requestOf("android");

    androidController.abort();
    await flushMicrotasks();
    const cancelCall = connection.lastSentOf("lease.cancel")!;
    connection.reply(cancelCall.id, { result: "cancelled" });
    await flushMicrotasks();
    connection.fail(androidCall.id, "QUEUE_TIMEOUT", "cancelled by request", { requestId: "r2" });

    await expect(androidLease).rejects.toMatchObject({ code: "CANCELLED" });
    expect(cancelCall.payload).toMatchObject({ platform: "android" });
    expect(connection.sent.filter((frame) => frame.type === "lease.cancel")).toHaveLength(1);
    expect(requestOf("ios")).toBeDefined();
    const iosState = await Promise.race([iosLease.catch((e: unknown) => e), "waiting"]);
    expect(iosState).toBe("waiting");
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

    expect(connection.sent).toHaveLength(before);
  });
});

describe("principal resolution (ADR §4, B3)", () => {
  it('adopts the daemon-resolved principal from hello\'s reply, never defaulting to ""', async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    const hello = connection.lastSentOf("hello")!;
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
    expect((cancelCall.payload as { requesterId?: string }).requesterId).toBe("48213");

    connection.reply(cancelCall.id, { result: "cancelled" });
    await flushMicrotasks();
    connection.fail(requestCall.id, "QUEUE_TIMEOUT", "cancelled by request");

    await expect(leasePromise).rejects.toMatchObject({ code: "CANCELLED" });

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
    expect((cancelCall.payload as { requesterId?: string }).requesterId).toBe("agent-7");
    connection.reply(cancelCall.id, { result: "not-cancellable" });
    await flushMicrotasks();

    connection.reply(requestCall.id, sampleGrant({ leaseId: "lease_proxy_abandoned" }));
    await flushMicrotasks();
    const releaseCall = connection.lastSentOf("lease.release")!;
    expect((releaseCall.payload as { leaseId: string }).leaseId).toBe("lease_proxy_abandoned");
    connection.reply(releaseCall.id, { leaseId: "lease_proxy_abandoned" });

    await expect(leasePromise).rejects.toMatchObject({ code: "CANCELLED" });

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
    expect(connection.closed).toBe(false);
    const anotherCall = client.cancelLease();
    await flushMicrotasks();
    const anotherCancelCall = connection.lastSentOf("lease.cancel")!;
    expect(anotherCancelCall.id).not.toBe(cancelCall.id);
    connection.reply(anotherCancelCall.id, { result: "not-found" });
    await expect(anotherCall).resolves.toMatchObject({ result: "not-found" });
  });
});

describe("requestLease requires", () => {
  it("sends requires on the lease.request frame and rejects with CAPABILITY_MISSING, its details naming the capabilities, when the worker lacks the capability", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const pending = client.requestLease({
      model: "iPhone 17",
      platform: "ios",
      requires: ["agent-device"],
    });
    await flushMicrotasks();
    const call = connection.lastSentOf("lease.request")!;
    connection.fail(call.id, "CAPABILITY_MISSING", "This worker cannot serve agent-device", {
      capabilities: ["agent-device"],
    });

    expect(call.payload).toMatchObject({ requires: ["agent-device"] });
    await expect(pending).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device"] },
      kind: "domain",
    });
  });
});
