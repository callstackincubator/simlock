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

function sleep(clock: Clock, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimer(milliseconds, resolve);
  });
}

function writeLine(options: RunUpdaterOptions, line: unknown): void {
  options.stdout.write(`${JSON.stringify(line)}\n`);
}

export async function runUpdater(options: RunUpdaterOptions): Promise<number> {
  const { clock, npm, probe, processes, to } = options;
  writeLine(options, { stage: "installing" });
  await npm.install(`simlock@${to}`);
  writeLine(options, { stage: "restarting" });
  await probe.stop();
  while (await probe.answers()) {
    await sleep(clock, POLL_MS);
  }
  await processes.run(process.execPath, [
    join(options.packageRoot, "dist", "cli", "main.js"),
    "daemon",
    "start",
  ]);
  for (;;) {
    const state = await probe.state();
    if (state?.health === "running" && state.version === to) return 0;
    await sleep(clock, POLL_MS);
  }
}
