import { join } from "node:path";

import { isMissingPathError } from "../ports/index.js";
import type {
  Clock,
  DaemonRole,
  Filesystem,
  NpmCli,
  ProcessRunner,
  ProcessSupervisor,
} from "../ports/index.js";

export { createDaemonProbe } from "./probe.js";

export interface DaemonProbe {
  stop(): Promise<void>;
  listening(): Promise<boolean>;
  state(): Promise<{ readonly health: string; readonly version: string } | undefined>;
}

export interface RunUpdaterOptions {
  readonly from: string;
  readonly to: string;
  readonly role: DaemonRole;
  readonly pid: number;
  readonly npm: NpmCli;
  readonly probe: DaemonProbe;
  readonly processes: ProcessRunner;
  readonly supervisor: ProcessSupervisor;
  readonly filesystem: Filesystem;
  readonly clock: Clock;
  readonly packageRoot: string;
  readonly dataDirectory: string;
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

const POLL_MS = 500;
const STOP_LIMIT_MS = 10 * 60_000;
const START_LIMIT_MS = 2 * 60_000;
const CALL_LIMIT_MS = 30_000;
const RESULT_FILE = "update-result.json";
const BACKUP_DIRECTORY = "update-backup";
const DATABASE_FILES = ["state.db", "history.db"].flatMap((name) => [
  name,
  `${name}-wal`,
  `${name}-shm`,
]);

function sleep(clock: Clock, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimer(milliseconds, resolve);
  });
}

// why: a daemon that accepted daemon.stop still holds the socket and databases while it settles, so "stopped" is a refused connection (and, for the old daemon, an exited pid), never a failed handshake.
async function waitUntilStopped(
  { clock, probe, supervisor }: RunUpdaterOptions,
  pid?: number,
): Promise<boolean> {
  const deadline = clock.now() + STOP_LIMIT_MS;
  while ((await probe.listening()) || (pid !== undefined && supervisor.isAlive(pid))) {
    if (clock.now() >= deadline) return false;
    await sleep(clock, POLL_MS);
  }
  return true;
}

// why: a daemon that holds the socket but never answers must cost one call's limit, not the whole update.
async function within<T>(clock: Clock, limitMs: number, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<Clock["setTimer"]> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = clock.setTimer(limitMs, () => resolve(undefined));
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clock.cancel(timer);
  }
}

function boundProbe(clock: Clock, probe: DaemonProbe): DaemonProbe {
  return {
    stop: async () => {
      await within(clock, CALL_LIMIT_MS, probe.stop());
    },
    listening: async () => (await within(clock, CALL_LIMIT_MS, probe.listening())) ?? true,
    state: () => within(clock, CALL_LIMIT_MS, probe.state()),
  };
}

function writeLine(options: RunUpdaterOptions, line: unknown): void {
  options.stdout.write(`${JSON.stringify(line)}\n`);
}

export async function runUpdater(given: RunUpdaterOptions): Promise<number> {
  const options = { ...given, probe: boundProbe(given.clock, given.probe) };
  const { clock, npm, probe, to } = options;
  writeLine(options, { stage: "installing" });
  const installed = await npm.install(`simlock@${to}`);
  if (!installed.ok) {
    writeLine(options, { failed: { stage: "installing", message: installed.message } });
    return 1;
  }
  writeLine(options, { stage: "restarting" });
  await probe.stop();
  if (!(await waitUntilStopped(options, options.pid))) {
    options.supervisor.signal(options.pid, "SIGKILL");
  }
  await backupDatabases(options);
  const reason = await startDaemon(options);
  if (reason === undefined) {
    await options.filesystem.rm(join(options.dataDirectory, BACKUP_DIRECTORY));
    return 0;
  }
  if ((await probe.state()) !== undefined) {
    await probe.stop();
    await waitUntilStopped(options);
  }
  await options.filesystem.writeFileAtomic(
    join(options.dataDirectory, RESULT_FILE),
    JSON.stringify({
      from: options.from,
      to,
      stage: "restarting",
      message: `${to} did not start: ${reason}`,
      at: clock.now(),
      rolledBack: true,
    }),
    { mode: 0o600 },
  );
  const reinstalled = await npm.install(`simlock@${options.from}`);
  let rollbackFailure: string | undefined;
  if (reinstalled.ok) {
    if (await stopAnsweringDaemon(options)) {
      await restoreDatabases(options);
      rollbackFailure = await startDaemon({ ...options, to: options.from });
    } else {
      rollbackFailure = "a daemon still holds the socket, so the database copy was not restored";
    }
  } else {
    rollbackFailure = reinstalled.message;
  }
  if (rollbackFailure === undefined) {
    await options.filesystem.rm(join(options.dataDirectory, BACKUP_DIRECTORY));
  } else {
    options.stderr.write(`rollback to ${options.from} failed: ${rollbackFailure}\n`);
  }
  return 1;
}

// why: under a service manager the service may have restarted a daemon by now; its live databases must not be overwritten.
async function stopAnsweringDaemon(options: RunUpdaterOptions): Promise<boolean> {
  if (!(await options.probe.listening())) return true;
  await options.probe.stop();
  return waitUntilStopped(options);
}

async function backupDatabases(options: RunUpdaterOptions): Promise<void> {
  const { dataDirectory, filesystem } = options;
  await filesystem.mkdirp(join(dataDirectory, BACKUP_DIRECTORY));
  for (const name of DATABASE_FILES) {
    if (await filesystem.exists(join(dataDirectory, name))) {
      await filesystem.copyFile(
        join(dataDirectory, name),
        join(dataDirectory, BACKUP_DIRECTORY, name),
      );
    }
  }
}

async function restoreDatabases(options: RunUpdaterOptions): Promise<void> {
  const { dataDirectory, filesystem } = options;
  for (const name of DATABASE_FILES) {
    const copy = join(dataDirectory, BACKUP_DIRECTORY, name);
    if (await filesystem.exists(copy)) {
      await filesystem.copyFile(copy, join(dataDirectory, name));
    } else {
      await filesystem.rm(join(dataDirectory, name));
    }
  }
}

async function startDaemon(options: RunUpdaterOptions): Promise<string | undefined> {
  const started = await within(
    options.clock,
    START_LIMIT_MS,
    options.processes.run(
      process.execPath,
      [
        join(options.packageRoot, "dist", "cli", "main.js"),
        "daemon",
        "start",
        ...(options.role === "gateway" ? ["--gateway"] : []),
      ],
      { timeoutMs: START_LIMIT_MS },
    ),
  );
  if (started === undefined) return "daemon start: did not exit within 2 minutes";
  if (started.code !== 0) return `daemon start: ${started.stderr.trim()}`;
  return awaitRunning(options);
}

async function awaitRunning({ clock, probe, to }: RunUpdaterOptions): Promise<string | undefined> {
  const deadline = clock.now() + START_LIMIT_MS;
  for (;;) {
    const state = await probe.state();
    if (state?.health === "running" && state.version === to) return undefined;
    if (state?.health === "failed") return "health failed";
    if (clock.now() >= deadline) return "did not answer within 2 minutes";
    await sleep(clock, POLL_MS);
  }
}

export type InstallCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly foundPath: string };

export async function checkInstall(options: {
  readonly npm: NpmCli;
  readonly filesystem: Filesystem;
  readonly packageRoot: string;
}): Promise<InstallCheck> {
  const { filesystem } = options;
  const foundPath = await filesystem.realpath(options.packageRoot);
  const globalRoot = await options.npm.globalRoot();
  if (globalRoot.ok) {
    try {
      const npmCopy = await filesystem.realpath(join(globalRoot.output.trim(), "simlock"));
      if (npmCopy === foundPath) return { ok: true };
    } catch (error: unknown) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return { ok: false, foundPath };
}

export interface UpdaterArguments {
  readonly from: string;
  readonly to: string;
  readonly pid: number;
  readonly role: DaemonRole;
}

const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;

export function parseUpdaterArgs(argv: readonly string[]): UpdaterArguments {
  const values = new Map<string, string>();
  let role: DaemonRole = "worker";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--gateway") {
      role = "gateway";
    } else if (["--from", "--to", "--pid"].includes(flag) && argv[index + 1] !== undefined) {
      values.set(flag, argv[index + 1] ?? "");
      index += 1;
    } else {
      throw new Error(`bad updater arguments: ${flag}`);
    }
  }
  const from = values.get("--from") ?? "";
  const to = values.get("--to") ?? "";
  const pid = Number(values.get("--pid"));
  if (
    !VERSION_PATTERN.test(from) ||
    !VERSION_PATTERN.test(to) ||
    !Number.isInteger(pid) ||
    pid < 1
  ) {
    throw new Error("bad updater arguments: --from, --to and --pid are required");
  }
  return { from, to, pid, role };
}
