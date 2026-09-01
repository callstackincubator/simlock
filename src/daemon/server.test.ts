import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  type Config,
  CleanupReaper,
  FakeDriver,
  InsufficientDiskSpaceError,
  LeaseEngine,
  Registry,
  RuntimeMissingError,
} from "../core/index.js";
import { AndroidLicenseNotAcceptedError } from "../drivers/android/index.js";
import {
  FakeClock,
  FakeSystemStats,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  NodeFilesystem,
  NodeIpcTransport,
  type Logger,
} from "../ports/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import { DaemonEndpointHost } from "./connection-host.js";
import { DaemonServer } from "./server.js";

const gibibyte = 1024 ** 3;

interface Client {
  readonly socket: Socket;
  frames(): readonly ServerFrame[];
  nextFrame(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
  request(type: string, payload: unknown, id?: string): Promise<ServerFrame>;
  send(contents: string): void;
  close(): Promise<void>;
}

interface ServerFrame {
  readonly error?: { readonly code: string; readonly message: string };
  readonly id?: string | null;
  readonly ok?: boolean;
  readonly payload?: unknown;
  readonly push?:
    | "device-recovered"
    | "device-unhealthy"
    | "event"
    | "lease-lost"
    | "lease.heartbeat"
    | "progress";
}

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("DaemonServer", () => {
  it("releases a held lease when its client connection closes", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);

    await holder.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    expect(grant.ok).toBe(true);
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    await holder.close();

    await expect.poll(() => harness.registry.snapshot.leases).toHaveLength(0);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    const observer = await createClient(harness.socketPath);
    await hello(observer);
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      payload: {
        capacity: { global: { warm: 1 }, ios: { warm: 1 } },
        devices: [{ state: "ready" }],
      },
    });
    await observer.close();
  });

  it("requires a compatible hello before serving requests", async () => {
    const harness = await createHarness();
    const missingHello = await createClient(harness.socketPath);

    await expect(missingHello.request("status.get", {})).resolves.toMatchObject({
      error: { code: "HANDSHAKE_REQUIRED" },
      ok: false,
    });
    await missingHello.close();

    const wrongVersion = await createClient(harness.socketPath);
    await expect(
      wrongVersion.request("hello", {
        clientVersion: "test",
        protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
      }),
    ).resolves.toMatchObject({
      error: { code: "PROTOCOL_VERSION_MISMATCH" },
      ok: false,
    });
  });

  // Protocol 2 added the `heartbeat` capability and the sliding held-lease TTL that
  // depends on it, and shipped without back-compat shims. Rejecting v1 is therefore a
  // deliberate product decision, not just arithmetic on the current constant.
  it("rejects a protocol v1 client outright rather than serving it without heartbeats", async () => {
    const harness = await createHarness();
    const legacy = await createClient(harness.socketPath);

    await expect(
      legacy.request("hello", { clientVersion: "test", protocolVersion: 1 }),
    ).resolves.toMatchObject({
      error: { code: "PROTOCOL_VERSION_MISMATCH" },
      ok: false,
    });
  });

  it("releases a holder and grants the queued client when the holder disconnects", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    const waiter = await createClient(harness.socketPath);
    await hello(holder);
    await hello(waiter);
    await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    const queuedGrant = waiter.request("lease.request", {
      mode: "held",
      requesterId: "waiter",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    await expect
      .poll(() => harness.eventBus.replay().some((event) => event.event === "lease.queued"))
      .toBe(true);

    await holder.close();

    await expect(queuedGrant).resolves.toMatchObject({ ok: true });
    expect(harness.registry.snapshot.leases.map((lease) => lease.requesterId)).toEqual(["waiter"]);
  });

  it("keeps lease progress on its requesting connection", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    const waiter = await createClient(harness.socketPath);
    await Promise.all([hello(holder), hello(waiter)]);
    await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    const queuedGrant = waiter.request("lease.request", {
      mode: "held",
      requesterId: "waiter",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    await expect(waiter.nextFrame((frame) => frame.push === "progress")).resolves.toMatchObject({
      payload: { queuePosition: 1, stage: "queued" },
      push: "progress",
    });

    expect(
      holder
        .frames()
        .filter(
          (frame) =>
            frame.push === "progress" &&
            (frame.payload as { readonly stage?: unknown } | undefined)?.stage === "queued",
        ),
    ).toEqual([]);
    await holder.close();
    await expect(queuedGrant).resolves.toMatchObject({ ok: true });
    await waiter.close();
  });

  it("multiplexes interleaved request ids on concurrent connections", async () => {
    const harness = await createHarness();
    const first = await createClient(harness.socketPath);
    const second = await createClient(harness.socketPath);
    await Promise.all([hello(first), hello(second)]);

    const [firstResponse, firstConfig, secondResponse] = await Promise.all([
      first.request("status.get", {}, "first-status"),
      first.request("config.get", {}, "first-config"),
      second.request("config.get", {}, "second-config"),
    ]);

    expect(firstResponse).toMatchObject({ id: "first-status", ok: true });
    expect(firstConfig).toMatchObject({ id: "first-config", ok: true });
    expect(secondResponse).toMatchObject({ id: "second-config", ok: true });
  });

  it("pushes driver-estimated progress while a slow lease acquisition is pending", async () => {
    const harness = await createHarness({
      estimateMs: { boot: 30, provision: 60 },
      latencyMs: { makeReady: 10, provision: 10 },
    });
    const client = await createClient(harness.socketPath);
    await hello(client);
    let requestSettled = false;
    const grant = client
      .request("lease.request", {
        mode: "detached",
        requesterId: "agent-1",
        request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      })
      .then((response) => {
        requestSettled = true;
        return response;
      });

    await expect(
      client.nextFrame((frame) => frame.push === "progress" && frame.payload !== undefined),
    ).resolves.toMatchObject({
      payload: { etaMs: 60, stage: "provisioning" },
      push: "progress",
    });
    expect(requestSettled).toBe(false);
    harness.clock.advance(10);
    await flush();
    harness.clock.advance(10);

    await expect(grant).resolves.toMatchObject({ ok: true });
  });

  it("buffers torn frames and recovers from a garbage line", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);

    client.send('{"id":"hello","type":"hel');
    client.send(
      `lo","payload":{"clientVersion":"test","protocolVersion":${DAEMON_PROTOCOL_VERSION}}}\n`,
    );
    await expect(client.nextFrame((frame) => frame.id === "hello")).resolves.toMatchObject({
      ok: true,
    });

    client.send("not json\n");
    await expect(client.nextFrame((frame) => frame.id === null)).resolves.toMatchObject({
      error: { code: "BAD_FRAME" },
      ok: false,
    });
    await expect(client.request("status.get", {}, "after-garbage")).resolves.toMatchObject({
      id: "after-garbage",
      ok: true,
    });
  });

  it("maps status, cleanup, events, config, and detached lease commands to daemon-owned core state", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: {
        capacity: {
          global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
          ios: {
            limit: 1,
            maxRunning: 1,
            overLimit: false,
            reserved: 0,
            running: 0,
            used: 0,
            warm: 0,
          },
        },
      },
    });
    await expect(client.request("list.get", {})).resolves.toMatchObject({ ok: true });
    await expect(client.request("config.get", {})).resolves.toMatchObject({ ok: true });
    await expect(client.request("cleanup.run", { dryRun: true })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.request("events.replay", { sinceTs: 0 })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.request("events.subscribe", {})).resolves.toMatchObject({ ok: true });
    harness.eventBus.emit(
      "disk.pressure-detected",
      { freeBytes: 1, threshold: testConfig().diskPressure.freeBytesThreshold },
      "test",
    );
    await expect(client.nextFrame((frame) => frame.push === "event")).resolves.toMatchObject({
      push: "event",
    });
    await expect(client.request("events.unsubscribe", {})).resolves.toMatchObject({ ok: true });

    const grant = await client.request("lease.request", {
      mode: "detached",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = (grant.payload as { readonly lease: { readonly id: string } }).lease.id;
    await expect(client.request("lease.renew", { leaseId, ttlMs: 120_000 })).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(client.request("lease.release", { leaseId })).resolves.toMatchObject({ ok: true });
    expect(harness.registry.snapshot.leases).toEqual([]);
  });

  it("serves the device catalog, omitting platforms with no registered driver", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("catalog.get", {})).resolves.toMatchObject({
      ok: true,
      payload: {
        platforms: [{ defaultRuntime: "26.5", models: [], platform: "ios", runtimes: ["26.5"] }],
      },
    });
    await expect(client.request("catalog.get", { platform: "ios" })).resolves.toMatchObject({
      ok: true,
      payload: { platforms: [{ platform: "ios" }] },
    });
    await expect(client.request("catalog.get", { platform: "android" })).resolves.toMatchObject({
      ok: true,
      payload: { platforms: [] },
    });
    await expect(client.request("catalog.get", { platform: "foo" })).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
      ok: false,
    });
  });

  it("recovers a stale socket file and refuses a second live daemon before running any device work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-stale-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "daemon.sock");
    await new NodeFilesystem().writeFileAtomic(socketPath, "stale");
    const first = await createHarness({ socketPath });
    let convergeCalls = 0;
    const second = await createHarness({
      converge: () => {
        convergeCalls += 1;
        return Promise.resolve();
      },
      socketPath,
      start: false,
    });

    await expect(second.daemon.start()).rejects.toMatchObject({
      name: "DaemonAlreadyRunningError",
    });
    // The claim (and its DaemonAlreadyRunningError) happens before convergence:
    // a lost startup race must not run device work at all.
    expect(convergeCalls).toBe(0);
    await second.daemon.stop("failed-start");
    const client = await createClient(socketPath);
    await hello(client);
    await client.close();
    expect(first.daemon.socketPath).toBe(socketPath);
  });

  it("gracefully stops by releasing held leases and persisting the final registry", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);
    await client.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    await expect(client.request("daemon.stop", {})).resolves.toMatchObject({ ok: true });
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);

    expect(harness.registry.snapshot.leases).toEqual([]);
    await expect(harness.stateFilesystem.readFile("/state.json")).resolves.toContain('"leases":[]');
    expect(harness.eventBus.replay().map((event) => event.event)).toContain("daemon.stopping");
  });

  it("pushes a lease-lost notification to the holding connection when its lease's TTL backstop expires", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = harness.registry.snapshot.leases.find(
      (lease) => lease.id === leaseId,
    )?.deviceId;

    harness.clock.advance(60_000);
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { deviceId, leaseId, reason: "expired" },
      push: "lease-lost",
    });
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);

    // The connection no longer believes it holds the expired lease, so closing it
    // (which releases any still-held leases) must not error or hang the daemon.
    await holder.close();
    const observer = await createClient(harness.socketPath);
    await hello(observer);
    await expect(observer.request("status.get", {})).resolves.toMatchObject({ ok: true });
    await observer.close();
  });

  it("pushes a lease-lost notification to the actual holding connection when another connection force-releases its lease", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    const releaser = await createClient(harness.socketPath);
    await Promise.all([hello(holder), hello(releaser)]);
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);

    await expect(releaser.request("lease.release", { leaseId })).resolves.toMatchObject({
      ok: true,
    });
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId, reason: "explicit" },
      push: "lease-lost",
    });

    // Acceptance criterion: the (now stale) holder's own release attempt is rejected
    // by the daemon rather than causing a transport error; the MCP layer maps this
    // local-ownership loss to LEASE_NOT_OWNED without even asking the daemon.
    await expect(holder.request("lease.release", { leaseId })).resolves.toMatchObject({
      error: { code: "UNKNOWN_LEASE" },
      ok: false,
    });
    await holder.close();
    await releaser.close();
  });

  it("does not push a redundant lease-lost notification back to a connection that explicitly released its own lease", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);

    await expect(holder.request("lease.release", { leaseId })).resolves.toMatchObject({
      ok: true,
    });
    // A subsequent request on the same connection lets us assert, by frame order, that
    // no lease-lost push arrived for the release this connection asked for itself.
    await expect(holder.request("status.get", {})).resolves.toMatchObject({ ok: true });
    expect(holder.frames().filter((frame) => frame.push === "lease-lost")).toEqual([]);
    await holder.close();
  });

  it("ignores lease-lost facts for leases with no currently connected holder without breaking the daemon", async () => {
    const harness = await createHarness();
    harness.eventBus.emit("lease.expired", { deviceId: "device-x", leaseId: "lease-x" }, "test");
    harness.eventBus.emit(
      "lease.released",
      { deviceId: "device-y", leaseId: "lease-y", reason: "killed" },
      "test",
    );

    const client = await createClient(harness.socketPath);
    await hello(client);
    await expect(client.request("status.get", {})).resolves.toMatchObject({ ok: true });
    await client.close();
  });

  it("pushes a device-unhealthy notification on device.crash-detected without releasing the lease", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = harness.registry.snapshot.leases.find(
      (lease) => lease.id === leaseId,
    )?.deviceId;

    harness.eventBus.emit(
      "device.crash-detected",
      { deviceId: deviceId as string, leaseId, observed: "stopped", platform: "ios" },
      "test",
    );
    await expect(
      holder.nextFrame((frame) => frame.push === "device-unhealthy"),
    ).resolves.toMatchObject({
      payload: { deviceId, leaseId, reason: "crashed" },
      push: "device-unhealthy",
    });

    // The lease is still held after the notice: closing the connection still
    // releases it, same as any other held lease, proving `heldLeaseIds` was never
    // touched by the push (unlike `#notifyLeaseLost`).
    await holder.close();
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
  });

  it("pushes a device-recovered notification on device.recovered without releasing the lease", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = harness.registry.snapshot.leases.find(
      (lease) => lease.id === leaseId,
    )?.deviceId;

    harness.eventBus.emit(
      "device.recovered",
      { attempts: 2, deviceId: deviceId as string, duration: 30_000, leaseId },
      "test",
    );
    await expect(
      holder.nextFrame((frame) => frame.push === "device-recovered"),
    ).resolves.toMatchObject({
      payload: { attempts: 2, deviceId, leaseId },
      push: "device-recovered",
    });

    await holder.close();
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
  });

  it("ignores device-unhealthy/device-recovered facts for leases with no currently connected holder", async () => {
    const harness = await createHarness();
    harness.eventBus.emit(
      "device.crash-detected",
      { deviceId: "device-x", leaseId: "lease-x", observed: "stopped", platform: "ios" },
      "test",
    );
    harness.eventBus.emit(
      "device.recovered",
      { attempts: 1, deviceId: "device-x", duration: 1_000, leaseId: "lease-x" },
      "test",
    );

    const client = await createClient(harness.socketPath);
    await hello(client);
    await expect(client.request("status.get", {})).resolves.toMatchObject({ ok: true });
    await client.close();
  });

  it("pushes a lease-lost notification carrying reason device-lost when a leased device could not be recovered", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = harness.registry.snapshot.leases.find(
      (lease) => lease.id === leaseId,
    )?.deviceId;

    // Simulates the health monitor giving up on recovery and releasing the lease as
    // `device-lost` -- proves the *existing* `lease.released` subscription already
    // reaches the holder with the reason verbatim, so the failure path needs no new
    // push of its own.
    harness.eventBus.emit(
      "lease.released",
      { deviceId: deviceId as string, leaseId, reason: "device-lost" },
      "test",
    );
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { deviceId, leaseId, reason: "device-lost" },
      push: "lease-lost",
    });
  });
});

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
    await expect(client.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: { health: "starting" },
    });

    converge.resolve();
    await startPromise;

    await expect(client.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: { health: "running" },
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
    // Requests on one connection are dispatched in arrival order without waiting for
    // the previous one to finish (`#read` fires `#dispatchLine` per line without
    // awaiting), so once this status.get round-trips, the parked request's dispatch
    // has already reached (and registered on) the readiness gate.
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
    // Round-tripping status.get first proves this request's dispatch has already
    // started (and so is already tracked in `#parkedDispatches`) before the failure
    // below -- this is not a race the assertion happens to win: `start()`'s catch
    // path explicitly drains `#parkedDispatches` (awaiting each dispatch's own
    // response write) before it closes any socket, so a request tracked at this
    // point is genuinely guaranteed a DAEMON_STARTUP_FAILED response, not merely
    // likely to get one before the connection drops.
    await expect(client.request("status.get", {})).resolves.toMatchObject({ ok: true });

    converge.reject(new Error("boom"));

    await expect(startPromise).rejects.toThrow("boom");
    await expect(parked).resolves.toMatchObject({
      error: { code: "DAEMON_STARTUP_FAILED" },
      ok: false,
    });
  });

  it("has lease-lost subscriptions wired before a lease.request parked on convergence proceeds", async () => {
    // Guards the invariant documented in `start()`: subscriptions are set up only
    // after convergence resolves, and a parked request must never observe a window
    // where its own grant can be silently force-released without a `lease-lost`
    // push. Grants the held lease while convergence is still pending, then --
    // immediately once convergence resolves and the grant comes back -- force
    // releases that very lease from a second connection and asserts the push
    // arrives, proving the subscription was already active by the time the grant
    // reached the client.
    const converge = deferred<void>();
    const harness = await createHarness({ converge: () => converge.promise, start: false });
    const startPromise = harness.daemon.start();

    const holder = await createClientRetrying(harness.socketPath);
    await hello(holder);
    const parkedGrant = holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
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

/**
 * `daemon.start()` claims the socket well before its own promise settles (that promise
 * also waits on convergence), so a test that connects while convergence is deliberately
 * held open must poll for the listener rather than assume it exists synchronously.
 */
async function createClientRetrying(socketPath: string, timeoutMs = 2_000): Promise<Client> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await createClient(socketPath);
    } catch (error: unknown) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe("DaemonServer lease heartbeat", () => {
  it("slides a held lease's deadline past the backstop while its holder keeps ponging, and stops sliding once it stops", async () => {
    const harness = await createHarness({
      lease: { heartbeatIntervalMs: 10, heldTtlBackstopMs: 40 },
    });
    const holder = await createClient(harness.socketPath);
    await hello(holder, { heartbeat: true });
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);
    expect((grant.payload as { lease: { ttlDeadline: number } }).lease.ttlDeadline).toBe(1_040);

    // Pong every tick, well past the original backstop (40ms from grant).
    let expectedDeadline = 1_040;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      harness.clock.advance(10);
      const push = await holder.nextFrame((frame) => frame.push === "lease.heartbeat");
      const nonce = (push.payload as { nonce: number }).nonce;
      expectedDeadline += 10;
      await expect(holder.request("lease.heartbeat", { nonce })).resolves.toMatchObject({
        ok: true,
        payload: { leases: [{ leaseId, ttlDeadline: expectedDeadline }] },
      });
    }
    // 60ms have passed since grant, exceeding the 40ms backstop, yet the lease is alive.
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);

    // Now stop ponging: pure sliding window means no fail-fast, just the existing backstop
    // eventually catching up from the last slid deadline.
    harness.clock.advance(10); // one more push arrives, but is never answered
    await holder.nextFrame((frame) => frame.push === "lease.heartbeat");
    harness.clock.advance(40); // the last slid deadline (expectedDeadline) elapses
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId, reason: "expired" },
      push: "lease-lost",
    });
    await holder.close();
  });

  it("never pings a connection that did not declare the heartbeat capability, and it expires exactly as before", async () => {
    const harness = await createHarness({
      lease: { heartbeatIntervalMs: 10, heldTtlBackstopMs: 40 },
    });
    const holder = await createClient(harness.socketPath);
    await hello(holder); // no capabilities declared
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);

    harness.clock.advance(40);
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    expect(holder.frames().filter((frame) => frame.push === "lease.heartbeat")).toEqual([]);
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId, reason: "expired" },
      push: "lease-lost",
    });
    await holder.close();
  });

  it("rejects a lease.heartbeat request from a connection that never declared the capability", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("lease.heartbeat", { nonce: 1 })).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
      ok: false,
    });
    await client.close();
  });

  it("releases a held lease as orphaned across a daemon restart, even with a heartbeat-slid deadline", async () => {
    const leaseOverrides = { heartbeatIntervalMs: 10, heldTtlBackstopMs: 40 };
    const first = await createHarness({ lease: leaseOverrides });
    const holder = await createClient(first.socketPath);
    await hello(holder, { heartbeat: true });
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = (grant.payload as { device: { id: string } }).device.id;

    first.clock.advance(10);
    const push = await holder.nextFrame((frame) => frame.push === "lease.heartbeat");
    const nonce = (push.payload as { nonce: number }).nonce;
    await expect(holder.request("lease.heartbeat", { nonce })).resolves.toMatchObject({
      ok: true,
      payload: { leases: [{ leaseId, ttlDeadline: 1_050 }] },
    });

    // Simulate an abrupt daemon crash (not a graceful `daemon stop`, which would itself
    // release the held connection's leases): the first daemon's process just disappears,
    // leaving the last persisted registry state — the post-heartbeat slid deadline —
    // on disk. It is intentionally left running here; the afterEach hook tears it down.

    // "Restart": a fresh daemon reloads that persisted registry state. A held lease's
    // liveness is its daemon connection, so it cannot have survived the restart regardless
    // of how recently its deadline was slid — the real startup path (src/daemon/main.ts)
    // releases it as orphaned before any timer would otherwise be restored.
    // The underlying device itself (unlike the daemon process) survives a restart, so the
    // "restarted" harness is wired to the same fake driver instance as the crashed one.
    const second = await createHarness({
      clock: new FakeClock(1_010),
      driver: first.driver,
      lease: leaseOverrides,
      stateFilesystem: first.stateFilesystem,
    });
    await second.engine.convergeRunningCapacity();

    expect(second.registry.snapshot.leases).toEqual([]);
    // The freed device is reclaimed and available to the next requester, not left shutdown.
    expect(second.registry.snapshot.devices).toMatchObject([{ id: deviceId, state: "ready" }]);
    await holder.close();
  });

  it("surfaces a derived lastHeartbeatAt for held leases in status and list --leases", async () => {
    const harness = await createHarness({
      lease: { heartbeatIntervalMs: 10, heldTtlBackstopMs: 40 },
    });
    const holder = await createClient(harness.socketPath);
    await hello(holder, { heartbeat: true });
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = leaseIdOf(grant);

    harness.clock.advance(10);
    const push = await holder.nextFrame((frame) => frame.push === "lease.heartbeat");
    const nonce = (push.payload as { nonce: number }).nonce;
    await holder.request("lease.heartbeat", { nonce });

    await expect(holder.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: { leases: [{ id: leaseId, lastHeartbeatAt: 1_010 }] },
    });
    await expect(holder.request("list.get", { kind: "leases" })).resolves.toMatchObject({
      ok: true,
      payload: [{ id: leaseId, lastHeartbeatAt: 1_010 }],
    });
    await holder.close();
  });

  it("surfaces a derived transitionAgeMs for a mid-transition device in status and list --devices", async () => {
    const harness = await createHarness();
    const device = await harness.registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_provisioning",
      provisionDuration: 0,
      spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    harness.clock.advance(5_000);

    const observer = await createClient(harness.socketPath);
    await hello(observer);
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: { devices: [{ id: device.id, transitionAgeMs: 5_000 }] },
    });
    await expect(observer.request("list.get", { kind: "devices" })).resolves.toMatchObject({
      ok: true,
      payload: [{ id: device.id, transitionAgeMs: 5_000 }],
    });
    await observer.close();
  });

  describe("operational logging", () => {
    function logger(): { logger: Logger; sink: MemoryLogSink } {
      const sink = new MemoryLogSink();
      return {
        logger: new JsonLinesLogger({ clock: new FakeClock(1_000), level: "debug", sink }),
        sink,
      };
    }

    it("logs the daemon start with version, protocol version, socket path, and effective config", async () => {
      const { logger: log, sink } = logger();
      const harness = await createHarness({ logger: log, start: false });

      await harness.daemon.start();

      expect(sink.records).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "Daemon started",
          fields: expect.objectContaining({
            version: "test",
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            socketPath: harness.socketPath,
            config: harness.config,
          }),
        }),
      );
    });

    it("logs a connection opening with its declared capabilities and closing afterward", async () => {
      const { logger: log, sink } = logger();
      const harness = await createHarness({ logger: log });
      const client = await createClient(harness.socketPath);

      await hello(client, { heartbeat: true });
      expect(sink.records).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "Connection opened",
          fields: expect.objectContaining({ heartbeatCapability: true }),
        }),
      );

      await client.close();
      await expect
        .poll(() => sink.records.some((record) => record.message === "Connection closed"))
        .toBe(true);
    });

    it("drains the backgrounded reclaims before disposing, on a graceful stop", async () => {
      const order: string[] = [];
      let finishSettle!: () => void;
      const settling = new Promise<void>((resolve) => {
        finishSettle = resolve;
      });
      const harness = await createHarness({
        dispose: () => order.push("dispose"),
        settle: async () => {
          order.push("settle-start");
          await settling;
          order.push("settle-end");
        },
      });
      const holder = await createClient(harness.socketPath);
      await hello(holder);
      await holder.request("lease.request", {
        mode: "held",
        requesterId: "holder",
        request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      });

      const stopping = harness.daemon.stop("test-drain");
      await expect.poll(() => order).toEqual(["settle-start"]);

      // The held lease is already gone -- that half of the release is synchronous --
      // but the purge it handed off is not, and `stop` waits for it so the pool is
      // left settled rather than `reclaiming` for the next startup to recover.
      expect(harness.registry.snapshot.leases).toHaveLength(0);

      finishSettle();
      await stopping;
      // Disposal last: a reclaim that settles into a purge failure arms a quarantine
      // retry timer, and cancelling before the drain would strand it armed.
      expect(order).toEqual(["settle-start", "settle-end", "dispose"]);
    });

    it("logs a clean shutdown", async () => {
      const { logger: log, sink } = logger();
      const harness = await createHarness({ logger: log });

      await harness.daemon.stop("test-shutdown");

      expect(sink.records).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "Daemon stopping",
          fields: { reason: "test-shutdown" },
        }),
      );
      expect(sink.records).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "Daemon stopped",
          fields: { reason: "test-shutdown" },
        }),
      );
    });

    it("logs an unhandled request error at error level", async () => {
      const { logger: log, sink } = logger();
      const harness = await createHarness({ logger: log });
      const client = await createClient(harness.socketPath);
      await hello(client);

      await client.request("doctor.run", {});

      expect(sink.records).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "Unhandled request error",
          fields: expect.objectContaining({ type: "doctor.run" }),
        }),
      );
      await client.close();
    });

    it("logs a handled/expected request error below error level", async () => {
      const { logger: log, sink } = logger();
      const harness = await createHarness({ logger: log });
      const client = await createClient(harness.socketPath);
      await hello(client);

      await client.request("lease.release", { leaseId: "not-a-lease" });

      expect(sink.records).toContainEqual(
        expect.objectContaining({
          level: "debug",
          message: "Handled request error",
          fields: { code: "UNKNOWN_LEASE", type: "lease.release" },
        }),
      );
      expect(sink.records).not.toContainEqual(
        expect.objectContaining({ level: "error", message: "Unhandled request error" }),
      );
      await client.close();
    });
  });
});

describe("DaemonServer download policy", () => {
  it("grants download permission under the always policy without a per-request flag", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ clock, downloads: { policy: "always" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const grant = await client.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    expect(grant.ok).toBe(true);
    expect(driver.calls.find((call) => call.operation === "resolveSpec")?.arguments[1]).toEqual({
      allowDownload: true,
    });
    await client.close();
  });

  it("withholds download permission under the never policy even when the request asks for it", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ clock, downloads: { policy: "never" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      allowDownload: true,
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).toContain("downloads.policy");
    expect(driver.calls.find((call) => call.operation === "resolveSpec")?.arguments[1]).toEqual({
      allowDownload: false,
    });
    await client.close();
  });

  it("defers to the request's own flag under the default on-request policy", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    // No allowDownload on the request and the default policy, so this fails exactly as it
    // did before the policy existed -- and, unlike the never-policy case above, the message
    // is not attributed to configuration, since nothing in config forced the outcome.
    const response = await client.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).not.toContain("downloads.policy");
    await client.close();
  });

  it("never attaches the download-policy suffix to an undownloadable RuntimeMissingError, even under the never policy", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    // Stands in for a real out-of-range / unpaired-runtime error: no download could ever have
    // fixed this request, so the policy is not what blocked it.
    driver.failOn(
      "resolveSpec",
      1,
      new RuntimeMissingError("ios", "12.0", { downloadable: false }),
    );
    const harness = await createHarness({ clock, downloads: { policy: "never" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      allowDownload: true,
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "12.0", platform: "ios" },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).not.toContain("downloads.policy");
    await client.close();
  });
});

describe("DaemonServer error code mapping", () => {
  it("maps InsufficientDiskSpaceError to INSUFFICIENT_DISK_SPACE", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.failOn("resolveSpec", 1, new InsufficientDiskSpaceError("ios", 8 * 1024 ** 3, 0));
    const harness = await createHarness({ clock, downloads: { policy: "always" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "INSUFFICIENT_DISK_SPACE" });
    await client.close();
  });

  it("maps LicenseNotAcceptedError to LICENSE_NOT_ACCEPTED", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "android" });
    driver.failOn(
      "resolveSpec",
      1,
      new AndroidLicenseNotAcceptedError("system-images;android-35;google_apis;arm64-v8a"),
    );
    const harness = await createHarness({ clock, downloads: { policy: "always" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "Pixel 8", osVersion: "35", platform: "android" },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "LICENSE_NOT_ACCEPTED" });
    await client.close();
  });
});

// fallow-ignore-next-line complexity -- a test harness whose branches are all trivial optional-parameter defaulting.
async function createHarness(
  options: {
    readonly estimateMs?: Partial<Record<"boot" | "provision", number>>;
    readonly latencyMs?: Partial<Record<"makeReady" | "provision", number>>;
    readonly lease?: Partial<Config["lease"]>;
    readonly socketPath?: string;
    readonly start?: boolean;
    readonly clock?: FakeClock;
    readonly converge?: () => Promise<void>;
    readonly dispose?: () => void;
    readonly downloads?: Partial<Config["downloads"]>;
    readonly driver?: FakeDriver;
    readonly logger?: Logger;
    readonly settle?: () => Promise<void>;
    readonly stateFilesystem?: MemoryFilesystem;
  } = {},
) {
  const directory =
    options.socketPath === undefined ? await mkdtemp(join(tmpdir(), "simlock-daemon-")) : undefined;
  if (directory !== undefined) {
    temporaryDirectories.push(directory);
  }
  const socketPath = options.socketPath ?? join(directory as string, "daemon.sock");
  const clock = options.clock ?? new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const stateFilesystem = options.stateFilesystem ?? new MemoryFilesystem();
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem: stateFilesystem,
    idGenerator: sequence(),
    statePath: "/state.json",
  });
  const driver =
    options.driver ??
    new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      ...(options.estimateMs === undefined ? {} : { estimateMs: options.estimateMs }),
      ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
      platform: "ios",
    });
  const config = testConfig(options.lease, options.downloads);
  const engine = new LeaseEngine({
    clock,
    config,
    drivers: [driver],
    eventBus,
    idGenerator: sequence(),
    registry,
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
      totalRamBytes: 32 * gibibyte,
    }),
  });
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: engine.cleanup,
    filesystem: new MemoryFilesystem(),
    registry,
  });
  const daemon = new DaemonServer({
    capacity: engine,
    catalog: engine,
    clock,
    config,
    ...(options.converge === undefined ? {} : { converge: options.converge }),
    defaultRequesterId: "test-process",
    eventBus,
    host: new DaemonEndpointHost({
      connector: new NodeIpcTransport(),
      endpoint: socketPath,
      filesystem: new NodeFilesystem(),
      listenerFactory: new NodeIpcTransport(),
    }),
    leases: engine,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    queue: engine,
    reaper,
    registry,
    settle: options.settle ?? (async () => engine.settle()),
    ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
    version: "test",
  });
  runningDaemons.push(daemon);
  if (options.start ?? true) {
    await daemon.start();
  }

  return { clock, config, daemon, driver, engine, eventBus, registry, socketPath, stateFilesystem };
}

async function createClient(socketPath: string): Promise<Client> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  let buffer = "";
  const frames: ServerFrame[] = [];
  const waiters: Array<{
    readonly predicate: (frame: ServerFrame) => boolean;
    readonly resolve: (frame: ServerFrame) => void;
  }> = [];
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const frame = JSON.parse(line) as ServerFrame;
      const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(frame));
      const waiter = waiterIndex < 0 ? undefined : waiters.splice(waiterIndex, 1)[0];
      if (waiter === undefined) {
        frames.push(frame);
      } else {
        waiter.resolve(frame);
      }
    }
  });
  socket.on("error", () => undefined);

  const nextFrame = (predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> => {
    const frameIndex = frames.findIndex(predicate);
    if (frameIndex >= 0) {
      const frame = frames.splice(frameIndex, 1)[0];
      return Promise.resolve(frame as ServerFrame);
    }
    return new Promise((resolve) => waiters.push({ predicate, resolve }));
  };

  let nextRequestId = 1;
  return {
    socket,
    frames: () => [...frames],
    nextFrame,
    async request(type, payload, id = `request-${nextRequestId++}`) {
      const response = nextFrame((frame) => frame.id === id);
      socket.write(`${JSON.stringify({ id, payload, type })}\n`);
      return response;
    },
    send(contents) {
      socket.write(contents);
    },
    async close() {
      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
        socket.destroy();
      });
    },
  };
}

async function hello(client: Client, capabilities?: Record<string, unknown>): Promise<void> {
  await expect(
    client.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      ...(capabilities === undefined ? {} : { capabilities }),
    }),
  ).resolves.toMatchObject({
    ok: true,
  });
}

function leaseIdOf(frame: ServerFrame): string {
  return (frame.payload as { readonly lease: { readonly id: string } }).lease.id;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
  }
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function testConfig(
  leaseOverrides?: Partial<Config["lease"]>,
  downloadsOverrides?: Partial<Config["downloads"]>,
): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    eventBuffer: { capacity: 100 },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    downloads: {
      policy: "on-request",
      acceptAndroidLicenses: false,
      timeoutMs: 1_200_000,
      ...downloadsOverrides,
    },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: {
      detachedTtlMs: 60_000,
      heldTtlBackstopMs: 60_000,
      heartbeatIntervalMs: 5_000,
      ...leaseOverrides,
    },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 1 + 1,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    warmPool: {
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}
