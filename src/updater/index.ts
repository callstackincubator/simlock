import { join } from "node:path";

import type {
  Clock,
  DaemonRole,
  Filesystem,
  NpmCli,
  ProcessRunner,
  ProcessSupervisor,
} from "../ports/index.js";

export interface DaemonProbe {
  stop(): Promise<void>;
  answers(): Promise<boolean>;
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

async function waitUntilStopped({ clock, probe }: RunUpdaterOptions): Promise<boolean> {
  const deadline = clock.now() + STOP_LIMIT_MS;
  while (await probe.answers()) {
    if (clock.now() >= deadline) return false;
    await sleep(clock, POLL_MS);
  }
  return true;
}

function writeLine(options: RunUpdaterOptions, line: unknown): void {
  options.stdout.write(`${JSON.stringify(line)}\n`);
}

export async function runUpdater(options: RunUpdaterOptions): Promise<number> {
  const { clock, npm, probe, to } = options;
  writeLine(options, { stage: "installing" });
  const installed = await npm.install(`simlock@${to}`);
  if (!installed.ok) {
    writeLine(options, { failed: { stage: "installing", message: installed.message } });
    return 1;
  }
  writeLine(options, { stage: "restarting" });
  await probe.stop();
  if (!(await waitUntilStopped(options))) {
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
    await restoreDatabases(options);
    rollbackFailure = await startDaemon({ ...options, to: options.from });
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
  const { clock, probe, to } = options;
  const started = await options.processes.run(process.execPath, [
    join(options.packageRoot, "dist", "cli", "main.js"),
    "daemon",
    "start",
    ...(options.role === "gateway" ? ["--gateway"] : []),
  ]);
  if (started.code !== 0) return `daemon start: ${started.stderr.trim()}`;
  const deadline = clock.now() + START_LIMIT_MS;
  for (;;) {
    const state = await probe.state();
    if (state?.health === "running" && state.version === to) return undefined;
    if (state?.health === "failed") return "health failed";
    if (clock.now() >= deadline) return "did not answer within 2 minutes";
    await sleep(clock, POLL_MS);
  }
}
