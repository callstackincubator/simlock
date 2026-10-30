import type { ProcessResult, ProcessRunner } from "./process-runner.js";

/**
 * Liveness and signalling for a process addressed by pid rather than by a handle.
 *
 * `ProcessRunner` covers processes this daemon spawned and still holds; this port covers
 * the ones it does not: a supervised child recorded on disk outlives the daemon that
 * started it, so after a crash the only thing left to ask about it is its pid.
 */
export interface ProcessSupervisor {
  /** True when a process with this pid exists and this user may signal it. */
  isAlive(pid: number): boolean;
  /** Best effort; a pid that is already gone is not an error. */
  signal(pid: number, signal: NodeJS.Signals): void;
  /**
   * why: a recorded pid may since have been handed to another process, so a caller proves what
   * it is from its arguments before signalling it. They come back unquoted and joined by single
   * spaces on every platform, as `ps -o args=` prints them, so one matcher reads them all; a
   * read that fails, times out or prints nothing is `undefined`, never a guess.
   */
  commandLine(pid: number): Promise<string | undefined>;
}

export interface NodeProcessSupervisorOptions {
  readonly platform: NodeJS.Platform;
  readonly processRunner: ProcessRunner;
}

export class NodeProcessSupervisor implements ProcessSupervisor {
  readonly #options: NodeProcessSupervisorOptions;

  constructor(options: NodeProcessSupervisorOptions) {
    this.#options = options;
  }

  async commandLine(pid: number): Promise<string | undefined> {
    if (!isAddressablePid(pid)) {
      return undefined;
    }

    const windows = this.#options.platform === "win32";
    let result: ProcessResult;
    try {
      result = windows
        ? await this.#options.processRunner.run("powershell.exe", windowsCommandLineRead(pid), {
            timeoutMs: COMMAND_LINE_TIMEOUT_MS,
          })
        : await this.#options.processRunner.run("ps", ["-ww", "-o", "args=", "-p", String(pid)], {
            timeoutMs: COMMAND_LINE_TIMEOUT_MS,
          });
    } catch {
      return undefined;
    }

    const line = result.code === 0 ? (result.stdout.split("\n")[0]?.trim() ?? "") : "";
    if (line === "") {
      return undefined;
    }

    return windows ? windowsArguments(line).join(" ") : line;
  }

  isAlive(pid: number): boolean {
    if (!isAddressablePid(pid)) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      // Both ESRCH (gone) and EPERM (alive, but another user's) answer "no" here, and
      // deliberately so: this port exists to decide whether a recorded pid is a process
      // this daemon can still reap. One it may not signal is not that, whatever it is --
      // and reporting it alive would leave the caller waiting on a kill that can never
      // land. Anything else is a bug rather than an answer about a process, and reporting
      // it as "not alive" would hide it behind a plausible-looking result.
      if (isFailureWithCode(error, NOT_ALIVE_CODES)) {
        return false;
      }

      throw error;
    }
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    if (!isAddressablePid(pid)) {
      return;
    }

    try {
      process.kill(pid, signal);
    } catch (error: unknown) {
      if (isFailureWithCode(error, NO_SUCH_PROCESS_CODES)) {
        return;
      }

      throw error;
    }
  }
}

export interface SignalRecord {
  readonly pid: number;
  readonly signal: NodeJS.Signals;
}

/**
 * Records signals instead of sending them, and lets a test decide which pids are alive.
 * Signalling deliberately does not kill anything here: whether a process dies on SIGTERM,
 * ignores it, or dies only on SIGKILL is exactly what the supervision code under test has
 * to cope with, so the test says which of those happened.
 */
export class FakeProcessSupervisor implements ProcessSupervisor {
  readonly signals: SignalRecord[] = [];
  readonly commandLineReads: number[] = [];
  readonly #live = new Set<number>();
  readonly #commandLines = new Map<number, (string | undefined)[]>();

  constructor(livePids: readonly number[] = []) {
    for (const pid of livePids) {
      this.#live.add(pid);
    }
  }

  isAlive(pid: number): boolean {
    return this.#live.has(pid);
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pid, signal });
  }

  markAlive(pid: number): void {
    this.#live.add(pid);
  }

  markDead(pid: number): void {
    this.#live.delete(pid);
  }

  commandLine(pid: number): Promise<string | undefined> {
    this.commandLineReads.push(pid);
    const answers = this.#commandLines.get(pid) ?? [];
    return Promise.resolve(answers.length > 1 ? answers.shift() : answers[0]);
  }

  /** why: a pid's second read can differ from its first (it exited and its number was reused), so each read takes the next answer and the last one repeats. */
  answerCommandLine(pid: number, ...answers: (string | undefined)[]): void {
    this.#commandLines.set(pid, [...answers]);
  }
}

/** why: PowerShell's first start on a cold host takes seconds, and `ps` answers in milliseconds; one bound covers both. */
const COMMAND_LINE_TIMEOUT_MS = 5_000;

/**
 * why: Windows has no `ps`; `Win32_Process` holds the command line as the parent passed it.
 * PowerShell writes a redirected stdout in the console's code page unless told otherwise, which
 * would turn a non-ASCII path into one no caller's marker matches.
 */
function windowsCommandLineRead(pid: number): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
  ];
}

/**
 * why: Windows passes a child one string, quoted by its parent (libuv, for Node), and a quoted
 * argument would not match a caller's marker. This splits it back as the C runtime does: the
 * program name ends at its closing quote or first blank; elsewhere 2n backslashes before a quote
 * are n and the quote toggles quoting, 2n+1 are n and a literal quote, and other backslashes
 * are literal.
 */
function windowsArguments(commandLine: string): string[] {
  const program = /^"([^"]*)"?|^[^ \t]*/.exec(commandLine) as RegExpExecArray;
  return [program[1] ?? program[0], ...splitWindowsArguments(commandLine.slice(program[0].length))];
}

/** why: a quote with the backslashes before it is one token, as their count decides what both mean. */
const WINDOWS_ARGUMENT_TOKEN = /(\\*)"|[ \t]+|\\+|[^\\" \t]+/g;

interface ArgumentSplit {
  readonly args: string[];
  current: string | undefined;
  quoted: boolean;
}

function splitWindowsArguments(rest: string): string[] {
  const split: ArgumentSplit = { args: [], current: undefined, quoted: false };
  for (const [token, slashes] of rest.matchAll(WINDOWS_ARGUMENT_TOKEN)) {
    if (slashes !== undefined) appendQuote(split, slashes.length);
    else if (!split.quoted && /^[ \t]/.test(token)) endArgument(split);
    else split.current = (split.current ?? "") + token;
  }
  endArgument(split);
  return split.args;
}

function appendQuote(split: ArgumentSplit, slashes: number): void {
  const literal = slashes % 2 === 1;
  split.current = `${split.current ?? ""}${"\\".repeat(Math.floor(slashes / 2))}${literal ? '"' : ""}`;
  if (!literal) split.quoted = !split.quoted;
}

function endArgument(split: ArgumentSplit): void {
  if (split.current !== undefined) split.args.push(split.current);
  split.current = undefined;
}

/** The pid is gone, or belongs to a user this process may not signal. */
const NOT_ALIVE_CODES = new Set(["ESRCH", "EPERM"]);

const NO_SUCH_PROCESS_CODES = new Set(["ESRCH"]);

/** `process.kill` refuses anything outside a signed 32-bit integer with a `RangeError`. */
const MAX_PID = 2 ** 31 - 1;

/**
 * Whether this number addresses one process at all. `process.kill` reads `0` as "every
 * process in my group" and a negative pid as a whole group -- `-1` as every process this
 * user may signal -- so a pid read back from a corrupt record on disk could turn a
 * routine `SIGKILL` of a stale child into the end of the user's login session. Guarding
 * here rather than in each caller is the point: this port is the primitive they all pass
 * through (safety rule 1).
 */
function isAddressablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_PID;
}

function isFailureWithCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.has(error.code)
  );
}
