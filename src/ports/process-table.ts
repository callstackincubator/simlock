import type { ProcessRunner } from "./process-runner-types.js";

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  /** why: the process's cumulative CPU time (user plus system), in seconds. */
  readonly cpuSeconds: number;
  readonly command: string;
}

export interface ProcessTable {
  /** why: one read of every process on the host; a read that times out or fails throws, so the caller counts no reading. */
  list(): Promise<readonly ProcessEntry[]>;
}

class ProcessTableReadError extends Error {
  constructor(message: string) {
    super(`could not read the process table: ${message}`);
    this.name = "ProcessTableReadError";
  }
}

export interface NodeProcessTableOptions {
  readonly platform: NodeJS.Platform;
  readonly processRunner: ProcessRunner;
}

const PS_ARGS = ["-axo", "pid=,ppid=,time=,command="];
const PS_TIMEOUT_MS = 5_000;
// why: Win32_Process reports kernel and user time in 100-nanosecond units; the query prints one `pid ppid time command` line each.
const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $([long]$_.KernelModeTime + [long]$_.UserModeTime) $($_.CommandLine)\" }",
];
const POWERSHELL_TIMEOUT_MS = 15_000;
const HUNDRED_NANOSECONDS_PER_SECOND = 10_000_000;

const LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/;
const PS_TIME = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/;

export class NodeProcessTable implements ProcessTable {
  constructor(private readonly options: NodeProcessTableOptions) {}

  async list(): Promise<readonly ProcessEntry[]> {
    const windows = this.options.platform === "win32";
    const result = await this.options.processRunner.run(
      windows ? "powershell.exe" : "ps",
      windows ? POWERSHELL_ARGS : PS_ARGS,
      { timeoutMs: windows ? POWERSHELL_TIMEOUT_MS : PS_TIMEOUT_MS },
    );
    if (result.endedBy !== undefined) throw new ProcessTableReadError(result.endedBy);
    if (result.code !== 0) throw new ProcessTableReadError(`exit ${String(result.code)}`);
    return parseEntries(result.stdout, windows ? windowsSeconds : psSeconds);
  }
}

function parseEntries(
  stdout: string,
  seconds: (text: string | undefined) => number | undefined,
): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = LINE.exec(line);
    const cpuSeconds = match === null ? undefined : seconds(match[3]);
    if (match === null || cpuSeconds === undefined) continue;
    entries.push({
      command: (match[4] ?? "").trim(),
      cpuSeconds,
      pid: Number(match[1]),
      ppid: Number(match[2]),
    });
  }
  return entries;
}

function windowsSeconds(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  return Number(text) / HUNDRED_NANOSECONDS_PER_SECOND;
}

function psSeconds(text: string | undefined): number | undefined {
  const match = PS_TIME.exec(text ?? "");
  if (match === null) return undefined;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

// fallow-ignore-next-line unused-export -- the drivers' idle checks (ADR 0090) test against it.
export class FakeProcessTable implements ProcessTable {
  #entries: readonly ProcessEntry[] = [];
  #failure: Error | undefined;

  set(entries: readonly ProcessEntry[]): void {
    this.#entries = entries;
    this.#failure = undefined;
  }

  // fallow-ignore-next-line unused-class-member -- the drivers' idle checks (ADR 0090) fail a table read with it.
  failNext(error: Error): void {
    this.#failure = error;
  }

  list(): Promise<readonly ProcessEntry[]> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    return Promise.resolve(this.#entries);
  }
}
