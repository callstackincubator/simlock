import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDriver, OWNED_ROOT_MARKER_FILE, type OwnedRootError } from "../core/index.js";
import { IosSimctlDriver } from "../drivers/ios/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  CryptoIdGenerator,
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  ScriptedProcessRunner,
  type IdGenerator,
} from "../ports/index.js";
import { discoverDrivers, startDaemon, type StartDaemonOptions } from "./main.js";
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

    const { drivers } = await discoverDrivers({
      clock: new FakeClock(),
      driversConfig: {},
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
