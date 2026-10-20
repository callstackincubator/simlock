import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type Config,
  DriverCrashError,
  type DriverToolVersion,
  OWNED_ROOT_MARKER_FILE,
  type OwnedRootError,
  REDACTED_VALUE,
  registryOwner,
} from "../core/index.js";
import { agentDeviceModule } from "../agent-device/definition.js";
import { agentDeviceModuleWith, FakeAgentDeviceHealth } from "../agent-device/testing.js";
import {
  FakeDriver,
  fakeDeviceDataTable,
  fakeDeviceDataTables,
  loadTestRegistry,
} from "../core/testing.js";
import { seedTokensDatabase } from "../auth/testing.js";
import { openStateDatabase } from "../state/index.js";
import { fakeModule, type FakeModule } from "../modules/testing.js";
import { androidDeviceDataTable } from "../drivers/android/index.js";
import { IosSimctlDriver, iosDeviceDataTable } from "../drivers/ios/index.js";
import { EventBus, type EventEnvelope } from "../bus/index.js";
import { readHistoryEvents, seedHistory } from "../history/testing.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  CryptoIdGenerator,
  FakeClock,
  FakeHostInfo,
  FakeHostLoadProbe,
  type HostLoadCounters,
  FakeProcessSupervisor,
  FakeSystemStats,
  FakeTcpProbe,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  NodeSqliteOpener,
  NoopLogger,
  ScriptedProcessRunner,
  type IdGenerator,
} from "../ports/index.js";
import {
  deviceModeWiring,
  modelPreferenceWiring,
  discoverDrivers,
  productionDeviceDataTables,
  resolveDeviceDataTables,
  emitSlimDiagnostic,
  parseDaemonArgv,
  processRunnerFor,
  startDaemon,
  type DriverDiscoveryContext,
  type StartDaemonOptions,
} from "./main.js";
import type { OptionalModuleDefinition } from "../modules/index.js";
import type { DaemonServer } from "./server.js";

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

/** `drivers: undefined` is spelled out by a caller that wants real (module-substituted)
 * discovery rather than the fake driver below. */
async function start(
  overrides: Partial<Omit<StartDaemonOptions, "deviceDataTables" | "drivers">> & {
    readonly deviceDataTables?: StartDaemonOptions["deviceDataTables"] | undefined;
    readonly drivers?: StartDaemonOptions["drivers"] | undefined;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
  temporaryDirectories.push(directory);
  const sink = new MemoryLogSink();
  const clock = new FakeClock(1_000);
  const logger = new JsonLinesLogger({ clock, level: "debug", sink });
  const daemon = await startDaemon({
    clock,
    dataDirectory: directory,
    drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
    deviceDataTables: fakeDeviceDataTables,
    filesystem: new MemoryFilesystem(),
    hostLoadProbe: null,
    logger,
    version: "1.2.3",
    ...overrides,
  } as StartDaemonOptions);
  runningDaemons.push(daemon);
  return { daemon, directory, sink };
}

describe("interrupted writes", () => {
  it("startup followed by doctor --fix removes dead-pid .tmp files beside config.json and instance.json while preserving live-pid files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-interrupted-write-"));
    temporaryDirectories.push(directory);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(directory);
    const deadPid = 41001;
    const livePid = 41002;
    const processSupervisor = new FakeProcessSupervisor([livePid]);
    const writeId = "00000000-0000-4000-8000-000000000001";
    const leftovers = ["config.json", "instance.json"].flatMap((target) =>
      [deadPid, livePid].map((pid) => ({
        path: join(directory, `.${target}.${pid}.${writeId}.tmp`),
        pid,
        contents: `interrupted ${target} write by ${pid}`,
      })),
    );
    for (const leftover of leftovers) {
      await filesystem.writeFileAtomic(leftover.path, leftover.contents, { mode: 0o600 });
    }

    const { daemon } = await start({
      dataDirectory: directory,
      filesystem,
      processSupervisor,
    });
    await daemon.dispatch(
      "doctor.run",
      { fix: true },
      {
        manageEventSubscription: () => undefined,
        principal: "operator",
        via: "socket",
        role: "admin",
      },
    );

    for (const leftover of leftovers.filter(({ pid }) => pid === livePid)) {
      expect(await filesystem.readFile(leftover.path)).toBe(leftover.contents);
    }
    const remaining = await Promise.all(
      leftovers.map(async ({ path, pid }) => ({
        path,
        exists: await filesystem.exists(path),
        writerAlive: processSupervisor.isAlive(pid),
      })),
    );
    expect(remaining).toEqual(
      leftovers.map(({ path, pid }) => ({
        path,
        exists: pid === livePid,
        writerAlive: pid === livePid,
      })),
    );
  });
});

describe("interrupted root assembly", () => {
  async function startWithRoot(
    filesystem: MemoryFilesystem,
    processSupervisor: FakeProcessSupervisor,
  ) {
    const directory = await mkdtemp(join(tmpdir(), "simlock-interrupted-staging-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const devices = join(SIMLOCK_HOME, "devices");
    const deviceRoot = join(devices, "ios");
    await filesystem.mkdirp(devices);
    const driver = Object.assign(
      new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
      {
        deviceRoot,
      },
    );
    const result = await start({
      dataDirectory: directory,
      drivers: [driver],
      filesystem,
      processSupervisor,
    });
    return { ...result, devices };
  }

  async function stage(filesystem: MemoryFilesystem, devices: string, name: string) {
    const path = join(devices, name);
    await filesystem.mkdirp(path);
    await filesystem.writeFileAtomic(join(path, "marker.json"), "{}");
    return path;
  }

  it("startup removes a staging directory named for a dead pid and keeps one named for a live pid", async () => {
    const filesystem = new MemoryFilesystem();
    const devices = join(SIMLOCK_HOME, "devices");
    await filesystem.mkdirp(devices);
    const dead = await stage(filesystem, devices, ".ios.41003.root-id.staging");
    const live = await stage(filesystem, devices, ".ios.41004.root-id.staging");

    await startWithRoot(filesystem, new FakeProcessSupervisor([41004]));

    expect([await filesystem.exists(dead), await filesystem.exists(live)]).toEqual([false, true]);
  });

  it("startup leaves a pid-less legacy staging directory in place and logs it once", async () => {
    const filesystem = new MemoryFilesystem();
    const devices = join(SIMLOCK_HOME, "devices");
    await filesystem.mkdirp(devices);
    const legacy = await stage(filesystem, devices, ".ios.root-id.staging");

    const { sink } = await startWithRoot(filesystem, new FakeProcessSupervisor());

    expect(await filesystem.exists(legacy)).toBe(true);
    expect(
      sink.records.filter(
        (record) =>
          record.message === "left a legacy staging directory in place" &&
          (record.fields as { path?: string } | undefined)?.path === legacy,
      ),
    ).toHaveLength(1);
  });

  it("startup leaves a directory of the user's own that only looks like a staging directory", async () => {
    const filesystem = new MemoryFilesystem();
    const devices = join(SIMLOCK_HOME, "devices");
    await filesystem.mkdirp(devices);
    const theirs = await stage(filesystem, devices, ".photos.2023.backup.staging");

    await startWithRoot(filesystem, new FakeProcessSupervisor());

    expect(await filesystem.exists(theirs)).toBe(true);
  });

  it("startup leaves a .tmp-named file of the user's own beside a device root", async () => {
    const filesystem = new MemoryFilesystem();
    const devices = join(SIMLOCK_HOME, "devices");
    await filesystem.mkdirp(devices);
    const theirs = join(devices, ".notes.41006.0b9f6c1e-6a4d-4c43-9d0e-3f2a1b7c8d90.tmp");
    await filesystem.writeFileAtomic(theirs, "mine");

    await startWithRoot(filesystem, new FakeProcessSupervisor());

    expect(await filesystem.exists(theirs)).toBe(true);
  });

  it("startup leaves a dead writer's leftover that another user owns", async () => {
    const filesystem = new MemoryFilesystem();
    const devices = join(SIMLOCK_HOME, "devices");
    await filesystem.mkdirp(devices);
    const foreign = await stage(filesystem, devices, ".ios.41005.root-id.staging");
    filesystem.defineAttributes(foreign, { uid: (process.getuid?.() ?? 0) + 1 });

    await startWithRoot(filesystem, new FakeProcessSupervisor());

    expect(await filesystem.exists(foreign)).toBe(true);
  });
});

async function historyEventsWhen(
  directory: string,
  done: (events: readonly EventEnvelope[]) => boolean,
): Promise<EventEnvelope[]> {
  let events: EventEnvelope[] = [];
  await vi.waitFor(
    async () => {
      events = await readHistoryEvents(directory);
      expect(done(events)).toBe(true);
    },
    { timeout: 4_000 },
  );
  return events;
}

const hasEvent =
  (name: string) =>
  (events: readonly EventEnvelope[]): boolean =>
    events.some((event) => event.event === name);

describe("the version a daemon reports", () => {
  it("is the version in package.json when the caller names none", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const socketPath = join(directory, "daemon.sock");
    const daemon = await startDaemon({
      deviceDataTables: fakeDeviceDataTables,
      clock,
      dataDirectory: directory,
      drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
      filesystem: new MemoryFilesystem(),
      hostLoadProbe: null,
      logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
      socketPath,
    });
    runningDaemons.push(daemon);
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    const client = await connectRetrying(socketPath);
    try {
      const hello = await client.request("hello", {
        clientVersion: "test",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      });
      expect(hello.payload).toMatchObject({ version: packageJson.version });
    } finally {
      client.socket.end();
    }
  });
});

describe("the event history", () => {
  it("judges retention by the injected clock, so an event younger than the retention on that clock survives the start-up prune", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    // The fake clock reads 1_000; a real clock would put the 7-day cutoff far past 500.
    await seedHistory(directory, [500]);

    await start({ dataDirectory: directory });

    const events = await historyEventsWhen(directory, hasEvent("daemon.started"));
    expect(events.map((event) => event.id)).toContain("evt_1");
  });

  it("prunes at start by the configured eventLog.retention, so an event older than it on the injected clock is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    // why: the fake clock reads 1_000; with a retention of 100 the cutoff is 900, past 500 and before 950.
    await seedHistory(directory, [500, 950]);

    await start({ configOverrides: { eventLog: { retention: 100 } }, dataDirectory: directory });

    const events = await historyEventsWhen(directory, hasEvent("daemon.started"));
    expect(events.map((event) => event.id)).not.toContain("evt_1");
    expect(events.map((event) => event.id)).toContain("evt_2");
  });
});

async function queryState(
  directory: string,
  sql: string,
): Promise<readonly Record<string, unknown>[]> {
  const database = await new NodeSqliteOpener().open(join(directory, "state.db"), {
    readOnly: true,
  });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

/** A gateway URL on a port just released. Nothing listens there, so a worker's uplink dial
 * fails fast, and the fake clock never fires its retry. */
async function unreachableGatewayUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { readonly port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `ws://127.0.0.1:${port}`;
}

// why: a drivers module must export the device-data tables of its platforms, and the module file
// cannot import the repo's TypeScript, so this is the fake driver's table spelled out in plain JS.
const MODULE_DEVICE_DATA_TABLES = `
const table = {
  migrations: [
    "CREATE TABLE fake_device_data (device_id TEXT PRIMARY KEY, fake_device_id TEXT NOT NULL) STRICT",
  ],
  name: "fake-device-data",
  read(database, deviceId) {
    const row = database
      .prepare("SELECT fake_device_id FROM fake_device_data WHERE device_id = ?")
      .get(deviceId);
    if (row === undefined) throw new Error("No fake driver data for device " + deviceId);
    return { fakeDeviceId: row.fake_device_id };
  },
  version: 1,
  write(database, deviceId, driverData) {
    database
      .prepare(
        "INSERT INTO fake_device_data (device_id, fake_device_id) VALUES (?, ?) ON CONFLICT (device_id) DO UPDATE SET fake_device_id = excluded.fake_device_id",
      )
      .run(deviceId, driverData.fakeDeviceId);
  },
};
export const deviceDataTables = new Map([["android", table], ["ios", table]]);
`;

async function writeModule(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-drivers-module-"));
  temporaryDirectories.push(directory);
  const modulePath = join(directory, "drivers.mjs");
  await writeFile(modulePath, `${contents}\n${MODULE_DEVICE_DATA_TABLES}`, "utf8");
  return modulePath;
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

async function agentStatus(daemon: DaemonServer) {
  return (await daemon.dispatch(
    "status.get",
    {},
    { manageEventSubscription: () => undefined, via: "socket", principal: "agent", role: "agent" },
  )) as { readonly host: { readonly tools: readonly unknown[] } };
}

/** A fake driver that reports tool versions, which `FakeDriver` does not. */
class ToolsFakeDriver extends FakeDriver {
  constructor(
    options: ConstructorParameters<typeof FakeDriver>[0],
    private readonly tools: () => Promise<readonly DriverToolVersion[]>,
  ) {
    super(options);
  }

  toolVersions(): Promise<readonly DriverToolVersion[]> {
    return this.tools();
  }
}

/**
 * Binds an ephemeral loopback port and releases it. A fixed port fails whenever two runs of
 * this file overlap -- two worktrees running the suite at once, or Stryker's parallel runners
 * -- and another run's daemon can even answer on it.
 */
async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
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

  it("keeps gateway.token out of the daemon log, the events.replay answer, and history.db, while config.get still returns it", async () => {
    const secret = "secret-join-token-170";
    const { daemon, directory, sink } = await start({
      configOverrides: { gateway: { token: secret, url: await unreachableGatewayUrl() } },
    });
    const admin = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "operator",
      role: "admin",
    } as const;

    const replayed = await daemon.dispatch("events.replay", {}, admin);
    const eventFile = JSON.stringify(
      await historyEventsWhen(directory, hasEvent("daemon.started")),
    );
    const config = (await daemon.dispatch("config.get", {}, admin)) as {
      readonly gateway: { readonly token?: string };
    };

    // The fixture is real: the daemon did log its start and emit `daemon.started` to both
    // the ring and the file, so "absent" below means redacted, not never written.
    expect(sink.records.some((record) => record.message === "Daemon started")).toBe(true);
    expect(eventFile).toContain('"daemon.started"');
    expect(JSON.stringify(replayed)).toContain('"daemon.started"');
    expect({
      daemonLog: JSON.stringify(sink.records).includes(secret),
      eventsReplay: JSON.stringify(replayed).includes(secret),
      historyDb: eventFile.includes(secret),
    }).toEqual({ daemonLog: false, eventsReplay: false, historyDb: false });
    expect(config.gateway.token).toBe(secret);
  });

  it("keeps gateway.token in the daemon.started payload and the Daemon started log line as the redaction marker, so a set token still reads as set", async () => {
    const { daemon, sink } = await start({
      configOverrides: {
        gateway: { token: "secret-join-token-170", url: await unreachableGatewayUrl() },
      },
    });
    const replayed = (await daemon.dispatch(
      "events.replay",
      {},
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "operator",
        role: "admin",
      },
    )) as readonly { readonly event: string; readonly payload: unknown }[];

    const started = replayed.find((envelope) => envelope.event === "daemon.started");
    const logged = sink.records.find((record) => record.message === "Daemon started");
    const snapshot = (started?.payload as { readonly configSnapshot?: Config } | undefined)
      ?.configSnapshot;
    const loggedConfig = logged?.fields?.config as Config | undefined;
    expect({
      eventToken: snapshot?.gateway.token,
      logToken: loggedConfig?.gateway.token,
    }).toEqual({ eventToken: REDACTED_VALUE, logToken: REDACTED_VALUE });
  });

  it("runs no prerequisite check at startup convergence, and runs every check on each doctor.run", async () => {
    const runs = { android: 0, ios: 0 };
    const missing = { message: "gone", prerequisite: "android-emulator", remedy: "install it" };
    const { daemon } = await start({
      prerequisiteChecks: [
        {
          check: () => {
            runs.ios += 1;
            return Promise.resolve([]);
          },
          platform: "ios",
        },
        {
          check: () => {
            runs.android += 1;
            return Promise.resolve([missing]);
          },
          platform: "android",
        },
      ],
    });
    const admin = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "operator",
      role: "admin",
    } as const;

    // doctor.run parks until startup convergence has finished, so by the time it answers,
    // convergence's own reconcile has run -- and must not have counted.
    const first = (await daemon.dispatch("doctor.run", {}, admin)) as {
      readonly findings: readonly { readonly kind: string; readonly prerequisite?: string }[];
    };
    expect(runs).toEqual({ android: 1, ios: 1 });
    // Android has no driver in this daemon, so the finding is the platform's, not running.
    expect(first.findings).toContainEqual(
      expect.objectContaining({ kind: "prerequisite-missing", platform: "android" }),
    );

    await daemon.dispatch("doctor.run", {}, admin);
    expect(runs).toEqual({ android: 2, ios: 2 });
  });

  it("stores lease requests under the configured limits, with failures classified by contract code", async () => {
    const { daemon, directory } = await start({
      configOverrides: { lease: { maxRequestRecords: 1 } },
    });
    const missingRuntime = {
      model: "iPhone 16",
      osVersion: "99.0",
      platform: "ios",
    } as const;
    const session = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "agent",
      role: "agent",
    } as const;

    for (const requesterId of ["first", "second"]) {
      await daemon
        .dispatch("lease.request", { ...missingRuntime, requesterId }, session)
        .catch(() => undefined);
    }

    // With the default cap both failures stay stored; with an unclassified failure the code
    // would be INTERNAL.
    await expect
      .poll(() => queryState(directory, "SELECT requester_id, failure_code FROM lease_requests"))
      .toEqual([{ failure_code: "RUNTIME_MISSING", requester_id: "second" }]);
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
      deviceDataTables: fakeDeviceDataTables,
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

  it("ends a running component install on shutdown, before the drivers are disposed", async () => {
    const clock = new FakeClock(1_000);
    const events: string[] = [];
    class InstallingDriver extends FakeDriver {
      override async installComponent(
        component: string,
        options: Parameters<FakeDriver["installComponent"]>[1],
      ) {
        events.push("install-started");
        options.signal.addEventListener("abort", () => events.push("install-ended"));
        return super.installComponent(component, options);
      }

      async dispose(): Promise<void> {
        events.push("disposed");
      }
    }
    const driver = new InstallingDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const { daemon } = await start({ drivers: [driver] });

    const lease = daemon
      .dispatch(
        "lease.request",
        {
          allowDownload: true,
          model: "iPhone 16",
          osVersion: "26.5",
          platform: "ios",
        },
        {
          manageEventSubscription: () => undefined,
          via: "socket",
          principal: "agent",
          role: "agent",
        },
      )
      .catch((error: unknown) => error);
    await expect.poll(() => events).toEqual(["install-started"]);
    await daemon.stop("test");

    expect(events).toEqual(["install-started", "install-ended", "disposed"]);
    await expect(lease).resolves.toBeInstanceOf(Error);
  });

  it("starts and reports no entry for a driver whose tool read fails, and every other tool", async () => {
    const clock = new FakeClock(1_000);
    const { daemon } = await start({
      drivers: [
        new ToolsFakeDriver(
          { availableOsVersions: ["26.5"], clock, platform: "ios" },
          // What an iOS driver whose `xcodebuild` fails looks like from here.
          () => Promise.reject(new Error("xcodebuild -version exited with 1")),
        ),
        new ToolsFakeDriver({ availableOsVersions: ["35"], clock, platform: "android" }, () =>
          Promise.resolve([{ name: "emulator", version: "35.4.9" }]),
        ),
      ],
      deviceDataTables: fakeDeviceDataTables,
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
    });

    await expect
      .poll(async () => (await agentStatus(daemon)).host)
      .toEqual({
        arch: "arm64",
        os: "macOS",
        osVersion: "15.5",
        tools: [{ name: "emulator", platform: "android", version: "35.4.9" }],
      });
  });

  it("answers status.get when a driver reports a tool version past the contract's bounds", async () => {
    const clock = new FakeClock(1_000);
    const { daemon } = await start({
      drivers: [
        new ToolsFakeDriver({ availableOsVersions: ["35"], clock, platform: "android" }, () =>
          Promise.resolve([
            { name: "emulator", version: "9".repeat(500) },
            { name: "platform-tools", version: "36.0.0" },
          ]),
        ),
      ],
      deviceDataTables: fakeDeviceDataTables,
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
    });

    await expect
      .poll(async () => (await agentStatus(daemon)).host.tools)
      .toEqual([{ name: "platform-tools", platform: "android", version: "36.0.0" }]);
  });

  it("reads tool versions at start, before anything asks for status", async () => {
    const clock = new FakeClock(1_000);
    let reads = 0;
    await start({
      drivers: [
        new ToolsFakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }, () => {
          reads += 1;
          return Promise.resolve([]);
        }),
      ],
      deviceDataTables: fakeDeviceDataTables,
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
    });

    expect(reads).toBe(1);
  });

  it("logs a driver whose component listing fails under daemon.components, and still answers component.list", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    ios.failOn("listComponents", 1, new Error("simctl runtime list failed"));
    const { daemon, sink } = await start({ drivers: [ios] });

    const listed = await daemon.dispatch(
      "component.list",
      {},
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent",
        role: "agent",
      },
    );

    expect(listed).toEqual({ components: [] });
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        fields: { error: "Error: simctl runtime list failed", platform: "ios" },
        level: "warn",
        message: "A driver could not list its installed components",
        module: "daemon.components",
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

describe("startDaemon wires core and leasing together", () => {
  const agent = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "agent",
    role: "agent",
  } as const;
  const admin = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "operator",
    role: "admin",
  } as const;
  const ios = {
    model: "iPhone 16",
    osVersion: "26.5",
    platform: "ios",
    requesterId: "agent-1",
  } as const;
  type Grant = {
    readonly lease: { readonly id: string };
    readonly device: { readonly id: string };
  };

  /** Lets the work a mutated daemon would still be doing finish, so "nothing happened" is a
   * statement about the daemon and not about how early the test looked. Only sound when that
   * work is all in memory: a timer fires after it however loaded the machine is, but real I/O
   * (a process spawn, a real file) can outlast it. */
  const settleRealTime = async () => new Promise<void>((resolve) => setTimeout(resolve, 25));

  async function leasedIos(options: ConstructorParameters<typeof FakeDriver>[0]) {
    const clock = options.clock as FakeClock;
    const driver = new FakeDriver(options);
    const filesystem = new MemoryFilesystem();
    const started = await start({ clock, drivers: [driver], filesystem });
    const grant = (await started.daemon.dispatch("lease.request", ios, agent)) as Grant;
    return { ...started, clock, driver, filesystem, grant };
  }

  it("runs the operator reset through core's nuke, which releases the lease through leasing", async () => {
    const clock = new FakeClock(1_000);
    const { daemon, grant } = await leasedIos({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
    });

    const report = await daemon.dispatch("nuke.run", { deleteDevices: true }, admin);

    expect(report).toEqual({
      deletedDevices: [grant.device.id],
      releasedLeaseIds: [grant.lease.id],
    });
  });

  it("grants a waiting physical request once device.add enrolls a second device of the model", async () => {
    const clock = new FakeClock(1_000);
    const phone = { apps: [], class: "phone", model: "iPhone 15 Pro", osVersion: "18.4" } as const;
    const driver = new FakeDriver({
      clock,
      physicalDevices: [
        { ...phone, ids: ["UDID-A"] },
        { ...phone, ids: ["UDID-B"] },
      ],
      platform: "ios",
    });
    driver.setPhysicalPresence("UDID-A", true);
    driver.setPhysicalPresence("UDID-B", true);
    const { daemon } = await start({ clock, drivers: [driver] });
    const physical = { model: "iPhone 15 Pro", physical: true, platform: "ios" } as const;
    await daemon.dispatch("device.add", { id: "UDID-A", platform: "ios" }, admin);
    await daemon.dispatch("lease.request", { ...physical, requesterId: "agent-1" }, agent);
    const waiting = daemon.dispatch(
      "lease.request",
      { ...physical, requesterId: "agent-2" },
      agent,
    ) as Promise<Grant>;
    await settleRealTime();

    await daemon.dispatch("device.add", { id: "UDID-B", platform: "ios" }, admin);

    const outcome = await Promise.race([waiting, settleRealTime().then(() => "still waiting")]);
    expect(outcome).toMatchObject({ device: { physical: true } });
  });

  it("status.get carries the presence the grant's read found on a physical device, through the daemon's own wiring", async () => {
    const clock = new FakeClock(1_000);
    const phone = { apps: [], class: "phone", model: "iPhone 15 Pro", osVersion: "18.4" } as const;
    const driver = new FakeDriver({
      clock,
      physicalDevices: [{ ...phone, ids: ["UDID-WIRED-PRESENCE"] }],
      platform: "ios",
    });
    driver.setPhysicalPresence("UDID-WIRED-PRESENCE", true);
    const { daemon } = await start({ clock, drivers: [driver] });
    await daemon.dispatch("device.add", { id: "UDID-WIRED-PRESENCE", platform: "ios" }, admin);
    await daemon.dispatch(
      "lease.request",
      { model: "iPhone 15 Pro", physical: true, platform: "ios", requesterId: "agent-1" },
      agent,
    );

    const status = (await daemon.dispatch("status.get", {}, agent)) as {
      devices?: { driverDeviceId?: string; presence?: unknown }[];
    };

    const entry = status.devices?.find((device) => device.driverDeviceId === "UDID-WIRED-PRESENCE");
    expect(entry).toMatchObject({ presence: { present: true } });
  });

  it("announces the capacity figures and then the queue depth once startup is done", async () => {
    const { directory } = await start();

    const events = await historyEventsWhen(directory, hasEvent("queue.changed"));
    const names = events.map((event) => event.event);

    expect(names.indexOf("capacity.changed")).toBeGreaterThan(-1);
    expect(names.indexOf("queue.changed")).toBeGreaterThan(names.indexOf("capacity.changed"));
    expect(events.find((event) => event.event === "queue.changed")?.module).toBe("wait-queue");
  });

  it("runs doctor's startup pass on the startup read before core's device steps announce the capacity figures", async () => {
    const { directory } = await start();

    const names = (await historyEventsWhen(directory, hasEvent("capacity.changed"))).map(
      (event) => event.event,
    );

    expect(names.indexOf("doctor.reconciled")).toBeGreaterThan(-1);
    expect(names.indexOf("doctor.reconciled")).toBeLessThan(names.indexOf("capacity.changed"));
  });

  it("settles the requests a restart left open before core's device steps announce the capacity figures", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    // The previous process's registry: one request still open when it stopped.
    const state = await openStateDatabase({
      dataDirectory: directory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      oldFiles: [],
      owners: [registryOwner, fakeDeviceDataTable],
      sqlite: new NodeSqliteOpener(),
      upgradeStep: "unused",
    });
    const previous = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "1" },
      state,
    });
    await previous.createLeaseRequest({
      ownerId: "agent-1",
      request: ios,
      requesterId: "agent-1",
    });
    state.close();

    const daemon = await startDaemon({
      clock,
      dataDirectory: directory,
      deviceDataTables: fakeDeviceDataTables,
      drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
      filesystem: new MemoryFilesystem(),
      logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
      version: "1.2.3",
    });
    runningDaemons.push(daemon);

    const names = (await historyEventsWhen(directory, hasEvent("capacity.changed"))).map(
      (event) => event.event,
    );
    expect(names.indexOf("lease.rejected")).toBeGreaterThan(-1);
    expect(names.indexOf("capacity.changed")).toBeGreaterThan(names.indexOf("lease.rejected"));
  });

  it("ends the lease whose device is not running before core's device steps announce capacity, so a restart no longer holds it", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    const options = () =>
      ({
        clock,
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
        filesystem: new MemoryFilesystem(),
        logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
        // why: capacity follows the host's cpus and memory, and a small runner has too few slots for three leases at once, so a later request waits for ever on the fake clock (30 s timeout in runs 39459769408 and 39457371326).
        systemStats: new FakeSystemStats({ cpuCount: 16, totalRamBytes: 64 * 1024 ** 3 }),
        version: "1.2.3",
      }) as StartDaemonOptions;
    const first = await startDaemon(options());
    // why: several leases, so a reconcile that runs beside core's steps lands some releases after the announcement.
    const grants: Grant[] = [];
    for (const requesterId of ["agent-1", "agent-2", "agent-3"]) {
      grants.push((await first.dispatch("lease.request", { ...ios, requesterId }, agent)) as Grant);
    }
    await first.stop("test");
    // why: the history orders events by their time, and the second start's must follow the first's.
    clock.advance(1);
    const secondRunStart = clock.now();

    const daemon = await startDaemon(options());
    runningDaemons.push(daemon);

    const leases = (await daemon.dispatch("list.get", { kind: "leases" }, admin)) as readonly {
      readonly id: string;
    }[];
    for (const grant of grants) {
      expect(leases.map((lease) => lease.id)).not.toContain(grant.lease.id);
    }
    const secondRun = (
      await historyEventsWhen(directory, (all) =>
        all.some(
          (event) => event.event === "capacity.changed" && event.timestamp >= secondRunStart,
        ),
      )
    )
      .filter((event) => event.timestamp >= secondRunStart)
      .sort((left, right) => left.seq - right.seq)
      .map((event) => event.event);
    expect(secondRun.filter((name) => name === "lease.released")).toHaveLength(grants.length);
    expect(secondRun.lastIndexOf("lease.released")).toBeLessThan(
      secondRun.indexOf("capacity.changed"),
    );
    // why: two daemon starts and a history wait of up to 4 s outrun the 5 s default on a loaded CI runner (run 39454292501 timed out at 5015 ms, 59 ms locally).
  }, 30_000);

  it("closes state.db on stop, and lists the same device and lease after a worker is stopped and started again", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const options = () =>
      ({
        clock,
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: [driver],
        filesystem: new MemoryFilesystem(),
        logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
        version: "1.2.3",
      }) as StartDaemonOptions;
    const first = await startDaemon(options());
    const grant = (await first.dispatch("lease.request", ios, agent)) as Grant;
    const list = async (daemon: Awaited<ReturnType<typeof startDaemon>>, kind: string) =>
      (
        (await daemon.dispatch("list.get", { kind }, admin)) as readonly { readonly id: string }[]
      ).map((row) => row.id);
    const devicesBefore = await list(first, "devices");
    await first.stop("test");
    // why: closing the last connection checkpoints and removes the WAL, so a stop that left state.db open leaves it.
    expect(existsSync(join(directory, "state.db-wal"))).toBe(false);

    const daemon = await startDaemon(options());
    runningDaemons.push(daemon);

    expect(devicesBefore).toContain(grant.device.id);
    expect(await list(daemon, "devices")).toEqual(devicesBefore);
    expect(await list(daemon, "leases")).toEqual([grant.lease.id]);
  });

  it("holds shutdown open while a release's erase runs, and does not read that erase as a stall", async () => {
    const clock = new FakeClock(1_000);
    const { daemon, driver, grant } = await leasedIos({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { reclaim: 600_000 },
      platform: "ios",
      reclaimResult: "shutdown",
    });
    await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);

    // Well past the stalled-transition threshold, but the erase holds its claim on the device.
    clock.advance(300_000);
    const devices = (await daemon.dispatch("list.get", { kind: "devices" }, admin)) as readonly {
      readonly id: string;
      readonly state: string;
      readonly stalled?: true;
    }[];
    expect(devices.map(({ id, state, stalled }) => ({ id, state, stalled }))).toEqual([
      { id: grant.device.id, state: "reclaiming", stalled: undefined },
    ]);

    let stopped = false;
    const stopping = daemon.stop("test").then(() => {
      stopped = true;
    });
    await settleRealTime();
    expect(stopped).toBe(false);
    clock.advance(300_000);
    await stopping;
    expect(driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(1);
  });

  it("cancels the expiry timer of an outstanding lease on shutdown, so nothing expires after it", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const { daemon, directory } = await start({ clock, drivers: [driver] });
    await daemon.dispatch("lease.request", { ...ios, ttlMs: 10_000 }, agent);
    const leaseIds = async () =>
      (await queryState(directory, "SELECT id FROM leases")).map((row) => row.id);
    const before = await leaseIds();
    expect(before).toHaveLength(1);

    await daemon.stop("test");
    clock.advance(10_000);
    await settleRealTime();

    expect(await leaseIds()).toEqual(before);
  });

  it("cancels the quarantine retry timer on shutdown, so no retry runs after it", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("reclaim", 1, new DriverCrashError("purge exploded"));
    const started = await start({ clock, drivers: [driver] });
    const grant = (await started.daemon.dispatch("lease.request", ios, agent)) as Grant;
    await started.daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);

    // Shutdown waits for the failed purge to settle into quarantine, which arms the retry.
    await started.daemon.stop("test");
    clock.advance(30_000);
    await settleRealTime();

    expect(driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(1);
  });

  describe("a device quarantined by a failed purge", () => {
    type CauseView = {
      readonly id: string;
      readonly quarantineCause?: { readonly kind: string; readonly message?: string };
      readonly state: string;
    };

    async function quarantinedAfterFailedPurge() {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
      driver.failOn("reclaim", 1, new DriverCrashError("purge exploded"));
      const { daemon } = await start({ clock, drivers: [driver] });
      const grant = (await daemon.dispatch("lease.request", ios, agent)) as Grant;
      await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);
      await settleRealTime();
      return daemon;
    }

    const devicesOf = async (
      daemon: Awaited<ReturnType<typeof quarantinedAfterFailedPurge>>,
      session: typeof agent | typeof admin,
    ) =>
      (
        (await daemon.dispatch("status.get", {}, session)) as {
          readonly devices: readonly CauseView[];
        }
      ).devices;

    it("shows quarantineCause purge-failed with the driver's error in status.get and list.get", async () => {
      const daemon = await quarantinedAfterFailedPurge();

      const status = await devicesOf(daemon, admin);
      const listed = (await daemon.dispatch(
        "list.get",
        { kind: "devices" },
        admin,
      )) as readonly CauseView[];

      for (const devices of [status, listed]) {
        expect(devices).toHaveLength(1);
        expect(devices[0]).toMatchObject({ state: "quarantined" });
        expect(devices[0]?.quarantineCause).toEqual({
          kind: "purge-failed",
          message: "DriverCrashError: purge exploded",
        });
      }
    });

    it("shows its message to an admin session and only its kind to an agent session", async () => {
      const daemon = await quarantinedAfterFailedPurge();

      const forAdmin = await devicesOf(daemon, admin);
      const forAgent = await devicesOf(daemon, agent);

      expect(forAdmin[0]?.quarantineCause).toEqual({
        kind: "purge-failed",
        message: "DriverCrashError: purge exploded",
      });
      expect(forAgent[0]).toMatchObject({ state: "quarantined" });
      expect(forAgent[0]?.quarantineCause).toEqual({ kind: "purge-failed" });
    });
  });

  it("probes a leased device again as time passes once startup is done", async () => {
    const clock = new FakeClock(1_000);
    const { driver } = await leasedIos({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const probesBefore = driver.calls.filter((call) => call.operation === "listManaged").length;

    clock.advance(30_000);
    await settleRealTime();

    expect(driver.calls.filter((call) => call.operation === "listManaged").length).toBeGreaterThan(
      probesBefore,
    );
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
      deviceDataTables: fakeDeviceDataTables,
      filesystem: new MemoryFilesystem(),
      socketPath,
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
      expect(starting.payload).toMatchObject({ daemon: { health: "starting" } });

      const parkedLease = client.request("lease.request", {
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
      expect(running.payload).toMatchObject({ daemon: { health: "running" } });
    } finally {
      client.socket.end();
    }
  });
});

describe("startDaemon stopped while starting", () => {
  it("arms no timer when the startup read finishes after a stop, so nothing keeps the process alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-stop-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const socketPath = join(directory, "daemon.sock");
    const filesystem = new MemoryFilesystem();
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
      deviceDataTables: fakeDeviceDataTables,
      filesystem,
      hostLoadProbe: null,
      socketPath,
      version: "1.2.3",
    });

    const client = await connectRetrying(socketPath);
    try {
      const secret = (await readFileRetrying(filesystem, join(directory, "admin.token"))).trim();
      await client.request("hello", {
        clientVersion: "test",
        credential: secret,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      });
      expect((await client.request("daemon.stop", {})).ok).toBe(true);
      // `daemon.stop` answers first and tears down after, so give the teardown real time to begin.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } finally {
      client.socket.end();
    }
    clock.advance(30_000);
    await startPromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(clock.pendingTimerCount).toBe(0);
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
    const secret = "slk_test_agent";
    await seedTokensDatabase(directory, [["tok_agent", secret, "agent"]]);
    const port = await freeLoopbackPort();

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
      deviceDataTables: fakeDeviceDataTables,
      filesystem,
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
    expect(statusBeforeConvergence).toMatchObject({ daemon: { health: "starting" } });

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

describe("startDaemon stop with a warm target", () => {
  it("creates no further device for a target once a stop is asked for, though the creation in flight ends while the gateway stops", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-stop-target-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.hangMakeReady();
    const daemon = await startDaemon({
      deviceDataTables: fakeDeviceDataTables,
      clock,
      configOverrides: {
        capacity: { config: { maxRunning: 8 }, strategy: "fixed" },
        http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
        warmPool: {
          maxConcurrentBoots: 1,
          targets: [{ count: 2, model: "iPhone 16", osVersion: "26.5", platform: "ios" }],
        },
      },
      dataDirectory: directory,
      drivers: [driver],
      filesystem: new MemoryFilesystem(),
      logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
      version: "1.2.3",
    });
    runningDaemons.push(daemon);
    await expect
      .poll(() => driver.calls.filter((call) => call.operation === "makeReady").length)
      .toBe(1);

    // The creation ends while the HTTP gateway is still being stopped: a pool not closed by then
    // would start the second one, and the drain would wait for its whole boot.
    const stopping = daemon.stop("test-stop-target");
    driver.releaseMakeReady();
    await stopping;

    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
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
    const port = await freeLoopbackPort();
    const socketPath = join(directory, "daemon.sock");

    const restoreListen = delayTcpListen(200);
    try {
      const startPromise = startDaemon({
        clock,
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        dataDirectory: directory,
        drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
        deviceDataTables: fakeDeviceDataTables,
        filesystem,
        logger,
        socketPath,
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
        deviceDataTables: fakeDeviceDataTables,
        filesystem,
        logger: new JsonLinesLogger({
          clock: new FakeClock(1_000),
          level: "debug",
          sink: new MemoryLogSink(),
        }),
        version: "1.2.3",
      }) as StartDaemonOptions;

    const first = await startDaemon(options(await freeLoopbackPort()));
    try {
      // A distinct port, so the only thing that can fail is the socket claim itself.
      const second = startDaemon(options(await freeLoopbackPort()));
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

describe("startDaemon gateway uplink when the socket claim fails", () => {
  // #395: the uplink is dialled from `onSocketClaimed`, so a daemon that loses the claim never
  // dials its gateway -- it would otherwise join as a worker it is about to stop being.
  it("never dials the gateway when the worker's socket is already claimed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-uplink-claim-"));
    temporaryDirectories.push(directory);
    const filesystem = new MemoryFilesystem();
    const dials: string[] = [];
    const gateway = createHttpServer();
    gateway.on("upgrade", (request, socket) => {
      dials.push(request.url ?? "");
      socket.destroy();
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const { port } = gateway.address() as { readonly port: number };
    const options = (gatewayUrl?: string): StartDaemonOptions =>
      ({
        clock: new FakeClock(1_000),
        ...(gatewayUrl === undefined
          ? {}
          : { configOverrides: { gateway: { token: "join-token-395", url: gatewayUrl } } }),
        dataDirectory: directory,
        drivers: [
          new FakeDriver({
            availableOsVersions: ["26.5"],
            clock: new FakeClock(1_000),
            platform: "ios",
          }),
        ],
        deviceDataTables: fakeDeviceDataTables,
        filesystem,
        logger: new JsonLinesLogger({
          clock: new FakeClock(1_000),
          level: "debug",
          sink: new MemoryLogSink(),
        }),
        version: "1.2.3",
      }) as StartDaemonOptions;

    const first = await startDaemon(options());
    try {
      const outcome = await startDaemon(options(`ws://127.0.0.1:${port}`)).then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      // The dial, were it made, reaches a loopback listener within milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect({ dials, outcome }).toEqual({ dials: [], outcome: "rejected" });
    } finally {
      await first.stop("test-cleanup").catch(() => undefined);
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });
});

describe("startDaemon with HTTP off", () => {
  // #395: the socket-claim callback now runs with HTTP off too (it dials the uplink), so it
  // must still leave the HTTP frontend unstarted.
  it("starts no HTTP gateway when http.enabled is false", async () => {
    const { sink } = await start({ configOverrides: { http: { enabled: false } } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Either outcome of a started frontend counts: bound ("listening") or refused ("failed").
    expect(
      sink.records
        .map((record) => record.message)
        .filter(
          (message) => message.startsWith("HTTP gateway") || message.startsWith("HTTP frontend"),
        ),
    ).toEqual([]);
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
    const port = await freeLoopbackPort();

    const occupier = createServer();
    await new Promise<void>((resolve) => occupier.listen(port, "127.0.0.1", resolve));
    try {
      await expect(
        startDaemon({
          clock,
          configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
          dataDirectory: directory,
          drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
          deviceDataTables: fakeDeviceDataTables,
          filesystem,
          logger,
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

describe("startDaemon HTTP status for a quarantined device", () => {
  it("gives an operator token the cause's message and an agent token its kind alone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-http-cause-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await seedTokensDatabase(directory, [
      ["tok_agent", "slk_cause_agent", "agent"],
      ["tok_op", "slk_cause_operator", "operator"],
    ]);
    const port = await freeLoopbackPort();
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("reclaim", 1, new DriverCrashError("purge exploded"));
    const daemon = await startDaemon({
      deviceDataTables: fakeDeviceDataTables,
      clock,
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
      dataDirectory: directory,
      drivers: [driver],
      filesystem,
      hostLoadProbe: null,
      version: "1.2.3",
    } as StartDaemonOptions);
    runningDaemons.push(daemon);
    const session = {
      manageEventSubscription: () => undefined,
      principal: "agent-1",
      role: "agent",
      via: "socket",
    } as const;
    const grant = (await daemon.dispatch(
      "lease.request",
      { model: "iPhone 16", osVersion: "26.5", platform: "ios", requesterId: "agent-1" },
      session,
    )) as { readonly lease: { readonly id: string } };
    await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, session);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const causeFor = async (secret: string) => {
      const status = (await pollUntilListening(port, secret)) as {
        readonly devices?: readonly {
          readonly quarantineCause?: unknown;
          readonly state: string;
        }[];
      };
      expect(status.devices?.[0]?.state).toBe("quarantined");
      return status.devices?.[0]?.quarantineCause;
    };

    expect(await causeFor("slk_cause_operator")).toEqual({
      kind: "purge-failed",
      message: "DriverCrashError: purge exploded",
    });
    expect(await causeFor("slk_cause_agent")).toEqual({ kind: "purge-failed" });
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
      eventBus: new EventBus(new FakeClock()),
      filesystem,
      hostArch: "arm64",
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

  it("builds no iOS prerequisite check on a host that is not macOS, and an Android one", async () => {
    const { prerequisiteChecks } = await discoverIos({ hostPlatform: "linux" });

    expect(prerequisiteChecks.map((check) => check.platform)).toEqual(["android"]);
  });

  it("builds both prerequisite checks on macOS, whether or not a driver started", async () => {
    // The refused root costs the iOS driver; it must not cost the check that explains it.
    const { drivers, prerequisiteChecks } = await discoverIos({
      filesystem: await foreignOwnedRoot(),
    });

    expect(drivers.some((driver) => driver.platform === "ios")).toBe(false);
    expect(prerequisiteChecks.map((check) => check.platform)).toEqual(["ios", "android"]);
  });

  it("starts the iOS driver on a host with simctl, with the root it validated", async () => {
    const filesystem = new MemoryFilesystem();

    const { drivers, rejections } = await discoverIos({ filesystem });

    expect(rejections).toEqual([]);
    expect(drivers.find((driver) => driver.platform === "ios")?.deviceRoot).toBe(IOS_ROOT);
  });

  it("names the daemon's pid in the staging directory of the iOS root it creates", async () => {
    const filesystem = new MemoryFilesystem();
    const rename = vi.spyOn(filesystem, "rename");

    await discoverIos({ filesystem });

    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`/devices/\\.ios\\.${process.pid}\\.[^/]+\\.staging$`)),
      IOS_ROOT,
    );
  });

  it("keeps the daemon up when the iOS device root is refused, reporting the platform instead", async () => {
    const filesystem = await foreignOwnedRoot();

    const { drivers, rejections } = await discoverIos({ filesystem });

    // Safety rule 9: the platform goes, the daemon stays -- a daemon that will not start
    // is a daemon that cannot tell anyone why.
    expect(drivers.some((driver) => driver.platform === "ios")).toBe(false);
    expect(rejections.map((rejection) => rejection.platform)).toEqual(["ios"]);
  });

  it("publishes the refusal as the payload docs/internal/EVENTS.md documents for driver.root-rejected", async () => {
    const filesystem = await foreignOwnedRoot();
    const refusal = await refusedRoot(filesystem);

    const { rejections } = await discoverIos({ filesystem });

    // Built from a real `OwnedRootError`, key by key: the payload is a wire contract
    // `simlock events --json` publishes, so renaming `root` has to fail here.
    expect(rejections[0]).toEqual({
      event: "driver.root-rejected",
      // why: the wrappers this platform would have answered to, so a request for `simctl` or
      // `devicectl` can say why the driver is missing instead of reading as "this host has no
      // Xcode".
      passthroughTools: ["simctl", "devicectl"],
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
      passthroughTools: ["adb"],
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

  it("names the daemon's pid in the staging directory of the Android root it creates", async () => {
    const filesystem = await androidSdk();
    const probe = new FakeTcpProbe([5038]);
    await filesystem.mkdirp(SIMLOCK_HOME);
    await filesystem.writeFileAtomic(
      join(SIMLOCK_HOME, "adb-server.json"),
      JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
    );
    const rename = vi.spyOn(filesystem, "rename");

    await discoverAndroid(filesystem, probe, [4242]);

    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`/devices/\\.android\\.${process.pid}\\.[^/]+\\.staging$`)),
      join(SIMLOCK_HOME, "devices", "android"),
    );
  });

  it("launches the discovered Android driver's emulators with the android.emulator options it was handed", async () => {
    const filesystem = await androidSdk();
    await filesystem.mkdirp(SIMLOCK_HOME);
    await filesystem.writeFileAtomic(
      join(SIMLOCK_HOME, "adb-server.json"),
      JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
    );
    // Only the console-port lookup a boot starts with is scripted: the emulator launch after it
    // is recorded and then refused, so the boot stops right after showing its argv.
    const processRunner = new ScriptedProcessRunner([
      {
        match: { args: ["devices"], command: "/android-sdk/platform-tools/adb" },
        result: { code: 0, stderr: "", stdout: "List of devices attached\n" },
      },
    ]);

    const { drivers } = await discoverAndroid(filesystem, new FakeTcpProbe([5038]), [4242], {
      androidEmulator: { audio: true, bootAnimation: true, gpu: "host", headless: true },
      processRunner,
    });
    const android = drivers.find((driver) => driver.platform === "android");
    await expect(
      android?.makeReady(
        {
          physical: false,
          address: "emulator-5586",
          deviceId: "simlock_one",
          driverData: {
            avdName: "simlock_one",
            configHash: "",
            port: 5586,
            serial: "emulator-5586",
          },
        },
        { mode: "full", purpose: "prepare" },
      ),
    ).rejects.toThrow(/Unexpected process invocation/);

    expect(processRunner.calls.map((call) => call.args)).toEqual([
      ["devices"],
      [
        "-avd",
        "simlock_one",
        "-port",
        "5586",
        "-no-snapshot-save",
        "-no-window",
        "-gpu",
        "host",
        "-no-snapshot-load",
      ],
    ]);
  });

  it("hands the Android driver the ABI of the host architecture it was given", async () => {
    const filesystem = await androidSdk();
    await filesystem.mkdirp(SIMLOCK_HOME);
    await filesystem.writeFileAtomic(
      join(SIMLOCK_HOME, "adb-server.json"),
      JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
    );
    // Nothing is scripted: the install is refused once its argv is recorded.
    const processRunner = new ScriptedProcessRunner([]);

    const { drivers } = await discoverAndroid(filesystem, new FakeTcpProbe([5038]), [4242], {
      hostArch: "x64",
      processRunner,
    });
    await drivers
      .find((driver) => driver.platform === "android")
      ?.installComponent("35", {
        onProgress: () => undefined,
        signal: new AbortController().signal,
      })
      .catch(() => undefined);

    expect(processRunner.calls.flatMap((call) => call.args)).toContain(
      "system-images;android-35;google_apis;x86_64",
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
    overrides: Partial<
      Pick<DriverDiscoveryContext, "androidEmulator" | "hostArch" | "processRunner">
    > = {},
  ) {
    return discoverDrivers({
      clock: new FakeClock(),
      driversConfig: {},
      eventBus: new EventBus(new FakeClock()),
      filesystem,
      hostArch: "arm64",
      ...overrides,
      hostPlatform: "linux",
      idGenerator: new CryptoIdGenerator(),
      instanceId: INSTANCE_ID,
      logger: new JsonLinesLogger({
        clock: new FakeClock(),
        level: "debug",
        sink: new MemoryLogSink(),
      }),
      processRunner: overrides.processRunner ?? new ScriptedProcessRunner([]),
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
    hostArch: "arm64",
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

describe("deviceModeWiring", () => {
  it.each(["slim", "full"] as const)(
    "maps ios.defaultMode %s to the default-mode map and to whether the iOS default is slim",
    (defaultMode) => {
      expect(
        deviceModeWiring({
          ios: { defaultMode, defaultModels: {}, slim: { bootTimeoutMs: 1 } },
        }),
      ).toEqual({
        defaultModes: { ios: defaultMode },
        slimByDefault: defaultMode === "slim",
      });
    },
  );
});

describe("modelPreferenceWiring", () => {
  const drivers = [
    {
      defaultModels: { phone: ["iPhone 17", "iPhone 16"], tablet: ["iPad (A16)"] },
      platform: "ios" as const,
    },
    { defaultModels: { phone: ["Pixel 9"] }, platform: "android" as const },
  ];
  const config = (
    ios: Config["ios"]["defaultModels"],
    android: Config["android"]["defaultModels"],
  ) =>
    ({
      android: { defaultModels: android },
      ios: { defaultModels: ios },
    }) as Pick<Config, "android" | "ios">;

  it("puts the configured names of a class before the driver's built-in ones", () => {
    expect(
      modelPreferenceWiring(
        config({ phone: ["iPhone 15", "iPhone 14"] }, { phone: ["Pixel 7"] }),
        drivers,
      ),
    ).toEqual({
      android: { phone: ["Pixel 7", "Pixel 9"] },
      ios: { phone: ["iPhone 15", "iPhone 14", "iPhone 17", "iPhone 16"], tablet: ["iPad (A16)"] },
    });
  });

  it("is the driver's built-in list alone for a class the config does not name", () => {
    expect(modelPreferenceWiring(config({}, {}), drivers)).toEqual({
      android: { phone: ["Pixel 9"] },
      ios: { phone: ["iPhone 17", "iPhone 16"], tablet: ["iPad (A16)"] },
    });
  });

  it("keeps a configured class the driver has no built-in list for", () => {
    expect(
      modelPreferenceWiring(config({ vision: ["Apple Vision Pro"] }, {}), drivers).ios?.vision,
    ).toEqual(["Apple Vision Pro"]);
  });

  it("leaves out a platform with no driver", () => {
    expect(modelPreferenceWiring(config({}, {}), [drivers[0]!])).not.toHaveProperty("android");
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

describe("processRunnerFor", () => {
  async function runOnce(level: "debug" | "info") {
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", sink });
    const inner = new ScriptedProcessRunner([
      { match: { args: ["devices"], command: "adb" }, result: { code: 0, stderr: "", stdout: "" } },
    ]);

    await processRunnerFor(level, inner, logger, clock).run("adb", ["devices"]);
    return sink.records.filter((record) => record.message === "process");
  }

  it("at log.level: info no process line is written", async () => {
    expect(await runOnce("info")).toEqual([]);
  });

  it("at log.level: debug each command leaves one process line under daemon.process", async () => {
    expect(await runOnce("debug")).toEqual([
      expect.objectContaining({
        level: "debug",
        module: "daemon.process",
        fields: expect.objectContaining({ command: "adb", args: ["devices"], code: 0 }),
      }),
    ]);
  });
});

describe("startDaemon event history", () => {
  const previousModule = process.env.SIMLOCK_DRIVERS_MODULE;

  afterEach(() => {
    if (previousModule === undefined) {
      delete process.env.SIMLOCK_DRIVERS_MODULE;
    } else {
      process.env.SIMLOCK_DRIVERS_MODULE = previousModule;
    }
  });

  it("starts a daemon whose history path is a directory, sets it aside and writes a fresh file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-event-file-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "history.db"));

    const { daemon } = await start({ dataDirectory: directory });

    const events = await historyEventsWhen(directory, hasEvent("daemon.started"));
    const names = await readdir(directory);
    const status = (await daemon.dispatch(
      "status.get",
      {},
      {
        manageEventSubscription: () => undefined,
        principal: "operator",
        role: "admin",
        via: "socket",
      },
    )) as { readonly history?: unknown };
    expect(daemon.health).toBe("running");
    expect(names).toContain("history.db.damaged-1000");
    expect((await stat(join(directory, "history.db.damaged-1000"))).isDirectory()).toBe(true);
    expect((await stat(join(directory, "history.db"))).isFile()).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(status.history).toEqual({ opened: true, setAsideAt: 1_000, writing: true });
  });

  it("a daemon that loses the socket claim leaves a damaged history.db byte-identical and in place", async () => {
    const winner = await mkdtemp(join(tmpdir(), "simlock-main-claim-"));
    const loser = await mkdtemp(join(tmpdir(), "simlock-main-claim-"));
    temporaryDirectories.push(winner, loser);
    const junk = "this is not a sqlite database ".repeat(20);
    await writeFile(join(loser, "history.db"), junk);
    const socketPath = join(winner, "daemon.sock");
    await start({ dataDirectory: winner, socketPath });

    const outcome = await start({ dataDirectory: loser, socketPath }).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );

    expect(outcome).toBe("rejected");
    expect(
      await readdir(loser).then((names) => names.filter((name) => name.startsWith("history"))),
    ).toEqual(["history.db"]);
    expect(await readFile(join(loser, "history.db"), "utf8")).toBe(junk);
  });

  it("mints event ids from the idGenerator the daemon was given", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-event-file-"));
    temporaryDirectories.push(directory);
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers({ eventBus }) {
         eventBus.emit("component.installed", { componentId: "18.6", durationMs: 1, platform: "ios" }, "test");
         return [];
       }`,
    );

    await start({
      dataDirectory: directory,
      drivers: undefined,
      idGenerator: { generate: () => "from-the-given-generator" },
    });

    const ids = (
      await historyEventsWhen(directory, (events) =>
        events.some((event) => event.id === "evt_from-the-given-generator"),
      )
    ).map((event) => event.id);
    expect(ids).toContain("evt_from-the-given-generator");
  });

  it("writes no daemon log line for component.installed and device.slimmed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-event-file-"));
    temporaryDirectories.push(directory);
    // The daemon's own bus is reachable only through what it hands discovery.
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers({ eventBus }) {
         eventBus.emit("component.installed", { componentId: "18.6", durationMs: 1, platform: "ios" }, "test");
         eventBus.emit("device.slimmed", {
           address: "a", categories: [], deviceId: "d", durationMs: 1, labelCount: 0,
           platform: "ios", signature: "s", unknownLabels: [],
         }, "test");
         return [];
       }`,
    );

    const { sink } = await start({ dataDirectory: directory, drivers: undefined });

    const written = (await historyEventsWhen(directory, hasEvent("device.slimmed"))).map(
      (event) => event.event,
    );
    expect(written).toEqual(expect.arrayContaining(["component.installed", "device.slimmed"]));
    expect(
      sink.records.filter((record) =>
        JSON.stringify(record).match(
          /component\.installed|device\.slimmed|Component installed|Device slimmed/,
        ),
      ),
    ).toEqual([]);
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

  async function discover(sink: MemoryLogSink) {
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink });
    return discoverDrivers({
      clock: new FakeClock(),
      driversConfig: {},
      eventBus: new EventBus(new FakeClock()),
      filesystem: new MemoryFilesystem(),
      hostArch: "arm64",
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

  it("takes the module's prerequisiteChecks export in place of the real checks", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers() { return []; }
       export const prerequisiteChecks = [{ platform: "android", fromModule: true, check: async () => [] }];`,
    );

    const { prerequisiteChecks } = await discover(new MemoryLogSink());

    expect(prerequisiteChecks).toEqual([expect.objectContaining({ fromModule: true })]);
  });

  it("hands config's android.emulator block to driver discovery when the daemon starts", async () => {
    const key = "__simlockDiscoveredAndroidEmulator";
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers(context) {
         globalThis.${key} = context.androidEmulator;
         return [];
       }`,
    );
    const emulator = { audio: false, bootAnimation: false, gpu: "host", headless: true };

    try {
      await start({ configOverrides: { android: { emulator } }, drivers: undefined });

      expect((globalThis as Record<string, unknown>)[key]).toEqual(emulator);
    } finally {
      delete (globalThis as Record<string, unknown>)[key];
    }
  });

  it("a throwing event subscriber writes one JSON line through the logger and nothing through console.error", async () => {
    // The drivers module is the one seam that reaches the daemon's own bus from outside.
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers(context) {
         context.eventBus.subscribe("daemon.started", () => {
           throw new Error("subscriber broke");
         });
         return [];
       }`,
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { sink } = await start({ drivers: undefined });

      expect(consoleError).not.toHaveBeenCalled();
      expect(sink.records.filter((record) => record.message === "Event handler failed")).toEqual([
        expect.objectContaining({
          level: "error",
          module: "daemon.bus",
          fields: expect.objectContaining({
            event: "daemon.started",
            seq: expect.any(Number),
            message: "subscriber broke",
            stack: expect.stringContaining("subscriber broke"),
          }),
        }),
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("supports a synchronous createDrivers returning an array directly", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers() { return []; }`,
    );

    // No `prerequisiteChecks` export: `doctor` runs no check rather than the real ones.
    await expect(discover(new MemoryLogSink())).resolves.toEqual({
      drivers: [],
      prerequisiteChecks: [],
      rejections: [],
    });
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

/** A disk whose free-space query fails, as `statfs` does on a data directory gone unreadable. */
class UnmeasurableDiskFilesystem extends MemoryFilesystem {
  async diskFree(_path: string): Promise<number> {
    throw Object.assign(new Error("statfs failed"), { code: "EIO" });
  }
}

describe("startDaemon logger wiring", () => {
  it("startDaemon hands its logger to the cleanup reaper: a scheduled cleanup run that fails is logged", async () => {
    const { sink } = await start({ filesystem: new UnmeasurableDiskFilesystem() });

    // `daemon.started` triggers a run nobody awaits; its failure has no caller to reach.
    await pollUntil(() =>
      sink.records.some((record) => record.message === "scheduled cleanup run failed"),
    );
    expect(
      sink.records.filter((record) => record.message === "scheduled cleanup run failed"),
    ).toMatchObject([
      {
        level: "error",
        module: "daemon.reaper",
        fields: { step: "cleanup", error: expect.stringContaining("statfs failed") },
      },
    ]);
  });

  it("startDaemon hands the gateway dispatcher its error classifier: a typed refusal is logged with its code at info, not as INTERNAL at error", async () => {
    // A gateway serves HTTP; on its default port two overlapping runs of this file collide.
    const { daemon, sink } = await start({
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
      },
      role: "gateway",
    });

    await expect(
      daemon.dispatch(
        "worker.drain",
        { workerId: "wrk_ghost" },
        {
          manageEventSubscription: () => undefined,
          via: "socket",
          principal: "test-operator",
          role: "admin",
        },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_WORKER" });

    expect(
      sink.records.filter(
        (record) => record.message === "operation" && record.fields?.operation === "worker.drain",
      ),
    ).toMatchObject([
      {
        level: "info",
        module: "daemon.gateway.dispatch",
        fields: { code: "UNKNOWN_WORKER", principal: "test-operator" },
      },
    ]);
  });
});

/** Polls until `condition` holds or the time runs out, without failing: the caller's own
 * assertion afterwards is what names a miss. */
async function pollUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("startDaemon with the agent-device edge", () => {
  const packageRoot = "/opt/ad/node_modules/agent-device";
  const realCli = `${packageRoot}/bin/agent-device.mjs`;
  const entry = `${packageRoot}/dist/src/internal/daemon.js`;
  const command = "/opt/ad/bin/agent-device";
  const lease = {
    model: "iPhone 16",
    osVersion: "26.5",
    platform: "ios",
    requesterId: "agent-1",
  } as const;
  const agent = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "agent",
    role: "agent",
  } as const;

  class KillingSupervisor extends FakeProcessSupervisor {
    readonly kills = new Map<number, () => void>();

    override signal(pid: number, signal: NodeJS.Signals): void {
      super.signal(pid, signal);
      this.markDead(pid);
      this.kills.get(pid)?.();
    }
  }

  async function setUp(
    config: unknown,
    options: { readonly directory?: string; readonly record?: { readonly pid: number } } = {},
  ) {
    const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "simlock-main-ad-")));
    temporaryDirectories.push(directory);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(directory);
    await filesystem.mkdirp("/opt/ad/bin");
    await filesystem.mkdirp(`${packageRoot}/bin`);
    await filesystem.mkdirp(`${packageRoot}/dist/src/internal`);
    await filesystem.writeFileAtomic(realCli, "#!/usr/bin/env node\n");
    filesystem.defineAttributes(realCli, { mode: 0o755 });
    await filesystem.writeFileAtomic(`${packageRoot}/package.json`, '{"name":"agent-device"}');
    await filesystem.writeFileAtomic(entry, "");
    filesystem.defineSymlink(command, realCli);
    await filesystem.writeFileAtomic(join(directory, "config.json"), JSON.stringify(config));
    if (options.record !== undefined) {
      await filesystem.writeFileAtomic(
        join(directory, "agent-device-daemon.json"),
        JSON.stringify({ entry, pid: options.record.pid, startedAt: 1 }),
      );
    }
    return { directory, filesystem };
  }

  function versionAndDaemon(directory: string): ScriptedProcessRunner {
    return new ScriptedProcessRunner([
      {
        match: { args: [realCli, "--version"], command: process.execPath },
        result: { code: 0, stderr: "", stdout: "0.21.28\n" },
      },
      {
        hangs: true,
        match: { args: [entry, `--simlock-home=${directory}`], command: process.execPath },
      },
    ]);
  }

  async function startEdge(
    setup: Awaited<ReturnType<typeof setUp>>,
    ports: {
      readonly agentDevice?: OptionalModuleDefinition<unknown>;
      readonly drivers?: StartDaemonOptions["drivers"];
      readonly modules?: readonly FakeModule[];
      readonly processRunner: ScriptedProcessRunner;
      readonly processSupervisor: FakeProcessSupervisor;
      readonly role?: "gateway";
    },
  ) {
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const daemon = await startDaemon({
      clock,
      dataDirectory: setup.directory,
      ...(ports.role === undefined ? {} : { role: ports.role }),
      deviceDataTables: fakeDeviceDataTables,
      drivers: ports.drivers ?? [
        new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
      ],
      filesystem: setup.filesystem,
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
      logger: new JsonLinesLogger({ clock, level: "debug", sink }),
      optionalModules: [
        ports.agentDevice ?? agentDeviceModuleWith({ health: new FakeAgentDeviceHealth() }),
        ...(ports.modules ?? []).map(
          (module) => module.definition as OptionalModuleDefinition<unknown>,
        ),
      ],
      processRunner: ports.processRunner,
      processSupervisor: ports.processSupervisor,
      tcpProbe: new FakeTcpProbe(),
      version: "1.2.3",
    });
    runningDaemons.push(daemon);
    return { daemon, sink };
  }

  it("runs a module's beforeDriversDispose and stops agent-device's child, both before the drivers are disposed", async () => {
    const setup = await setUp({
      capabilities: { "agent-device": { command, enabled: true }, alpha: { enabled: true } },
    });
    const events: string[] = [];
    const processSupervisor = new KillingSupervisor();
    const runner = versionAndDaemon(setup.directory);
    const spawn = runner.spawn.bind(runner);
    vi.spyOn(runner, "spawn").mockImplementation((spawned, args, options) => {
      const handle = spawn(spawned, args, options);
      if (args[0] === entry) {
        processSupervisor.markAlive(handle.pid);
        processSupervisor.kills.set(handle.pid, () => handle.kill());
        void handle.wait().then(() => events.push("agent-device exited"));
      }
      return handle;
    });
    const clock = new FakeClock(1_000);
    class DisposingDriver extends FakeDriver {
      async dispose(): Promise<void> {
        events.push("driver disposed");
      }
    }
    const { daemon } = await startEdge(setup, {
      drivers: [new DisposingDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
      modules: [
        fakeModule({
          hooks: {
            beforeDriversDispose: () => {
              events.push("module beforeDriversDispose");
              return Promise.resolve();
            },
          },
          name: "alpha",
        }),
      ],
      processRunner: runner,
      processSupervisor,
    });
    await pollUntil(() => runner.calls.length === 2);

    await daemon.stop("test");

    expect(events.at(-1)).toBe("driver disposed");
    expect(events.slice(0, -1).sort()).toEqual([
      "agent-device exited",
      "module beforeDriversDispose",
    ]);
  });

  it("resolves and grants a lease to an ordinary client while agent-device's /health never answers, and stops the child before the drivers are disposed", async () => {
    const setup = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
    const events: string[] = [];
    const processSupervisor = new KillingSupervisor();
    const runner = versionAndDaemon(setup.directory);
    const spawn = runner.spawn.bind(runner);
    vi.spyOn(runner, "spawn").mockImplementation((spawned, args, options) => {
      const handle = spawn(spawned, args, options);
      if (args[0] === entry) {
        processSupervisor.markAlive(handle.pid);
        processSupervisor.kills.set(handle.pid, () => handle.kill());
        void handle.wait().then(() => events.push("agent-device exited"));
      }
      return handle;
    });
    const clock = new FakeClock(1_000);
    class DisposingDriver extends FakeDriver {
      async dispose(): Promise<void> {
        events.push("driver disposed");
      }
    }

    const { daemon } = await startEdge(setup, {
      drivers: [new DisposingDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
      processRunner: runner,
      processSupervisor,
    });
    await pollUntil(() => runner.calls.length === 2);

    expect(runner.calls.map((call) => call.args[0])).toEqual([realCli, entry]);
    await expect(daemon.dispatch("lease.request", lease, agent)).resolves.toMatchObject({
      lease: { id: expect.any(String) },
    });

    await daemon.stop("test");

    expect(events).toEqual(["agent-device exited", "driver disposed"]);
  });

  async function spawnedEnvironment(drivers: (clock: FakeClock) => StartDaemonOptions["drivers"]) {
    const setup = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
    const runner = versionAndDaemon(setup.directory);
    await startEdge(setup, {
      drivers: drivers(new FakeClock(1_000)),
      processRunner: runner,
      processSupervisor: new FakeProcessSupervisor(),
    });
    await pollUntil(() => runner.calls.length === 2);
    return runner.calls[1]?.options.env ?? {};
  }

  it("hands the drivers' lease environment to the agent-device daemon", async () => {
    const env = await spawnedEnvironment((clock) => [
      new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        leaseEnvironment: { SIMLOCK_IOS_DEVICE_SET: "/sets/ios", SIMLOCK_TEST_MARKER: "kept" },
        platform: "ios",
      }),
    ]);

    expect(env["SIMLOCK_TEST_MARKER"]).toBe("kept");
    expect(env["AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET"]).toBe("/sets/ios");
  });

  it("hides a platform whose driver is off from the agent-device daemon, and only that one", async () => {
    const iosOnly = await spawnedEnvironment((clock) => [
      new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
    ]);
    const both = await spawnedEnvironment((clock) => [
      new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
      new FakeDriver({ availableOsVersions: ["14"], clock, platform: "android" }),
    ]);

    expect(iosOnly["AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST"]).toBe("simlock-no-android-device");
    expect(both["AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST"]).toBeUndefined();
  });

  it("still starts and grants a lease when agent-device is not found", async () => {
    const setup = await setUp({
      capabilities: { "agent-device": { command: "/opt/missing/agent-device", enabled: true } },
    });
    const runner = new ScriptedProcessRunner([]);

    const { daemon } = await startEdge(setup, {
      processRunner: runner,
      processSupervisor: new FakeProcessSupervisor(),
    });
    await pollUntil(() => false, 100);

    await expect(daemon.dispatch("lease.request", lease, agent)).resolves.toMatchObject({
      lease: { id: expect.any(String) },
    });
    expect(runner.calls).toEqual([]);
  });

  it("builds no supervisor in gateway mode: no ps and no agent-device process run, and no signal is sent", async () => {
    const setup = await setUp(
      {
        capabilities: { "agent-device": { command, enabled: true } },
        http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
      },
      { record: { pid: 900 } },
    );
    const runner = new ScriptedProcessRunner([]);
    const processSupervisor = new FakeProcessSupervisor([900]);

    await startEdge(setup, {
      drivers: [],
      processRunner: runner,
      processSupervisor,
      role: "gateway",
    });
    await pollUntil(() => false, 100);

    expect(runner.calls).toEqual([]);
    expect(processSupervisor.signals).toEqual([]);
  });

  it('a worker with no capabilities["agent-device"] section, and one with enabled false, answer status.get with { name: agent-device, state: off }', async () => {
    const admin = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "op",
      role: "admin",
    } as const;
    for (const config of [{}, { capabilities: { "agent-device": { enabled: false } } }]) {
      const setup = await setUp(config);
      const { daemon } = await startEdge(setup, {
        processRunner: new ScriptedProcessRunner([]),
        processSupervisor: new FakeProcessSupervisor(),
      });

      const status = await daemon.dispatch("status.get", {}, admin);

      expect(status.capabilities).toEqual([{ name: "agent-device", state: "off" }]);
    }
  });

  it("a worker with agent-device off never calls agent-device's loadWorker", async () => {
    let loads = 0;
    const spying: OptionalModuleDefinition<unknown> = {
      ...agentDeviceModule,
      loadWorker: () => {
        loads += 1;
        return agentDeviceModule.loadWorker();
      },
    } as OptionalModuleDefinition<unknown>;
    const setup = await setUp({ capabilities: { "agent-device": { enabled: false } } });
    const { daemon } = await startEdge(setup, {
      agentDevice: spying,
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
    });
    await daemon.stop("test");

    expect(loads).toBe(0);

    const on = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
    await startEdge(on, {
      agentDevice: spying,
      processRunner: versionAndDaemon(on.directory),
      processSupervisor: new FakeProcessSupervisor(),
    });
    expect(loads).toBe(1);
  });

  it('a worker whose config has only the old agentDevice key warns `Unknown config key: "agentDevice"` and reports agent-device off', async () => {
    const admin = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "op",
      role: "admin",
    } as const;
    const setup = await setUp({ agentDevice: { command, enabled: true } });

    const { daemon, sink } = await startEdge(setup, {
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
    });

    expect(sink.records.map((record) => record.message)).toContain(
      'Unknown config key: "agentDevice"',
    );
    expect((await daemon.dispatch("status.get", {}, admin)).capabilities).toEqual([
      { name: "agent-device", state: "off" },
    ]);
  });

  it("a worker with agent-device off starts no supervisor: no ps runs and no signal is sent, even with a recorded daemon on disk", async () => {
    const setup = await setUp(
      { capabilities: { "agent-device": { command, enabled: false } } },
      { record: { pid: 900 } },
    );
    const runner = new ScriptedProcessRunner([]);
    const processSupervisor = new FakeProcessSupervisor([900]);

    await startEdge(setup, { processRunner: runner, processSupervisor });
    await pollUntil(() => false, 100);

    expect(runner.calls).toEqual([]);
    expect(processSupervisor.signals).toEqual([]);
  });

  it("runs no ps and sends no signal in a second daemon on the same home that loses the socket claim", async () => {
    const first = await setUp({ capabilities: { "agent-device": { enabled: false } } });
    await startEdge(first, {
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
    });
    const second = await setUp(
      { capabilities: { "agent-device": { command, enabled: true } } },
      { directory: first.directory, record: { pid: 900 } },
    );
    const runner = new ScriptedProcessRunner([]);
    const processSupervisor = new FakeProcessSupervisor([900]);

    await expect(startEdge(second, { processRunner: runner, processSupervisor })).rejects.toThrow();
    await pollUntil(() => false, 100);

    expect(runner.calls).toEqual([]);
    expect(processSupervisor.signals).toEqual([]);
  });

  describe("doctor.run", () => {
    const operator = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "operator",
      role: "admin",
    } as const;

    type Report = {
      readonly findings: readonly { readonly kind: string; readonly message?: string }[];
    };

    const agentDeviceFinding = (report: Report) =>
      report.findings.find((finding) => finding.kind === "module-unavailable");

    it("reports module-unavailable for agent-device, naming the found and needed versions, and an ordinary client is still granted a lease", async () => {
      const setup = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
      const runner = new ScriptedProcessRunner([
        {
          match: { args: [realCli, "--version"], command: process.execPath },
          result: { code: 0, stderr: "", stdout: "0.20.3\n" },
        },
      ]);
      const { daemon } = await startEdge(setup, {
        processRunner: runner,
        processSupervisor: new FakeProcessSupervisor(),
      });

      await expect
        .poll(
          async () =>
            agentDeviceFinding((await daemon.dispatch("doctor.run", {}, operator)) as Report),
          {
            timeout: 5_000,
          },
        )
        .toMatchObject({
          kind: "module-unavailable",
          module: "agent-device",
          message: expect.stringContaining("found 0.20.3, need 0.21.28 or later"),
          remedy: expect.any(String),
        });
      await expect(daemon.dispatch("lease.request", lease, agent)).resolves.toMatchObject({
        lease: { id: expect.any(String) },
      });
    }, 10_000);

    it("lists agent-device's module-unavailable finding before a module's own", async () => {
      const setup = await setUp({
        capabilities: {
          "agent-device": { command: "/opt/missing/agent-device", enabled: true },
          alpha: { enabled: true },
        },
      });
      const { daemon } = await startEdge(setup, {
        modules: [
          fakeModule({
            findings: () => [{ message: "it is down", remedy: "bring it up" }],
            name: "alpha",
          }),
        ],
        processRunner: new ScriptedProcessRunner([]),
        processSupervisor: new FakeProcessSupervisor(),
      });

      await expect
        .poll(
          async () =>
            (
              (await daemon.dispatch("doctor.run", {}, operator)) as {
                readonly findings: readonly { readonly kind: string; readonly module?: string }[];
              }
            ).findings
              .filter((finding) => finding.kind === "module-unavailable")
              .map((finding) => finding.module),
          { timeout: 4_000 },
        )
        .toEqual(["agent-device", "alpha"]);
    });

    it("reports module-unavailable for agent-device, naming the command when capabilities.agent-device.command is found nowhere", async () => {
      const setup = await setUp({
        capabilities: { "agent-device": { command: "/opt/missing/agent-device", enabled: true } },
      });
      const { daemon } = await startEdge(setup, {
        processRunner: new ScriptedProcessRunner([]),
        processSupervisor: new FakeProcessSupervisor(),
      });

      await expect
        .poll(
          async () =>
            agentDeviceFinding((await daemon.dispatch("doctor.run", {}, operator)) as Report),
          {
            timeout: 5_000,
          },
        )
        .toMatchObject({
          kind: "module-unavailable",
          module: "agent-device",
          message: expect.stringContaining("/opt/missing/agent-device"),
        });
    }, 10_000);

    it("reports no module-unavailable finding with capabilities.agent-device.enabled false", async () => {
      const setup = await setUp({ capabilities: { "agent-device": { enabled: false } } });
      const { daemon } = await startEdge(setup, {
        processRunner: new ScriptedProcessRunner([]),
        processSupervisor: new FakeProcessSupervisor(),
      });

      const report = (await daemon.dispatch("doctor.run", {}, operator)) as Report;

      expect(agentDeviceFinding(report)).toBeUndefined();
    });

    it("reports no module-unavailable finding while agent-device's /health never answers and the readiness budget has not run out", async () => {
      const setup = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
      const runner = versionAndDaemon(setup.directory);
      const { daemon } = await startEdge(setup, {
        processRunner: runner,
        processSupervisor: new FakeProcessSupervisor(),
      });
      await expect
        .poll(() => runner.calls.some((call) => call.args[0] === entry), { timeout: 5_000 })
        .toBe(true);

      const report = (await daemon.dispatch("doctor.run", {}, operator)) as Report;

      expect(agentDeviceFinding(report)).toBeUndefined();
    });
  });
});

describe("startDaemon host load", () => {
  const COUNTERS: HostLoadCounters = {
    cpu: { busyTime: 100, cores: 4, limited: false, totalTime: 1_000 },
    disk: { freeBytes: 120, totalBytes: 500 },
    memory: {
      availableBytes: 4_000,
      limited: false,
      pressure: "normal",
      swapUsedBytes: 100,
      totalBytes: 16_000,
    },
  };

  async function startOnClock(overrides: Partial<StartDaemonOptions> = {}) {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-load-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const daemon = await startDaemon({
      deviceDataTables: fakeDeviceDataTables,
      clock,
      dataDirectory: directory,
      drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
      filesystem: new MemoryFilesystem(),
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
      logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
      version: "1.2.3",
      ...overrides,
    } as StartDaemonOptions);
    runningDaemons.push(daemon);
    return { clock, daemon, directory };
  }

  async function workerStatus(daemon: DaemonServer): Promise<Record<string, unknown>> {
    return (await daemon.dispatch(
      "status.get",
      {},
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent",
        role: "agent",
      },
    )) as Record<string, unknown>;
  }

  it("answers status.get with load from the probe, on the starting answer and the running one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-load-slow-"));
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
      deviceDataTables: fakeDeviceDataTables,
      filesystem: new MemoryFilesystem(),
      hostLoadProbe: new FakeHostLoadProbe(COUNTERS),
      socketPath,
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
      const statusLoad = async () =>
        ((await client.request("status.get", {})).payload as { load?: unknown }).load;

      await expect
        .poll(statusLoad)
        .toEqual({ ageMs: 0, disk: COUNTERS.disk, memory: COUNTERS.memory });
      expect((await client.request("status.get", {})).payload).toMatchObject({
        daemon: { health: "starting" },
      });

      clock.advance(30_000);
      await startPromise;

      expect((await client.request("status.get", {})).payload).toMatchObject({
        daemon: { health: "running" },
      });
      expect(await statusLoad()).toMatchObject({
        disk: COUNTERS.disk,
        memory: COUNTERS.memory,
      });
    } finally {
      client.socket.end();
    }
  });

  it("answers status.get without load before the first read finishes, without waiting for it", async () => {
    const probe = new FakeHostLoadProbe();
    const { daemon } = await startOnClock({ hostLoadProbe: probe });

    expect(probe.reads).toBe(1);
    expect(await workerStatus(daemon)).not.toHaveProperty("load");

    probe.answer(COUNTERS);
    await expect
      .poll(async () => (await workerStatus(daemon)).load)
      .toMatchObject({
        memory: COUNTERS.memory,
      });
  });

  it("dials its gateway only after the first host load reading, so the gateway's first status.get carries load", async () => {
    const dials: number[] = [];
    const listener = createServer((socket) => {
      dials.push(Date.now());
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const { port } = listener.address() as { readonly port: number };
    try {
      const probe = new FakeHostLoadProbe();
      await startOnClock({
        configOverrides: { gateway: { token: "join-token-load", url: `ws://127.0.0.1:${port}` } },
        hostLoadProbe: probe,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(dials).toEqual([]);

      probe.answer(COUNTERS);

      await expect.poll(() => dials.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it("fits the load it answers with to the status.get bounds: an age over a day is capped at one day", async () => {
    const probe = new FakeHostLoadProbe(COUNTERS);
    const { clock, daemon } = await startOnClock({ hostLoadProbe: probe });
    await expect.poll(async () => (await workerStatus(daemon)).load).toBeDefined();

    // why: a stepped-over clock leaves the last reading older than the schema's one-day bound.
    clock.advance(3 * 86_400_000);

    const load = (await workerStatus(daemon)).load as { ageMs: number } | undefined;
    expect(load?.ageMs).toBeLessThanOrEqual(86_400_000);
  });

  it("with hostLoadProbe: null answers the same as with a probe, apart from load, and arms no host load timer", async () => {
    const withProbe = await startOnClock({ hostLoadProbe: new FakeHostLoadProbe(COUNTERS) });
    const without = await startOnClock({ hostLoadProbe: null });

    await expect.poll(async () => (await workerStatus(withProbe.daemon)).load).toBeDefined();
    const { load: _load, ...probed } = await workerStatus(withProbe.daemon);
    const bare = await workerStatus(without.daemon);

    expect(bare).not.toHaveProperty("load");
    expect(probed).toEqual(bare);
    expect(withProbe.clock.pendingTimerCount).toBeGreaterThan(without.clock.pendingTimerCount);
  });

  it("starts the sampler only after the daemon holds its socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-load-socket-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "daemon.sock");
    const socketAtRead: boolean[] = [];
    class WatchingProbe extends FakeHostLoadProbe {
      override read(): Promise<HostLoadCounters> {
        socketAtRead.push(existsSync(socketPath));
        return super.read();
      }
    }

    await startOnClock({
      dataDirectory: directory,
      hostLoadProbe: new WatchingProbe(COUNTERS),
      socketPath,
    });

    expect(socketAtRead).toEqual([true]);
  });

  it("leaves no host load timer pending when start fails after the sampler started", async () => {
    class SecretRefusingFilesystem extends MemoryFilesystem {
      override async writeFileAtomic(
        ...arguments_: Parameters<MemoryFilesystem["writeFileAtomic"]>
      ): Promise<void> {
        if (arguments_[0].endsWith("admin.token")) throw new Error("disk is read-only");
        return super.writeFileAtomic(...arguments_);
      }
    }
    const failedStart = async (hostLoadProbe: FakeHostLoadProbe | null) => {
      const directory = await mkdtemp(join(tmpdir(), "simlock-main-load-fail-"));
      temporaryDirectories.push(directory);
      const clock = new FakeClock(1_000);
      await expect(
        startDaemon({
          clock,
          dataDirectory: directory,
          drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
          deviceDataTables: fakeDeviceDataTables,
          filesystem: new SecretRefusingFilesystem(),
          hostLoadProbe,
          socketPath: join(directory, "daemon.sock"),
          version: "1.2.3",
        } as StartDaemonOptions),
      ).rejects.toThrow("disk is read-only");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return clock.pendingTimerCount;
    };
    const probe = new FakeHostLoadProbe(COUNTERS);

    const withProbe = await failedStart(probe);
    const without = await failedStart(null);

    expect(probe.reads).toBe(1);
    expect(withProbe).toBe(without);
  });

  it("leaves no host load timer pending after a stop", async () => {
    const probe = new FakeHostLoadProbe(COUNTERS);
    const withProbe = await startOnClock({ hostLoadProbe: probe });
    const without = await startOnClock({ hostLoadProbe: null });
    expect(withProbe.clock.pendingTimerCount).toBeGreaterThan(without.clock.pendingTimerCount);

    await withProbe.daemon.stop("test");
    await without.daemon.stop("test");

    expect(withProbe.clock.pendingTimerCount).toBe(without.clock.pendingTimerCount);
  });
});

describe("startDaemon in gateway mode host load", () => {
  const COUNTERS: HostLoadCounters = {
    cpu: { busyTime: 100, cores: 4, limited: false, totalTime: 1_000 },
    disk: { freeBytes: 120, totalBytes: 500 },
    memory: {
      availableBytes: 4_000,
      limited: false,
      pressure: "normal",
      swapUsedBytes: 100,
      totalBytes: 16_000,
    },
  };
  const operator = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "test-operator",
    role: "admin",
  } as const;

  async function startGateway(
    overrides: Partial<StartDaemonOptions> & { readonly directory?: string } = {},
  ) {
    const { directory: given, ...rest } = overrides;
    const directory = given ?? (await mkdtemp(join(tmpdir(), "simlock-main-gw-load-")));
    if (given === undefined) temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const daemon = await startDaemon({
      clock,
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
      },
      role: "gateway",
      dataDirectory: directory,
      drivers: [],
      filesystem: new MemoryFilesystem(),
      logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
      version: "1.2.3",
      ...rest,
    } as StartDaemonOptions);
    runningDaemons.push(daemon);
    return { clock, daemon, directory };
  }

  const statusOf = async (daemon: DaemonServer) =>
    (await daemon.dispatch("status.get", {}, operator)) as Record<string, unknown>;

  it("a gateway started with a probe answers status.get with the gateway machine's load from it", async () => {
    const probe = new FakeHostLoadProbe(COUNTERS);
    const { daemon } = await startGateway({ hostLoadProbe: probe });

    await expect
      .poll(async () => (await statusOf(daemon)).load)
      .toEqual({ ageMs: 0, disk: COUNTERS.disk, memory: COUNTERS.memory });
    expect(probe.reads).toBe(1);
  });

  it("a gateway started with hostLoadProbe: null answers status.get without load, and arms no host load timer", async () => {
    const withProbe = await startGateway({ hostLoadProbe: new FakeHostLoadProbe(COUNTERS) });
    const without = await startGateway({ hostLoadProbe: null });

    await expect.poll(async () => (await statusOf(withProbe.daemon)).load).toBeDefined();

    expect(await statusOf(without.daemon)).not.toHaveProperty("load");
    expect(withProbe.clock.pendingTimerCount).toBeGreaterThan(without.clock.pendingTimerCount);
  });

  it("a gateway started with no hostLoadProbe builds the production probe, the same factory a worker uses", async () => {
    const { daemon } = await startGateway({});

    await expect
      .poll(
        async () => ((await statusOf(daemon)).load as { memory?: { totalBytes: number } })?.memory,
      )
      .toMatchObject({ totalBytes: expect.any(Number) });
  });

  it("a stopped gateway, and one that lost the start race, leave no host load timer pending", async () => {
    const probe = new FakeHostLoadProbe(COUNTERS);
    const withProbe = await startGateway({ hostLoadProbe: probe });
    const without = await startGateway({ hostLoadProbe: null });
    expect(withProbe.clock.pendingTimerCount).toBeGreaterThan(without.clock.pendingTimerCount);

    await withProbe.daemon.stop("test");
    await without.daemon.stop("test");

    expect(withProbe.clock.pendingTimerCount).toBe(without.clock.pendingTimerCount);

    const first = await startGateway({ hostLoadProbe: null });
    const lost = async (hostLoadProbe: FakeHostLoadProbe | null) => {
      const clock = new FakeClock(1_000);
      await expect(
        startDaemon({
          clock,
          configOverrides: {
            http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
          },
          role: "gateway",
          dataDirectory: first.directory,
          drivers: [],
          deviceDataTables: fakeDeviceDataTables,
          filesystem: new MemoryFilesystem(),
          hostLoadProbe,
          version: "1.2.3",
        } as StartDaemonOptions),
      ).rejects.toThrow();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return clock.pendingTimerCount;
    };
    const losingProbe = new FakeHostLoadProbe(COUNTERS);

    const withLoser = await lost(losingProbe);
    const withoutLoser = await lost(null);

    expect(losingProbe.reads).toBe(0);
    expect(withLoser).toBe(withoutLoser);
  });
});

describe("daemon role (ADR 0034)", () => {
  it("startDaemon with role gateway and no data directory uses <root>/gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "simlock-main-root-"));
    temporaryDirectories.push(root);
    vi.stubEnv("SIMLOCK_HOME", root);
    try {
      const daemon = await startDaemon({
        configOverrides: {
          http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
        },
        drivers: [],
        deviceDataTables: fakeDeviceDataTables,
        role: "gateway",
      });
      runningDaemons.push(daemon);

      expect(existsSync(join(root, "gateway", "instance.json"))).toBe(true);
      expect(existsSync(join(root, "instance.json"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    [[], "worker"],
    [["--gateway"], "gateway"],
    [["--gateway", "x"], undefined],
    [["--worker"], undefined],
  ] as const)(
    "parseDaemonArgv reads no arguments as a worker, --gateway as a gateway, and anything else as nothing (%j)",
    (argv, expected) => {
      expect(parseDaemonArgv(argv)).toBe(expected);
    },
  );
});

describe("startDaemon state.db", () => {
  const previousModule = process.env.SIMLOCK_DRIVERS_MODULE;

  afterEach(() => {
    if (previousModule === undefined) {
      delete process.env.SIMLOCK_DRIVERS_MODULE;
    } else {
      process.env.SIMLOCK_DRIVERS_MODULE = previousModule;
    }
  });

  it("a worker started with state.json in its folder refuses with the old-file message and its step, and creates no state.db", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-old-file-"));
    temporaryDirectories.push(directory);
    const oldFile = join(directory, "state.json");
    await writeFile(oldFile, "{}", "utf8");

    await expect(start({ dataDirectory: directory })).rejects.toMatchObject({
      message: `Found ${oldFile}, which this Simlock no longer reads. To upgrade: with the older Simlock, release every lease and run \`simlock nuke --delete-devices\`; then remove ${oldFile} and start again. See "Breaking: state moves to state.db" in docs/CLI.md.`,
    });
    expect(existsSync(join(directory, "state.db"))).toBe(false);
  });

  it.each([
    [
      "worker",
      "tokens.json",
      "with the older Simlock, release every lease and run `simlock nuke --delete-devices`; then remove <path> and start again.",
    ],
    [
      "gateway",
      "tokens.json",
      "remove <path> and start again; then create each worker's join token again with `simlock --gateway token create --role worker`, set it as that worker's `gateway.token`, and drain workers again.",
    ],
    [
      "gateway",
      "workers.json",
      "remove <path> and start again; then create each worker's join token again with `simlock --gateway token create --role worker`, set it as that worker's `gateway.token`, and drain workers again.",
    ],
  ] as const)(
    "a %s started with %s in its folder refuses with the old-file message and its step",
    async (role, file, step) => {
      const directory = await mkdtemp(join(tmpdir(), "simlock-main-old-file-"));
      temporaryDirectories.push(directory);
      const oldFile = join(directory, file);
      await writeFile(oldFile, "[]", "utf8");

      await expect(start({ dataDirectory: directory, role })).rejects.toMatchObject({
        message: `Found ${oldFile}, which this Simlock no longer reads. To upgrade: ${step.replace("<path>", oldFile)} See "Breaking: state moves to state.db" in docs/CLI.md.`,
      });
      expect(existsSync(join(directory, "state.db"))).toBe(false);
    },
  );

  it("a token created, then the daemon restarted on the same state.db, verifies and lists with every field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-token-restart-"));
    temporaryDirectories.push(directory);
    const admin = {
      manageEventSubscription: () => undefined,
      principal: "admin",
      role: "admin",
      via: "socket",
    } as const;
    const port = await freeLoopbackPort();
    const launch = (now: number) =>
      startDaemon({
        clock: new FakeClock(now),
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: [],
        hostLoadProbe: null,
        version: "1.2.3",
      } as StartDaemonOptions);
    type Created = { readonly secret: string; readonly token: Record<string, unknown> };
    const first = await launch(1_000);
    const labelled = (await first.dispatch(
      "token.create",
      { label: "ci", role: "agent" },
      admin,
    )) as Created;
    const bare = (await first.dispatch("token.create", { role: "operator" }, admin)) as Created;
    await first.stop();

    const second = await launch(2_000);
    runningDaemons.push(second);

    const listed = (await second.dispatch("token.list", {}, admin)) as {
      readonly tokens: readonly Record<string, unknown>[];
    };
    expect(listed.tokens).toEqual([labelled.token, bare.token]);
    expect("label" in (listed.tokens[1] ?? {})).toBe(false);

    const statusWith = async (secret: string) =>
      (
        await fetch(`http://127.0.0.1:${port}/v1/status`, {
          headers: { authorization: `Bearer ${secret}` },
        })
      ).status;
    expect(await statusWith(labelled.secret)).toBe(200);
    expect(await statusWith(bare.secret)).toBe(200);
    expect(await statusWith("slk_not-a-created-secret")).toBe(401);
  });

  it("a start that fails after state.db opened closes it before it throws", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-closes-state-"));
    temporaryDirectories.push(directory);
    const state = await openStateDatabase({
      dataDirectory: directory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      oldFiles: [],
      owners: [registryOwner, fakeDeviceDataTable],
      sqlite: new NodeSqliteOpener(),
      upgradeStep: "unused",
    });
    const previous = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "1" },
      state,
    });
    await previous.registerDevice({
      driverData: { fakeDeviceId: "fk-1" },
      driverDeviceId: "drv-1",
      provisionDuration: 0,
      spec: { model: "iPhone 16", osVersion: "26.5", physical: false, platform: "ios" },
    });
    state.database.exec("DELETE FROM fake_device_data");
    state.close();
    expect(existsSync(join(directory, "state.db-wal"))).toBe(false);

    await expect(start({ dataDirectory: directory })).rejects.toMatchObject({
      name: "RegistryLoadError",
    });

    expect(existsSync(join(directory, "state.db-wal"))).toBe(false);
  });

  it("a second startDaemon on a folder whose daemon runs leaves state.db's schema_versions and bytes unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-live-state-"));
    temporaryDirectories.push(directory);
    await start({ dataDirectory: directory });
    const versions = () => queryState(directory, "SELECT owner, version FROM schema_versions");
    const before = await versions();
    const bytesBefore = await readFile(join(directory, "state.db"));
    // why: a newer binary brings a newer version of an owner the live daemon's state.db has; opening would migrate it in.
    const newerTable = {
      ...fakeDeviceDataTable,
      migrations: [
        ...fakeDeviceDataTable.migrations,
        "CREATE TABLE newer_fake_data (id TEXT) STRICT",
      ],
      version: 2,
    };

    await expect(
      start({
        dataDirectory: directory,
        deviceDataTables: new Map([["ios", newerTable]]),
      }),
    ).rejects.toMatchObject({ name: "DaemonAlreadyRunningError" });

    expect(await versions()).toEqual(before);
    expect(await readFile(join(directory, "state.db"))).toEqual(bytesBefore);
  });

  it("a SIMLOCK_DRIVERS_MODULE without a deviceDataTables export fails start naming it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-no-tables-"));
    temporaryDirectories.push(directory);
    const modulePath = join(directory, "drivers.mjs");
    await writeFile(modulePath, "export function createDrivers() { return []; }\n", "utf8");
    process.env.SIMLOCK_DRIVERS_MODULE = modulePath;

    await expect(
      start({ dataDirectory: directory, deviceDataTables: undefined, drivers: undefined }),
    ).rejects.toMatchObject({
      message: `SIMLOCK_DRIVERS_MODULE ${modulePath} does not export deviceDataTables, a Map from platform to its device-data table`,
    });
    expect(existsSync(join(directory, "state.db"))).toBe(false);
  });

  it("resolveDeviceDataTables answers the option's map when given, else the drivers module's export, else the production map", async () => {
    expect(await resolveDeviceDataTables({ deviceDataTables: fakeDeviceDataTables })).toBe(
      fakeDeviceDataTables,
    );

    // why: the module exports tables of its own, so a module checked first would answer a different map.
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      "export function createDrivers() { return []; }",
    );
    const optionMap = new Map(fakeDeviceDataTables);
    expect(await resolveDeviceDataTables({ deviceDataTables: optionMap })).toBe(optionMap);

    delete process.env.SIMLOCK_DRIVERS_MODULE;
    const production = await resolveDeviceDataTables({});
    expect(production).toEqual(productionDeviceDataTables());
    expect(production.get("ios")).toBe(iosDeviceDataTable);
    expect(production.get("android")).toBe(androidDeviceDataTable);

    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      "export function createDrivers() { return []; }",
    );
    const fromModule = await resolveDeviceDataTables({});
    expect([...fromModule.keys()].sort()).toEqual(["android", "ios"]);
    expect(fromModule.get("ios")?.name).toBe("fake-device-data");
    expect(fromModule).not.toBe(fakeDeviceDataTables);
  });
});
