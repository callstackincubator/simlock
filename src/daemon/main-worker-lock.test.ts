import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeHostInfo,
  FakeNpmCli,
  FakeProcessSupervisor,
  FakeTcpProbe,
  MemoryFilesystem,
  ScriptedProcessRunner,
} from "../ports/index.js";
import { type StartDaemonOptions } from "./main.js";
import {
  start,
  startGateway,
  stopDaemons,
  temporaryDirectories,
  writeModule,
} from "./test-main.js";

afterEach(stopDaemons);

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
