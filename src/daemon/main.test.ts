import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect, createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Config,
  DriverCrashError,
  type DriverToolVersion,
  REDACTED_VALUE,
  registryOwner,
  baselinesOwner,
} from "../core/index.js";
import {
  FakeDriver,
  fakeDeviceDataTable,
  fakeDeviceDataTables,
  loadTestRegistry,
} from "../core/testing.js";
import { seedTokensDatabase } from "../auth/testing.js";
import { openStateDatabase } from "../state/index.js";
import { androidDeviceDataTable } from "../drivers/android/index.js";
import { iosDeviceDataTable } from "../drivers/ios/index.js";
import { EventBus, type EventEnvelope } from "../bus/index.js";
import { readHistoryEvents, seedHistory } from "../history/testing.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  FakeClock,
  FakeHostInfo,
  FakeNpmCli,
  FakeProcessSupervisor,
  daemonDataDirectory,
  FakeServiceManager,
  serviceDefinition,
  type ServiceDefinition,
  type ServiceManager,
  type ServiceState,
  FakeSystemStats,
  FakeTcpProbe,
  IpcError,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryIpcTransport,
  MemoryLogSink,
  NodeFilesystem,
  NodeSqliteOpener,
  NoopLogger,
  ScriptedProcessRunner,
} from "../ports/index.js";
import { productionServiceCheck, startDaemon, type StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";
import { productionDeviceDataTables, resolveDeviceDataTables } from "./driver-discovery.js";
import { parseDaemonArgv } from "./entry-support.js";
import {
  SIMLOCK_HOME,
  STANDALONE_OFF,
  connectRetrying,
  pollUntil,
  pollUntilListening,
  runningDaemons,
  start,
  startGateway,
  stopDaemons,
  temporaryDirectories,
  writeModule,
} from "./test-main.js";
import { startOnFreePort } from "../test-support/loopback-port.js";

afterEach(stopDaemons);

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

  it("startup leaves a pid-less legacy staging directory in place", async () => {
    const filesystem = new MemoryFilesystem();
    const devices = join(SIMLOCK_HOME, "devices");
    await filesystem.mkdirp(devices);
    const legacy = await stage(filesystem, devices, ".ios.root-id.staging");

    await startWithRoot(filesystem, new FakeProcessSupervisor());

    expect(await filesystem.exists(legacy)).toBe(true);
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

describe("the data directory", () => {
  it("creates a missing data directory owner-only, and for one other users can reach logs one warning at start and leaves its mode", async () => {
    // why: under the umask every real host starts from, a directory made without a mode comes
    // out 0755, so only the daemon asking for 0700 ends there.
    const previousUmask = process.umask(0o022);
    try {
      const base = await mkdtemp(join(tmpdir(), "simlock-dd-"));
      temporaryDirectories.push(base);
      const cases = [
        { name: "new", existing: undefined, mode: 0o700, warned: undefined },
        { name: "700", existing: 0o700, mode: 0o700, warned: undefined },
        { name: "750", existing: 0o750, mode: 0o750, warned: "750" },
        { name: "755", existing: 0o755, mode: 0o755, warned: "755" },
      ];

      for (const testCase of cases) {
        const dataDirectory = join(base, testCase.name);
        if (testCase.existing !== undefined) {
          await mkdir(dataDirectory);
          await chmod(dataDirectory, testCase.existing);
        }

        const { sink } = await start({ dataDirectory, filesystem: new NodeFilesystem() });

        expect(
          {
            mode: (await stat(dataDirectory)).mode & 0o777,
            warnings: sink.records
              .filter((record) => record.message.startsWith("data directory"))
              .map((record) => [record.level, record.message]),
          },
          testCase.name,
        ).toEqual({
          mode: testCase.mode,
          warnings:
            testCase.warned === undefined
              ? []
              : [
                  [
                    "warn",
                    `data directory ${dataDirectory} is accessible to other users (mode ${testCase.warned}); run chmod 700 ${dataDirectory}`,
                  ],
                ],
        });
      }
    } finally {
      process.umask(previousUmask);
    }
  });
});

describe("the data directory", () => {
  it("makes the parent of a gateway's data directory owner-only too when it creates it", async () => {
    // why: a gateway started first creates `<root>`, which is the worker's data directory later.
    const previousUmask = process.umask(0o022);
    try {
      const root = join(await mkdtemp(join(tmpdir(), "simlock-dd-")), "home");
      temporaryDirectories.push(join(root, ".."));

      await start({ dataDirectory: join(root, "gateway"), filesystem: new NodeFilesystem() });

      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "gateway"))).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });
});

describe("the version a daemon reports", () => {
  it("is the version in package.json when the caller names none", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const socketPath = join(directory, "daemon.sock");
    const daemon = await startDaemon({
      configOverrides: STANDALONE_OFF,
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

/** why: A gateway URL on a port just released. Nothing listens there, so a worker's uplink dial
 * fails fast, and the fake clock never fires its retry. */
async function unreachableGatewayUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { readonly port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `ws://127.0.0.1:${port}`;
}

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

describe("startDaemon", () => {
  it("keeps gateway.token out of the daemon log, the events.replay answer, and history.db, while config.get returns it only as the redaction marker unless showSecrets is asked", async () => {
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

    // why: The fixture is real: the daemon did log its start and emit `daemon.started` to both
    // the ring and the file, so "absent" below means redacted, not never written.
    expect(sink.records.some((record) => record.message === "Daemon started")).toBe(true);
    expect(eventFile).toContain('"daemon.started"');
    expect(JSON.stringify(replayed)).toContain('"daemon.started"');
    expect({
      daemonLog: JSON.stringify(sink.records).includes(secret),
      eventsReplay: JSON.stringify(replayed).includes(secret),
      historyDb: eventFile.includes(secret),
    }).toEqual({ daemonLog: false, eventsReplay: false, historyDb: false });
    const shown = (await daemon.dispatch("config.get", { showSecrets: true }, admin)) as {
      readonly gateway: { readonly token?: string };
    };
    expect({ default: config.gateway.token, shown: shown.gateway.token }).toEqual({
      default: "[redacted]",
      shown: secret,
    });
  });

  it.each([
    {
      name: "nothing set: each driver's own defaults",
      drivers: {},
      expected: (home: string) => ({
        android: {
          backend: "local",
          adbServerPort: 5038,
          deviceRoot: join(home, "devices", "android"),
        },
        ios: { backend: "local", deviceRoot: join(home, "devices", "ios"), deviceSet: "simlock" },
      }),
    },
    {
      name: "set keys win over the defaults, and a driver's unknown key is carried",
      drivers: { android: { adbServerPort: 5039 }, ios: { deviceSet: "simlock", retries: 3 } },
      expected: (home: string) => ({
        android: {
          backend: "local",
          adbServerPort: 5039,
          deviceRoot: join(home, "devices", "android"),
        },
        ios: {
          backend: "local",
          deviceRoot: join(home, "devices", "ios"),
          deviceSet: "simlock",
          retries: 3,
        },
      }),
    },
    {
      name: "deviceSet default: no iOS deviceRoot, which that set does not use",
      drivers: { ios: { deviceSet: "default" } },
      expected: (home: string) => ({
        android: {
          backend: "local",
          adbServerPort: 5038,
          deviceRoot: join(home, "devices", "android"),
        },
        ios: { backend: "local", deviceSet: "default" },
      }),
    },
  ])(
    "answers config.get with every drivers.* key the drivers use, so config get reads it back ($name)",
    async ({ drivers, expected }) => {
      const { daemon, directory } = await start({ configOverrides: { drivers } });

      const config = (await daemon.dispatch(
        "config.get",
        {},
        {
          manageEventSubscription: () => undefined,
          via: "socket",
          principal: "operator",
          role: "admin",
        },
      )) as { readonly drivers?: unknown };

      expect(config.drivers).toEqual(expected(directory));
    },
  );

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

    // why: doctor.run parks until startup convergence has finished, so by the time it answers,
    // convergence's own reconcile has run -- and must not have counted.
    const first = (await daemon.dispatch("doctor.run", {}, admin)) as {
      readonly findings: readonly { readonly kind: string; readonly prerequisite?: string }[];
    };
    expect(runs).toEqual({ android: 1, ios: 1 });
    expect(first.findings).toContainEqual(
      expect.objectContaining({ kind: "prerequisite-missing", platform: "android" }),
    );

    await daemon.dispatch("doctor.run", {}, admin);
    expect(runs).toEqual({ android: 2, ios: 2 });
  });

  it("a worker's doctor reports service-broken for each service whose paths are gone", async () => {
    const gone = "/Users/me/.nvm/versions/node/v22.13.0/bin/node";
    const mainGone = "/Users/me/simlock/dist/daemon/main.js";
    const name = "com.callstack.simlock.worker";
    const remedy = "Run `simlock daemon install` again.";
    const admin = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "operator",
      role: "admin",
    } as const;
    for (const testCase of [
      { label: "not installed", missing: [], expected: [] },
      { label: "installed and whole", missing: [], expected: [] },
      {
        label: "one path gone",
        missing: [gone],
        expected: [{ kind: "service-broken", manager: "launchd", name, missing: [gone], remedy }],
      },
      {
        label: "both gone",
        missing: [gone, mainGone],
        expected: [
          { kind: "service-broken", manager: "launchd", name, missing: [gone, mainGone], remedy },
        ],
      },
    ]) {
      const { daemon } = await start({
        serviceCheck: { manager: "launchd", name, check: async () => testCase.missing },
      });
      const report = (await daemon.dispatch("doctor.run", {}, admin)) as {
        readonly findings: readonly { readonly kind: string }[];
      };
      expect(
        report.findings.filter((finding) => finding.kind === "service-broken"),
        testCase.label,
      ).toEqual(testCase.expected);
    }
  });

  it("productionServiceCheck builds the service definition from the process facts and reads its state: the missing paths when broken, none otherwise, and no check on a gateway or without a manager", async () => {
    const seen: ServiceDefinition[] = [];
    const manager: ServiceManager = {
      manager: "launchd",
      state: async (definition) => {
        seen.push(definition);
        return { state: "broken", path: definition.path, missing: [definition.command] };
      },
      install: async () => undefined,
      uninstall: async () => undefined,
      start: async () => undefined,
    };
    const host = {
      manager,
      root: "/Users/me/.simlock",
      home: "/Users/me",
      nodePath: "/gone/node",
      mainPath: "/gone/main.js",
      env: { PATH: "/usr/bin" },
    };

    const { serviceCheck } = productionServiceCheck("worker", host);

    expect(serviceCheck?.name).toBe("com.callstack.simlock.worker");
    expect(await serviceCheck?.check()).toEqual(["/gone/node"]);
    expect(seen).toEqual([
      serviceDefinition({
        role: "worker",
        root: "/Users/me/.simlock",
        dataDirectory: daemonDataDirectory("/Users/me/.simlock", "worker"),
        home: "/Users/me",
        nodePath: "/gone/node",
        mainPath: "/gone/main.js",
        env: { PATH: "/usr/bin" },
      }),
    ]);
    expect(productionServiceCheck("gateway", host)).toEqual({});
    expect(productionServiceCheck("worker", { ...host, manager: undefined })).toEqual({});

    const states: readonly { readonly state: ServiceState; readonly missing: readonly string[] }[] =
      [
        { state: { state: "not-installed" }, missing: [] },
        { state: { state: "installed", path: "/p" }, missing: [] },
        { state: { state: "not-loaded", path: "/p" }, missing: [] },
        {
          state: { state: "broken", path: "/p", missing: ["/gone/node", "/gone/main.js"] },
          missing: ["/gone/node", "/gone/main.js"],
        },
      ];
    for (const testCase of states) {
      const checked = productionServiceCheck("worker", {
        ...host,
        manager: new FakeServiceManager({ state: testCase.state }),
      });
      expect(checked.serviceCheck?.manager).toBe("launchd");
      expect(checked.serviceCheck?.name).toBe("com.callstack.simlock.worker");
      expect(await checked.serviceCheck?.check(), testCase.state.state).toEqual(testCase.missing);
    }
    expect(
      productionServiceCheck("worker", {
        ...host,
        manager: new FakeServiceManager({ manager: "systemd" }),
      }).serviceCheck?.manager,
    ).toBe("systemd");

    const systemd = productionServiceCheck("worker", {
      ...host,
      manager: { ...manager, manager: "systemd" },
      home: "/home/me",
      root: "/home/me/.simlock",
    });
    await systemd.serviceCheck?.check();
    expect(seen.at(-1)?.path).toBe(
      "/home/me/.config/systemd/user/com.callstack.simlock.worker.service",
    );
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

    // why: Never regenerated: a second id would strand every device already sitting in a root
    // marked with the first one (ADR 0001, decision 2).
    expect(written.instanceId).not.toBe("");
    expect(JSON.parse(await filesystem.readFile(identityPath))).toEqual(written);
  });

  it("disposes every driver on shutdown, and reports the one that failed without stopping", async () => {
    // why: The wiring, not the halves: `DaemonServer` awaiting its `dispose` option is tested in
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

  it("still answers component.list when a driver's component listing fails", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    ios.failOn("listComponents", 1, new Error("simctl runtime list failed"));
    const { daemon } = await start({ drivers: [ios] });

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

  /** why: Lets the work a mutated daemon would still be doing finish, so "nothing happened" is a
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
      removedBaselines: [],
    });
  });

  it("runs the operator's warm.forget through core's warm pool, which answers the kinds it forgot", async () => {
    const { daemon } = await start();

    const report = await daemon.dispatch(
      "warm.forget",
      { model: "iPhone 17 Pro", platform: "ios" },
      admin,
    );

    expect(report).toEqual({ forgotten: [] });
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

  it("starts a device.exec child from the allowlisted keys of the daemon's environment plus the command's own env, without a secret the daemon inherited", async () => {
    const clock = new FakeClock(1_000);
    const runner = new ScriptedProcessRunner([
      { match: { args: ["list", "devices"], command: "fake-simctl" } },
    ]);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: () => ({
        args: ["list", "devices"],
        command: "fake-simctl",
        env: { SIMLOCK_SCOPED: "1" },
      }),
      passthroughTools: ["simctl"],
      platform: "ios",
    });
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret");
    vi.stubEnv("LC_CTYPE", "simlock-test-locale");
    try {
      const { daemon } = await start({
        clock,
        drivers: [driver],
        hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
        processRunner: runner,
      });
      const grant = (await daemon.dispatch("lease.request", ios, agent)) as Grant;

      await daemon.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId: grant.lease.id, tool: "simctl" },
        agent,
      );

      const env = runner.calls.find((call) => call.command === "fake-simctl")?.options.env;
      expect(env).toMatchObject({ LC_CTYPE: "simlock-test-locale", SIMLOCK_SCOPED: "1" });
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
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

  it("marks a saved baseline whose runtime is gone as stale at start, before anything lists baselines", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    const state = await openStateDatabase({
      dataDirectory: directory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      oldFiles: [],
      owners: [registryOwner, fakeDeviceDataTable, baselinesOwner],
      sqlite: new NodeSqliteOpener(),
      upgradeStep: "unused",
    });
    state.database
      .prepare(
        "INSERT INTO baselines (name, version, platform, model, os_version, mode, saved_at, source_id) VALUES ('login', 1, 'ios', 'iPhone 17 Pro', '26.5', 'full', '2026-11-02T13:40:00.000Z', 'src-login')",
      )
      .run();
    state.close();
    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-26-5 is not installed";
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.setSources([
      {
        id: "src-login",
        kind: "baseline",
        model: "iPhone 17 Pro",
        osVersion: "26.5",
        staleReason: reason,
      },
    ]);

    const daemon = await startDaemon({
      clock,
      configOverrides: STANDALONE_OFF,
      dataDirectory: directory,
      deviceDataTables: fakeDeviceDataTables,
      drivers: [driver],
      filesystem: new MemoryFilesystem(),
      logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
      version: "1.2.3",
    });
    runningDaemons.push(daemon);

    const stale = await historyEventsWhen(directory, hasEvent("baseline.stale"));
    expect(
      stale.filter((event) => event.event === "baseline.stale").map((event) => event.payload),
    ).toEqual([{ name: "login", reason, version: 1 }]);
  });

  it("settles the requests a restart left open before core's device steps announce the capacity figures", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
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
    await previous.createLeaseRequest({
      ownerId: "agent-1",
      request: ios,
      requesterId: "agent-1",
    });
    state.close();

    const daemon = await startDaemon({
      clock,
      configOverrides: STANDALONE_OFF,
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
        configOverrides: STANDALONE_OFF,
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
        configOverrides: STANDALONE_OFF,
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
      latencyMs: { destroy: 600_000 },
      platform: "ios",
    });
    await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);
    await settleRealTime();

    clock.advance(300_000);
    const devices = (await daemon.dispatch("list.get", { kind: "devices" }, admin)) as readonly {
      readonly id: string;
      readonly state: string;
      readonly stalled?: true;
    }[];
    expect(devices.map(({ id, state, stalled }) => ({ id, state, stalled }))).toEqual([
      { id: grant.device.id, state: "shutdown", stalled: undefined },
    ]);

    let stopped = false;
    const stopping = daemon.stop("test").then(() => {
      stopped = true;
    });
    await settleRealTime();
    expect(stopped).toBe(false);
    clock.advance(300_000);
    await stopping;
    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
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
    driver.failOn("destroy", 1, new DriverCrashError("purge exploded"));
    const started = await start({ clock, drivers: [driver] });
    const grant = (await started.daemon.dispatch("lease.request", ios, agent)) as Grant;
    await started.daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);

    await started.daemon.stop("test");
    clock.advance(30_000);
    await settleRealTime();

    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
  });

  describe("a device quarantined by a failed delete", () => {
    type CauseView = {
      readonly id: string;
      readonly quarantineCause?: { readonly kind: string; readonly message?: string };
      readonly state: string;
    };

    async function quarantinedAfterFailedPurge() {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
      driver.failOn("destroy", 1, new DriverCrashError("purge exploded"));
      const { daemon } = await start({
        clock,
        configOverrides: { warmPool: { enabled: false } },
        drivers: [driver],
      });
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

    it("shows quarantineCause delete-failed with the driver's error in status.get and list.get", async () => {
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
          kind: "delete-failed",
          message: "DriverCrashError: purge exploded",
        });
      }
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
  it("claims the socket and answers hello/status.get while doctor.reconcile is still in flight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-slow-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const socketPath = join(directory, "daemon.sock");
    const startPromise = startDaemon({
      clock,
      configOverrides: STANDALONE_OFF,
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
      // why: Round-tripping another status.get proves the parked request was already
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

describe("startDaemon with HTTP off", () => {
  it("starts no HTTP gateway when http.enabled is false", async () => {
    const { port } = await startOnFreePort((port) =>
      start({ configOverrides: { http: { enabled: false, host: "127.0.0.1", port } } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const outcome = await new Promise<"connected" | "refused">((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.once("error", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  });
});

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
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("destroy", 1, new DriverCrashError("purge exploded"));
    const { port, started: daemon } = await startOnFreePort((port) =>
      startDaemon({
        deviceDataTables: fakeDeviceDataTables,
        clock,
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        dataDirectory: directory,
        drivers: [driver],
        filesystem,
        hostLoadProbe: null,
        version: "1.2.3",
      } as StartDaemonOptions),
    );
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
      kind: "delete-failed",
      message: "DriverCrashError: purge exploded",
    });
    expect(await causeFor("slk_cause_agent")).toEqual({ kind: "delete-failed" });
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

  it("keeps component.installed and device.slimmed in the event history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-event-file-"));
    temporaryDirectories.push(directory);
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

    await start({ dataDirectory: directory, drivers: undefined });

    const written = (await historyEventsWhen(directory, hasEvent("device.slimmed"))).map(
      (event) => event.event,
    );
    expect(written).toEqual(expect.arrayContaining(["component.installed", "device.slimmed"]));
  });
});

class UnmeasurableDiskFilesystem extends MemoryFilesystem {
  async diskFree(_path: string): Promise<number> {
    throw Object.assign(new Error("statfs failed"), { code: "EIO" });
  }
}

describe("startDaemon logger wiring", () => {
  it("startDaemon hands its logger to the cleanup reaper: a scheduled cleanup run that fails is logged", async () => {
    const { sink } = await start({ filesystem: new UnmeasurableDiskFilesystem() });

    // why: `daemon.started` triggers a run nobody awaits; its failure has no caller to reach.
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

  it("a gateway rejects worker.drain for an unknown worker with UNKNOWN_WORKER", async () => {
    // why: A gateway serves HTTP; on its default port two overlapping runs of this file collide.
    const { daemon } = await start({ role: "gateway" });

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
  });
});

describe("daemon role (ADR 0034)", () => {
  it("startDaemon with role gateway and no data directory uses <root>/gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "simlock-main-root-"));
    temporaryDirectories.push(root);
    vi.stubEnv("SIMLOCK_HOME", root);
    try {
      const { started: daemon } = await startOnFreePort((port) =>
        startDaemon({
          configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
          drivers: [],
          deviceDataTables: fakeDeviceDataTables,
          role: "gateway",
        }),
      );
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

  it.each([
    [
      "worker",
      "state.json",
      "with the older Simlock, release every lease and run `simlock nuke --delete-devices`; then remove <path> and start again.",
    ],
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
        message: `Found ${oldFile}, which this Simlock no longer reads. To upgrade: ${step.replace("<path>", oldFile)} See https://callstackincubator.github.io/simlock/docs/worker/running-the-daemon#upgrade-simlock.`,
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
    let port = 0;
    const launch = async (now: number) => {
      const launched = await startOnFreePort((candidate) =>
        startDaemon({
          clock: new FakeClock(now),
          configOverrides: {
            ...STANDALONE_OFF,
            http: { enabled: true, host: "127.0.0.1", port: candidate },
          },
          dataDirectory: directory,
          deviceDataTables: fakeDeviceDataTables,
          drivers: [],
          hostLoadProbe: null,
          version: "1.2.3",
        } as StartDaemonOptions),
      );
      port = launched.port;
      return launched.started;
    };
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

  it("a worker drops a deleted device record older than the configured devices.deletedRetentionMs at start", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-deleted-retention-"));
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
    const device = await previous.registerDevice({
      driverData: { fakeDeviceId: "fk-1" },
      driverDeviceId: "drv-1",
      provisionDuration: 0,
      spec: { model: "iPhone 16", osVersion: "26.5", physical: false, platform: "ios" },
    });
    await previous.markDeviceMissing(device.id, "doctor");
    state.close();
    // why: 30 minutes is inside the default hour and outside the ten minutes configured below.
    clock.advance(30 * 60_000);

    await start({
      clock,
      configOverrides: { devices: { deletedRetentionMs: 600_000 } },
      dataDirectory: directory,
    });

    expect(await queryState(directory, "SELECT id FROM devices")).toEqual([]);
  });

  it("a worker's state.db holds both platforms' source-data tables, a gateway's holds neither", async () => {
    const worker = await mkdtemp(join(tmpdir(), "simlock-main-source-owners-"));
    const gateway = await mkdtemp(join(tmpdir(), "simlock-main-source-owners-"));
    temporaryDirectories.push(worker, gateway);
    await start({ dataDirectory: worker });
    await start({ dataDirectory: gateway, role: "gateway" });
    const owners = async (directory: string) =>
      (await queryState(directory, "SELECT owner FROM schema_versions"))
        .map((row) => row["owner"])
        .filter((owner) => owner === "ios-source-data" || owner === "android-source-data")
        .sort();

    expect(await owners(worker)).toEqual(["android-source-data", "ios-source-data"]);
    expect(await owners(gateway)).toEqual([]);
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

  it("refuses to start as already running when connecting to its endpoint times out, as a Windows pipe whose every instance is busy does", async () => {
    const memory = new MemoryIpcTransport();
    const ipc = {
      connect: async () => {
        throw new IpcError("connection-timeout", "timed out", undefined);
      },
      listen: memory.listen.bind(memory),
    };

    await expect(start({ ipc })).rejects.toMatchObject({ name: "DaemonAlreadyRunningError" });
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

describe("startDaemon worker lock", () => {
  const LOCK_PATH = "/tmp/simlock-test/worker.lock";
  const OTHER_FOLDER = "/home/other/.simlock";

  async function filesystemWithLockHeldBy(
    owner: { readonly pid: number; readonly folder: string },
    path = LOCK_PATH,
  ): Promise<MemoryFilesystem> {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(path);
    await filesystem.writeFileAtomic(
      join(path, "owner.json"),
      JSON.stringify({ ...owner, startedAt: "2026-11-02T08:00:00.000Z" }),
    );
    return filesystem;
  }

  async function installAndroidSdk(filesystem: MemoryFilesystem): Promise<void> {
    vi.stubEnv("ANDROID_HOME", "/android-sdk");
    for (const binary of [
      "platform-tools/adb",
      "emulator/emulator",
      "cmdline-tools/latest/bin/avdmanager",
      "cmdline-tools/latest/bin/sdkmanager",
    ]) {
      await filesystem.mkdirp(dirname(join("/android-sdk", binary)));
      await filesystem.writeFileAtomic(join("/android-sdk", binary), "binary");
    }
  }

  // why: real drivers are the ones discovered, so neither the drivers option nor the substitute module may be set.
  async function startWithRealDrivers(
    filesystem: MemoryFilesystem,
    livePids: readonly number[] | FakeProcessSupervisor,
    processRunner: ScriptedProcessRunner,
    dataDirectory?: string,
    extra: Partial<StartDaemonOptions> = {},
  ) {
    vi.stubEnv("SIMLOCK_DRIVERS_MODULE", undefined as unknown as string);
    return start({
      ...extra,
      drivers: undefined,
      filesystem,
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
      npm: new FakeNpmCli(),
      processRunner,
      processSupervisor: Array.isArray(livePids)
        ? new FakeProcessSupervisor(livePids)
        : (livePids as FakeProcessSupervisor),
      workerLockPath: LOCK_PATH,
      ...(dataDirectory === undefined ? {} : { dataDirectory }),
    });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a worker whose lock is held by a live pid in another folder fails to start with the refusal message, before any driver is discovered", async () => {
    const filesystem = await filesystemWithLockHeldBy({ folder: OTHER_FOLDER, pid: 4242 });
    // why: without an SDK discovery does nothing a test can see, so a lock taken after it would pass; with one, discovery creates the Android device root.
    await installAndroidSdk(filesystem);
    const processRunner = new ScriptedProcessRunner([]);
    const dataDirectory = await mkdtemp(join(tmpdir(), "simlock-main-lock-"));
    temporaryDirectories.push(dataDirectory);

    await expect(
      startWithRealDrivers(filesystem, [4242], processRunner, dataDirectory),
    ).rejects.toThrow(
      `another Simlock worker runs for this user (pid 4242, folder ${OTHER_FOLDER}, since 2026-11-02T08:00:00.000Z); stop it first: SIMLOCK_HOME=${OTHER_FOLDER} simlock daemon stop`,
    );
    expect(processRunner.calls).toEqual([]);
    expect(await filesystem.exists(join(dataDirectory, "devices", "android"))).toBe(false);
  });

  it.each([
    { name: "real drivers", substitute: "none" },
    { name: "drivers passed to startDaemon", substitute: "passed" },
    { name: "SIMLOCK_DRIVERS_MODULE set", substitute: "module" },
  ] as const)(
    "takes the worker lock when drivers are discovered, writing its pid, folder and start time, and reads a held one never otherwise: $name",
    async ({ substitute }) => {
      const held = { folder: OTHER_FOLDER, pid: 4242 };
      const filesystem = await filesystemWithLockHeldBy(
        substitute === "none" ? { folder: "/gone", pid: 4343 } : held,
      );
      vi.stubEnv("SIMLOCK_DRIVERS_MODULE", undefined as unknown as string);
      if (substitute === "module") {
        vi.stubEnv(
          "SIMLOCK_DRIVERS_MODULE",
          await writeModule(`export function createDrivers() { return []; }`),
        );
      }

      const { directory } = await start({
        ...(substitute === "passed" ? {} : { drivers: undefined }),
        filesystem,
        hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
        npm: new FakeNpmCli(),
        processRunner: new ScriptedProcessRunner([]),
        processSupervisor: new FakeProcessSupervisor([4242]),
        workerLockPath: LOCK_PATH,
      });

      const owner = JSON.parse(await filesystem.readFile(join(LOCK_PATH, "owner.json")));
      expect(owner).toEqual(
        substitute === "none"
          ? { folder: directory, pid: process.pid, startedAt: "1970-01-01T00:00:01.000Z" }
          : { ...held, startedAt: "2026-11-02T08:00:00.000Z" },
      );
    },
  );

  it("a worker that wins the socket claim while the lock names its folder and another live pid rewrites owner.json with its own pid", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "simlock-main-lock-"));
    temporaryDirectories.push(dataDirectory);
    const filesystem = await filesystemWithLockHeldBy({ folder: dataDirectory, pid: 4242 });

    await startWithRealDrivers(filesystem, [4242], new ScriptedProcessRunner([]), dataDirectory);

    expect(JSON.parse(await filesystem.readFile(join(LOCK_PATH, "owner.json")))).toEqual({
      folder: dataDirectory,
      pid: process.pid,
      startedAt: "1970-01-01T00:00:01.000Z",
    });
  });

  it("a worker that wins the socket claim while a live pid in another folder holds the lock fails its start with the refusal message", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "simlock-main-lock-"));
    temporaryDirectories.push(dataDirectory);
    const filesystem = await filesystemWithLockHeldBy({ folder: dataDirectory, pid: 4242 });
    const ownerFile = join(LOCK_PATH, "owner.json");
    const reads: string[] = [];
    // why: the other worker takes the lock over between this worker's take and its check after the claim, which a start cannot be made to wait for.
    const readFile = filesystem.readFile.bind(filesystem);
    filesystem.readFile = async (path: string) => {
      if (path === ownerFile) reads.push(path);
      return path === ownerFile && reads.length > 1
        ? JSON.stringify({ folder: OTHER_FOLDER, pid: 4242, startedAt: "t0" })
        : readFile(path);
    };

    await expect(
      startWithRealDrivers(filesystem, [4242], new ScriptedProcessRunner([]), dataDirectory),
    ).rejects.toThrow(
      `another Simlock worker runs for this user (pid 4242, folder ${OTHER_FOLDER}, since t0)`,
    );
  });

  it.each([
    { name: "a stop removes the lock it wrote", takenOver: false, failedStart: false },
    { name: "a stop leaves a lock another worker took over", takenOver: true, failedStart: false },
    {
      name: "a start that fails after taking the lock removes it",
      takenOver: false,
      failedStart: true,
    },
  ])("$name", async ({ failedStart, takenOver }) => {
    const filesystem = new MemoryFilesystem();
    const ownerFile = join(LOCK_PATH, "owner.json");
    const taken = { folder: OTHER_FOLDER, pid: 4242, startedAt: "t0" };
    // why: the Android driver's disposal ends the adb server this record names, which is the one thing a test can see a driver do at disposal; the lock must still stand then (ADR 0059 §3).
    await installAndroidSdk(filesystem);
    const dataDirectory = await mkdtemp(join(tmpdir(), "simlock-main-lock-"));
    temporaryDirectories.push(dataDirectory);
    await filesystem.mkdirp(dataDirectory);
    await filesystem.writeFileAtomic(
      join(dataDirectory, "adb-server.json"),
      JSON.stringify({ pid: 4343, port: 5038, startedAt: 1 }),
    );
    const supervisor = new FakeProcessSupervisor([4242, 4343]);
    supervisor.answerCommandLine(4343, "/android-sdk/platform-tools/adb -P 5038 nodaemon server");
    const lockAtDisposal: Promise<boolean>[] = [];
    const signal = supervisor.signal.bind(supervisor);
    supervisor.signal = (pid, kill) => {
      lockAtDisposal.push(filesystem.exists(LOCK_PATH));
      signal(pid, kill);
      supervisor.markDead(pid);
    };
    const starting = startWithRealDrivers(
      filesystem,
      supervisor,
      new ScriptedProcessRunner([]),
      dataDirectory,
      // why: a module named like a core route is refused by the module host, which runs after the lock is taken.
      {
        tcpProbe: new FakeTcpProbe([5038]),
        ...(failedStart ? { optionalModules: [{ name: "status" } as never] } : {}),
      },
    );

    if (failedStart) {
      await expect(starting).rejects.toThrow("status");
    } else {
      const { daemon } = await starting;
      if (takenOver) await filesystem.writeFileAtomic(ownerFile, JSON.stringify(taken));
      await daemon.stop("test");
    }

    if (!failedStart) expect(await Promise.all(lockAtDisposal)).toEqual([true]);
    expect(await filesystem.exists(LOCK_PATH)).toBe(takenOver);
    if (takenOver) expect(JSON.parse(await filesystem.readFile(ownerFile))).toEqual(taken);
  });

  it("a gateway never takes the worker lock, even when it is held", async () => {
    const filesystem = await filesystemWithLockHeldBy({ folder: OTHER_FOLDER, pid: 4242 });
    vi.stubEnv("SIMLOCK_DRIVERS_MODULE", undefined as unknown as string);

    const { daemon } = await startGateway({
      // why: a gateway given no drivers is the case where a worker would discover them and take the lock.
      drivers: undefined as never,
      filesystem,
      processSupervisor: new FakeProcessSupervisor([4242]),
      workerLockPath: LOCK_PATH,
    });

    expect(daemon.health).toBe("running");
    expect(JSON.parse(await filesystem.readFile(join(LOCK_PATH, "owner.json")))).toMatchObject({
      pid: 4242,
    });
  });
});
