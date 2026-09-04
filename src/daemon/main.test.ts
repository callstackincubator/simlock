import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeDriver } from "../core/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  CryptoIdGenerator,
  CryptoTokenSecrets,
  FakeClock,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  ScriptedProcessRunner,
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

    const drivers = await discoverDrivers({
      clock: new FakeClock(),
      eventBus: new EventBus(new FakeClock()),
      filesystem,
      idGenerator: new CryptoIdGenerator(),
      logger,
      processRunner: new ScriptedProcessRunner([]),
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
});

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
      eventBus: new EventBus(new FakeClock()),
      filesystem: new MemoryFilesystem(),
      idGenerator: new CryptoIdGenerator(),
      logger,
      processRunner: new ScriptedProcessRunner([]),
    });
  }

  it("substitutes discovery with the module's createDrivers(context), logging the substitution", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers(context) {
         return [{ platform: "ios", fromModule: true, sawContext: typeof context.logger === "object" }];
       }`,
    );
    const sink = new MemoryLogSink();

    const drivers = await discover(sink);

    expect(drivers).toEqual([{ platform: "ios", fromModule: true, sawContext: true }]);
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

    await expect(discover(new MemoryLogSink())).resolves.toEqual([]);
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
