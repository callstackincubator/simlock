import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeDriver } from "../core/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  CryptoIdGenerator,
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
        request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
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
