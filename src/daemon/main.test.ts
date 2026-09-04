import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDriver, OWNED_ROOT_MARKER_FILE, type OwnedRootError } from "../core/index.js";
import { IosSimctlDriver } from "../drivers/ios/index.js";
import { EventBus } from "../bus/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  CryptoIdGenerator,
  CryptoTokenSecrets,
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  ScriptedProcessRunner,
  type IdGenerator,
} from "../ports/index.js";
import {
  bridgeAndroidDriverDiagnostic,
  discoverDrivers,
  emitComponentInstallDiagnostic,
  emitSlimDiagnostic,
  startDaemon,
  wireComponentInstallLogging,
  type StartDaemonOptions,
} from "./main.js";
import type { DaemonServer } from "./server.js";

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function start(overrides: Partial<StartDaemonOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
  temporaryDirectories.push(directory);
  const sink = new MemoryLogSink();
  const clock = new FakeClock(1_000);
  const logger = new JsonLinesLogger({ clock, level: "debug", sink });
  const daemon = await startDaemon({
    clock,
    dataDirectory: directory,
    drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
    filesystem: new MemoryFilesystem(),
    logger,
    statePath: join(directory, "state.json"),
    version: "1.2.3",
    ...overrides,
  } as StartDaemonOptions);
  runningDaemons.push(daemon);
  return { daemon, sink };
}

/** A driver whose disposal is observable, which `FakeDriver` deliberately is not. */
class DisposableFakeDriver extends FakeDriver {
  constructor(
    private readonly disposed: string[],
    options: ConstructorParameters<typeof FakeDriver>[0],
    private readonly failure?: Error,
  ) {
    super(options);
  }

  async dispose(): Promise<void> {
    this.disposed.push(this.platform);
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }
}

describe("startDaemon", () => {
  it("writes a structured start record with version, protocol version, socket path, and effective config", async () => {
    const { daemon, sink } = await start();

    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Daemon started",
        fields: expect.objectContaining({
          version: "1.2.3",
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          socketPath: daemon.socketPath,
        }),
      }),
    );
    const record = sink.records.find((entry) => entry.message === "Daemon started");
    expect(record?.fields?.config).toMatchObject({ log: { level: "info" } });
  });

  it("establishes the instance identity once, and reuses it on the next start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-identity-"));
    temporaryDirectories.push(directory);
    const filesystem = new MemoryFilesystem();
    const identityPath = join(directory, "instance.json");

    const first = await start({ dataDirectory: directory, filesystem });
    const written = JSON.parse(await filesystem.readFile(identityPath)) as {
      readonly instanceId: string;
    };
    await first.daemon.stop("test");
    await start({ dataDirectory: directory, filesystem });

    // Never regenerated: a second id would strand every device already sitting in a root
    // marked with the first one (ADR 0001, decision 2).
    expect(written.instanceId).not.toBe("");
    expect(JSON.parse(await filesystem.readFile(identityPath))).toEqual(written);
  });

  it("disposes every driver on shutdown, and reports the one that failed without stopping", async () => {
    // The wiring, not the halves: `DaemonServer` awaiting its `dispose` option is tested in
    // `server.test.ts` and a driver reaping its adb server in the Android driver's own, and
    // between them sat the composition that connects the two. Losing it silently abandons
    // Simlock's adb server on every shutdown, and only `Driver.dispose` can stop one.
    const disposed: string[] = [];
    const clock = new FakeClock(1_000);
    const { daemon, sink } = await start({
      drivers: [
        new DisposableFakeDriver(disposed, {
          availableOsVersions: ["26.5"],
          clock,
          platform: "ios",
        }),
        new DisposableFakeDriver(
          disposed,
          { availableOsVersions: ["35"], clock, platform: "android" },
          new Error("adb server would not die"),
        ),
      ],
    });

    await daemon.stop("test");

    expect(disposed).toEqual(["ios", "android"]);
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Driver disposal failed",
        fields: expect.objectContaining({ platform: "android" }),
      }),
    );
  });

  it("scopes child loggers under daemon.<module> so records are attributable", async () => {
    const { sink } = await start();

    const modules = new Set(sink.records.map((record) => record.module));
    expect(modules).toContain("daemon.server");
    expect(modules).toContain("daemon.connection-host");
  });
});

describe("startDaemon startup readiness", () => {
  // Reproduces the issue #41 symptom end-to-end through the real startDaemon wiring:
  // doctor.reconcile() shells out to driver.listManaged() per driver, which is where
  // real convergence time is lost. Here it's held open on the FakeClock so the test
  // can prove the socket answers hello/status.get ("starting"), parks lease.request,
  // and only then converges -- without waiting on a real clock.
  it("claims the socket and answers hello/status.get while doctor.reconcile is still in flight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-slow-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const socketPath = join(directory, "daemon.sock");
    const startPromise = startDaemon({
      clock,
      dataDirectory: directory,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["26.5"],
          clock,
          latencyMs: { listManaged: 30_000 },
          platform: "ios",
        }),
      ],
      filesystem: new MemoryFilesystem(),
      socketPath,
      statePath: join(directory, "state.json"),
      version: "1.2.3",
    } as StartDaemonOptions).then((daemon) => {
      runningDaemons.push(daemon);
      return daemon;
    });

    const client = await connectRetrying(socketPath);
    try {
      await client.request("hello", {
        clientVersion: "test",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      });
      const starting = await client.request("status.get", {});
      expect(starting.payload).toMatchObject({ health: "starting" });

      const parkedLease = client.request("lease.request", {
        mode: "detached",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });
      let leaseSettled = false;
      void parkedLease.then(() => {
        leaseSettled = true;
      });
      // Round-tripping another status.get proves the parked request was already
      // dispatched (and is awaiting the readiness gate) without relying on a timer.
      await client.request("status.get", {});
      expect(leaseSettled).toBe(false);

      clock.advance(30_000);
      const daemon = await startPromise;
      expect(daemon).toBeDefined();

      await expect(parkedLease).resolves.toMatchObject({ ok: true });
      const running = await client.request("status.get", {});
      expect(running.payload).toMatchObject({ health: "running" });
    } finally {
      client.socket.end();
    }
  });
});

describe("startDaemon HTTP gateway startup readiness", () => {
  // ADR 0003 §2: "an HTTP request during startup now waits like a socket request instead of
  // being refused." Mirrors the socket-side test above (same FakeDriver latency trick to hold
  // convergence open on the FakeClock), but drives a real HTTP request instead of a socket
  // frame -- proving the gateway is actually listening (and its request actually parks) before
  // convergence finishes, not just that `dispatch()` would park it in principle.
  it("parks an HTTP request until convergence completes, instead of refusing the connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-http-slow-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const secrets = new CryptoTokenSecrets();
    const secret = "slk_test_agent";
    await filesystem.mkdirp(directory);
    await filesystem.writeFileAtomic(
      join(directory, "tokens.json"),
      JSON.stringify([
        { id: "tok_agent", hash: secrets.hash(secret), role: "agent", createdAt: 0 },
      ]),
    );
    const port = 47_011;

    const startPromise = startDaemon({
      clock,
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
      dataDirectory: directory,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["26.5"],
          clock,
          latencyMs: { listManaged: 30_000 },
          platform: "ios",
        }),
      ],
      filesystem,
      statePath: join(directory, "state.json"),
      version: "1.2.3",
    } as StartDaemonOptions).then((daemon) => {
      runningDaemons.push(daemon);
      return daemon;
    });

    // Polls rather than a fixed delay: the gateway binds asynchronously (`onSocketClaimed`
    // fires once the socket claim resolves, then `gateway.start()` itself awaits a real
    // `listen()`), so there is no single microtask boundary to await here the way the
    // socket-side test above can just retry-connect on the unix socket.
    const statusBeforeConvergence = await pollUntilListening(port, secret);
    expect(statusBeforeConvergence).toMatchObject({ health: "starting" });

    const parkedStatusPromise = fetch(`http://127.0.0.1:${port}/v1/leases`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    let settled = false;
    void parkedStatusPromise.then(() => {
      settled = true;
    });
    // Give the parked request's own microtasks a chance to run before asserting it hasn't --
    // it must still be awaiting `dispatch()`'s startup-readiness gate, not merely slow.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    clock.advance(30_000);
    const daemon = await startPromise;
    expect(daemon).toBeDefined();

    const parkedResponse = await parkedStatusPromise;
    expect(parkedResponse.status).toBe(200);
  });
});

describe("startDaemon HTTP gateway stop-during-start race (review finding S5)", () => {
  // Before this fix, `stopAuxiliary` (this file's `stopAuxiliary` closure passed to
  // `DaemonServer`) returned immediately whenever the concurrently-started HTTP gateway
  // (`onSocketClaimed` -> `startHttpGateway()`) hadn't finished its own `listen()` yet --
  // `stopHttpGateway` isn't assigned until it does. `#stop()` (server.ts) awaits
  // `stopAuxiliary()` first, so it would go on to release leases, settle, and dispose while the
  // gateway was still binding, then start accepting HTTP requests -- against a torn-down engine
  // -- once its own `listen()` finally resolved. The fix makes `stopAuxiliary` await
  // `gatewayStarted` (settled only once the gateway's own bind attempt finishes, one way or the
  // other) before doing anything else.
  //
  // The window this reproduces (`onSocketClaimed` firing to the gateway's `listen()` actually
  // resolving) is normally a handful of real milliseconds -- reachable, per the review, via
  // `simlock daemon stop` during startup, but not something a test can land inside reliably by
  // just racing real I/O against real I/O. So this test holds the window open deterministically
  // instead: it patches `net.Server.prototype.listen` (restored in `finally`) to delay only a
  // TCP bind (the gateway's) by 200ms, leaving the daemon's own Unix-socket `listen()` (a string
  // first argument, not a port) untouched -- so the socket claims and answers `daemon.stop`
  // long before the patched gateway bind is even allowed to start.
  it("never lets the HTTP gateway outlive full teardown when daemon.stop lands while the gateway is still mid-bind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-http-race-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", sink });
    const filesystem = new MemoryFilesystem();
    const port = 47_013;
    const socketPath = join(directory, "daemon.sock");

    const restoreListen = delayTcpListen(200);
    try {
      const startPromise = startDaemon({
        clock,
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        dataDirectory: directory,
        drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
        filesystem,
        logger,
        socketPath,
        statePath: join(directory, "state.json"),
        version: "1.2.3",
      } as StartDaemonOptions);
      // `stop()` is idempotent, so it is safe for `afterEach` to also stop whatever this
      // resolves to (it will, once the delayed gateway bind above finishes settling).
      void startPromise.then((daemon) => runningDaemons.push(daemon)).catch(() => undefined);

      // Connects and authenticates as admin, then sends `daemon.stop` -- comfortably inside the
      // 200ms window the patch above holds the gateway's own bind open for. The admin secret is
      // written (`AdminSecretManager#persist`) before `onSocketClaimed` fires, so it is already
      // there by the time the socket itself is reachable.
      const client = await connectRetrying(socketPath);
      const secret = (await readFileRetrying(filesystem, join(directory, "admin.token"))).trim();
      await client.request("hello", {
        clientVersion: "test",
        credential: secret,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      });
      const stopReply = await client.request("daemon.stop", {});
      expect(stopReply.ok).toBe(true);
      client.socket.end();

      // Lets the delayed gateway bind actually fire and settle (one way or the other) before
      // this test reads the log for it.
      await new Promise((resolve) => setTimeout(resolve, 400));

      const stoppingIndex = sink.records.findIndex(
        (record) => record.message === "Daemon stopping",
      );
      expect(stoppingIndex).toBeGreaterThanOrEqual(0);
      const gatewayStoppedIndex = sink.records.findIndex(
        (record) => record.message === "HTTP gateway stopped",
      );
      const gatewayListeningIndex = sink.records.findIndex(
        (record) => record.message === "HTTP gateway listening",
      );
      // The gateway actually got to bind (it does here -- the port is free and 200ms is ample
      // real time for a loopback `listen()`), so this asserts the meaningful case directly
      // rather than treating it as merely possible: it bound, and it was stopped, and both
      // happened strictly before "Daemon stopping" (logged only once `stopAuxiliary` resolves --
      // see `server.ts#stop`). Before the fix, `stoppingIndex` would be *smaller* than both of
      // these -- `stopAuxiliary` returned immediately, so "Daemon stopping" logged right away,
      // well before the (patch-delayed) gateway bind even started.
      expect(gatewayListeningIndex).toBeGreaterThanOrEqual(0);
      expect(gatewayListeningIndex).toBeLessThan(stoppingIndex);
      expect(gatewayStoppedIndex).toBeGreaterThanOrEqual(0);
      expect(gatewayStoppedIndex).toBeLessThan(stoppingIndex);

      // And the port must never be reachable once the daemon has finished stopping -- the
      // gateway did not outlive teardown just because it bound after `stop()` was requested.
      await expect(
        fetch(`http://127.0.0.1:${port}/v1/status`, {
          headers: { authorization: "Bearer irrelevant" },
          signal: AbortSignal.timeout(200),
        }),
      ).rejects.toThrow();
    } finally {
      restoreListen();
    }
  });
});

describe("startDaemon socket race with HTTP enabled", () => {
  // Review finding V1: `gatewayStarted` is settled only from inside `onSocketClaimed`'s
  // handler, and `start()` fires that callback only after the socket claim succeeds. A daemon
  // that loses the start race therefore rejected without the callback ever running, so nothing
  // settled `gatewayStarted` and `Promise.allSettled` waited on it forever -- `startDaemon()`
  // hung instead of reporting the lost race, with no rejection and no non-zero exit code.
  // Reachable by racing `simlock daemon start`, or by the CLI's own auto-launch.
  it("rejects rather than hanging when the socket is already claimed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-socket-race-"));
    temporaryDirectories.push(directory);
    const filesystem = new MemoryFilesystem();
    const statePath = join(directory, "state.json");
    const options = (port: number): StartDaemonOptions =>
      ({
        clock: new FakeClock(1_000),
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        dataDirectory: directory,
        drivers: [
          new FakeDriver({
            availableOsVersions: ["26.5"],
            clock: new FakeClock(1_000),
            platform: "ios",
          }),
        ],
        filesystem,
        logger: new JsonLinesLogger({
          clock: new FakeClock(1_000),
          level: "debug",
          sink: new MemoryLogSink(),
        }),
        statePath,
        version: "1.2.3",
      }) as StartDaemonOptions;

    const first = await startDaemon(options(47_013));
    try {
      // A distinct port, so the only thing that can fail is the socket claim itself.
      const second = startDaemon(options(47_014));
      const outcome = await Promise.race([
        second.then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3_000)),
      ]);
      expect(outcome).toBe("rejected");
    } finally {
      await first.stop("test-cleanup").catch(() => undefined);
    }
  });
});

describe("startDaemon HTTP gateway bind failure", () => {
  // Review finding B6: before this fix, an HTTP bind failure (occupied port) logged and
  // stopped the daemon from inside `onSocketClaimed`'s handler without `startDaemon()` itself
  // ever seeing it -- the daemon's own `start()` would go on to resolve successfully once
  // convergence finished, so the CLI reported success (exit code 0) with no socket, no HTTP,
  // and no daemon actually running. This proves `startDaemon()` now rejects instead, and that
  // the daemon never reports having started after it already reported stopping.
  it("rejects startDaemon() when the configured HTTP port is already in use, without emitting a started record after a stopping one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-http-bind-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", sink });
    const filesystem = new MemoryFilesystem();
    const port = 47_012;

    const occupier = createServer();
    await new Promise<void>((resolve) => occupier.listen(port, "127.0.0.1", resolve));
    try {
      await expect(
        startDaemon({
          clock,
          configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
          dataDirectory: directory,
          drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
          filesystem,
          logger,
          statePath: join(directory, "state.json"),
          version: "1.2.3",
        } as StartDaemonOptions),
      ).rejects.toThrow(/EADDRINUSE|address already in use/i);
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }

    const startedIndex = sink.records.findIndex((record) => record.message === "Daemon started");
    const stoppingIndex = sink.records.findIndex((record) => record.message === "Daemon stopping");
    expect(stoppingIndex).toBeGreaterThanOrEqual(0);
    // Either "Daemon started" never appears (the common case: the bind failure is discovered
    // and the whole thing torn down without convergence ever seeing readiness), or -- if
    // convergence happened to finish first -- it appears strictly before "Daemon stopping",
    // never after (ADR events rule 3: a fact must be true when emitted).
    if (startedIndex >= 0) {
      expect(startedIndex).toBeLessThan(stoppingIndex);
    }
  });
});

async function pollUntilListening(port: number, secret: string): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      return await response.json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("HTTP gateway never started listening");
}

describe("discoverDrivers", () => {
  it("logs a skip when the Android SDK cannot be found, without throwing", async () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink });
    const filesystem = new MemoryFilesystem();

    const { drivers } = await discoverDrivers({
      clock: new FakeClock(),
      driversConfig: {},
      eventBus: new EventBus(new FakeClock()),
      filesystem,
      hostPlatform: "linux",
      idGenerator: new CryptoIdGenerator(),
      instanceId: "instance-1",
      logger,
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
      simlockHome: "/home/.simlock",
      tcpProbe: new FakeTcpProbe(),
    });

    expect(drivers.some((driver) => driver.platform === "android")).toBe(false);
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Skipped Android driver: SDK missing",
        module: "daemon.driver-discovery",
      }),
    );
  });

  it("does not look for simulators on a host that has no simctl", async () => {
    const { drivers, rejections } = await discoverIos({ hostPlatform: "linux" });

    expect(drivers.some((driver) => driver.platform === "ios")).toBe(false);
    // Nothing refused anything here: a host without Xcode is not a fail-closed refusal
    // and must not be reported as one.
    expect(rejections).toEqual([]);
  });

  it("starts the iOS driver on a host with simctl, with the root it validated", async () => {
    const filesystem = new MemoryFilesystem();

    const { drivers, rejections } = await discoverIos({ filesystem });

    expect(rejections).toEqual([]);
    expect(drivers.find((driver) => driver.platform === "ios")?.deviceRoot).toBe(IOS_ROOT);
  });

  it("keeps the daemon up when the iOS device root is refused, reporting the platform instead", async () => {
    const filesystem = await foreignOwnedRoot();

    const { drivers, rejections } = await discoverIos({ filesystem });

    // Safety rule 9: the platform goes, the daemon stays -- a daemon that will not start
    // is a daemon that cannot tell anyone why.
    expect(drivers.some((driver) => driver.platform === "ios")).toBe(false);
    expect(rejections.map((rejection) => rejection.platform)).toEqual(["ios"]);
  });

  it("publishes the refusal as the payload docs/EVENTS.md documents for driver.root-rejected", async () => {
    const filesystem = await foreignOwnedRoot();
    const refusal = await refusedRoot(filesystem);

    const { rejections } = await discoverIos({ filesystem });

    // Built from a real `OwnedRootError`, key by key: the payload is a wire contract
    // `simlock events --json` publishes, so renaming `root` has to fail here.
    expect(rejections[0]).toEqual({
      event: "driver.root-rejected",
      // The wrapper this platform would have answered to, so `simlock simctl` can say why
      // it is missing instead of reading as "this host has no Xcode".
      passthroughTool: "simctl",
      payload: { platform: "ios", reason: "wrong-instance", root: IOS_ROOT },
      platform: "ios",
      reason: "wrong-instance",
      summary: refusal.message,
    });
  });

  it("logs the refused root, so the reason survives even if nobody runs doctor", async () => {
    const sink = new MemoryLogSink();

    await discoverIos({ filesystem: await foreignOwnedRoot(), sink });

    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Skipped iOS driver: device root rejected",
        module: "daemon.driver-discovery",
        fields: expect.objectContaining({ reason: "wrong-instance", root: IOS_ROOT }),
      }),
    );
  });

  it("still fails startup when the iOS driver fails for a reason that is not a refusal", async () => {
    // Anything that is not an `OwnedRootError` is a bug rather than a fail-closed
    // decision, and swallowing it would hide it behind a silently missing platform.
    await expect(
      discoverIos({
        idGenerator: {
          generate: () => {
            throw new Error("entropy exhausted");
          },
        },
      }),
    ).rejects.toThrow("entropy exhausted");
  });
});

describe("discoverDrivers on a host with an Android SDK", () => {
  const previousAndroidHome = process.env.ANDROID_HOME;

  afterEach(() => {
    if (previousAndroidHome === undefined) {
      delete process.env.ANDROID_HOME;
    } else {
      process.env.ANDROID_HOME = previousAndroidHome;
    }
  });

  it("keeps the daemon up when Simlock's adb port is occupied, reporting the platform instead", async () => {
    const filesystem = await androidSdk();

    const { drivers, rejections } = await discoverAndroid(filesystem, new FakeTcpProbe([5038]));

    expect(drivers.some((driver) => driver.platform === "android")).toBe(false);
    // The payload is a wire contract `simlock events --json` publishes for
    // `driver.adb-server-rejected`, so a renamed key has to fail here.
    expect(rejections[0]).toMatchObject({
      event: "driver.adb-server-rejected",
      payload: { port: 5038, reason: "occupied" },
      platform: "android",
      reason: "occupied",
    });
  });

  it("starts the Android driver on its own root once its adb server is established", async () => {
    const filesystem = await androidSdk();
    const probe = new FakeTcpProbe([5038]);
    await filesystem.mkdirp(SIMLOCK_HOME);
    // The server a previous daemon left behind, with the pid that proves it is Simlock's.
    await filesystem.writeFileAtomic(
      join(SIMLOCK_HOME, "adb-server.json"),
      JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
    );

    const { drivers, rejections } = await discoverAndroid(filesystem, probe, [4242]);

    expect(rejections).toEqual([]);
    expect(drivers.find((driver) => driver.platform === "android")?.deviceRoot).toBe(
      join(SIMLOCK_HOME, "devices", "android"),
    );
  });

  /** The minimum layout `discoverSdk` accepts, in memory. */
  async function androidSdk(): Promise<MemoryFilesystem> {
    const filesystem = new MemoryFilesystem();
    process.env.ANDROID_HOME = "/android-sdk";
    for (const binary of [
      "/android-sdk/platform-tools/adb",
      "/android-sdk/emulator/emulator",
      "/android-sdk/cmdline-tools/latest/bin/avdmanager",
      "/android-sdk/cmdline-tools/latest/bin/sdkmanager",
    ]) {
      await filesystem.mkdirp(binary.slice(0, binary.lastIndexOf("/")));
      await filesystem.writeFileAtomic(binary, "binary");
    }
    return filesystem;
  }

  function discoverAndroid(
    filesystem: MemoryFilesystem,
    tcpProbe: FakeTcpProbe,
    livePids: readonly number[] = [],
  ) {
    return discoverDrivers({
      clock: new FakeClock(),
      driversConfig: {},
      eventBus: new EventBus(new FakeClock()),
      filesystem,
      hostPlatform: "linux",
      idGenerator: new CryptoIdGenerator(),
      instanceId: INSTANCE_ID,
      logger: new JsonLinesLogger({
        clock: new FakeClock(),
        level: "debug",
        sink: new MemoryLogSink(),
      }),
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(livePids),
      simlockHome: SIMLOCK_HOME,
      tcpProbe,
    });
  }
});

const SIMLOCK_HOME = "/home/.simlock";
const IOS_ROOT = join(SIMLOCK_HOME, "devices", "ios");
const INSTANCE_ID = "instance-1";

/** A root marked by a different Simlock instance -- the cheapest real `OwnedRootError`. */
async function foreignOwnedRoot(): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(IOS_ROOT);
  await filesystem.writeFileAtomic(
    join(IOS_ROOT, OWNED_ROOT_MARKER_FILE),
    JSON.stringify({
      instanceId: "someone-else",
      owner: "simlock",
      platform: "ios",
      schemaVersion: 1,
    }),
  );
  return filesystem;
}

/** The very `OwnedRootError` the driver raises for that root, never a hand-written copy. */
async function refusedRoot(filesystem: MemoryFilesystem): Promise<OwnedRootError> {
  try {
    await IosSimctlDriver.create({
      clock: new FakeClock(),
      driverConfig: {},
      filesystem,
      idGenerator: new CryptoIdGenerator(),
      instanceId: INSTANCE_ID,
      processRunner: new ScriptedProcessRunner([]),
      simlockHome: SIMLOCK_HOME,
    });
  } catch (error: unknown) {
    return error as OwnedRootError;
  }
  throw new Error("expected the iOS device root to be refused");
}

/** Discovery as it runs on a Mac, with the host platform supplied rather than sniffed. */
function discoverIos(
  overrides: {
    readonly filesystem?: MemoryFilesystem;
    readonly hostPlatform?: NodeJS.Platform;
    readonly idGenerator?: IdGenerator;
    readonly sink?: MemoryLogSink;
  } = {},
) {
  return discoverDrivers({
    clock: new FakeClock(),
    driversConfig: {},
    eventBus: new EventBus(new FakeClock()),
    filesystem: overrides.filesystem ?? new MemoryFilesystem(),
    hostPlatform: overrides.hostPlatform ?? "darwin",
    idGenerator: overrides.idGenerator ?? new CryptoIdGenerator(),
    instanceId: INSTANCE_ID,
    logger: new JsonLinesLogger({
      clock: new FakeClock(),
      level: "debug",
      sink: overrides.sink ?? new MemoryLogSink(),
    }),
    processRunner: new ScriptedProcessRunner([]),
    processSupervisor: new FakeProcessSupervisor(),
    simlockHome: SIMLOCK_HOME,
    tcpProbe: new FakeTcpProbe(),
  });
}

describe("component install diagnostic bridging", () => {
  it("emits component.install-started/-installed/-failed for the bridged platform", () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const seen: unknown[] = [];
    eventBus.subscribeAll((envelope) => seen.push(envelope));
    const bridge = emitComponentInstallDiagnostic(eventBus, "ios");

    bridge({ componentId: "18.6", kind: "component-install-started" });
    bridge({ componentId: "18.6", durationMs: 42_000, kind: "component-installed" });
    bridge({
      componentId: "18.6",
      durationMs: 5_000,
      error: "DriverCrashError: xcodebuild failed",
      kind: "component-install-failed",
    });

    expect(seen).toEqual([
      expect.objectContaining({
        event: "component.install-started",
        module: "driver-diagnostics",
        payload: { componentId: "18.6", platform: "ios" },
      }),
      expect.objectContaining({
        event: "component.installed",
        module: "driver-diagnostics",
        payload: { componentId: "18.6", durationMs: 42_000, platform: "ios" },
      }),
      expect.objectContaining({
        event: "component.install-failed",
        module: "driver-diagnostics",
        payload: {
          componentId: "18.6",
          durationMs: 5_000,
          error: "DriverCrashError: xcodebuild failed",
          platform: "ios",
        },
      }),
    ]);
  });

  it("carries requesterId onto the bridged event when the diagnostic knows one, and omits it when it doesn't", () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const seen: unknown[] = [];
    eventBus.subscribeAll((envelope) => seen.push(envelope));
    const bridge = emitComponentInstallDiagnostic(eventBus, "ios");

    bridge({ componentId: "18.6", kind: "component-install-started", requesterId: "agent-1" });
    bridge({ componentId: "18.6", kind: "component-install-started" });

    expect(seen).toEqual([
      expect.objectContaining({
        event: "component.install-started",
        payload: { componentId: "18.6", platform: "ios", requesterId: "agent-1" },
      }),
      expect.objectContaining({
        event: "component.install-started",
        payload: { componentId: "18.6", platform: "ios" },
      }),
    ]);
  });

  it("forwards only component-install-* diagnostics from the Android driver's broader onDiagnostic surface", () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const seen: unknown[] = [];
    eventBus.subscribeAll((envelope) => seen.push(envelope));
    const bridge = bridgeAndroidDriverDiagnostic(eventBus);

    bridge({ avdName: "simlock_1", kind: "snapshot-cold-boot", readyAfterMs: 15_000 });
    bridge({
      kind: "device-profile-source-unreadable",
      path: "/x/.android/devices.xml",
      reason: "parse-error",
    });
    bridge({
      componentId: "system-images;android-35;google_apis;arm64-v8a",
      kind: "component-install-started",
    });

    expect(seen).toEqual([
      expect.objectContaining({
        event: "component.install-started",
        payload: {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          platform: "android",
        },
      }),
    ]);
  });
});

describe("slim diagnostic bridging", () => {
  it("emits device.slimmed with the driver-diagnostics module for a SlimmedFact", () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const seen: unknown[] = [];
    eventBus.subscribeAll((envelope) => seen.push(envelope));
    const bridge = emitSlimDiagnostic(eventBus);

    bridge({
      address: "simlock-ios-1-address",
      categories: ["siri", "spotlight"],
      deviceId: "simlock-ios-1",
      durationMs: 12_000,
      labelCount: 170,
      signature: "sig-abc123",
      unknownLabels: ["com.apple.unknown-daemon"],
    });

    expect(seen).toEqual([
      expect.objectContaining({
        event: "device.slimmed",
        module: "driver-diagnostics",
        payload: {
          address: "simlock-ios-1-address",
          categories: ["siri", "spotlight"],
          deviceId: "simlock-ios-1",
          durationMs: 12_000,
          labelCount: 170,
          platform: "ios",
          signature: "sig-abc123",
          unknownLabels: ["com.apple.unknown-daemon"],
        },
      }),
    ]);
  });
});

describe("wireComponentInstallLogging", () => {
  it('writes a durable structured log line under logger.child("components") when component.installed fires', () => {
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", sink });
    const eventBus = new EventBus(clock);

    wireComponentInstallLogging(eventBus, logger);
    eventBus.emit(
      "component.installed",
      { componentId: "18.6", durationMs: 42_000, platform: "ios" },
      "driver-diagnostics",
    );

    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Component installed",
        module: "daemon.components",
        fields: { componentId: "18.6", durationMs: 42_000, platform: "ios" },
      }),
    );
  });

  it("includes requesterId in the durable log line when the event carries one", () => {
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", sink });
    const eventBus = new EventBus(clock);

    wireComponentInstallLogging(eventBus, logger);
    eventBus.emit(
      "component.installed",
      { componentId: "18.6", durationMs: 42_000, platform: "ios", requesterId: "agent-1" },
      "driver-diagnostics",
    );

    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Component installed",
        module: "daemon.components",
        fields: {
          componentId: "18.6",
          durationMs: 42_000,
          platform: "ios",
          requesterId: "agent-1",
        },
      }),
    );
  });

  it("does not log for component.install-started or component.install-failed", () => {
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", sink });
    const eventBus = new EventBus(clock);

    wireComponentInstallLogging(eventBus, logger);
    eventBus.emit(
      "component.install-started",
      { componentId: "18.6", platform: "ios" },
      "driver-diagnostics",
    );
    eventBus.emit(
      "component.install-failed",
      { componentId: "18.6", durationMs: 1_000, error: "boom", platform: "ios" },
      "driver-diagnostics",
    );

    expect(sink.records).toEqual([]);
  });

  it('writes a durable structured log line under logger.child("slim") when device.slimmed fires', () => {
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", sink });
    const eventBus = new EventBus(clock);

    wireComponentInstallLogging(eventBus, logger);
    eventBus.emit(
      "device.slimmed",
      {
        address: "simlock-ios-1-address",
        categories: ["siri", "spotlight"],
        deviceId: "simlock-ios-1",
        durationMs: 12_000,
        labelCount: 170,
        platform: "ios",
        signature: "sig-abc123",
        unknownLabels: [],
      },
      "driver-diagnostics",
    );

    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Device slimmed",
        module: "daemon.slim",
        fields: {
          categories: ["siri", "spotlight"],
          deviceId: "simlock-ios-1",
          durationMs: 12_000,
          labelCount: 170,
          signature: "sig-abc123",
          unknownLabels: [],
        },
      }),
    );
  });
});

describe("discoverDrivers with SIMLOCK_DRIVERS_MODULE", () => {
  const previousModule = process.env.SIMLOCK_DRIVERS_MODULE;

  afterEach(() => {
    if (previousModule === undefined) {
      delete process.env.SIMLOCK_DRIVERS_MODULE;
    } else {
      process.env.SIMLOCK_DRIVERS_MODULE = previousModule;
    }
  });

  async function writeModule(contents: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "simlock-drivers-module-"));
    temporaryDirectories.push(directory);
    const modulePath = join(directory, "drivers.mjs");
    await writeFile(modulePath, contents, "utf8");
    return modulePath;
  }

  async function discover(sink: MemoryLogSink) {
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink });
    return discoverDrivers({
      clock: new FakeClock(),
      driversConfig: {},
      eventBus: new EventBus(new FakeClock()),
      filesystem: new MemoryFilesystem(),
      hostPlatform: "linux",
      idGenerator: new CryptoIdGenerator(),
      instanceId: "instance-1",
      logger,
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
      simlockHome: "/home/.simlock",
      tcpProbe: new FakeTcpProbe(),
    });
  }

  it("substitutes discovery with the module's createDrivers(context), logging the substitution", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers(context) {
         return [{ platform: "ios", fromModule: true, sawContext: typeof context.logger === "object" }];
       }`,
    );
    const sink = new MemoryLogSink();

    const { drivers, rejections } = await discover(sink);

    expect(drivers).toEqual([{ platform: "ios", fromModule: true, sawContext: true }]);
    expect(rejections).toEqual([]);
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Substituting driver discovery via SIMLOCK_DRIVERS_MODULE",
        module: "daemon.driver-discovery",
      }),
    );
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Loaded drivers from SIMLOCK_DRIVERS_MODULE",
        module: "daemon.driver-discovery",
        fields: expect.objectContaining({ count: 1 }),
      }),
    );
  });

  it("supports a synchronous createDrivers returning an array directly", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers() { return []; }`,
    );

    await expect(discover(new MemoryLogSink())).resolves.toEqual({ drivers: [], rejections: [] });
  });

  it("fails loudly when the module has no createDrivers export", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(`export const nope = 1;`);

    await expect(discover(new MemoryLogSink())).rejects.toThrow(/createDrivers/);
  });

  it("fails loudly when the module cannot be imported", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = join(
      tmpdir(),
      "simlock-drivers-module-does-not-exist.mjs",
    );

    await expect(discover(new MemoryLogSink())).rejects.toThrow();
  });
});
interface MinimalClient {
  readonly socket: import("node:net").Socket;
  request(
    type: string,
    payload: unknown,
  ): Promise<{ readonly ok: boolean; readonly payload?: unknown }>;
}

/** Minimal newline-delimited-JSON client, mirroring the real daemon protocol framing. */
function connectClient(socketPath: string): Promise<MinimalClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let nextId = 1;
    const waiters = new Map<string, (frame: { ok: boolean; payload?: unknown }) => void>();
    socket.once("connect", () => {
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          const frame = JSON.parse(line) as { id?: string; ok: boolean; payload?: unknown };
          if (typeof frame.id === "string") {
            waiters.get(frame.id)?.(frame);
            waiters.delete(frame.id);
          }
        }
      });
      resolve({
        socket,
        request: (type, payload) =>
          new Promise((resolveRequest) => {
            const id = `req-${String(nextId)}`;
            nextId += 1;
            waiters.set(id, resolveRequest);
            socket.write(`${JSON.stringify({ id, payload, type })}\n`);
          }),
      });
    });
    socket.once("error", reject);
  });
}

async function connectRetrying(socketPath: string, timeoutMs = 2_000): Promise<MinimalClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await connectClient(socketPath);
    } catch (error: unknown) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** Delays every TCP `listen()` call (a numeric or options-object port, as HTTP servers use) by
 * `delayMs`, real time, via `setTimeout` -- but passes a Unix-socket `listen(path, callback)`
 * call (a string first argument) straight through unpatched. Used only by the S5 race test
 * above to hold the HTTP gateway's own bind open deterministically without touching `src/http`
 * -- `@hono/node-server`'s `serve()` ultimately calls `http.Server#listen`, which is `net.Server`'s
 * own method (Node's `http` module does not override it), so patching it here reaches the
 * gateway's real bind call. Returns a restorer; always call it, even on failure. */
function delayTcpListen(delayMs: number): () => void {
  const original = Server.prototype.listen;
  type ListenFn = (...callArgs: unknown[]) => Server;
  Server.prototype.listen = function patchedListen(this: Server, ...args: unknown[]) {
    const isTcp =
      typeof args[0] === "number" ||
      (typeof args[0] === "object" && args[0] !== null && !("path" in (args[0] as object)));
    if (!isTcp) {
      return (original as ListenFn).apply(this, args);
    }
    setTimeout(() => {
      (original as ListenFn).apply(this, args);
    }, delayMs);
    return this;
  } as typeof Server.prototype.listen;
  return () => {
    Server.prototype.listen = original;
  };
}

/** Polls a `MemoryFilesystem` path with no backoff -- used to read `admin.token` the moment
 * `AdminSecretManager#persist` lands it, without adding artificial delay to a test that is
 * deliberately racing that write's timing against something else (see the S5 race test). */
async function readFileRetrying(
  filesystem: MemoryFilesystem,
  path: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await filesystem.readFile(path);
    } catch (error: unknown) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
