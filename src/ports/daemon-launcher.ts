import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface DaemonLauncher {
  launch(): Promise<LaunchedDaemon>;
}

export interface DaemonExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface LaunchedDaemon {
  readonly exited: Promise<DaemonExit>;
  readOutput(): Promise<string>;
}

export function startErrorFrom(exit: DaemonExit, output: string): string {
  const lines = output.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const message = fatalMessage(lines[index] ?? "");
    if (message !== undefined) return `The daemon could not start: ${message}`;
  }
  return `The daemon exited with code ${String(exit.code ?? exit.signal)} while starting; see \`simlock daemon logs\``;
}

const DEADLINE_LOG_LINES = 20;

export function startTimeoutMessage(lastError: string, output: string): string {
  const lines = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-DEADLINE_LOG_LINES);
  const base = `Timed out starting simlock daemon: ${lastError}`;
  return lines.length === 0 ? base : `${base}\ndaemon.log since the start:\n${lines.join("\n")}`;
}

export async function logReaderSince(logPath: string): Promise<() => Promise<string>> {
  const before = await stat(logPath).catch(() => undefined);
  if (before === undefined) {
    return async () => (await readFile(logPath)).subarray(-MAX_OUTPUT_BYTES).toString("utf8");
  }
  return () => readLogSince(logPath, before.ino, before.size);
}

function fatalMessage(line: string): string | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const { message, fields } = record as { message?: unknown; fields?: unknown };
  if (message !== "Daemon failed to start") return undefined;
  if (typeof fields !== "object" || fields === null) return undefined;
  const detail = (fields as { message?: unknown }).message;
  return typeof detail === "string" ? detail : undefined;
}

/**
 * why: this is not an expected wait -- a daemon boots in a second or two; 20 s is the ceiling
 * for a loaded machine, long enough that a start is not reported failed while the daemon the
 * caller itself launched is still coming up. It stays under the 30 s a caller gives the CLI
 * process, so a start that gives up still gets to say so itself. Both frontends' launch-then-
 * poll loops read this one bound; neither writes a number of its own (architecture rule 10).
 */
export const DAEMON_STARTUP_TIMEOUT_MS = 20_000;

export interface NodeDaemonLauncherOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly logPath: string;
  /**
   * why: The *resolved* `SIMLOCK_HOME` the launching process is using. It is exported into the
   * daemon's environment rather than left to be inherited, because a relative
   * `SIMLOCK_HOME` resolves against whatever directory the process reading it happens to
   * be standing in -- and the two processes agreeing only because one spawned the other
   * from its own cwd is an assumption, not a guarantee. It now decides where tens of
   * gigabytes of devices live, and a daemon that resolved it differently would build its
   * device roots somewhere the CLI never looks.
   */
  readonly simlockHome: string;
}

/**
 * why: the log lives in the data directory, and on a fresh machine this launch is what first
 * creates it, so it is made owner-only here (`DATA_DIRECTORY_MODE`, which a test that loads this
 * file alone in a child process cannot import), its parents left to the default and an existing
 * one left as it is. `chmod` because the umask can only take bits from `mkdir`'s mode.
 */
async function createDataDirectory(directory: string): Promise<void> {
  await mkdir(dirname(directory), { recursive: true });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
      return;
    throw error;
  }
  await chmod(directory, 0o700);
}

export class NodeDaemonLauncher implements DaemonLauncher {
  constructor(private readonly options: NodeDaemonLauncherOptions) {}

  async launch(): Promise<LaunchedDaemon> {
    await createDataDirectory(dirname(this.options.logPath));
    // why: 0600 at creation, like the other files that hold secrets or state under the home:
    // this `open` is what first creates `daemon.log` for an auto-launched daemon -- the daemon's
    // own sink only appends to the file this one made.
    const log = await open(this.options.logPath, "a", 0o600);
    const { ino, size } = await log.stat();
    const logPath = this.options.logPath;
    try {
      const child = spawn(this.options.command, this.options.args, {
        detached: true,
        // why: Explicit rather than relying on spawn's default: the daemon must inherit
        // overrides like SIMLOCK_DRIVERS_MODULE from whichever frontend (CLI/MCP)
        // auto-launched it, and must be told the home this one already resolved.
        env: { ...process.env, SIMLOCK_HOME: this.options.simlockHome },
        stdio: ["ignore", log.fd, log.fd],
      });
      const exited = new Promise<DaemonExit>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      return { exited, readOutput: () => readLogSince(logPath, ino, size) };
    } finally {
      await log.close();
    }
  }
}

export class FakeDaemonLauncher implements DaemonLauncher {
  launches = 0;

  constructor(
    private readonly onLaunch: () => Promise<void> | void = () => undefined,
    private readonly result: { readonly exit?: DaemonExit; readonly output?: string } = {},
  ) {}

  async launch(): Promise<LaunchedDaemon> {
    this.launches += 1;
    await this.onLaunch();
    const { exit, output = "" } = this.result;
    return {
      exited: exit === undefined ? new Promise<DaemonExit>(() => undefined) : Promise.resolve(exit),
      readOutput: async () => output,
    };
  }
}

const MAX_OUTPUT_BYTES = 64 * 1024;

// why: `NodeFileLogSink` rotates by renaming the log to `<path>.1`, so the bytes written since
// the launch can sit in either file; the inode noted at launch says which one is the old log.
async function readLogSince(logPath: string, ino: number, size: number): Promise<string> {
  const chunks: Buffer[] = [];
  if ((await stat(logPath)).ino === ino) {
    chunks.push((await readFile(logPath)).subarray(size));
  } else {
    const rotatedPath = `${logPath}.1`;
    if ((await stat(rotatedPath)).ino !== ino) throw new Error("daemon.log was replaced");
    chunks.push((await readFile(rotatedPath)).subarray(size), await readFile(logPath));
  }
  return Buffer.concat(chunks).subarray(-MAX_OUTPUT_BYTES).toString("utf8");
}
