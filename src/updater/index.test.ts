import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promiseState } from "../test-support/promise-state.js";
import {
  FakeClock,
  FakeNpmCli,
  FakeProcessSupervisor,
  MemoryFilesystem,
  MemoryIpcTransport,
  resolveDaemonSocketPath,
  NodeFilesystem,
  ScriptedProcessRunner,
  type DaemonRole,
  type NpmOutcome,
} from "../ports/index.js";
import {
  checkInstall,
  createDaemonProbe,
  parseUpdaterArgs,
  runUpdater,
  type DaemonProbe,
} from "./index.js";

const PACKAGE_ROOT = "/global/node_modules/simlock";
const CLI = `${PACKAGE_ROOT}/dist/cli/main.js`;
const PID = 4242;
const EPOCH = 1_700_000_000_000;

class StopRecordingNpm extends FakeNpmCli {
  readonly stopsBeforeInstall: number[] = [];
  probe: FakeProbe | undefined;
  onInstall: (() => Promise<void>) | undefined;

  override async install(spec: string): Promise<NpmOutcome> {
    await this.onInstall?.();
    this.stopsBeforeInstall.push(this.probe?.stops ?? -1);
    return super.install(spec);
  }
}

class FakeProbe implements DaemonProbe {
  stops = 0;
  oldDaemonListening = true;
  newDaemon: { health: string; version: string } | "hangs" | undefined;
  onStop: (() => Promise<void>) | undefined;
  drain: (() => void) | undefined;

  constructor(
    private readonly staysUp = false,
    private readonly stopNeverReturns = false,
  ) {}

  async stop(): Promise<void> {
    this.stops += 1;
    await this.onStop?.();
    if (!this.staysUp) this.drain?.();
    if (this.stopNeverReturns) await new Promise(() => undefined);
  }

  // why: models a real stopping daemon: it holds the socket (accepting, then closing, connections) until it exits, and never completes a handshake again.
  async listening(): Promise<boolean> {
    return this.oldDaemonListening;
  }

  async state(): Promise<{ health: string; version: string } | undefined> {
    if (this.newDaemon === "hangs") return new Promise(() => undefined);
    return this.newDaemon;
  }
}

interface StartSpec {
  readonly daemon: { health: string; version: string } | "hangs" | null;
  readonly hangs?: boolean;
  readonly result?: { code: number; stderr: string };
}

interface Scenario {
  readonly name: string;
  readonly role?: DaemonRole;
  readonly install?: readonly NpmOutcome[];
  readonly oldDaemonStaysUp?: boolean;
  readonly daemonStopNeverReturns?: boolean;
  readonly oldDaemonDrainsMs?: number;
  readonly serviceRestartsDaemonDuringRollbackInstall?: boolean;
  readonly starts?: readonly StartSpec[];
  readonly expected: {
    readonly stdout: readonly string[];
    readonly exit: number;
    readonly installs: readonly string[];
    readonly stops: number;
    readonly startArgs: readonly (readonly string[])[];
    readonly signals: readonly string[];
    readonly waitedAtLeastMs: number;
    readonly waitedAtMostMs?: number;
    readonly stderr?: readonly string[];
    readonly stopsBeforeEachInstall?: readonly number[];
    readonly oldDaemonGoneAtEveryStart?: boolean;
    readonly database?: {
      readonly copiedBeforeStart: string;
      readonly restoredBeforeRollbackStart?: string;
      readonly liveDuringRollbackInstall?: string;
      readonly liveWhenRestartedDaemonStopped?: string;
      readonly liveAtEnd?: string;
      readonly filesRestored?: boolean;
      readonly backupLeft: boolean;
    };
    readonly resultFile?: { readonly message: string; readonly mode: number };
  };
}

const started = (...extra: string[]): readonly string[] => [CLI, "daemon", "start", ...extra];

const SCENARIOS: readonly Scenario[] = [
  {
    name: "latest installed and started",
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 0,
      installs: ["simlock@0.4.0"],
      stops: 1,
      startArgs: [started()],
      signals: [],
      waitedAtLeastMs: 0,
      database: { copiedBeforeStart: "original", backupLeft: false },
    },
  },
  {
    name: "npm fails",
    install: [{ ok: false, message: "npm error 404 simlock@0.4.0 is not in this registry" }],
    expected: {
      stdout: [
        '{"stage":"installing"}',
        '{"failed":{"stage":"installing","message":"npm error 404 simlock@0.4.0 is not in this registry"}}',
      ],
      exit: 1,
      installs: ["simlock@0.4.0"],
      stops: 0,
      startArgs: [],
      signals: [],
      waitedAtLeastMs: 0,
    },
  },
  {
    name: "old daemon still answering after 10 minutes",
    oldDaemonStaysUp: true,
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 0,
      installs: ["simlock@0.4.0"],
      stops: 1,
      startArgs: [started()],
      signals: [`${PID}:SIGKILL`],
      waitedAtLeastMs: 600_000,
    },
  },
  {
    name: "daemon.stop never returns",
    daemonStopNeverReturns: true,
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 0,
      installs: ["simlock@0.4.0"],
      stops: 1,
      startArgs: [started()],
      signals: [],
      waitedAtLeastMs: 30_000,
      waitedAtMostMs: 40_000,
    },
  },
  {
    name: "new version not running within 2 minutes",
    starts: [{ daemon: null }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 1,
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 120_000,
      waitedAtMostMs: 130_000,
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "new daemon running another version than the one installed",
    starts: [{ daemon: { health: "running", version: "0.3.9" } }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 2,
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 120_000,
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "--gateway",
    role: "gateway",
    starts: [{ daemon: null }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 1,
      startArgs: [started("--gateway"), started("--gateway")],
      signals: [],
      waitedAtLeastMs: 120_000,
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "new version reports health failed",
    starts: [{ daemon: { health: "failed", version: "0.4.0" } }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 2,
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 0,
      resultFile: { message: "0.4.0 did not start: health failed", mode: 0o600 },
    },
  },
  {
    name: "daemon start exits non-zero",
    starts: [{ daemon: null, result: { code: 1, stderr: "port busy" } }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 1,
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 0,
      resultFile: { message: "0.4.0 did not start: daemon start: port busy", mode: 0o600 },
    },
  },
  {
    name: "rollback install fails too",
    starts: [{ daemon: null }],
    install: [
      { ok: true, output: "" },
      { ok: false, message: "npm error EACCES" },
    ],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      stderr: ["rollback to 0.3.0 failed: npm error EACCES"],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 1,
      startArgs: [started()],
      signals: [],
      waitedAtLeastMs: 120_000,
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "rolled-back daemon does not start either",
    starts: [{ daemon: null }, { daemon: null }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      stderr: ["rollback to 0.3.0 failed: did not answer within 2 minutes"],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 1,
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 240_000,
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "rollback restores the database copy",
    starts: [{ daemon: null }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 1,
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 120_000,
      database: {
        copiedBeforeStart: "original",
        restoredBeforeRollbackStart: "original",
        liveDuringRollbackInstall: "migrated",
        filesRestored: true,
        backupLeft: false,
      },
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "new daemon alive but starting after 2 minutes",
    starts: [{ daemon: { health: "starting", version: "0.4.0" } }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 2,
      stopsBeforeEachInstall: [0, 2],
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 120_000,
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "old daemon accepted daemon.stop and is still settling",
    oldDaemonDrainsMs: 90_000,
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 0,
      installs: ["simlock@0.4.0"],
      stops: 1,
      startArgs: [started()],
      signals: [],
      waitedAtLeastMs: 90_000,
      oldDaemonGoneAtEveryStart: true,
      database: { copiedBeforeStart: "original", backupLeft: false },
    },
  },
  {
    name: "new daemon ignores daemon.stop for 10 minutes",
    oldDaemonStaysUp: true,
    starts: [{ daemon: { health: "starting", version: "0.4.0" } }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 3,
      stderr: [
        "rollback to 0.3.0 failed: a daemon still holds the socket, so the database copy was not restored",
      ],
      startArgs: [started()],
      signals: [`${PID}:SIGKILL`],
      waitedAtLeastMs: 1_920_000,
      database: { copiedBeforeStart: "original", liveAtEnd: "migrated", backupLeft: true },
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "the service restarts a daemon during the rollback install",
    serviceRestartsDaemonDuringRollbackInstall: true,
    starts: [{ daemon: null }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      stderr: [],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 2,
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 120_000,
      database: {
        copiedBeforeStart: "original",
        restoredBeforeRollbackStart: "original",
        liveWhenRestartedDaemonStopped: "migrated",
        filesRestored: true,
        backupLeft: false,
      },
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "new daemon holds the socket and never answers",
    starts: [{ daemon: "hangs" }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 1,
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 120_000,
      waitedAtMostMs: 200_000,
      resultFile: { message: "0.4.0 did not start: did not answer within 2 minutes", mode: 0o600 },
    },
  },
  {
    name: "daemon start never exits",
    starts: [{ daemon: null, hangs: true }],
    expected: {
      stdout: ['{"stage":"installing"}', '{"stage":"restarting"}'],
      exit: 1,
      installs: ["simlock@0.4.0", "simlock@0.3.0"],
      stops: 1,
      startArgs: [started(), started()],
      signals: [],
      waitedAtLeastMs: 120_000,
      waitedAtMostMs: 200_000,
      resultFile: {
        message: "0.4.0 did not start: daemon start: did not exit within 2 minutes",
        mode: 0o600,
      },
    },
  },
];

const DATABASE_NAMES = [
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "history.db",
  "history.db-wal",
  "history.db-shm",
];

async function settle<T>(promise: Promise<T>, clock: FakeClock): Promise<T> {
  const state = promiseState(promise);
  for (let step = 0; step < 2_000 && state.state === "pending"; step += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.advance(1_000);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (state.state === "rejected") await promise;
  expect(state.state).toBe("fulfilled");
  return promise;
}

type Expected = Scenario["expected"];

async function expectDatabase(
  database: NonNullable<Expected["database"]>,
  seen: {
    readonly filesystem: MemoryFilesystem;
    readonly statePath: string;
    readonly backupPath: string;
    readonly copiedBeforeStart: readonly string[];
    readonly liveAtStart: readonly string[];
    readonly liveAtInstall: readonly string[];
    readonly liveAtStop: readonly string[];
    readonly liveFiles: () => Promise<Record<string, string | undefined>>;
  },
): Promise<void> {
  expect(seen.copiedBeforeStart).toEqual([database.copiedBeforeStart]);
  expect(await seen.filesystem.exists(seen.backupPath)).toBe(database.backupLeft);
  if (database.restoredBeforeRollbackStart !== undefined) {
    expect(seen.liveAtStart[1]).toBe(database.restoredBeforeRollbackStart);
  }
  if (database.liveWhenRestartedDaemonStopped !== undefined) {
    expect(seen.liveAtStop.at(-1)).toBe(database.liveWhenRestartedDaemonStopped);
  }
  if (database.filesRestored === true) {
    // why: every file the backup held is back and the one it lacked (history.db-wal, written by the new version) is gone.
    expect(await seen.liveFiles()).toEqual({
      "state.db": "original",
      "state.db-wal": "wal original",
      "state.db-shm": "shm original",
      "history.db": "history",
      "history.db-wal": undefined,
      "history.db-shm": "history shm",
    });
  }
  if (database.liveAtEnd !== undefined) {
    expect(await seen.filesystem.readFile(seen.statePath)).toBe(database.liveAtEnd);
  }
  if (database.liveDuringRollbackInstall !== undefined) {
    expect(seen.liveAtInstall[1]).toBe(database.liveDuringRollbackInstall);
  }
}

async function expectResultFile(
  expected: Expected,
  seen: {
    readonly filesystem: MemoryFilesystem;
    readonly resultPath: string;
    readonly clock: FakeClock;
    readonly fileAtRollbackStart: readonly boolean[];
  },
): Promise<void> {
  const { filesystem, resultPath, clock } = seen;
  if (expected.resultFile === undefined) {
    expect(await filesystem.exists(resultPath)).toBe(false);
    return;
  }
  const written = JSON.parse(await filesystem.readFile(resultPath)) as { at: number };
  expect(written).toEqual({
    from: "0.3.0",
    to: "0.4.0",
    stage: "restarting",
    message: expected.resultFile.message,
    at: expect.any(Number),
    rolledBack: true,
  });
  expect(written.at).toBeGreaterThanOrEqual(EPOCH);
  expect(written.at).toBeLessThanOrEqual(clock.now());
  expect((await filesystem.stat(resultPath)).mode).toBe(expected.resultFile.mode);
  expect(seen.fileAtRollbackStart).toEqual(
    expected.startArgs.length === 2 ? [false, true] : [false],
  );
}

describe("runUpdater", () => {
  it.each(SCENARIOS)(
    "installs, restarts, and reports each stage on its pipe: $name",
    async ({
      role = "worker",
      install,
      oldDaemonStaysUp,
      daemonStopNeverReturns,
      oldDaemonDrainsMs,
      serviceRestartsDaemonDuringRollbackInstall,
      starts = [],
      expected,
    }) => {
      const clock = new FakeClock(EPOCH);
      const filesystem = new MemoryFilesystem();
      const dataDirectory = role === "gateway" ? "/home/.simlock/gateway" : "/home/.simlock";
      await filesystem.mkdirp(dataDirectory);
      const resultPath = `${dataDirectory}/update-result.json`;
      const fileAtRollbackStart: boolean[] = [];
      const statePath = `${dataDirectory}/state.db`;
      const backupPath = `${dataDirectory}/update-backup`;
      await filesystem.writeFileAtomic(statePath, "original");
      await filesystem.writeFileAtomic(`${dataDirectory}/history.db`, "history");
      await filesystem.writeFileAtomic(`${statePath}-wal`, "wal original");
      await filesystem.writeFileAtomic(`${statePath}-shm`, "shm original");
      await filesystem.writeFileAtomic(`${dataDirectory}/history.db-shm`, "history shm");
      const copiedBeforeStart: string[] = [];
      const liveAtStart: string[] = [];
      const liveAtInstall: string[] = [];
      const liveAtStop: string[] = [];
      const npm = new StopRecordingNpm(install === undefined ? {} : { install });
      const probe = new FakeProbe(oldDaemonStaysUp, daemonStopNeverReturns);
      npm.probe = probe;
      const supervisor = new FakeProcessSupervisor([PID]);
      probe.drain = () => {
        const exit = () => {
          probe.oldDaemonListening = false;
          supervisor.markDead(PID);
        };
        if (oldDaemonDrainsMs === undefined) exit();
        else clock.setTimer(oldDaemonDrainsMs, exit);
      };
      const oldDaemonGoneAtStart: boolean[] = [];
      probe.onStop = async () => {
        liveAtStop.push(await filesystem.readFile(statePath));
      };
      npm.onInstall = async () => {
        liveAtInstall.push(await filesystem.readFile(statePath));
        if (serviceRestartsDaemonDuringRollbackInstall === true && liveAtInstall.length === 2) {
          probe.oldDaemonListening = true;
          probe.newDaemon = { health: "running", version: "0.3.0" };
        }
      };
      const processes = new ScriptedProcessRunner(
        expected.startArgs.map((args, index) => ({
          match: { command: process.execPath, args },
          result: { stdout: "", ...(starts[index]?.result ?? { code: 0, stderr: "" }) },
          ...(starts[index]?.hangs === true ? { hangs: true } : {}),
          onSpawn: () => {
            oldDaemonGoneAtStart.push(!probe.oldDaemonListening && !supervisor.isAlive(PID));
            const spec = starts[index];
            probe.newDaemon =
              spec === undefined
                ? { health: "running", version: index === 0 ? "0.4.0" : "0.3.0" }
                : spec.daemon === null
                  ? undefined
                  : spec.daemon;
            void filesystem.exists(resultPath).then((exists) => fileAtRollbackStart.push(exists));
            void (async () => {
              liveAtStart.push(await filesystem.readFile(statePath));
              if (index === 0) {
                copiedBeforeStart.push(
                  (await filesystem.exists(`${backupPath}/state.db`))
                    ? await filesystem.readFile(`${backupPath}/state.db`)
                    : "missing",
                );
                await filesystem.writeFileAtomic(statePath, "migrated");
                await filesystem.writeFileAtomic(`${statePath}-wal`, "written by the new version");
                await filesystem.writeFileAtomic(`${dataDirectory}/history.db-wal`, "new version");
                await filesystem.writeFileAtomic(`${statePath}-shm`, "new version");
                await filesystem.writeFileAtomic(`${dataDirectory}/history.db-shm`, "new version");
              }
            })();
          },
        })),
      );
      const lines: string[] = [];
      const errors: string[] = [];

      const exit = await settle(
        runUpdater({
          from: "0.3.0",
          to: "0.4.0",
          role,
          pid: PID,
          npm,
          probe,
          processes,
          supervisor,
          filesystem,
          clock,
          packageRoot: PACKAGE_ROOT,
          dataDirectory,
          stdout: { write: (chunk) => lines.push(chunk) },
          stderr: { write: (chunk) => errors.push(chunk) },
        }),
        clock,
      );

      expect(lines.join("").trimEnd().split("\n")).toEqual(expected.stdout);
      expect(errors.join("").split("\n").filter(Boolean)).toEqual(expected.stderr ?? []);
      expect(exit).toBe(expected.exit);
      expect(
        npm.calls.filter((call) => call.method === "install").map((call) => call.spec),
      ).toEqual(expected.installs);
      expect(probe.stops).toBe(expected.stops);
      if (expected.stopsBeforeEachInstall !== undefined) {
        expect(npm.stopsBeforeInstall).toEqual(expected.stopsBeforeEachInstall);
      }
      if (expected.oldDaemonGoneAtEveryStart === true) {
        expect(oldDaemonGoneAtStart).toEqual([true]);
      }
      expect(processes.calls.map((call) => call.args)).toEqual(expected.startArgs);
      expect(supervisor.signals.map((sent) => `${sent.pid}:${sent.signal}`)).toEqual(
        expected.signals,
      );
      expect(clock.now()).toBeGreaterThanOrEqual(EPOCH + expected.waitedAtLeastMs);
      if (expected.waitedAtMostMs !== undefined) {
        expect(clock.now()).toBeLessThanOrEqual(EPOCH + expected.waitedAtMostMs);
      }
      if (expected.database !== undefined) {
        await expectDatabase(expected.database, {
          filesystem,
          statePath,
          backupPath,
          copiedBeforeStart,
          liveAtStart,
          liveAtInstall,
          liveAtStop,
          liveFiles: async () =>
            Object.fromEntries(
              await Promise.all(
                DATABASE_NAMES.map(async (name) => [
                  name,
                  (await filesystem.exists(`${dataDirectory}/${name}`))
                    ? await filesystem.readFile(`${dataDirectory}/${name}`)
                    : undefined,
                ]),
              ),
            ),
        });
      }
      await expectResultFile(expected, { filesystem, resultPath, clock, fileAtRollbackStart });
    },
  );
});

describe("createDaemonProbe", () => {
  const dataDirectory = "/home/.simlock";
  const endpoint = resolveDaemonSocketPath(dataDirectory);
  const setup = async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataDirectory);
    await filesystem.writeFileAtomic(`${dataDirectory}/admin.token`, "token\n");
    await filesystem.writeFileAtomic(endpoint, "");
    const ipc = new MemoryIpcTransport();
    return { ipc, probe: createDaemonProbe({ dataDirectory, filesystem, ipc }) };
  };

  it("a socket file with nothing behind it is not listening and does not answer", async () => {
    const { probe } = await setup();

    expect(await probe.listening()).toBe(false);
    expect(await probe.state()).toBeUndefined();
  });

  it("a stopping daemon that accepts and closes connections is still listening, though it no longer answers", async () => {
    const { ipc, probe } = await setup();
    const listener = await ipc.listen(endpoint, (connection) => {
      void connection.close();
    });

    expect(await probe.listening()).toBe(true);
    expect(await probe.state()).toBeUndefined();

    await listener.close();
    expect(await probe.listening()).toBe(false);
  });
});

describe("checkInstall", () => {
  const trees: string[] = [];

  afterEach(async () => {
    await Promise.all(trees.splice(0).map((tree) => rm(tree, { recursive: true, force: true })));
  });

  it.each([
    { name: "npm global", layout: "npm", globalRoot: "ok", ok: true },
    { name: "pnpm global", layout: "pnpm", globalRoot: "ok", ok: false },
    { name: "source checkout", layout: "checkout", globalRoot: "ok", ok: false },
    { name: "another copy under npm's root", layout: "stale", globalRoot: "ok", ok: false },
    { name: "npm root -g failing", layout: "npm", globalRoot: "fails", ok: false },
  ] as const)("tells npm installs from others: $name", async ({ layout, globalRoot, ok }) => {
    const tree = await realpath(await mkdtemp(join(tmpdir(), "simlock-install-")));
    trees.push(tree);
    const npmModules = join(tree, "npm", "lib", "node_modules");
    await mkdir(join(npmModules, "simlock"), { recursive: true });
    const real = {
      npm: join(npmModules, "simlock"),
      pnpm: join(tree, "pnpm", "store", "simlock"),
      checkout: join(tree, "checkout"),
      stale: join(tree, "stale", "simlock"),
    }[layout];
    await mkdir(real, { recursive: true });
    // why: pnpm and a checkout run from a folder outside npm's global root, which then holds no simlock.
    if (layout === "pnpm" || layout === "checkout")
      await rm(join(npmModules, "simlock"), { recursive: true });
    const packageRoot = join(tree, "running");
    await symlink(real, packageRoot);
    const npm = new FakeNpmCli({
      globalRoot: [
        globalRoot === "ok"
          ? { ok: true, output: `${npmModules}\n` }
          : { ok: false, message: "npm: command not found" },
      ],
    });

    const result = await checkInstall({ npm, filesystem: new NodeFilesystem(), packageRoot });

    expect(result).toEqual(ok ? { ok: true } : { ok: false, foundPath: real });
  });
});

describe("parseUpdaterArgs", () => {
  it.each([
    {
      name: "a worker's update",
      argv: ["--from", "0.3.0", "--to", "0.4.0", "--pid", "4242"],
      parsed: { from: "0.3.0", to: "0.4.0", pid: 4242, role: "worker" },
    },
    {
      name: "a gateway's update",
      argv: ["--from", "0.3.0", "--to", "0.4.0-rc.1", "--pid", "7", "--gateway"],
      parsed: { from: "0.3.0", to: "0.4.0-rc.1", pid: 7, role: "gateway" },
    },
    { name: "a missing --to", argv: ["--from", "0.3.0", "--pid", "7"], parsed: undefined },
    {
      name: "a pid that is not a positive integer",
      argv: ["--from", "0.3.0", "--to", "0.4.0", "--pid", "0"],
      parsed: undefined,
    },
    {
      name: "a version past 64 characters",
      argv: ["--from", "0.3.0", "--to", "1".repeat(65), "--pid", "7"],
      parsed: undefined,
    },
    {
      name: "a version of exactly 64 characters",
      argv: ["--from", "0.3.0", "--to", "1".repeat(64), "--pid", "7"],
      parsed: { from: "0.3.0", to: "1".repeat(64), pid: 7, role: "worker" },
    },
    {
      name: "an argument it does not know",
      argv: ["--from", "0.3.0", "--to", "0.4.0", "--pid", "7", "--force"],
      parsed: undefined,
    },
  ])(
    "reads the arguments a daemon gives the updater and refuses the rest: $name",
    ({ argv, parsed }) => {
      if (parsed === undefined) {
        expect(() => parseUpdaterArgs(argv)).toThrow("bad updater arguments");
      } else {
        expect(parseUpdaterArgs(argv)).toEqual(parsed);
      }
    },
  );
});
