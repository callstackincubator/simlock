import { describe, expect, it, vi } from "vitest";
import { connectSimlockAdmin } from "../admin/index.js";
import { connectSimlock } from "../client/index.js";
import type { SimlockAdminClient, SimlockClient } from "./client.js";
import { MAX_WIRE_LINE_CHARS } from "./wire.js";
import { completeHello, ScriptedConnection } from "./test-support.js";
import { flushMicrotasks, sampleGrant } from "./test-client.js";

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

    const client = await connectPromise;
    expect(connection.closed).toBe(false);

    const before = connection.sent.length;
    await expect(client.getStatus()).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    await expect(client.runCleanup()).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    await expect(client.addDevice({ id: "UDID-1", platform: "ios" })).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    await expect(client.removeDevice({ id: "UDID-1" })).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    await expect(client.usage({ from: 0, to: 60_000 })).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    await expect(client.testAlertDestination({ destination: "ops" })).rejects.toMatchObject({
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
      details: {
        // The range this client offered at hello; the legacy daemon's is the one that predates
        // ranges.
        client: (hello.payload as { protocolRange: unknown }).protocolRange,
        daemon: { max: 2, min: 2 },
        daemonVersion: "unknown",
      },
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
    // `model`, when given, must be non-empty per the contract's input schema.
    await expect(client.requestLease({ model: "", platform: "ios" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(connection.sent).toHaveLength(before);
  });

  it.each([
    {
      name: "component.list from an agent client",
      admin: false,
      operation: "component.list",
      payload: { platform: "ios" },
      answer: {
        components: [
          {
            devices: 0,
            foreignDevices: 2,
            installedBySimlock: false,
            platform: "ios",
            sizeBytes: 9_100_000_000,
            variant: "23A343",
            version: "26.0",
          },
        ],
      },
      call: (client: SimlockAdminClient) => client.listComponents({ platform: "ios" }),
    },
    {
      name: "identity.get from an agent client",
      admin: false,
      operation: "identity.get",
      payload: {},
      answer: { name: "ci-runner", principal: "tok_9f2c", role: "agent", via: "token" },
      call: (client: SimlockAdminClient) => client.identity(),
    },
    {
      name: "component.remove from an admin client",
      admin: true,
      operation: "component.remove",
      payload: { dryRun: true, platform: "ios", version: "26.4" },
      answer: { outcome: "would-remove", platform: "ios", sizeBytes: 7, version: "26.4" },
      call: (client: SimlockAdminClient) =>
        client.removeComponent({ dryRun: true, platform: "ios", version: "26.4" }),
    },
  ])("sends $name with its input and returns the daemon's answer", async (row) => {
    const connection = new ScriptedConnection();
    const connectPromise = row.admin
      ? connectSimlockAdmin({ connection, credential: "operator-secret" })
      : connectSimlock({ connection });
    await flushMicrotasks();
    if (row.admin) completeHello(connection, { role: "admin" });
    else completeHello(connection);
    const client = (await connectPromise) as SimlockAdminClient;

    const callPromise = row.call(client);
    await flushMicrotasks();
    const call = connection.lastSentOf(row.operation)!;
    expect(call.payload).toEqual(row.payload);
    connection.reply(call.id, row.answer);

    await expect(callPromise).resolves.toEqual(row.answer);
  });

  it("the admin client's testAlertDestination sends alerts.test and returns its output", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const client = await connectPromise;

    const callPromise = client.testAlertDestination({ destination: "ops-slack" });
    await flushMicrotasks();
    const call = connection.lastSentOf("alerts.test")!;
    expect(call.payload).toEqual({ destination: "ops-slack" });
    connection.reply(call.id, { destination: "ops-slack", status: 204 });

    await expect(callPromise).resolves.toEqual({ destination: "ops-slack", status: 204 });

    const failing = client.testAlertDestination({ destination: "ops-slack" });
    await flushMicrotasks();
    connection.fail(
      connection.lastSentOf("alerts.test")!.id,
      "ALERT_SEND_FAILED",
      "ops-slack answered HTTP 404",
      { destination: "ops-slack", status: 404 },
    );
    await expect(failing).rejects.toMatchObject({
      code: "ALERT_SEND_FAILED",
      details: { destination: "ops-slack", status: 404 },
    });
  });

  it("the admin client's updateWorker sends worker.update and returns its output, and refuses an empty worker id before sending", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const client = await connectPromise;
    const answer = {
      health: "running",
      lastUpdateFailure: null,
      latestVersion: "0.4.0",
      resolved: "0.4.0",
      started: true,
      update: null,
      upToDate: false,
      version: "0.3.0",
      workerId: "wrk_1",
    };

    const callPromise = client.updateWorker({ force: true, version: "0.4.0", workerId: "wrk_1" });
    await flushMicrotasks();
    const call = connection.lastSentOf("worker.update");
    expect(call?.payload).toEqual({ force: true, version: "0.4.0", workerId: "wrk_1" });
    connection.reply(call!.id, answer);

    await expect(callPromise).resolves.toEqual(answer);
    await expect(client.updateWorker({ workerId: "" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("enrolls a device from an admin client with device.add and removes it with device.remove, sending the input and returning the daemon's answer", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const client = await connectPromise;
    const enrolled = {
      appCount: 2,
      class: "phone",
      driverDeviceId: "UDID-1",
      id: "dev_1",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
      reenrolled: false,
    };

    const addPromise = client.addDevice({ id: "ALIAS", platform: "ios" });
    await flushMicrotasks();
    const addCall = connection.lastSentOf("device.add")!;
    expect(addCall.payload).toEqual({ id: "ALIAS", platform: "ios" });
    connection.reply(addCall.id, enrolled);
    await expect(addPromise).resolves.toEqual(enrolled);

    const removePromise = client.removeDevice({ id: "UDID-1" });
    await flushMicrotasks();
    const removeCall = connection.lastSentOf("device.remove")!;
    expect(removeCall.payload).toEqual({ id: "UDID-1" });
    connection.reply(removeCall.id, { driverDeviceId: "UDID-1", id: "UDID-1" });
    await expect(removePromise).resolves.toEqual({ driverDeviceId: "UDID-1", id: "UDID-1" });
  });

  it("asks usage.get for a window from an admin client and returns the daemon's answer, refusing a window the contract bounds before sending it", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const client = await connectPromise;
    const none = { count: 0, max: null, p50: null, p95: null };
    const figures = {
      boot: none,
      bySource: { booted: 0, provisioned: 0, warm: 0 },
      declined: 0,
      failures: { byEvent: {} },
      granted: 0,
      held: none,
      incidents: { crashRecovered: 0, lost: 0, quarantineRecovered: 0, quarantined: 0 },
      provisioning: none,
      queue: { meanDepth: null, peakDepth: null },
      rejected: { byReason: {}, total: 0 },
      requests: 0,
      turnaround: none,
      utilisation: { slots: { max: null, mean: null, peak: null } },
      wait: none,
    };
    const answer = {
      bucketMs: 60_000,
      coversFrom: 1_000,
      partial: false,
      platforms: { android: figures, ios: figures },
      requesters: [],
      series: [],
      totals: figures,
      window: { from: 1_000, to: 3_601_000 },
      workers: [],
    };

    const callPromise = client.usage({ from: 1_000, to: 3_601_000 });
    await flushMicrotasks();
    const call = connection.lastSentOf("usage.get")!;
    expect(call.payload).toEqual({ from: 1_000, to: 3_601_000 });
    connection.reply(call.id, answer);

    await expect(callPromise).resolves.toEqual(answer);

    const sentBefore = connection.sent.length;
    const refused = client.usage({ from: 5, to: 5 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await flushMicrotasks();
    expect(connection.sent).toHaveLength(sentBefore);
    expect(await refused).toMatchObject({ code: "BAD_REQUEST" });
  });

  it.each([
    {
      call: (client: SimlockClient) => client.getCatalog(),
      operation: "catalog.get",
      reply: { notPlatforms: true },
    },
    {
      call: (client: SimlockClient) => client.requestLease({ model: "iPhone 17", platform: "ios" }),
      operation: "lease.request",
      reply: null,
    },
    {
      call: (client: SimlockClient) => client.requestLease({ model: "iPhone 17", platform: "ios" }),
      operation: "lease.request",
      reply: { lease: null },
    },
  ])(
    "wraps a malformed $operation response ($reply) instead of throwing a raw parse failure",
    async ({ call: callOperation, operation, reply }) => {
      const connection = new ScriptedConnection();
      const connectPromise = connectSimlock({ connection });
      await flushMicrotasks();
      completeHello(connection);
      const client = await connectPromise;

      const callPromise = callOperation(client);
      await flushMicrotasks();
      const call = connection.lastSentOf(operation)!;
      connection.reply(call.id, reply);

      await expect(callPromise).rejects.toMatchObject({ code: "BAD_FRAME" });
    },
  );

  it("rejects status.get from a worker with an over-long host string by the gateway's schema", async () => {
    // A gateway reads each worker through this client (`WorkerLink`), so this parse is where
    // a worker's host facts are bounded before they reach its view.
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, principal: "gw:instance-1" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const client = await connectPromise;
    const status = {
      capacity: {
        android: {
          atRamBudget: false,
          limit: 1,
          maxRunning: 1,
          overLimit: false,
          reserved: 0,
          running: 0,
          used: 0,
          warm: 0,
        },
        global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
        ios: {
          atRamBudget: false,
          limit: 1,
          maxRunning: 1,
          overLimit: false,
          reserved: 0,
          running: 0,
          used: 0,
          warm: 0,
        },
      },
      daemon: {
        health: "running",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      devices: [],
      host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
      leases: [],
      queueDepth: 0,
    };

    const accepted = client.getStatus();
    await flushMicrotasks();
    connection.reply(connection.lastSentOf("status.get")!.id, status);
    await expect(accepted).resolves.toMatchObject({ host: { os: "macOS" } });

    const rejected = client.getStatus();
    await flushMicrotasks();
    connection.reply(connection.lastSentOf("status.get")!.id, {
      ...status,
      host: { ...status.host, osVersion: "1".repeat(129) },
    });
    await expect(rejected).rejects.toMatchObject({ code: "BAD_FRAME" });
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

describe("wire framing", () => {
  it("finds a reply split across many chunks scanning each byte a bounded number of times, and closes the connection when an unfinished line passes its cap", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection });
    await flushMicrotasks();
    completeHello(connection);
    const client = await connectPromise;

    const statusPromise = client.getStatus();
    await flushMicrotasks();
    const call = connection.lastSentOf("status.get")!;
    const line = `${JSON.stringify({ id: call.id, ok: true, payload: { notStatus: "x".repeat(20_000) } })}\n`;
    let scanned = 0;
    const original = String.prototype.indexOf;
    const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
      this: string,
      ...args: Parameters<typeof original>
    ) {
      scanned += this.length;
      return original.apply(this, args);
    });
    try {
      for (let at = 0; at < line.length; at += 16) connection.receiveRaw(line.slice(at, at + 16));
    } finally {
      spy.mockRestore();
    }
    // why: the payload fails the status schema, so BAD_FRAME proves the split line reached its call.
    await expect(statusPromise).rejects.toMatchObject({ code: "BAD_FRAME" });
    expect(scanned).toBeLessThanOrEqual(3 * line.length);

    const pending = client.getStatus();
    await flushMicrotasks();
    expect(connection.closed).toBe(false);
    const chunk = "a".repeat(64 * 1024);
    // why: the largest real reply is a usage ledger of about 54 MB, so an unfinished line of 64 MiB must be accepted: a cap set below it goes red here.
    let sent = 0;
    for (; sent < 64 * 1024 * 1024; sent += chunk.length) connection.receiveRaw(chunk);
    await flushMicrotasks();
    expect(connection.closed).toBe(false);
    for (; sent <= MAX_WIRE_LINE_CHARS; sent += chunk.length) connection.receiveRaw(chunk);
    await flushMicrotasks();
    expect(connection.closed).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "DAEMON_CONNECTION_LOST" });
  });
});
