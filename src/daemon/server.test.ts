import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  type Config,
  type DriverRejection,
  CleanupReaper,
  FakeDriver,
  InsufficientDiskSpaceError,
  LeaseEngine,
  PassthroughRefusedError,
  Registry,
  RuntimeMissingError,
} from "../core/index.js";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { AndroidLicenseNotAcceptedError } from "../drivers/android/index.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeSystemStats,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  NodeFilesystem,
  NodeIpcTransport,
  ScriptedProcessRunner,
  type Logger,
  type ProcessRunner,
  type ProcessStreamOptions,
  type StreamingProcessHandle,
  type StreamingProcessResult,
} from "../ports/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import { DaemonEndpointHost } from "./connection-host.js";
import { AdminAuthenticationFailedError, type SessionRoleResolver } from "./session.js";
import { DaemonServer } from "./server.js";
import { AdminSecretManager } from "./admin-secret.js";

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
    | "output"
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
  it("keeps a lease when its client connection closes, and ends it at its own deadline", async () => {
    // ADR 0004 §3: connection close means nothing to a lease. The daemon keeps no
    // per-connection lease state and releases nothing on close, on any transport -- the TTL
    // is the only thing that ends a lease nobody released.
    const harness = await createHarness({ lease: { defaultTtlMs: 40 } });
    const holder = await createClient(harness.socketPath);

    await holder.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    expect(grant.ok).toBe(true);
    const leaseId = leaseIdOf(grant);
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    await holder.close();

    const observer = await createClient(harness.socketPath);
    await hello(observer);
    // Still granted, still leasing its device, with nothing renewing it.
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      payload: { devices: [{ state: "leased" }], leases: [{ id: leaseId }] },
    });

    // The deadline is what ends it.
    harness.clock.advance(40);
    await expect.poll(() => harness.registry.snapshot.leases).toHaveLength(0);
    await expect.poll(() => harness.registry.snapshot.devices[0]?.state).toBe("ready");
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      payload: {
        capacity: { global: { warm: 1 }, ios: { warm: 1 } },
        devices: [{ state: "ready" }],
      },
    });
    await observer.close();
  });

  it("releases on an explicit lease.release, which is what a holder does on its way out", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    await expect(
      holder.request("lease.release", { leaseId: leaseIdOf(grant) }),
    ).resolves.toMatchObject({ ok: true });

    await expect.poll(() => harness.registry.snapshot.leases).toHaveLength(0);
    await expect.poll(() => harness.registry.snapshot.devices[0]?.state).toBe("ready");
    await holder.close();
  });

  it("requires a compatible hello before serving requests", async () => {
    const harness = await createHarness();
    const missingHello = await createClient(harness.socketPath);

    await expect(missingHello.request("status.get", {})).resolves.toMatchObject({
      error: { code: "HANDSHAKE_REQUIRED" },
      ok: false,
    });
    await missingHello.close();

    // ADR 0003 §6: protocol versions are now negotiated as ranges. A bare `protocolVersion`
    // with no overlap against the daemon's range is `PROTOCOL_VERSION_UNSUPPORTED`, carrying
    // both ranges and the daemon version -- there is no more exact-match
    // `PROTOCOL_VERSION_MISMATCH` on this daemon (a real protocol-2 daemon out in the world
    // still answers with the old code; see `contract/protocol.test.ts`'s
    // `mapLegacyProtocolMismatch` for how a client maps that).
    const wrongVersion = await createClient(harness.socketPath);
    await expect(
      wrongVersion.request("hello", {
        clientVersion: "test",
        protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "PROTOCOL_VERSION_UNSUPPORTED",
        details: {
          client: { min: DAEMON_PROTOCOL_VERSION + 1, max: DAEMON_PROTOCOL_VERSION + 1 },
          daemon: PROTOCOL_VERSION_RANGE,
        },
      },
      ok: false,
    });
  });

  // Every protocol bump so far shipped without a back-compat shim, so rejecting an older
  // client outright is a deliberate product decision, not just arithmetic on the current
  // constant. Protocol 3 (ADR 0003) turned the rejection into a range check; 4 (ADR 0004)
  // removed `lease.heartbeat` and `mode` behind that same no-shim rule; 5 (ADR 0005) adds
  // `device.exec` and a `mode` field on `status.get` the same way. A v1 client has no overlap
  // with `PROTOCOL_VERSION_RANGE` and is still rejected outright.
  it("rejects a protocol v1 client outright rather than serving it a wire it cannot speak", async () => {
    const harness = await createHarness();
    const legacy = await createClient(harness.socketPath);

    await expect(
      legacy.request("hello", { clientVersion: "test", protocolVersion: 1 }),
    ).resolves.toMatchObject({
      error: { code: "PROTOCOL_VERSION_UNSUPPORTED" },
      ok: false,
    });
  });

  it("grants the queued client when the holder's lease expires, not when it disconnects", async () => {
    // A log sink rather than a sleep: "the waiter stays queued" is a negative assertion, and
    // the only honest way to make one is to wait for the daemon to have actually processed
    // the close first. `Connection closed` is that receipt.
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      lease: { defaultTtlMs: 40 },
      logger: new JsonLinesLogger({ clock: new FakeClock(1_000), level: "debug", sink }),
    });
    const holder = await createClient(harness.socketPath);
    const waiter = await createClient(harness.socketPath);
    await hello(holder);
    await hello(waiter);
    await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    const queuedGrant = waiter.request("lease.request", {
      requesterId: "waiter",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    await expect
      .poll(() => harness.eventBus.replay().some((event) => event.event === "lease.queued"))
      .toBe(true);

    // The holder's socket dying frees nothing (ADR 0004 §3) -- the waiter stays queued.
    await holder.close();
    await expect
      .poll(() => sink.records.some((record) => record.message === "Connection closed"))
      .toBe(true);
    expect(harness.registry.snapshot.leases.map((lease) => lease.requesterId)).toEqual(["holder"]);

    // Its deadline does free it, and the queue is served from there.
    harness.clock.advance(40);
    await expect(queuedGrant).resolves.toMatchObject({ ok: true });
    await expect
      .poll(() => harness.registry.snapshot.leases.map((lease) => lease.requesterId))
      .toEqual(["waiter"]);
  });

  it("keeps lease progress on its requesting connection", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    const waiter = await createClient(harness.socketPath);
    await Promise.all([hello(holder), hello(waiter)]);
    const holderGrant = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    const queuedGrant = waiter.request("lease.request", {
      requesterId: "waiter",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    // ADR 0003 §8: `progress` now carries the originating request's frame id alongside the
    // progress payload, under `progress`, rather than the bare stage object at the top level.
    await expect(waiter.nextFrame((frame) => frame.push === "progress")).resolves.toMatchObject({
      payload: { progress: { queuePosition: 1, stage: "queued" } },
      push: "progress",
    });

    expect(
      holder
        .frames()
        .filter(
          (frame) =>
            frame.push === "progress" &&
            (frame.payload as { readonly progress?: { readonly stage?: unknown } } | undefined)
              ?.progress?.stage === "queued",
        ),
    ).toEqual([]);
    // Closing the holder frees nothing (ADR 0004 §3); releasing does.
    await holder.request("lease.release", { leaseId: leaseIdOf(holderGrant) });
    await expect(queuedGrant).resolves.toMatchObject({ ok: true });
    await holder.close();
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
        requesterId: "agent-1",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      })
      .then((response) => {
        requestSettled = true;
        return response;
      });

    await expect(
      client.nextFrame((frame) => frame.push === "progress" && frame.payload !== undefined),
    ).resolves.toMatchObject({
      payload: { progress: { etaMs: 60, stage: "provisioning" } },
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
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
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

  it("resolves a passthrough to its driver's command without running it here", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: (args) => ({
        args: ["simctl", "--set", "/root", ...args],
        command: "xcrun",
        env: {},
      }),
      passthroughTool: "simctl",
      platform: "ios",
    });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("driver.passthrough", { args: ["list", "devices"], tool: "simctl" }),
    ).resolves.toMatchObject({
      ok: true,
      payload: { args: ["simctl", "--set", "/root", "list", "devices"], command: "xcrun" },
    });
  });

  it("gives a refused verb its own code, so the CLI can render it as a usage error", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: () => {
        throw new PassthroughRefusedError("simctl", "Refusing it; use `simlock release` instead.");
      },
      passthroughTool: "simctl",
      platform: "ios",
    });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("driver.passthrough", { args: ["delete", "ABCD"], tool: "simctl" }),
    ).resolves.toMatchObject({
      error: { code: "PASSTHROUGH_REFUSED", message: expect.stringContaining("simlock release") },
      ok: false,
    });
  });

  it.each([[{ args: "list", tool: "simctl" }], [{ args: ["list"] }]])(
    "rejects a malformed passthrough payload: %s",
    async (payload) => {
      const harness = await createHarness();
      const client = await createClient(harness.socketPath);
      await hello(client);

      await expect(client.request("driver.passthrough", payload)).resolves.toMatchObject({
        error: { code: "BAD_REQUEST" },
        ok: false,
      });
    },
  );

  // A well-formed request for a wrapper no driver claims is not a malformed one: it gets its
  // own ERROR_TABLE row so the socket and HTTP transports name the condition identically
  // (ADR 0003 §7), and so the CLI can tell "you typed it wrong" from "no driver serves this".
  it("distinguishes an unknown passthrough tool from a malformed payload", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("driver.passthrough", { args: ["devices"], tool: "adb" }),
    ).resolves.toMatchObject({
      error: { code: "UNKNOWN_PASSTHROUGH_TOOL" },
      ok: false,
    });
  });

  /**
   * ADR 0005 §19a over the socket. The dispatcher's own suite proves what the command does;
   * this proves the one thing only this transport can: the chunks reach the wire as `output`
   * pushes keyed by the request's frame id, ahead of the reply that carries the exit code.
   */
  it("pushes device.exec output frames keyed by the request id, then replies with the exit code", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: (args: readonly string[]) => ({
        args: ["--set", "/root", ...args],
        command: "simctl",
        env: {},
      }),
      passthroughTool: "simctl",
      platform: "ios",
    });
    const harness = await createHarness({
      clock,
      driver,
      processRunner: new ScriptedProcessRunner([
        {
          chunks: [
            { chunk: "booted", stream: "stdout" },
            { chunk: "a warning", stream: "stderr" },
          ],
          match: { args: ["--set", "/root", "list", "devices"], command: "simctl" },
          result: { code: 6, stderr: "", stdout: "" },
        },
      ]),
    });
    const client = await createClient(harness.socketPath);
    await hello(client);
    const grant = await client.request("lease.request", {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    });

    const response = await client.request(
      "device.exec",
      { args: ["list", "devices"], leaseId: leaseIdOf(grant), tool: "simctl" },
      "exec-frame",
    );

    expect(response).toMatchObject({ ok: true, payload: { exitCode: 6 } });
    expect(client.frames().filter((frame) => frame.push === "output")).toEqual([
      { payload: { chunk: "booted", requestId: "exec-frame", stream: "stdout" }, push: "output" },
      {
        payload: { chunk: "a warning", requestId: "exec-frame", stream: "stderr" },
        push: "output",
      },
    ]);
  });

  it("routes two commands on one connection by frame id, and pushes to no other connection", async () => {
    // ADR 0005 §19a keys `output` on the request's frame id for the same reason `progress` is
    // keyed on it: one connection may have several calls in flight. And a push is a *reply* to
    // one call, not a broadcast -- a second connection, even one owned by the same principal,
    // has no business seeing another's command output.
    const clock = new FakeClock(1_000);
    const driver = passthroughDriver(clock);
    const harness = await createHarness({
      clock,
      driver,
      processRunner: new ScriptedProcessRunner([
        {
          chunks: [{ chunk: "first-command", stream: "stdout" }],
          match: { args: ["--set", "/root", "list", "devices"], command: "simctl" },
        },
        {
          chunks: [{ chunk: "second-command", stream: "stdout" }],
          match: { args: ["--set", "/root", "list", "runtimes"], command: "simctl" },
        },
      ]),
    });
    const client = await createClient(harness.socketPath);
    const observer = await createClient(harness.socketPath);
    await hello(client);
    await hello(observer);
    const grant = await client.request("lease.request", {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);

    const first = client.request(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      "exec-a",
    );
    const second = client.request(
      "device.exec",
      { args: ["list", "runtimes"], leaseId, tool: "simctl" },
      "exec-b",
    );
    await Promise.all([first, second]);

    expect(
      client
        .frames()
        .filter((frame) => frame.push === "output")
        .map((frame) => frame.payload),
    ).toEqual([
      { chunk: "first-command", requestId: "exec-a", stream: "stdout" },
      { chunk: "second-command", requestId: "exec-b", stream: "stdout" },
    ]);
    expect(observer.frames().filter((frame) => frame.push === "output")).toEqual([]);
  });

  it("stops pushing when the connection dies, and lets the command finish anyway", async () => {
    // ADR 0004 §3's reasoning applied to a process: a dropped connection is not a reason to
    // kill a half-applied `simctl install`. What stops is the pushing -- writing to a dead
    // socket is the transport's problem to not have, and the operation itself carries on to
    // its own end (or to `exec.timeoutMs`).
    const clock = new FakeClock(1_000);
    const driver = passthroughDriver(clock);
    const runner = new ControllableStreamingRunner();
    const harness = await createHarness({ clock, driver, processRunner: runner });
    const client = await createClient(harness.socketPath);
    await hello(client);
    const grant = await client.request("lease.request", {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    });

    void client.request(
      "device.exec",
      { args: ["list", "devices"], leaseId: leaseIdOf(grant), tool: "simctl" },
      "exec-dropped",
    );
    await waitFor(() => runner.handle !== undefined);
    const firstPush = client.nextFrame((frame) => frame.push === "output");
    runner.handle?.emit("stdout", "before-the-drop");
    expect(await firstPush).toMatchObject({
      payload: { chunk: "before-the-drop", requestId: "exec-dropped" },
      push: "output",
    });

    await client.close();
    await flush();
    // Chunks written after the socket is gone reach no one and throw nothing, and the command
    // still runs to its own end: the daemon is not left with a half-run command, and nothing
    // about a dead socket reaches the operation.
    runner.handle?.emit("stdout", "after-the-drop");
    runner.handle?.finish(0);
    await flush();
    expect(runner.handle?.settled).toBe(true);

    // Still serving: writing to a socket that went away mid-command took nothing down with it.
    const survivor = await createClient(harness.socketPath);
    await hello(survivor);
    await expect(survivor.request("status.get", {})).resolves.toMatchObject({ ok: true });
    await survivor.close();
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

  // Review finding S1: `AdminSecretManager`'s own doc (`admin-secret.ts`) asserts "a daemon
  // that loses the start race never calls `persist()` at all ... so the file an
  // already-running daemon wrote is never touched by the loser" -- untested anywhere before
  // this. Mirrors the "recovers a stale socket file" test above (two harnesses racing for the
  // same socket path), but gives each its own real `AdminSecretManager` over its own
  // `MemoryFilesystem` so this can assert on the filesystem directly, rather than trusting a
  // stub. In production both instances would target the *same* real `admin.token` path (see
  // `main.ts`); separate filesystems here isolate what each instance actually did, without that
  // shared path letting a wrongly-invoked `remove()` on the loser silently clean up after a
  // wrongly-invoked `persist()` and mask the very bug this test exists to catch.
  it("never touches admin.token on the daemon instance that loses the start race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-stale-admin-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "daemon.sock");
    await new NodeFilesystem().writeFileAtomic(socketPath, "stale");

    const secrets = new CryptoTokenSecrets();
    const winnerFilesystem = new MemoryFilesystem();
    // Not bound to a name: `createHarness` already registers its daemon in `runningDaemons`
    // for `afterEach` to stop, and this test only needs the winner alive on `socketPath` (so
    // the loser's own `start()` below actually loses) plus its filesystem.
    await createHarness({
      adminSecret: new AdminSecretManager({
        filesystem: winnerFilesystem,
        path: "/admin.token",
        secrets,
      }),
      socketPath,
    });
    // The winner (the only one whose `start()` actually reached `host.start()`'s success path)
    // did persist its secret.
    await expect(winnerFilesystem.readFile("/admin.token")).resolves.toContain("\n");

    const loserFilesystem = new MemoryFilesystem();
    const second = await createHarness({
      adminSecret: new AdminSecretManager({
        filesystem: loserFilesystem,
        path: "/admin.token",
        secrets,
      }),
      socketPath,
      start: false,
    });
    await expect(second.daemon.start()).rejects.toMatchObject({
      name: "DaemonAlreadyRunningError",
    });
    // The claim under test: the loser's own filesystem was never written to, because its
    // `start()` threw before reaching `adminSecret.persist()`. `startDaemon()` (`main.ts`)
    // never calls `stop()` on a `daemon.start()` rejection like this one either, so this
    // asserts the state exactly as production leaves it, before any test-hygiene cleanup below.
    await expect(loserFilesystem.readFile("/admin.token")).rejects.toThrow();

    await second.daemon.stop("failed-start");
    const client = await createClient(socketPath);
    await hello(client);
    await client.close();
  });

  it("gracefully stops without touching leases, persisting them with their deadlines", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);
    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);

    await expect(client.request("daemon.stop", {})).resolves.toMatchObject({ ok: true });

    // ADR 0004 §3: a stop ends connections, not leases -- they persist and the next daemon
    // restores each one's timer from its deadline.
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);
    await expect(harness.stateFilesystem.readFile("/state.json")).resolves.toContain(leaseId);
    expect(harness.eventBus.replay().map((event) => event.event)).toContain("daemon.stopping");
    expect(harness.eventBus.replay().map((event) => event.event)).not.toContain("lease.released");
  });

  it("pushes a lease-lost notification to the holding connection when its lease's TTL backstop expires", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
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
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
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
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
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
    harness.eventBus.emit(
      "lease.expired",
      { deviceId: "device-x", leaseId: "lease-x", ownerId: "test-process" },
      "test",
    );
    harness.eventBus.emit(
      "lease.released",
      { deviceId: "device-y", leaseId: "lease-y", ownerId: "test-process", reason: "killed" },
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
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
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

    // The lease is untouched by the notice: it is a fact about the device, not about the
    // lease, and it is still there to be released the normal way.
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);
    await holder.request("lease.release", { leaseId });
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    await holder.close();
  });

  it("pushes a device-recovered notification on device.recovered without releasing the lease", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
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

    // The lease survived the crash and the recovery both, and ends the normal way.
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);
    await holder.request("lease.release", { leaseId });
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    await holder.close();
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
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
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
      { deviceId: deviceId as string, leaseId, ownerId: "test-process", reason: "device-lost" },
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

  it("does not arm live machinery when a stop completes while convergence is still running", async () => {
    // `daemon.stop` is accepted during startup (see `#dispatchLine`), and an auxiliary
    // frontend that fails to bind asks for a stop of its own -- so a stop can run to
    // completion before convergence resolves. `start()` must then bail rather than
    // subscribe to a disposed bus, schedule a heartbeat tick on a dead daemon, and emit
    // `daemon.started` after `daemon.stopping` (a fact untrue when emitted, which
    // `docs/agent-rules/events.md` rule 3 forbids).
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

describe("DaemonServer driver rejections", () => {
  it("publishes one event per platform that refused to start, after the daemon is up", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.root-rejected",
          payload: { platform: "ios", reason: "wrong-instance", root: "/Devices" },
          platform: "ios",
          reason: "wrong-instance",
          summary: "Refusing the ios device root /Devices: it belongs to another instance",
        },
      ],
    });

    const events = harness.eventBus.replay();
    const rejected = events.filter((event) => event.event === "driver.root-rejected");
    expect(rejected).toEqual([
      expect.objectContaining({
        module: "daemon",
        payload: { platform: "ios", reason: "wrong-instance", root: "/Devices" },
      }),
    ]);
    // The daemon did come up -- the refusal costs one platform, not the process -- and
    // the buffer says so in that order.
    const started = events.find((event) => event.event === "daemon.started");
    expect(started?.seq).toBeLessThan(rejected[0]?.seq ?? 0);
  });

  it("names the refusal when a lease asks for a platform whose driver did not start", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.adb-server-rejected",
          payload: { port: 5038, reason: "occupied" },
          platform: "android",
          reason: "occupied",
          summary: "Refusing the Android driver: port 5038 is held by an adb server we do not own",
        },
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "Pixel 8",
      platform: "android",
    });

    // Safety rule 9's other half: the platform's driver does not start *and Simlock
    // reports why*. A bare `NO_DRIVER` reads exactly like "this host has no Android SDK".
    expect(response.error?.code).toBe("NO_DRIVER");
    expect(response.error?.message).toContain("port 5038 is held by an adb server we do not own");
  });

  it("leaves an ordinary missing platform unexplained, having nothing to explain", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.root-rejected",
          payload: { platform: "ios", reason: "symlink", root: "/Devices" },
          platform: "ios",
          reason: "symlink",
          summary: "Refusing the ios device root /Devices: it is a symlink",
        },
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "Pixel 8",
      platform: "android",
    });

    // The refusal on file is another platform's; attaching it here would blame iOS for
    // Android's absence.
    expect(response.error?.code).toBe("NO_DRIVER");
    expect(response.error?.message).toBe("No driver registered for platform: android");
  });

  it("names the refusal when a passthrough asks for the tool whose driver did not start", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.adb-server-rejected",
          passthroughTool: "adb",
          payload: { port: 5038, reason: "occupied" },
          platform: "android",
          reason: "occupied",
          summary: "Refusing the Android driver: port 5038 is held by an adb server we do not own",
        },
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("driver.passthrough", {
      args: ["devices"],
      tool: "adb",
    });

    // Unexplained, "No driver provides a adb passthrough" reads as "this host has no
    // Android SDK" and sends the operator off to install one, while the summary naming the
    // port conflict sits unread in `driverRejections` (safety rule 9).
    expect(response.error?.code).toBe("UNKNOWN_PASSTHROUGH_TOOL");
    expect(response.error?.message).toContain("port 5038 is held by an adb server we do not own");
  });

  it("leaves an unknown passthrough tool unexplained when no driver claimed it", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.root-rejected",
          passthroughTool: "simctl",
          payload: { platform: "ios", reason: "symlink", root: "/Devices" },
          platform: "ios",
          reason: "symlink",
          summary: "Refusing the ios device root /Devices: it is a symlink",
        },
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("driver.passthrough", {
      args: ["devices"],
      tool: "adb",
    });

    expect(response.error?.message).toBe("No driver provides a adb passthrough");
  });

  it("refuses at compile time to pair an event with another event's payload", () => {
    const rejection: DriverRejection = {
      event: "driver.adb-server-rejected",
      // @ts-expect-error -- `port` is a number on the wire (docs/EVENTS.md). The check has
      // to happen where a refusal is written, because the daemon forwards `payload` to the
      // ring buffer -- and to `simlock events --json` -- without ever reading it.
      payload: { port: "5038", reason: "occupied" },
      platform: "android",
      reason: "occupied",
      summary: "Refusing the Android driver: port 5038 is occupied",
    };

    expect(rejection.event).toBe("driver.adb-server-rejected");
  });

  it("publishes nothing when every driver started", async () => {
    const harness = await createHarness();

    expect(harness.eventBus.replay().filter((event) => event.event.startsWith("driver."))).toEqual(
      [],
    );
  });
});

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

    // Renew on the client's own cadence, well past the grant-time deadline. Each renew names
    // no TTL, so each re-applies the lease's own 40ms width from now.
    let expectedDeadline = 1_040;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      harness.clock.advance(10);
      expectedDeadline = harness.clock.now() + 40;
      await expect(holder.request("lease.renew", { leaseId })).resolves.toMatchObject({
        ok: true,
        payload: { id: leaseId, ttlDeadline: expectedDeadline, ttlMs: 40 },
      });
    }
    // 60ms have passed since the grant, well past the deadline it carried, and the lease is
    // alive because something kept renewing it.
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);

    // Stop renewing and the deadline catches up, with no separate backstop behind it.
    harness.clock.advance(40);
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId, reason: "expired" },
      push: "lease-lost",
    });
    await holder.close();
  });

  it("never pushes anything to a connection to prove liveness", async () => {
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

    harness.clock.advance(40);
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    expect(holder.frames().filter((frame) => frame.push === "lease.heartbeat")).toEqual([]);
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

  it("rejects a ttlMs above lease.maxTtlMs on a request and on a renew, rather than clamping", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 40, maxTtlMs: 100 } });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("lease.request", {
        requesterId: "agent-1",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
        ttlMs: 101,
      }),
    ).resolves.toMatchObject({ error: { code: "BAD_REQUEST" }, ok: false });
    expect(harness.registry.snapshot.leases).toEqual([]);

    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
      ttlMs: 100,
    });
    const leaseId = leaseIdOf(grant);
    expect((grant.payload as { lease: { ttlMs: number } }).lease.ttlMs).toBe(100);

    await expect(client.request("lease.renew", { leaseId, ttlMs: 101 })).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
      ok: false,
    });
    expect(harness.registry.snapshot.leases).toMatchObject([{ ttlDeadline: 1_100 }]);
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

    // Simulate an abrupt daemon crash: the first daemon's process just disappears, leaving
    // the last persisted registry state -- the renewed deadline -- on disk. It is
    // intentionally left running here; the afterEach hook tears it down.

    // "Restart": a fresh daemon reloads that persisted state. ADR 0004 removed the orphan
    // sweep that used to release this lease on the theory that a restart proves its holder
    // is dead -- it proves nothing of the sort, so the lease stands and its timer is
    // restored from the renewed deadline. The underlying device (unlike the daemon process)
    // survives a restart, so the "restarted" harness shares the same fake driver instance.
    const second = await createHarness({
      clock: new FakeClock(1_010),
      driver: first.driver,
      lease: leaseOverrides,
      stateFilesystem: first.stateFilesystem,
    });
    await second.engine.convergeRunningCapacity();

    expect(second.registry.snapshot.leases).toMatchObject([{ id: leaseId, ttlDeadline: 1_050 }]);
    expect(second.registry.snapshot.devices).toMatchObject([{ id: deviceId, state: "leased" }]);

    // The restored timer is the renewed one, not the grant-time one: nothing expires at
    // 1_040, and the lease ends at 1_050 with no client left to renew it.
    second.clock.advance(30);
    await expect.poll(() => second.registry.snapshot.leases).toHaveLength(1);
    second.clock.advance(10);
    await expect.poll(() => second.registry.snapshot.leases).toEqual([]);
    await expect.poll(() => second.registry.snapshot.devices[0]?.state).toBe("ready");
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

    // The next daemon starts well after the persisted deadline (1_040).
    const second = await createHarness({
      clock: new FakeClock(2_000),
      driver: first.driver,
      lease: leaseOverrides,
      stateFilesystem: first.stateFilesystem,
    });
    await second.engine.convergeRunningCapacity();

    await expect.poll(() => second.registry.snapshot.leases).toEqual([]);
    await expect
      .poll(() => second.registry.snapshot.devices)
      .toMatchObject([{ id: deviceId, state: "ready" }]);
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
    // Written at grant, before any renew -- it is a stored field, not a derived one, so
    // there is always an answer.
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

  it("leaves leases alone on a daemon stop", async () => {
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
    await holder.close();

    await harness.daemon.stop("test");

    // ADR 0004 §3: a stop ends connections, not leases. The record persists with its
    // deadline for the next daemon to restore a timer from.
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);
    expect(harness.eventBus.replay().filter((event) => event.event === "lease.released")).toEqual(
      [],
    );
  });
});

describe("DaemonServer decorations", () => {
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

    it("logs a connection opening with its principal and role, and closing afterward", async () => {
      const { logger: log, sink } = logger();
      const harness = await createHarness({ logger: log });
      const client = await createClient(harness.socketPath);

      await helloAs(client, "agent-7");
      expect(sink.records).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "Connection opened",
          fields: expect.objectContaining({ principal: "agent-7", role: "admin" }),
        }),
      );

      await client.close();
      // ADR 0004 §3: there is no held-lease count to log any more, because there is no
      // per-connection lease state to count.
      await expect
        .poll(() =>
          sink.records.some(
            (record) =>
              record.message === "Connection closed" && record.fields?.principal === "agent-7",
          ),
        )
        .toBe(true);
    });

    it("drains the backgrounded reclaims before disposing, on a graceful stop", async () => {
      const order: string[] = [];
      let finishSettle!: () => void;
      const settling = new Promise<void>((resolve) => {
        finishSettle = resolve;
      });
      const harness = await createHarness({
        dispose: () => {
          order.push("dispose");
        },
        settle: async () => {
          order.push("settle-start");
          await settling;
          order.push("settle-end");
        },
      });
      const holder = await createClient(harness.socketPath);
      await hello(holder);
      const grant = await holder.request("lease.request", {
        requesterId: "holder",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      // The stop itself releases nothing (ADR 0004 §3), so the reclaim `stop` has to drain
      // is one somebody else started: the holder releasing on its way out, which commits
      // the registry half and hands the purge off.
      await holder.request("lease.release", { leaseId: leaseIdOf(grant) });
      expect(harness.registry.snapshot.leases).toHaveLength(0);

      const stopping = harness.daemon.stop("test-drain");
      await expect.poll(() => order).toEqual(["settle-start"]);

      finishSettle();
      await stopping;
      // Disposal last: a reclaim that settles into a purge failure arms a quarantine
      // retry timer, and cancelling before the drain would strand it armed.
      expect(order).toEqual(["settle-start", "settle-end", "dispose"]);
    });

    it("waits for an asynchronous disposal before reporting the daemon stopped", async () => {
      let disposed = false;
      let finishDispose!: () => void;
      const disposing = new Promise<void>((resolve) => {
        finishDispose = resolve;
      });
      const harness = await createHarness({
        dispose: async () => {
          await disposing;
          disposed = true;
        },
      });

      const stopping = harness.daemon.stop("test-async-dispose");
      await expect.poll(() => disposed).toBe(false);

      // A driver's release is asynchronous -- Android's reaps the adb server it started --
      // and a stop that returned before it finished would report a shutdown that had not
      // happened, leaving the next daemon to find the port still held.
      finishDispose();
      await stopping;
      expect(disposed).toBe(true);
    });

    it("stops an auxiliary frontend before releasing held leases and draining settle", async () => {
      const order: string[] = [];
      const harness = await createHarness({
        dispose: () => {
          order.push("dispose");
        },
        settle: async () => {
          order.push("settle");
        },
        stopAuxiliary: async () => {
          order.push("stopAuxiliary");
        },
      });
      const holder = await createClient(harness.socketPath);
      await hello(holder);
      await holder.request("lease.request", {
        requesterId: "holder",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      await harness.daemon.stop("test-stop-auxiliary");

      expect(order).toEqual(["stopAuxiliary", "settle", "dispose"]);
      // The lease is untouched: ADR 0004 §3 -- a stop tears down connections and timers,
      // and leaves every lease standing with its deadline for the next daemon.
      expect(harness.registry.snapshot.leases).toHaveLength(1);
    });

    it("reports health via the public accessor across the startup/stop lifecycle", async () => {
      const harness = await createHarness({ start: false });
      expect(harness.daemon.health).toBe("starting");

      await harness.daemon.start();
      expect(harness.daemon.health).toBe("running");

      await harness.daemon.stop("test-health");
      expect(harness.daemon.health).toBe("running");
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

    // `doctor.run`/`nuke.run` used to surface an unconfigured collaborator as a plain `Error`,
    // which `errorCode()` had no choice but to map to `INTERNAL` -- logged at error level
    // indistinguishably from a real bug. `DoctorUnavailableError`/`NukeUnavailableError` (ADR
    // 0003 §7: "one error class, closed codes") give this its own typed code, so it is now a
    // *handled*, debug-level error like any other expected domain refusal.
    it("logs an unconfigured doctor as a handled DOCTOR_UNAVAILABLE, not an unhandled error", async () => {
      const { logger: log, sink } = logger();
      const harness = await createHarness({ logger: log });
      const client = await createClient(harness.socketPath);
      await hello(client);

      await client.request("doctor.run", {});

      expect(sink.records).toContainEqual(
        expect.objectContaining({
          level: "debug",
          message: "Handled request error",
          fields: { code: "DOCTOR_UNAVAILABLE", type: "doctor.run" },
        }),
      );
      expect(sink.records).not.toContainEqual(
        expect.objectContaining({ level: "error", message: "Unhandled request error" }),
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
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(grant.ok).toBe(true);
    expect(driver.calls.find((call) => call.operation === "resolveSpec")?.arguments[1]).toEqual({
      allowDownload: true,
      requesterId: "agent-1",
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
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).toContain("downloads.policy");
    expect(driver.calls.find((call) => call.operation === "resolveSpec")?.arguments[1]).toEqual({
      allowDownload: false,
      requesterId: "agent-1",
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
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).not.toContain("downloads.policy");
    await client.close();
  });

  it("attaches the download-policy suffix under the never policy even when the request itself never asked for a download", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ clock, downloads: { policy: "never" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    // No allowDownload on this request at all -- the driver's own message still suggests
    // `--allow-download`, which under the never policy can never help, so the suffix must
    // still attach as the correction.
    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).toContain("downloads.policy");
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
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "12.0",
      platform: "ios",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).not.toContain("downloads.policy");
    await client.close();
  });
});

describe("DaemonServer full request flag", () => {
  it("parses request.full: true into a spec stamped full: true", async () => {
    // Stamping `full` is gated on the resolving driver declaring `reducesFeatures` -- without it
    // there is nothing to opt out of, so the flag would (correctly) leave the spec untouched and
    // this test would be asserting the wrong half of that contract.
    const harness = await createHarness({ reducesFeatures: true });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      full: true,
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(grant.ok).toBe(true);
    expect(
      (grant.payload as { device: { spec: Record<string, unknown> } }).device.spec,
    ).toMatchObject({ full: true });
    await client.close();
  });

  it("omits full from the spec when the request does not ask for it", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(grant.ok).toBe(true);
    expect(
      (grant.payload as { device: { spec: Record<string, unknown> } }).device.spec,
    ).not.toHaveProperty("full");
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
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
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
      requesterId: "agent-1",
      model: "Pixel 8",
      osVersion: "35",
      platform: "android",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "LICENSE_NOT_ACCEPTED" });
    await client.close();
  });
});

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

  // ADR 0003 §6's "frozen exception" for `daemon.stop` is scoped to the protocol-version gate
  // only -- it must still require a completed handshake and the `admin` role, per §3's operation
  // matrix and the ADR's Context section ("Any local connection can release any lease, nuke, or
  // stop the daemon" is named as the defect this ADR fixes).
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

    it("lets an admin connection stop the daemon", async () => {
      const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
      const client = await createClient(harness.socketPath);
      await hello(client);

      await expect(client.request("daemon.stop", {})).resolves.toMatchObject({
        ok: true,
        payload: { stopping: true },
      });
      await expect.poll(() => harness.daemon.health).toBe("running");
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

      // The handshake failed outright: `#handleHello` closes the connection right after the
      // rejected credential, before `connection.helloReceived` is ever set. `daemon.stop` --
      // despite ADR §6's frozen exception, which is scoped to protocol version only -- never
      // gets a chance to run on this connection: there is no connection left to run it on.
      await socketClosed;
      expect(harness.daemon.health).toBe("running");
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

      // Every other operation on this mismatched connection is refused the same way, repeatedly.
      await expect(client.request("status.get", {})).resolves.toMatchObject({
        error: { code: "PROTOCOL_VERSION_UNSUPPORTED" },
        ok: false,
      });
      await expect(client.request("list.get", {})).resolves.toMatchObject({
        error: { code: "PROTOCOL_VERSION_UNSUPPORTED" },
        ok: false,
      });

      // But `daemon.stop` -- the ADR §6 frozen exception -- still works, because the role was
      // resolved from the handshake before the version check ran, and this connection's role is
      // admin.
      await expect(client.request("daemon.stop", {})).resolves.toMatchObject({
        ok: true,
        payload: { stopping: true },
      });
      await expect.poll(() => harness.daemon.health).toBe("running");
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

  it("still lets an agent call doctor.run with fix:false, but not fix:true (input-dependent role)", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("doctor.run", { fix: false })).resolves.toMatchObject({
      // No `doctor` collaborator wired into this harness, so a fix:false call clears the
      // role gate and fails DOCTOR_UNAVAILABLE downstream -- proof the rejection was not
      // FORBIDDEN, which is the only thing this test cares about.
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

  it("forwards ttlMs as the initial TTL of any lease, and stores it as the lease's width", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "agent" } });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const granted = await client.request("lease.request", {
      ttlMs: 30_000,
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    expect(granted.ok).toBe(true);
    // ADR 0004 §4: `ttlMs` is accepted on every request -- it used to be `BAD_REQUEST` unless
    // the request also named `mode: "detached"` -- and the width it asks for is stored on the
    // record, which is what a later body-less renew re-applies.
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
    await client.close();
  });

  it("cancels a still-queued lease.cancel without closing the connection, and the original request settles rather than hanging", async () => {
    // Default harness capacity is one iOS device (see `testConfig`), so a second held request
    // for the same spec queues behind the first without any extra configuration.
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
    // The connection is still alive and usable after cancelling -- ADR §9: "Cancellation no
    // longer means closing the connection."
    await expect(waiter.request("status.get", {})).resolves.toMatchObject({ ok: true });

    await holder.close();
    await waiter.close();
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

    // A second, otherwise-idle connection sharing the same principal -- today's bug (fixed by
    // this PR) is that only the connection holding the lease ever learned of its end; a
    // detached lease has no "holding" connection at all, so this second connection previously
    // learned nothing.
    const observer = await createClient(harness.socketPath);
    await helloAs(observer, "alice");

    await expect(requester.request("lease.release", { leaseId })).resolves.toMatchObject({
      ok: true,
    });

    const push = await observer.nextFrame((frame) => frame.push === "lease-lost");
    expect(push.payload).toMatchObject({ leaseId, reason: "explicit" });
    // The releasing connection itself does not get a redundant self-push.
    expect(requester.frames().filter((frame) => frame.push === "lease-lost")).toEqual([]);

    await requester.close();
    await observer.close();
  });
});

async function helloAs(
  client: Client,
  principal: string,
  capabilities?: Record<string, unknown>,
): Promise<void> {
  await expect(
    client.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      principal,
      ...(capabilities === undefined ? {} : { capabilities }),
    }),
  ).resolves.toMatchObject({ ok: true });
}

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
    readonly dispose?: () => void | Promise<void>;
    readonly driver?: FakeDriver;
    readonly driverRejections?: readonly DriverRejection[];
    readonly logger?: Logger;
    /** Passed to the default `FakeDriver`; makes a `--full` request meaningful (see `Driver.reducesFeatures`). */
    readonly reducesFeatures?: boolean;
    /** Overrides the default single-iOS-device capacity limit; a test that needs two
     * concurrent iOS leases granted (rather than one queued behind the other) sets this. */
    readonly iosMaxDevices?: number;
    readonly settle?: () => Promise<void>;
    readonly stateFilesystem?: MemoryFilesystem;
    readonly stopAuxiliary?: () => Promise<void>;
    /** ADR 0003 §5's per-start admin secret (`AdminSecretManager`). Undefined by default, same
     * as `DaemonServer`'s own default -- most of this suite doesn't exercise the credential
     * handshake at all. A test that needs to observe `persist()`/`remove()` calls (or their
     * absence -- see the "loses the start race" test) injects a spy here. */
    readonly adminSecret?: AdminSecretManager;
    /** ADR 0003 §5's seam (see `session.ts`): defaults every session in this harness to
     * "admin" -- this suite predates roles and exercises every operation freely, the same
     * access a pre-ADR-0003 connection always had. Tests that specifically exercise role
     * enforcement (ADR §3) override this to get an "agent" (or mixed) session instead. */
    readonly resolveRole?: SessionRoleResolver;
    /** Overrides the `downloads` config block for tests that exercise the download policy. */
    readonly downloads?: Partial<Config["downloads"]>;
    /** Wires `device.exec`'s runner (ADR 0005 §19a); absent by default like the option itself. */
    readonly processRunner?: ProcessRunner;
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
      ...(options.reducesFeatures === undefined
        ? {}
        : { reducesFeatures: options.reducesFeatures }),
    });
  const config = testConfig(options.lease, options.downloads, options.iosMaxDevices);
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
    ...(options.adminSecret === undefined ? {} : { adminSecret: options.adminSecret }),
    capacity: engine,
    catalog: engine,
    clock,
    config,
    ...(options.converge === undefined ? {} : { converge: options.converge }),
    ...(options.driverRejections === undefined
      ? {}
      : { driverRejections: options.driverRejections }),
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
    passthrough: engine,
    ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    queue: engine,
    reaper,
    registry,
    resolveRole: options.resolveRole ?? { resolve: () => "admin" },
    settle: options.settle ?? (async () => engine.settle()),
    ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
    ...(options.stopAuxiliary === undefined ? {} : { stopAuxiliary: options.stopAuxiliary }),
    version: "test",
  });
  runningDaemons.push(daemon);
  if (options.start ?? true) {
    await daemon.start();
  }

  return { clock, config, daemon, driver, engine, eventBus, registry, socketPath, stateFilesystem };
}

/** A `FakeDriver` that claims the `simctl` wrapper, for the `device.exec` flows. */
function passthroughDriver(clock: FakeClock): FakeDriver {
  return new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    passthrough: (args: readonly string[]) => ({
      args: ["--set", "/root", ...args],
      command: "simctl",
      env: {},
    }),
    passthroughTool: "simctl",
    platform: "ios",
  });
}

/**
 * A `ProcessRunner` whose streamed child is driven by the test rather than scripted up front --
 * `ScriptedProcessRunner` emits every chunk at spawn, which cannot express "a chunk arrives
 * *after* the client disconnected", the case that matters here.
 */
class ControllableStreamingRunner implements ProcessRunner {
  handle: ControllableStreamingHandle | undefined;

  run(): Promise<never> {
    throw new Error("not used");
  }

  spawn(): never {
    throw new Error("not used");
  }

  spawnStreaming(
    _command: string,
    _args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    this.handle = new ControllableStreamingHandle(options.onChunk);
    return this.handle;
  }
}

class ControllableStreamingHandle implements StreamingProcessHandle {
  readonly pid = 4_242;
  settled = false;
  readonly #result: Promise<StreamingProcessResult>;
  #resolve!: (result: StreamingProcessResult) => void;

  constructor(private readonly onChunk: (stream: "stdout" | "stderr", chunk: string) => void) {
    this.#result = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  emit(stream: "stdout" | "stderr", chunk: string): void {
    this.onChunk(stream, chunk);
  }

  finish(code: number): void {
    this.settled = true;
    this.#resolve({ code, signal: null });
  }

  kill(): void {
    this.finish(0);
  }

  wait(): Promise<StreamingProcessResult> {
    return this.#result;
  }
}

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for a condition");
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
  iosMaxDevices = 1,
): Config {
  return {
    exec: { timeoutMs: 600_000 },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    drivers: {},
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
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: {
      defaultTtlMs: 60_000,
      maxTtlMs: 3_600_000,
      ...leaseOverrides,
    },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: iosMaxDevices, maxRunning: iosMaxDevices },
          maxRunning: iosMaxDevices + 1,
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
