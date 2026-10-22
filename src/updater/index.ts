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
}

const POLL_MS = 500;
const STOP_LIMIT_MS = 10 * 60_000;
const START_LIMIT_MS = 2 * 60_000;
const RESULT_FILE = "update-result.json";

function sleep(clock: Clock, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimer(milliseconds, resolve);
  });
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
  const stopDeadline = clock.now() + STOP_LIMIT_MS;
  while (await probe.answers()) {
    if (clock.now() >= stopDeadline) {
      options.supervisor.signal(options.pid, "SIGKILL");
      break;
    }
    await sleep(clock, POLL_MS);
  }
  const reason = await startDaemon(options);
  if (reason === undefined) return 0;
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
  await npm.install(`simlock@${options.from}`);
  await startDaemon({ ...options, to: options.from });
  return 1;
}

async function startDaemon(options: RunUpdaterOptions): Promise<string | undefined> {
  const { clock, probe, to } = options;
  await options.processes.run(process.execPath, [
    join(options.packageRoot, "dist", "cli", "main.js"),
    "daemon",
    "start",
  ]);
  const deadline = clock.now() + START_LIMIT_MS;
  for (;;) {
    const state = await probe.state();
    if (state?.health === "running" && state.version === to) return undefined;
    if (clock.now() >= deadline) return "did not answer within 2 minutes";
    await sleep(clock, POLL_MS);
  }
}
