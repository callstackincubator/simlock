import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DriverCrashError } from "../core/index.js";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { seedTokensDatabase } from "../auth/testing.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  NodeFilesystem,
  resolveDaemonSocketPath,
} from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import { parseDaemonArgv } from "./entry-support.js";
import {
  SIMLOCK_HOME,
  STANDALONE_OFF,
  connectRetrying,
  pollUntil,
  pollUntilListening,
  runningDaemons,
  start,
  stopDaemons,
  temporaryDirectories,
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

  it.each([
    ["a pid-less legacy staging directory", ".ios.root-id.staging"],
    [
      "a directory of the user's own that only looks like a staging directory",
      ".photos.2023.backup.staging",
    ],
  ])("startup leaves %s in place", async (_case, name) => {
    const filesystem = new MemoryFilesystem();
    const devices = join(SIMLOCK_HOME, "devices");
    await filesystem.mkdirp(devices);
    const kept = await stage(filesystem, devices, name);

    await startWithRoot(filesystem, new FakeProcessSupervisor());

    expect(await filesystem.exists(kept)).toBe(true);
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

  // why: Windows has no `getuid`, so no file there belongs to another user by id.
  it.skipIf(process.platform === "win32")(
    "startup leaves a dead writer's leftover that another user owns",
    async () => {
      const filesystem = new MemoryFilesystem();
      const devices = join(SIMLOCK_HOME, "devices");
      await filesystem.mkdirp(devices);
      const foreign = await stage(filesystem, devices, ".ios.41005.root-id.staging");
      filesystem.defineAttributes(foreign, { uid: (process.getuid?.() ?? 0) + 1 });

      await startWithRoot(filesystem, new FakeProcessSupervisor());

      expect(await filesystem.exists(foreign)).toBe(true);
    },
  );
});

describe("the data directory", () => {
  // why: a POSIX mode and umask have no Windows counterpart.
  it.skipIf(process.platform === "win32")(
    "creates a missing data directory owner-only, and for one other users can reach logs one warning at start and leaves its mode",
    async () => {
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
    },
  );
});

describe("the data directory", () => {
  // why: a POSIX mode and umask have no Windows counterpart.
  it.skipIf(process.platform === "win32")(
    "makes the parent of a gateway's data directory owner-only too when it creates it",
    async () => {
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
    },
  );
});

describe("the version a daemon reports", () => {
  it("is the version in package.json when the caller names none", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const socketPath = resolveDaemonSocketPath(directory);
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

describe("startDaemon startup readiness", () => {
  it("claims the socket and answers hello/status.get while doctor.reconcile is still in flight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-slow-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const socketPath = resolveDaemonSocketPath(directory);
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
