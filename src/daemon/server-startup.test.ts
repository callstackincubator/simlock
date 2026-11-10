import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeClock,
  JsonLinesLogger,
  MemoryLogSink,
  FakeNpmCli,
  FakeUpdaterLauncher,
  NodeFilesystem,
  NodeIpcTransport,
} from "../ports/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import { DaemonEndpointHost, type ConnectionHost } from "./connection-host.js";
import { GatewayRelay, type GatewayWorkerClient, type WorkerDirectory } from "../gateway/index.js";
import { linkPair } from "../link/testing.js";
import { connectSimlockClient } from "../simlock-client/client.js";
import { SimlockWire } from "../simlock-client/wire.js";
import type { RelayTargets } from "./relay.js";
import * as relaySupport from "./test-relay-support.js";
import {
  createClient,
  createClientRetrying,
  createHarness,
  deferred,
  driveConnection,
  hello,
  helloAs,
  leaseIdOf,
  stopTestDaemons,
  temporaryDirectories,
} from "./test-server.js";

afterEach(stopTestDaemons);

describe("DaemonServer startup readiness", () => {
  it("claims a connectable socket before startup convergence finishes", async () => {
    const converge = deferred<void>();
    const harness = await createHarness({ converge: () => converge.promise, start: false });
    const startPromise = harness.daemon.start();

    const client = await createClientRetrying(harness.socketPath);
    await hello(client);
    await client.close();

    converge.resolve();
    await startPromise;
  });

  it("answers hello and status.get with health starting during convergence, then running once converged", async () => {
    const converge = deferred<void>();
    const harness = await createHarness({ converge: () => converge.promise, start: false });
    const startPromise = harness.daemon.start();

    const client = await createClientRetrying(harness.socketPath);
    await hello(client);
    const during = await client.request("status.get", {});
    expect(during).toMatchObject({
      ok: true,
      payload: { daemon: { health: "starting", mode: "worker" } },
    });
    expect(Object.keys((during as { payload: object }).payload).sort()).toEqual([
      "daemon",
      "history",
      "host",
    ]);

    converge.resolve();
    await startPromise;

    await expect(client.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: { daemon: { health: "running", mode: "worker" } },
    });
    await client.close();
  });

  it("answers daemon.update with query while starting, and only reports running once a rolled back update's failure is readable", async () => {
    const converge = deferred<void>();
    const resultFileGate = deferred<void>();
    const harness = await createHarness({
      converge: () => converge.promise,
      start: false,
      update: {
        npm: new FakeNpmCli(),
        launcher: new FakeUpdaterLauncher(),
        version: "0.3.0",
        resultFile: JSON.stringify({
          from: "0.3.0",
          to: "0.4.0",
          stage: "restarting",
          message: "0.4.0 did not start: health failed",
          at: 500,
          rolledBack: true,
        }),
        resultFileGate: resultFileGate.promise,
      },
    });
    const startPromise = harness.daemon.start();
    const client = await createClientRetrying(harness.socketPath);
    await hello(client);

    // why: a query that parks on readiness must fail the assertion below, not time the test out.
    const queried = async () => {
      const parked = new Promise<"parked">((resolve) => setTimeout(() => resolve("parked"), 250));
      const answer = await Promise.race([client.request("daemon.update", { query: true }), parked]);
      return answer === "parked" ? answer : answer.payload;
    };
    expect(await queried(), "while converging").toMatchObject({
      health: "starting",
      lastUpdateFailure: null,
    });

    // why: a gateway's events.subscribe parks until the daemon is ready, so it must still get the rollback's event.
    const subscribed = client.request("events.subscribe", {});
    await expect(client.request("status.get", {})).resolves.toMatchObject({ ok: true });

    converge.resolve();
    expect(await queried(), "converged, result file not read yet").toMatchObject({
      health: "starting",
    });

    resultFileGate.resolve();
    await startPromise;
    await expect(subscribed).resolves.toMatchObject({ ok: true });
    await expect
      .poll(
        () =>
          client
            .frames()
            .some(
              (frame) =>
                frame.push === "event" &&
                JSON.stringify(frame.payload).includes('"daemon.update-failed"'),
            ),
        { message: "the parked subscriber receives daemon.update-failed" },
      )
      .toBe(true);
    expect(await queried(), "started").toMatchObject({
      health: "running",
      lastUpdateFailure: { stage: "restarting", from: "0.3.0", to: "0.4.0" },
    });
    await client.close();
  });

  it("parks a request type other than hello/status.get until convergence completes, then serves it", async () => {
    const converge = deferred<void>();
    const harness = await createHarness({ converge: () => converge.promise, start: false });
    const startPromise = harness.daemon.start();

    const client = await createClientRetrying(harness.socketPath);
    await hello(client);

    const parked = client.request("list.get", { kind: "devices" });
    await expect(client.request("status.get", {})).resolves.toMatchObject({ ok: true });

    converge.resolve();
    await startPromise;

    await expect(parked).resolves.toMatchObject({ ok: true, payload: [] });
    await client.close();
  });

  it("rejects startup, and does not hang a parked request, when convergence fails", async () => {
    const converge = deferred<void>();
    const harness = await createHarness({ converge: () => converge.promise, start: false });
    const startPromise = harness.daemon.start();

    const client = await createClientRetrying(harness.socketPath);
    await hello(client);
    const parked = client.request("list.get", { kind: "devices" });
    await expect(client.request("status.get", {})).resolves.toMatchObject({ ok: true });

    converge.reject(new Error("boom"));

    await expect(startPromise).rejects.toThrow("boom");
    await expect(parked).resolves.toMatchObject({
      error: { code: "DAEMON_STARTUP_FAILED" },
      ok: false,
    });
  });

  it("emits daemon.stopping and no daemon.started when a stop completes during convergence", async () => {
    const converge = deferred<void>();
    const harness = await createHarness({ converge: () => converge.promise, start: false });
    const emitted: string[] = [];
    harness.eventBus.subscribeAll((event) => {
      if (event.event === "daemon.started" || event.event === "daemon.stopping") {
        emitted.push(event.event);
      }
    });
    const startPromise = harness.daemon.start();

    await harness.daemon.stop("requested");
    converge.resolve();
    await startPromise;

    expect(emitted).toEqual(["daemon.stopping"]);
  });

  it("refuses a cleanup.run parked on startup with DAEMON_STOPPING once a stop lands mid-converge, and shuts down no device", async () => {
    const converge = deferred<void>();
    const harness = await createHarness({ converge: () => converge.promise, start: false });
    const spec = {
      physical: false,
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    const provisioned = await harness.driver.provision(spec);
    const device = await harness.registry.registerDevice({
      backend: "local",
      driverData: provisioned.driverData,
      driverDeviceId: provisioned.deviceId,
      provisionDuration: 0,
      spec,
    });
    await harness.registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      requesterId: "agent-1",
      ownerId: "agent-1",
      ttlMs: 60_000,
      ttlDeadline: 61_000,
    });
    await harness.registry.beginRelease(lease.id);
    await harness.registry.transitionDevice(device.id, "ready", {
      event: "device.reclaimed",
      payload: { deviceId: device.id, duration: 0, strategy: "erase" },
    });
    harness.clock.advance(harness.config.idle.shutdownAfterMs + 1);
    const startPromise = harness.daemon.start();

    const parked = harness.daemon.dispatch(
      "cleanup.run",
      { rule: "idle-shutdown" },
      {
        principal: "operator",
        role: "admin",
        via: "token",
        manageEventSubscription: () => undefined,
      },
    );
    await harness.daemon.stop("requested");
    converge.resolve();
    await startPromise;

    await expect(parked).rejects.toMatchObject({ code: "DAEMON_STOPPING" });
    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toEqual([]);
    expect(harness.registry.snapshot.devices.find((entry) => entry.id === device.id)?.state).toBe(
      "ready",
    );
  });

  it("has lease-lost subscriptions wired before a lease.request parked on convergence proceeds", async () => {
    const converge = deferred<void>();
    const harness = await createHarness({ converge: () => converge.promise, start: false });
    const startPromise = harness.daemon.start();

    const holder = await createClientRetrying(harness.socketPath);
    await hello(holder);
    const parkedGrant = holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    converge.resolve();
    await startPromise;
    const grant = await parkedGrant;
    expect(grant.ok).toBe(true);
    const leaseId = leaseIdOf(grant);

    const evictor = await createClientRetrying(harness.socketPath);
    await hello(evictor);
    await evictor.request("lease.release", { leaseId });

    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId },
    });
  });
});

describe("DaemonServer stored lease requests", () => {
  const iPhone = {
    model: "iPhone 16",
    osVersion: "26.5",
    platform: "ios",
  } as const;

  async function queueBehindHolder(harness: Awaited<ReturnType<typeof createHarness>>) {
    const holder = await createClient(harness.socketPath);
    const waiter = await createClient(harness.socketPath);
    await Promise.all([hello(holder), hello(waiter)]);
    await holder.request("lease.request", { ...iPhone, requesterId: "holder" });
    void waiter.request("lease.request", {
      ...iPhone,
      idempotencyKey: "key-1",
      requesterId: "waiter",
    });
    await expect
      .poll(() => harness.eventBus.replay().some((event) => event.event === "lease.queued"))
      .toBe(true);
    return { holder, waiter };
  }

  it("ends only the caller's wait on a disconnect, writing no result for the request", async () => {
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      logger: new JsonLinesLogger({ clock: new FakeClock(1_000), level: "debug", sink }),
    });
    const { waiter } = await queueBehindHolder(harness);

    await waiter.close();
    await expect
      .poll(() => sink.records.some((record) => record.message === "Connection closed"))
      .toBe(true);

    expect(
      harness.registry.leaseRequests().find((record) => record.requesterId === "waiter"),
    ).toMatchObject({ state: "open" });
    expect(harness.engine.queueDepth).toBe(1);
  });

  it("gives a client that reconnects after a disconnect its result when it repeats the request", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 40 } });
    const { waiter } = await queueBehindHolder(harness);
    await waiter.close();

    const reconnected = await createClient(harness.socketPath);
    await hello(reconnected);
    const repeat = reconnected.request("lease.request", {
      ...iPhone,
      idempotencyKey: "key-1",
      requesterId: "waiter",
    });
    harness.clock.advance(40);

    await expect(repeat).resolves.toMatchObject({
      ok: true,
      payload: { lease: { requesterId: "waiter" } },
    });
    expect(harness.registry.snapshot.leases.map((lease) => lease.requesterId)).toEqual(["waiter"]);
  });

  it("answers IDEMPOTENCY_CONFLICT on the wire when a key is reused for a different device", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);
    await client.request("lease.request", { ...iPhone, idempotencyKey: "key-1" });

    await expect(
      client.request("lease.request", { ...iPhone, idempotencyKey: "key-1", model: "iPhone 17" }),
    ).resolves.toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" }, ok: false });
  });

  it("answers FORBIDDEN on the wire to a repeat from a different principal", async () => {
    const harness = await createHarness();
    const owner = await createClient(harness.socketPath);
    const other = await createClient(harness.socketPath);
    await helloAs(owner, "alice");
    await helloAs(other, "mallory");
    await owner.request("lease.request", {
      ...iPhone,
      idempotencyKey: "key-1",
      requesterId: "agent",
    });

    await expect(
      other.request("lease.request", { ...iPhone, idempotencyKey: "key-1", requesterId: "agent" }),
    ).resolves.toMatchObject({ error: { code: "FORBIDDEN" }, ok: false });
  });

  it("replays a stored failure with the code it failed with", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    const client = await createClient(harness.socketPath);
    await Promise.all([hello(holder), hello(client)]);
    const held = (await holder.request("lease.request", { ...iPhone, requesterId: "holder" })) as {
      readonly payload: { readonly lease: { readonly id: string } };
    };
    const noWait = { ...iPhone, idempotencyKey: "key-1", noWait: true, requesterId: "agent" };
    await expect(client.request("lease.request", noWait)).resolves.toMatchObject({
      error: { code: "NO_CAPACITY" },
    });

    await holder.request("lease.release", { leaseId: held.payload.lease.id });
    await expect
      .poll(() => harness.registry.snapshot.devices.map((device) => device.state))
      .toEqual(["deleted"]);

    await expect(client.request("lease.request", noWait)).resolves.toMatchObject({
      error: { code: "NO_CAPACITY" },
      ok: false,
    });
    expect(harness.registry.snapshot.leases).toEqual([]);
  });
});

describe("DaemonServer relays during startup", () => {
  async function startParked(relayTargets: RelayTargets, host?: ConnectionHost) {
    const converge = deferred<void>();
    const harness = await createHarness({
      converge: () => converge.promise,
      ...(host === undefined ? {} : { host }),
      relayTargets,
      start: false,
    });
    const startPromise = harness.daemon.start();
    startPromise.catch(() => undefined);
    const pair = linkPair();
    harness.daemon.acceptUplink(pair.worker);
    return { converge, harness, pair, startPromise };
  }

  async function wireOf(pair: ReturnType<typeof linkPair>) {
    const wire = new SimlockWire(pair.gateway);
    await wire.hello({ principal: "gw:test" });
    await wire.call("status.get", {});
    return { link: pair.gateway, wire };
  }

  async function gatewayRelayOf(pair: ReturnType<typeof linkPair>) {
    const client = (await connectSimlockClient(
      { connection: pair.gateway, principal: "gw:test" },
      true,
    )) as GatewayWorkerClient;
    const directory: WorkerDirectory = {
      target: (workerId) =>
        workerId === "wrk_a"
          ? { client: () => client, reachable: true, refresh: async () => undefined, workerId }
          : undefined,
    };
    return new GatewayRelay({ directory });
  }

  it("a relay sent while the worker is still starting holds its channel, and its 8 MiB upload, twice the 4 MiB window, only finishes once startup converges and arrives in full", async () => {
    let received = "";
    let length = 0;
    let calls = 0;
    const { converge, pair, startPromise } = await startParked({
      echo: async (request) => {
        calls += 1;
        const parts = await relaySupport.readParts(request.body);
        received = relaySupport.digestOf(parts);
        length = parts.reduce((total, part) => total + part.length, 0);
        return new Response("ok");
      },
    });
    const uplink = await wireOf(pair);

    const relay = await relaySupport.openRelay(
      uplink,
      relaySupport.relayInput({ hasBody: true, method: "PUT" }),
      { keepOpen: true },
    );
    // why: 8 MiB is twice the 4 MiB window, so a sender can only finish once the worker reads; a channel accepted but parked would let it write at most the window.
    const upload = relaySupport.patternBytes(8 * relaySupport.MIB, 5);
    const writer = relay.channel.writable.getWriter();
    let written = 0;
    const writing = (async () => {
      for (let offset = 0; offset < upload.length; offset += relaySupport.MIB) {
        await writer.write(upload.subarray(offset, offset + relaySupport.MIB));
        written += relaySupport.MIB;
      }
      await writer.close();
    })();
    await relaySupport.sleep(200);
    const callsWhileStarting = calls;
    const writtenWhileStarting = written;
    converge.resolve();
    await startPromise;
    const outcome = await relaySupport.settleWithin(relay.result);
    await writing;

    expect(callsWhileStarting).toBe(0);
    // why: bytes written while startup is parked prove the channel was accepted; none written would also pass "< 8 MiB" if nothing were accepted.
    expect(writtenWhileStarting).toBeGreaterThan(0);
    expect(writtenWhileStarting).toBeLessThan(upload.length);
    expect(outcome).toEqual({ state: "fulfilled", value: {} });
    expect(length).toBe(upload.length);
    expect(received).toBe(relaySupport.digestOf([upload]));
  });

  it("a relay whose 8 MiB upload stays parked by worker startup for 60 s fails INTERNAL on the gateway with the 60 s message", async () => {
    const { converge, pair, startPromise } = await startParked({
      echo: () => Promise.resolve(new Response("ok")),
    });
    const relay = await gatewayRelayOf(pair);
    const request = new Request("http://gateway.test:4321/agent-device/rpc", {
      body: relaySupport.patternStream(8 * relaySupport.MIB, 2),
      duplex: "half",
      method: "PUT",
    } as RequestInit);

    const pending = relaySupport.settleWithin(
      relay.relay("wrk_a", { request, target: "echo", tenant: "gw.g1.alice" }),
      10_000,
    );
    await relaySupport.sleep(300);
    pair.clock.advance(60_000);
    const outcome = await pending;
    converge.resolve();
    await startPromise;

    expect(outcome).toEqual({
      code: "INTERNAL",
      message: "worker wrk_a did not read the relayed request body for 60 s",
      state: "rejected",
    });
  });

  it("a parked relay whose channel failed while it waited answers { cancelled: true } without running its target", async () => {
    let calls = 0;
    const { converge, pair, startPromise } = await startParked({
      echo: () => {
        calls += 1;
        return Promise.resolve(new Response("ok"));
      },
    });
    const uplink = await wireOf(pair);
    const relay = await relaySupport.openRelay(uplink, relaySupport.relayInput(), {
      keepOpen: true,
    });
    await relaySupport.sleep(100);

    relay.channel.abort("caller left while the worker started");
    await relaySupport.sleep(100);
    converge.resolve();
    await startPromise;
    const outcome = await relaySupport.settleWithin(relay.result);

    expect(outcome).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(calls).toBe(0);
  });

  it.each(["convergence", "socket claim"] as const)(
    "a parked relay whose startup fails at its %s answers DAEMON_STARTUP_FAILED and leaves its channel errored aborted",
    async (failing) => {
      const claim = deferred<void>();
      const host: ConnectionHost = {
        endpoint: "/claim-refused/daemon.sock",
        start: () => claim.promise,
        stop: async () => undefined,
      };
      const { converge, pair, startPromise } = await startParked(
        { echo: () => Promise.resolve(new Response("ok")) },
        failing === "socket claim" ? host : undefined,
      );
      const uplink = await wireOf(pair);
      const relay = await relaySupport.openRelay(uplink, relaySupport.relayInput());
      await relaySupport.sleep(100);

      if (failing === "socket claim") claim.reject(new Error("listen EACCES"));
      else converge.reject(new Error("boom"));
      await startPromise.catch(() => undefined);
      const outcome = await relaySupport.settleWithin(relay.result);
      const read = await relay.readError();

      expect(outcome).toMatchObject({ code: "DAEMON_STARTUP_FAILED", state: "rejected" });
      expect(read).toEqual({ ended: false, reason: "aborted" });
    },
  );
});

describe("DaemonServer failed start", () => {
  it("a daemon.stop accepted while the admin.token write is pending is the one teardown when that write then fails, and the start rejects with the write's error without waiting for a stop whose auxiliary waits for the start", async () => {
    const persisting = deferred<void>();
    const startSettled = deferred<void>();
    let stopBegun = false;
    let disposals = 0;
    let removals = 0;
    const harness = await createHarness({
      adminSecret: {
        persist: () => persisting.promise,
        remove: async () => {
          removals += 1;
        },
      },
      beginStop: () => {
        stopBegun = true;
      },
      dispose: () => {
        disposals += 1;
      },
      // why: as `main.ts`'s does: the HTTP frontend's start is settled only once `start()` settles when the claim's hooks never ran.
      stopAuxiliary: () => startSettled.promise,
      host: {
        endpoint: "memory://failed-start",
        start: async () => undefined,
        stop: async () => undefined,
      },
      start: false,
    });
    const events: string[] = [];
    harness.eventBus.subscribeAll((event) => {
      if (event.event.startsWith("daemon.")) events.push(event.event);
    });
    const startPromise = harness.daemon.start().finally(() => startSettled.resolve());
    startPromise.catch(() => undefined);
    const pair = linkPair();
    harness.daemon.acceptUplink(pair.worker);
    const gateway = driveConnection(pair.gateway);
    await gateway.request("hello", {
      clientVersion: "gateway",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      principal: "gw:test",
    });

    await expect(gateway.request("daemon.stop", {})).resolves.toMatchObject({ ok: true });
    await expect.poll(() => stopBegun).toBe(true);
    persisting.reject(new Error("disk is read-only"));
    const outcome = await Promise.race([
      startPromise.then(
        () => "resolved",
        (error: unknown) => (error as Error).message,
      ),
      relaySupport.sleep(1_000).then(() => "still pending after 1 s"),
    ]);
    // why: unwinds a start that waits for the stop, so a failing run ends instead of hanging the stop below.
    startSettled.resolve();
    await harness.daemon.stop();

    expect({ outcome, disposals, removals, events }).toEqual({
      outcome: "disk is read-only",
      disposals: 1,
      removals: 1,
      events: ["daemon.stopping"],
    });
  });
});

describe("DaemonServer failed start release", () => {
  it("closes a connection opened after the connections were closed, while the endpoint release still holds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-daemon-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "daemon.sock");
    const real = new DaemonEndpointHost({
      connector: new NodeIpcTransport(),
      endpoint: socketPath,
      filesystem: new NodeFilesystem(),
      listenerFactory: new NodeIpcTransport(),
    });
    const releasing = deferred<void>();
    let releaseBegun = false;
    const harness = await createHarness({
      adminSecret: {
        persist: async () => {
          throw new Error("disk is read-only");
        },
        remove: async () => undefined,
      },
      host: {
        endpoint: socketPath,
        start: (accept) => real.start(accept),
        stop: async () => {
          releaseBegun = true;
          await releasing.promise;
          await real.stop();
        },
      },
      socketPath,
      start: false,
    });
    const starting = harness.daemon.start().then(
      () => "started",
      (error: unknown) => (error as Error).message,
    );
    await expect.poll(() => releaseBegun).toBe(true);

    const late = await createClient(socketPath);
    const closed = new Promise<"closed">((resolve) =>
      late.socket.once("close", () => resolve("closed")),
    );
    const outcome = await Promise.race([closed, relaySupport.sleep(1_000).then(() => "hung")]);
    // why: a leaked connection would hang the release, so the assertion comes first and the cleanup forces the socket down.
    try {
      expect(outcome).toBe("closed");
    } finally {
      late.socket.destroy();
      releasing.resolve();
    }
    expect(await starting).toBe("disk is read-only");
  });
});
