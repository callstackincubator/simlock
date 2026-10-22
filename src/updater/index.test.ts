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
  NodeFilesystem,
  ScriptedProcessRunner,
  type DaemonRole,
  type NpmOutcome,
} from "../ports/index.js";
import { checkInstall, runUpdater, type DaemonProbe } from "./index.js";

const PACKAGE_ROOT = "/global/node_modules/simlock";
const CLI = `${PACKAGE_ROOT}/dist/cli/main.js`;
const PID = 4242;
const EPOCH = 1_700_000_000_000;

class StopRecordingNpm extends FakeNpmCli {
  readonly stopsBeforeInstall: number[] = [];
  probe: FakeProbe | undefined;

  override async install(spec: string): Promise<NpmOutcome> {
    this.stopsBeforeInstall.push(this.probe?.stops ?? -1);
    return super.install(spec);
  }
}

class FakeProbe implements DaemonProbe {
  stops = 0;
  oldDaemonAnswers = true;
  newDaemon: { health: string; version: string } | undefined;

  constructor(private readonly staysUp = false) {}

  async stop(): Promise<void> {
    this.stops += 1;
    if (!this.staysUp) this.oldDaemonAnswers = false;
  }

  async answers(): Promise<boolean> {
    return this.oldDaemonAnswers;
  }

  async state(): Promise<{ health: string; version: string } | undefined> {
    return this.newDaemon;
  }
}

interface StartSpec {
  readonly daemon: { health: string; version: string } | null;
  readonly result?: { code: number; stderr: string };
}

interface Scenario {
  readonly name: string;
  readonly role?: DaemonRole;
  readonly install?: readonly NpmOutcome[];
  readonly oldDaemonStaysUp?: boolean;
  readonly starts?: readonly StartSpec[];
  readonly expected: {
    readonly stdout: readonly string[];
    readonly exit: number;
    readonly installs: readonly string[];
    readonly stops: number;
    readonly startArgs: readonly (readonly string[])[];
    readonly signals: readonly string[];
    readonly waitedAtLeastMs: number;
    readonly stderr?: readonly string[];
    readonly stopsBeforeEachInstall?: readonly number[];
    readonly database?: {
      readonly copiedBeforeStart: string;
      readonly restoredBeforeRollbackStart?: string;
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

describe("runUpdater", () => {
  it.each(SCENARIOS)(
    "installs, restarts, and reports each stage on its pipe: $name",
    async ({ role = "worker", install, oldDaemonStaysUp, starts = [], expected }) => {
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
      const copiedBeforeStart: string[] = [];
      const liveAtStart: string[] = [];
      const npm = new StopRecordingNpm(install === undefined ? {} : { install });
      const probe = new FakeProbe(oldDaemonStaysUp);
      npm.probe = probe;
      const processes = new ScriptedProcessRunner(
        expected.startArgs.map((args, index) => ({
          match: { command: process.execPath, args },
          result: { stdout: "", ...(starts[index]?.result ?? { code: 0, stderr: "" }) },
          onSpawn: () => {
            const spec = starts[index];
            probe.newDaemon =
              spec === undefined
                ? { health: "running", version: index === 0 ? "0.4.0" : "0.3.0" }
                : (spec.daemon ?? undefined);
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
              }
            })();
          },
        })),
      );
      const supervisor = new FakeProcessSupervisor([PID]);
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
      expect(processes.calls.map((call) => call.args)).toEqual(expected.startArgs);
      expect(supervisor.signals.map((sent) => `${sent.pid}:${sent.signal}`)).toEqual(
        expected.signals,
      );
      expect(clock.now()).toBeGreaterThanOrEqual(EPOCH + expected.waitedAtLeastMs);
      if (expected.database !== undefined) {
        expect(copiedBeforeStart).toEqual([expected.database.copiedBeforeStart]);
        expect(await filesystem.exists(backupPath)).toBe(expected.database.backupLeft);
        if (expected.database.restoredBeforeRollbackStart !== undefined) {
          expect(liveAtStart[1]).toBe(expected.database.restoredBeforeRollbackStart);
        }
      }
      if (expected.resultFile === undefined) {
        expect(await filesystem.exists(resultPath)).toBe(false);
      } else {
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
        expect(fileAtRollbackStart).toEqual(
          expected.startArgs.length === 2 ? [false, true] : [false],
        );
      }
    },
  );
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
    }[layout];
    await mkdir(real, { recursive: true });
    // why: pnpm and a checkout run from a folder outside npm's global root, which then holds no simlock.
    if (layout !== "npm") await rm(join(npmModules, "simlock"), { recursive: true });
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
