import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import { createClient, createHarness, hello, leaseIdOf, stopTestDaemons } from "./test-server.js";

afterEach(stopTestDaemons);

describe("DaemonServer lease liveness (ADR 0004)", () => {
  it("keeps a lease alive only while something renews it, and expires it when nothing does", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 40 } });
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    expect((grant.payload as { lease: { ttlDeadline: number } }).lease.ttlDeadline).toBe(1_040);

    let expectedDeadline = 1_040;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      harness.clock.advance(10);
      expectedDeadline = harness.clock.now() + 40;
      await expect(holder.request("lease.renew", { leaseId })).resolves.toMatchObject({
        ok: true,
        payload: { id: leaseId, ttlDeadline: expectedDeadline, ttlMs: 40 },
      });
    }
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);

    harness.clock.advance(40);
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId, reason: "expired" },
      push: "lease-lost",
    });
    await holder.close();
  });

  it("no longer answers lease.heartbeat at all", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("lease.heartbeat", { nonce: 1 })).resolves.toMatchObject({
      error: { code: "UNKNOWN_REQUEST" },
      ok: false,
    });
    await client.close();
  });

  it("answers worker.list with this daemon's instance id and the version its hello reports", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
    const client = await createClient(harness.socketPath);
    const greeting = await client.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    expect(greeting).toMatchObject({ ok: true, payload: { version: "test" } });

    await expect(client.request("worker.list", {})).resolves.toMatchObject({
      ok: true,
      payload: { workers: [{ id: "instance-test", version: "test" }] },
    });
    await client.close();
  });

  it("re-reads worker.list's kept catalog once this daemon's bus reports a component installed", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
    const client = await createClient(harness.socketPath);
    await hello(client);
    const catalogReads = vi.spyOn(harness.driver, "listCatalog");

    await client.request("worker.list", {});
    await client.request("worker.list", {});
    expect(catalogReads).toHaveBeenCalledTimes(1);

    harness.eventBus.emit(
      "component.installed",
      {
        alreadyPresent: false,
        componentId: "27.0",
        durationMs: 1,
        platform: "ios",
        version: "27.0",
      },
      "test",
    );
    await client.request("worker.list", {});

    expect(catalogReads).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it("disposes the worker's dispatcher, ending its bus subscriptions, when the daemon stops", async () => {
    const live = new Map<string, number>();
    const subscribe = EventBus.prototype.subscribe;
    const spy = vi.spyOn(EventBus.prototype, "subscribe").mockImplementation(function (
      this: EventBus,
      event,
      handler,
    ) {
      const unsubscribe = subscribe.call(this, event, handler);
      live.set(event, (live.get(event) ?? 0) + 1);
      let ended = false;
      return () => {
        if (!ended) live.set(event, (live.get(event) ?? 0) - 1);
        ended = true;
        unsubscribe();
      };
    });
    try {
      const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
      expect(live.get("component.installed")).toBeGreaterThan(0);

      await harness.daemon.stop("test");

      expect(live.get("component.installed")).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers worker.install-component and worker.update with UNSUPPORTED_IN_WORKER_MODE: a worker has no workers to install on or update", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("worker.install-component", {
        platform: "android",
        version: "35",
        workers: "all",
      }),
    ).resolves.toMatchObject({
      error: {
        code: "UNSUPPORTED_IN_WORKER_MODE",
        details: { operation: "worker.install-component" },
      },
      ok: false,
    });
    await expect(client.request("worker.update", { workerId: "wrk_1" })).resolves.toMatchObject({
      error: { code: "UNSUPPORTED_IN_WORKER_MODE", details: { operation: "worker.update" } },
      ok: false,
    });
    await client.close();
  });

  it("keeps a lease across a daemon restart and restores its timer from the persisted deadline", async () => {
    const leaseOverrides = { defaultTtlMs: 40 };
    const first = await createHarness({ lease: leaseOverrides });
    const holder = await createClient(first.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = (grant.payload as { device: { id: string } }).device.id;

    first.clock.advance(10);
    await expect(holder.request("lease.renew", { leaseId })).resolves.toMatchObject({
      ok: true,
      payload: { ttlDeadline: 1_050 },
    });

    const second = await createHarness({
      clock: new FakeClock(1_010),
      driver: first.driver,
      lease: leaseOverrides,
      state: first.state,
    });
    await second.engine.convergeRunningCapacity();

    expect(second.registry.snapshot.leases).toMatchObject([{ id: leaseId, ttlDeadline: 1_050 }]);
    expect(second.registry.snapshot.devices).toMatchObject([{ id: deviceId, state: "leased" }]);

    second.clock.advance(30);
    await expect.poll(() => second.registry.snapshot.leases).toHaveLength(1);
    second.clock.advance(10);
    await expect.poll(() => second.registry.snapshot.leases).toEqual([]);
    await expect.poll(() => second.registry.snapshot.devices[0]?.state).toBe("deleted");
    await holder.close();
  });

  it("expires a lease whose deadline passed while no daemon was running, as soon as one is", async () => {
    const leaseOverrides = { defaultTtlMs: 40 };
    const first = await createHarness({ lease: leaseOverrides });
    const holder = await createClient(first.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const deviceId = (grant.payload as { device: { id: string } }).device.id;
    await holder.close();

    const second = await createHarness({
      clock: new FakeClock(2_000),
      driver: first.driver,
      lease: leaseOverrides,
      state: first.state,
    });
    await second.engine.convergeRunningCapacity();

    await expect.poll(() => second.registry.snapshot.leases).toEqual([]);
    await expect
      .poll(() => second.registry.snapshot.devices)
      .toMatchObject([{ id: deviceId, state: "deleted" }]);
  });

  it("surfaces the stored lastRenewedAt and ttlMs in status and list --leases", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 40 } });
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    expect((grant.payload as { lease: { lastRenewedAt: number } }).lease.lastRenewedAt).toBe(1_000);

    harness.clock.advance(10);
    await holder.request("lease.renew", { leaseId });

    await expect(holder.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: { leases: [{ id: leaseId, lastRenewedAt: 1_010, ttlMs: 40 }] },
    });
    await expect(holder.request("list.get", { kind: "leases" })).resolves.toMatchObject({
      ok: true,
      payload: [{ id: leaseId, lastRenewedAt: 1_010, ttlMs: 40 }],
    });
    await holder.close();
  });
});

describe("DaemonServer lease request mode", () => {
  it("grants a slim request on a runtime the driver can slim with mode slim", async () => {
    const harness = await createHarness({ slimmableOsVersions: ["26.5"] });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      mode: "slim",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(grant.ok).toBe(true);
    expect((grant.payload as { device: { mode: string } }).device.mode).toBe("slim");
    await client.close();
  });

  it.each([
    ["full", { full: true }],
    ["a mode other than slim or full", { mode: "fast" }],
    ["the lease mode ADR 0004 retired", { mode: "held" }],
  ])("answers a lease.request carrying %s with BAD_REQUEST", async (_label, extra) => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
      ...extra,
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "BAD_REQUEST" });
    await client.close();
  });
});
