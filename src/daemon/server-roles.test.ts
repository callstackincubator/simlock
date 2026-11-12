import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import { AdminAuthenticationFailedError } from "../auth/index.js";
import { connectSimlock } from "../client/index.js";
import { linkPair } from "../link/testing.js";
import { promiseState } from "../test-support/promise-state.js";
import * as relaySupport from "./test-relay-support.js";
import {
  createClient,
  createHarness,
  deferred,
  driveConnection,
  hello,
  helloAs,
  leaseIdOf,
  stopTestDaemons,
  waitFor,
} from "./test-server.js";

afterEach(stopTestDaemons);

describe("DaemonServer roles and ownership (ADR 0003 §2-4)", () => {
  it("rejects an admin-only operation from an agent session with FORBIDDEN, and reports the resolved role at hello", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
    const client = await createClient(harness.socketPath);
    const helloReply = await client.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    expect(helloReply.payload).toMatchObject({ role: "agent" });

    const response = await client.request("list.get", {});
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "FORBIDDEN" });
    await client.close();
  });

  it("hello reports the resolved principal: the client-supplied one verbatim, or the daemon's default when omitted (ADR §4)", async () => {
    const harness = await createHarness();

    const explicit = await createClient(harness.socketPath);
    const explicitReply = await explicit.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      principal: "host",
    });
    expect(explicitReply.payload).toMatchObject({ principal: "host" });
    await explicit.close();

    const omitted = await createClient(harness.socketPath);
    const omittedReply = await omitted.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    expect(omittedReply.payload).toMatchObject({ principal: "test-process" });
    await omitted.close();
  });

  it("allows an admin session to call the same admin-only operation", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("list.get", {});
    expect(response.ok).toBe(true);
    await client.close();
  });

  describe("daemon.stop authorization (ADR 0003 §3, §5, §6)", () => {
    it("refuses daemon.stop from an agent-role connection with FORBIDDEN", async () => {
      const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
      const client = await createClient(harness.socketPath);
      await hello(client);

      await expect(client.request("daemon.stop", {})).resolves.toMatchObject({
        error: { code: "FORBIDDEN" },
        ok: false,
      });
      expect(harness.daemon.health).toBe("running");
      await client.close();
    });

    it("refuses daemon.stop from a connection that never sent hello", async () => {
      const harness = await createHarness();
      const client = await createClient(harness.socketPath);

      await expect(client.request("daemon.stop", {})).resolves.toMatchObject({
        error: { code: "HANDSHAKE_REQUIRED" },
        ok: false,
      });
      expect(harness.daemon.health).toBe("running");
      await client.close();
    });

    it("still fails the handshake outright on a wrong credential, and daemon.stop never runs on that connection", async () => {
      const harness = await createHarness({
        resolveRole: {
          resolve: (helloPayload) => {
            if (helloPayload.credential === undefined) return "agent";
            if (helloPayload.credential === "correct-secret") return "admin";
            throw new AdminAuthenticationFailedError();
          },
        },
      });
      const client = await createClient(harness.socketPath);
      const socketClosed = new Promise<void>((resolve) => client.socket.once("close", resolve));

      await expect(
        client.request("hello", {
          clientVersion: "test",
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          credential: "wrong-secret",
        }),
      ).resolves.toMatchObject({
        error: { code: "ADMIN_AUTHENTICATION_FAILED" },
        ok: false,
      });

      await socketClosed;
      expect(harness.eventBus.replay().map((event) => event.event)).not.toContain(
        "daemon.stopping",
      );
    });

    it("lets an admin connection stop the daemon even when its own hello's protocol negotiation failed, and refuses every other operation on it with the version error", async () => {
      const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
      const client = await createClient(harness.socketPath);

      const mismatchedHello = await client.request("hello", {
        clientVersion: "test",
        protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
      });
      expect(mismatchedHello).toMatchObject({
        error: {
          code: "PROTOCOL_VERSION_UNSUPPORTED",
          details: {
            client: { min: DAEMON_PROTOCOL_VERSION + 1, max: DAEMON_PROTOCOL_VERSION + 1 },
            daemon: PROTOCOL_VERSION_RANGE,
          },
        },
        ok: false,
      });

      await expect(client.request("status.get", {})).resolves.toMatchObject({
        error: { code: "PROTOCOL_VERSION_UNSUPPORTED" },
        ok: false,
      });
      await expect(client.request("list.get", {})).resolves.toMatchObject({
        error: { code: "PROTOCOL_VERSION_UNSUPPORTED" },
        ok: false,
      });

      await expect(client.request("daemon.stop", {})).resolves.toMatchObject({
        ok: true,
        payload: { stopping: true },
      });
      await expect
        .poll(() => harness.eventBus.replay().map((event) => event.event))
        .toContain("daemon.stopping");
    });

    it("answers a connection opened while the daemon is stopping: status.get with DAEMON_STOPPING, daemon.stop with stopping true", async () => {
      let finishSettle!: () => void;
      const settling = new Promise<void>((resolve) => {
        finishSettle = resolve;
      });
      const harness = await createHarness({
        resolveRole: { resolve: () => "admin" },
        settle: () => settling,
      });
      const stopping = harness.daemon.stop("test-stop-window");
      await expect
        .poll(() => harness.eventBus.replay().map((event) => event.event))
        .toContain("daemon.stopping");

      const late = await createClient(harness.socketPath);
      const closed = new Promise<"connection closed">((resolve) =>
        late.socket.once("close", () => resolve("connection closed")),
      );
      const ask = (type: string, payload: unknown) =>
        Promise.race([late.request(type, payload), closed]);
      const replies = [
        await ask("hello", { clientVersion: "test", protocolVersion: DAEMON_PROTOCOL_VERSION }),
        await ask("status.get", {}),
        await ask("daemon.stop", {}),
      ];
      finishSettle();
      await stopping;

      expect(replies).toMatchObject([
        { ok: true },
        { error: { code: "DAEMON_STOPPING" }, ok: false },
        { ok: true, payload: { stopping: true } },
      ]);
    });

    it("closes a connection opened after the connections were closed, while the admin.token removal still holds the stop", async () => {
      const removing = deferred<void>();
      let removalBegun = false;
      const harness = await createHarness({
        adminSecret: {
          persist: async () => undefined,
          remove: () => {
            removalBegun = true;
            return removing.promise;
          },
        },
      });
      const stopping = harness.daemon.stop("test-late-connection");
      await expect.poll(() => removalBegun).toBe(true);

      const late = await createClient(harness.socketPath);
      const closed = new Promise<"closed">((resolve) =>
        late.socket.once("close", () => resolve("closed")),
      );
      const outcome = await Promise.race([closed, relaySupport.sleep(1_000).then(() => "hung")]);
      // why: a leaked connection would hang the stop, so the assertion comes first and the cleanup forces the socket down.
      try {
        expect(outcome).toBe("closed");
      } finally {
        late.socket.destroy();
        removing.resolve();
        await stopping;
      }
    });

    it("still refuses daemon.stop with FORBIDDEN on a version-mismatched connection whose role is agent", async () => {
      const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
      const client = await createClient(harness.socketPath);

      await expect(
        client.request("hello", {
          clientVersion: "test",
          protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
        }),
      ).resolves.toMatchObject({
        error: { code: "PROTOCOL_VERSION_UNSUPPORTED" },
        ok: false,
      });

      await expect(client.request("daemon.stop", {})).resolves.toMatchObject({
        error: { code: "FORBIDDEN" },
        ok: false,
      });
      expect(harness.daemon.health).toBe("running");
      await client.close();
    });
  });

  it("routes warm.forget from the socket to the dispatcher, which answers that the warm pool is unavailable when none is wired", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("warm.forget", { model: "Pixel", platform: "android" }),
    ).resolves.toMatchObject({
      error: { code: "INTERNAL", message: "The warm pool is unavailable" },
      ok: false,
    });
    await client.close();
  });

  it("routes baseline.save, baseline.list and baseline.remove from the socket to the dispatcher", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    const routed = [
      { operation: "baseline.save", payload: { leaseId: "lse_gone", name: "login" } },
      { operation: "baseline.list", payload: {} },
      { operation: "baseline.remove", payload: { name: "login" } },
    ] as const;
    const answers = [];
    for (const { operation, payload } of routed) {
      const answer = await client.request(operation, payload);
      answers.push({
        operation,
        unknownRequest: answer.error?.code === "UNKNOWN_REQUEST",
      });
    }
    expect(answers).toEqual(routed.map(({ operation }) => ({ operation, unknownRequest: false })));
    await client.close();
  });

  it("still lets an agent call doctor.run with fix:false, but not fix:true (input-dependent role)", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("doctor.run", { fix: false })).resolves.toMatchObject({
      error: { code: "DOCTOR_UNAVAILABLE" },
      ok: false,
    });
    await expect(client.request("doctor.run", { fix: true })).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
      ok: false,
    });
    await client.close();
  });

  it("denies lease.renew/lease.release to a session whose principal does not own the lease, and allows the owner", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
    const owner = await createClient(harness.socketPath);
    await helloAs(owner, "alice");
    const grant = await owner.request("lease.request", {
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    expect(grant.ok).toBe(true);
    const leaseId = leaseIdOf(grant);
    expect((grant.payload as { lease: { ownerId: string } }).lease.ownerId).toBe("alice");

    const other = await createClient(harness.socketPath);
    await helloAs(other, "bob");
    await expect(other.request("lease.renew", { leaseId })).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
      ok: false,
    });
    await expect(other.request("lease.release", { leaseId })).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
      ok: false,
    });

    await expect(owner.request("lease.renew", { leaseId })).resolves.toMatchObject({ ok: true });
    await owner.close();
    await other.close();
  });

  it("lets admin renew/release a lease it does not own", async () => {
    const harness = await createHarness({
      resolveRole: { resolve: (payload) => (payload.principal === "operator" ? "admin" : "agent") },
    });
    const owner = await createClient(harness.socketPath);
    await helloAs(owner, "alice");
    const grant = await owner.request("lease.request", {
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);

    const admin = await createClient(harness.socketPath);
    await helloAs(admin, "operator");
    harness.clock.advance(5_000);
    await expect(admin.request("lease.renew", { leaseId })).resolves.toMatchObject({
      ok: true,
      payload: { ttlDeadline: 6_000 + 60_000 },
    });
    await expect(admin.request("lease.release", { leaseId })).resolves.toMatchObject({ ok: true });
    await owner.close();
    await admin.close();
  });

  it("lease.list returns only the caller's own leases for an agent, and every lease for admin", async () => {
    const harness = await createHarness({
      iosMaxDevices: 2,
      resolveRole: { resolve: (payload) => (payload.principal === "operator" ? "admin" : "agent") },
    });
    const alice = await createClient(harness.socketPath);
    await helloAs(alice, "alice");
    const aliceGrant = await alice.request("lease.request", {
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const bob = await createClient(harness.socketPath);
    await helloAs(bob, "bob");
    await bob.request("lease.request", {
      requesterId: "bob-2",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    const aliceList = await alice.request("lease.list", {});
    expect(aliceList.ok).toBe(true);
    expect((aliceList.payload as { leases: readonly { id: string }[] }).leases).toMatchObject([
      { id: leaseIdOf(aliceGrant), ownerId: "alice", requesterId: "alice" },
    ]);

    const admin = await createClient(harness.socketPath);
    await helloAs(admin, "operator");
    const adminList = await admin.request("lease.list", {});
    expect((adminList.payload as { leases: readonly unknown[] }).leases).toHaveLength(2);

    await alice.close();
    await bob.close();
    await admin.close();
  });

  it("lease.get over the socket answers the caller's own lease and UNKNOWN_LEASE for another agent's", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
    const alice = await createClient(harness.socketPath);
    await helloAs(alice, "alice");
    const grant = await alice.request("lease.request", {
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    const bob = await createClient(harness.socketPath);
    await helloAs(bob, "bob");

    const own = await alice.request("lease.get", { leaseId });
    expect(own.ok).toBe(true);
    expect((own.payload as { lease: { id: string } }).lease).toMatchObject({
      id: leaseId,
      ownerId: "alice",
    });
    const other = await bob.request("lease.get", { leaseId });
    expect(other.ok).toBe(false);
    expect(other.error).toMatchObject({ code: "UNKNOWN_LEASE" });

    await alice.close();
    await bob.close();
  });

  it("forwards ttlMs as the initial TTL of any lease, and stores it as the lease's width", async () => {
    const harness = await createHarness({
      iosMaxDevices: 2,
      resolveRole: { resolve: () => "agent" },
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const granted = await client.request("lease.request", {
      ttlMs: 30_000,
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    expect(granted.ok).toBe(true);
    expect(
      (granted.payload as { lease: { grantedAt: number; ttlMs: number; ttlDeadline: number } })
        .lease,
    ).toMatchObject({ grantedAt: 1_000, ttlMs: 30_000, ttlDeadline: 1_000 + 30_000 });

    const leaseId = leaseIdOf(granted);
    harness.clock.advance(5_000);
    await expect(client.request("lease.renew", { leaseId })).resolves.toMatchObject({
      ok: true,
      payload: { ttlMs: 30_000, ttlDeadline: 6_000 + 30_000 },
    });

    const defaulted = await client.request("lease.request", {
      requesterId: "defaulted",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    expect(defaulted.ok).toBe(true);
    expect((defaulted.payload as { lease: { ttlMs: number } }).lease.ttlMs).toBe(60_000);
    await client.close();
  });

  it("cancels a still-queued lease.cancel without closing the connection, and the original request settles rather than hanging", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const held = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    expect(held.ok).toBe(true);

    const waiter = await createClient(harness.socketPath);
    await hello(waiter);
    const queuedRequest = waiter.request("lease.request", {
      requesterId: "waiter",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    await expect.poll(() => harness.engine.queueDepth).toBe(1);

    const cancel = await waiter.request("lease.cancel", { requesterId: "waiter" });
    expect(cancel).toMatchObject({ ok: true, payload: { result: "cancelled" } });

    await expect(queuedRequest).resolves.toMatchObject({ ok: false });
    await expect(waiter.request("status.get", {})).resolves.toMatchObject({ ok: true });

    await holder.close();
    await waiter.close();
  });

  it("a requestLease aborted right after its frame is sent, with the device limit held, rejects CANCELLED and its request ends cancelled, not by its queue timeout", async () => {
    const harness = await createHarness();
    const refusals: string[] = [];
    harness.eventBus.subscribe("lease.rejected", (envelope) => {
      if (envelope.payload.requester === "waiter") refusals.push(envelope.payload.reason);
    });
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const held = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    expect(held.ok).toBe(true);

    const client = await connectSimlock({
      endpoint: harness.socketPath,
      principal: "waiter",
    });
    const controller = new AbortController();
    const lease = client.requestLease(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios", timeoutMs: 60_000 },
      { signal: controller.signal },
    );
    const state = promiseState(lease);
    const outcome = lease.then(
      () => "granted",
      (error: unknown) => error,
    );
    await Promise.resolve();
    controller.abort();

    await waitFor(() => state.state !== "pending" || harness.engine.queueDepth === 1);
    harness.clock.advance(60_001);

    expect(await outcome).toMatchObject({ code: "CANCELLED" });
    expect(refusals).toEqual(["cancelled"]);

    await holder.close();
    await client.close();
  });

  it("a lease.cancel sent while the same requester's lease.request is refused before admission answers once it is refused, instead of waiting forever", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);
    const refused = client.request("lease.request", {
      requesterId: "waiter",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
      requires: ["no-such-capability"],
    });
    const cancel = client.request("lease.cancel", { requesterId: "waiter", platform: "ios" });
    const state = promiseState(cancel);
    await waitFor(() => state.state !== "pending");

    expect(state.state).toBe("fulfilled");
    expect(await refused).toMatchObject({ ok: false, error: { code: "CAPABILITY_MISSING" } });
    expect(await cancel).toMatchObject({ ok: true });
    await client.close();
  });

  it("pushes lease-lost to every live connection sharing the lease's owner, including a detached holder on another connection (ADR 0003 §8)", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
    const requester = await createClient(harness.socketPath);
    await helloAs(requester, "alice");
    const grant = await requester.request("lease.request", {
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);

    const observer = await createClient(harness.socketPath);
    await helloAs(observer, "alice");

    await expect(requester.request("lease.release", { leaseId })).resolves.toMatchObject({
      ok: true,
    });

    const push = await observer.nextFrame((frame) => frame.push === "lease-lost");
    expect(push.payload).toMatchObject({ leaseId, reason: "explicit" });
    await expect(requester.request("status.get", {})).resolves.toMatchObject({ ok: true });
    expect(requester.frames().filter((frame) => frame.push === "lease-lost")).toEqual([]);

    await requester.close();
    await observer.close();
  });

  it("grants an accepted uplink the admin role without a credential (ADR 0005 §5)", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
    const pair = linkPair();
    harness.daemon.acceptUplink(pair.worker);
    const gateway = driveConnection(pair.gateway);

    const reply = await gateway.request("hello", {
      clientVersion: "gateway",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      principal: "gw:instance-1",
    });

    expect(reply).toMatchObject({ ok: true, payload: { role: "admin" } });
    await expect(gateway.request("list.get", { kind: "devices" })).resolves.toMatchObject({
      ok: true,
    });

    const local = await createClient(harness.socketPath);
    await local.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    await expect(local.request("list.get", {})).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    await local.close();
  });

  it("identity.get answers the declared principal as principal and name over a socket: agent with no credential, admin with the admin secret, admin with an operator token", async () => {
    const harness = await createHarness({
      resolveRole: {
        resolve: (payload) =>
          payload.credential === "admin-secret" || payload.credential === "slk_operator"
            ? "admin"
            : "agent",
      },
    });
    const cases = [
      { credential: undefined, principal: "claude-1", role: "agent" },
      { credential: "admin-secret", principal: "claude-2", role: "admin" },
      { credential: "slk_operator", principal: "claude-3", role: "admin" },
    ];

    for (const { credential, principal, role } of cases) {
      const client = await createClient(harness.socketPath);
      await expect(
        client.request("hello", {
          clientVersion: "test",
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          principal,
          ...(credential === undefined ? {} : { credential }),
        }),
      ).resolves.toMatchObject({ ok: true });

      await expect(client.request("identity.get", {})).resolves.toMatchObject({
        ok: true,
        payload: { name: principal, principal, role, via: "socket" },
      });
      await client.close();
    }
  });

  it("negotiates the protocol range over an uplink exactly as over the socket (ADR 0005 §31)", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
    const pair = linkPair();
    harness.daemon.acceptUplink(pair.worker);
    const gateway = driveConnection(pair.gateway);

    const reply = await gateway.request("hello", {
      clientVersion: "gateway",
      protocolRange: { min: 99, max: 99 },
    });

    expect(reply).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_VERSION_UNSUPPORTED" },
    });
    expect(reply.error).toMatchObject({
      details: { client: { min: 99, max: 99 }, daemon: PROTOCOL_VERSION_RANGE },
    });
  });
  it("refuses a gateway on the current protocol when this worker advertises the previous one (ADR 0007 §12)", async () => {
    const previous = { min: PROTOCOL_VERSION_RANGE.min - 1, max: PROTOCOL_VERSION_RANGE.max - 1 };
    const harness = await createHarness({
      protocolVersion: previous,
      resolveRole: { resolve: () => "admin" },
    });
    const pair = linkPair();
    harness.daemon.acceptUplink(pair.worker);
    const gateway = driveConnection(pair.gateway);

    const reply = await gateway.request("hello", {
      clientVersion: "gateway",
      protocolRange: PROTOCOL_VERSION_RANGE,
    });

    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: "PROTOCOL_VERSION_UNSUPPORTED",
        details: { client: PROTOCOL_VERSION_RANGE, daemon: previous },
      },
    });
  });
});
