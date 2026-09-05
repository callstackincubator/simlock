import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";

// `close` normally follows `exit` within the same tick, once the child's own stdio
// pipes report EOF. But children are spawned `detached: true`, so a process that
// forks a grandchild before it dies can leave that grandchild holding the inherited
// write end of our pipe open -- `close` then never fires even though the process we
// actually care about is long gone. After `exit`, `wait()` therefore stops waiting
// for `close` once the pipes have gone quiet for this long.
//
// Quiet, not merely elapsed: settling on a bare timer would truncate the output of a
// process that exited while its pipe was still draining (a large `simctl list --json`
// under a loaded event loop), and a truncated capture surfaces as a parse error far
// from its cause. So the window restarts whenever more output arrives, which
// distinguishes "still draining" from "held open by something that has nothing to
// say" -- the only case this needs to escape.
const EXIT_TO_CLOSE_GRACE_MS = 1_000;

// A grandchild that inherits the pipe *and* chatters on it would otherwise restart the
// grace window forever, so the deferral is capped. Reaching this cap means the output
// may be incomplete; nothing else is waiting on it by then.
const EXIT_TO_CLOSE_MAX_DEFERRAL_MS = 5_000;

// A hard bound on how long `run()` waits after a timeout-triggered SIGTERM before escalating to
// SIGKILL. A child that ignores SIGTERM (or is itself stuck in an uninterruptible wait) would
// otherwise hold the caller's `await process.wait()` open forever -- exactly the unbounded wait
// this constant exists to cap. Fixed rather than derived from `timeoutMs`: it is a
// termination-cleanup budget, not a scaled fraction of the operation's own timeout.
const SIGTERM_TO_SIGKILL_GRACE_MS = 10_000;

export interface ProcessRunOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /**
   * `"ignore"` detaches the child's output entirely: nothing is captured and nothing is
   * iterable. A long-lived supervised process (Simlock's own adb server) would otherwise
   * accumulate every line it ever wrote in this handle's buffers for as long as it runs.
   */
  readonly stdio?: "pipe" | "ignore";
  /**
   * Written to the child's stdin and then closed. For a CLI that reads an interactive prompt
   * from stdin (e.g. `sdkmanager --licenses`'s per-license `y/N`) rather than accepting a flag.
   * Omitted means stdin is left open and unwritten, exactly as before this option existed.
   */
  readonly input?: string;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessHandle {
  readonly pid: number;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  kill(signal?: NodeJS.Signals): void;
  /**
   * Stops this child from keeping the parent's event loop alive. Only for a process that
   * is meant to outlive the daemon and is reaped by pid instead of by exit (Simlock's adb
   * server): everything else is awaited through `wait()` and must keep the loop open.
   */
  unref(): void;
  wait(): Promise<ProcessResult>;
}

/**
 * A child that could not be started at all -- a binary that exists but is not executable,
 * `ETXTBSY` while it is being rewritten, `EAGAIN` under memory pressure. Node reports this
 * asynchronously, so it is raised here as a synchronous throw (and therefore a rejected
 * promise out of `run`) rather than left to surface as an unhandled `error` event.
 */
export class ProcessSpawnError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
  ) {
    super(`Failed to spawn ${command} ${args.join(" ")}`);
    this.name = "ProcessSpawnError";
  }
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessResult>;
  spawn(command: string, args: readonly string[], options?: ProcessRunOptions): ProcessHandle;
}

export class NodeProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    const process = this.spawn(command, args, options);
    let killTimeout: NodeJS.Timeout | undefined;
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            try {
              process.kill("SIGTERM");
            } catch {
              // The child may have exited between the timer firing and the kill.
            }
            // SIGTERM is a request, not a guarantee -- a child that ignores it (or is itself
            // hung) must not be able to keep this `run()` call waiting indefinitely. Escalate to
            // SIGKILL if it hasn't exited within the grace period; cleared below like `timeout`
            // itself the moment `process.wait()` actually settles, so a child that does exit
            // promptly after SIGTERM never sees the follow-up signal.
            killTimeout = setTimeout(() => {
              try {
                process.kill("SIGKILL");
              } catch {
                // The child may have exited between the timer firing and the kill.
              }
            }, SIGTERM_TO_SIGKILL_GRACE_MS);
          }, options.timeoutMs);

    try {
      return await process.wait();
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (killTimeout !== undefined) {
        clearTimeout(killTimeout);
      }
    }
  }

  spawn(command: string, args: readonly string[], options: ProcessRunOptions = {}): ProcessHandle {
    const child = spawnChildProcess(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: process.platform !== "win32",
      stdio: options.stdio ?? "pipe",
    });

    if (child.pid === undefined) {
      // The spawn failed, and Node will say why by emitting `error` on the next tick. An
      // `error` with no listener is a hard, uncatchable process exit, so the listener is
      // attached *before* this function leaves -- throwing first would take the daemon
      // down over an unreadable `adb`. The reason is lost with it (it does not exist yet),
      // which is the price of turning an asynchronous crash into a catchable failure.
      child.once("error", () => undefined);
      throw new ProcessSpawnError(command, args);
    }

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }

    return new NodeProcessHandle(child, child.pid);
  }
}

class NodeProcessHandle implements ProcessHandle {
  readonly pid: number;
  readonly stdout = new LineBuffer();
  readonly stderr = new LineBuffer();
  readonly #stdoutChunks: string[] = [];
  readonly #stderrChunks: string[] = [];
  readonly #result: Promise<ProcessResult>;

  constructor(
    private readonly child: ChildProcess,
    pid: number,
  ) {
    this.pid = pid;
    captureLines(child.stdout, this.stdout, this.#stdoutChunks);
    captureLines(child.stderr, this.stderr, this.#stderrChunks);
    this.#result = new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", reject);

      let settled = false;
      const settle = (code: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ code, stderr: this.#stderrChunks.join(""), stdout: this.#stdoutChunks.join("") });
      };

      child.once("close", (code) => {
        settle(code);
      });
      child.once("exit", (code) => {
        const deadline = Date.now() + EXIT_TO_CLOSE_MAX_DEFERRAL_MS;
        const capturedSoFar = (): number => this.#stdoutChunks.length + this.#stderrChunks.length;
        const armGrace = (chunksAtArm: number): void => {
          const timer = setTimeout(() => {
            if (capturedSoFar() !== chunksAtArm && Date.now() < deadline) {
              armGrace(capturedSoFar());
              return;
            }
            settle(code);
          }, EXIT_TO_CLOSE_GRACE_MS);
          // A pending grace timer must never keep the Node process alive on its own.
          timer.unref();
        };
        armGrace(capturedSoFar());
      });
    });
    // A child nobody waits on (the supervised adb server) would otherwise turn a late
    // `error` into an unhandled rejection, which ends the daemon. Marking the promise
    // handled here changes nothing for a caller that does await `wait()`.
    this.#result.catch(() => undefined);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (process.platform === "win32") {
      this.child.kill(signal);
      return;
    }

    try {
      process.kill(-this.pid, signal);
    } catch (error: unknown) {
      if (isNoSuchProcessError(error)) {
        return;
      }

      throw error;
    }
  }

  unref(): void {
    this.child.unref();
  }

  wait(): Promise<ProcessResult> {
    return this.#result;
  }
}

export interface ProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ProcessRunOptions;
}

export interface ProcessMatcher {
  readonly command: string | RegExp;
  readonly args: readonly (string | RegExp)[];
}

export interface ScriptedProcessExpectation {
  readonly match: ProcessMatcher;
  readonly result?: ProcessResult;
  readonly stdoutLines?: readonly string[];
  readonly stderrLines?: readonly string[];
  readonly hangs?: boolean;
}

export class ScriptedProcessRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  /**
   * The handle each `spawn` returned, index-aligned with `calls`, so a test can assert what
   * the caller did *with* the child rather than only how it was started. `unref` is the case
   * that needs it: nothing about the argv or the options says whether the event loop was
   * released, and a spawned child that stays referenced keeps the daemon alive after
   * `daemon stop`.
   */
  readonly handles: (ProcessHandle & { readonly unreffed: boolean })[] = [];
  #nextPid = 1;
  readonly #expectations: ScriptedProcessExpectation[];

  constructor(expectations: readonly ScriptedProcessExpectation[]) {
    this.#expectations = [...expectations];
  }

  async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    return this.spawn(command, args, options).wait();
  }

  spawn(command: string, args: readonly string[], options: ProcessRunOptions = {}): ProcessHandle {
    const invocation = { args: [...args], command, options };
    this.calls.push(invocation);
    const expectation = this.#expectations.shift();

    if (expectation === undefined || !matches(expectation.match, invocation)) {
      throw new Error(`Unexpected process invocation: ${command} ${args.join(" ")}`);
    }

    const handle = new ScriptedProcessHandle(this.#nextPid++, expectation);
    this.handles.push(handle);
    return handle;
  }
}

class ScriptedProcessHandle implements ProcessHandle {
  /** Whether the caller released the event loop, which only a supervised child should do. */
  unreffed = false;
  readonly stdout = new LineBuffer();
  readonly stderr = new LineBuffer();
  readonly #result: Promise<ProcessResult>;
  #resolve!: (result: ProcessResult) => void;
  #finished = false;

  constructor(
    readonly pid: number,
    private readonly expectation: ScriptedProcessExpectation,
  ) {
    this.#result = new Promise<ProcessResult>((resolve) => {
      this.#resolve = resolve;
    });
    this.#writeLines(expectation.stdoutLines, this.stdout);
    this.#writeLines(expectation.stderrLines, this.stderr);

    if (!expectation.hangs) {
      this.#finish(expectation.result ?? defaultResult(expectation));
    }
  }

  kill(_signal: NodeJS.Signals = "SIGTERM"): void {
    this.#finish({ code: null, stderr: "", stdout: "" });
  }

  unref(): void {
    this.unreffed = true;
  }

  wait(): Promise<ProcessResult> {
    return this.#result;
  }

  #writeLines(lines: readonly string[] | undefined, destination: LineBuffer): void {
    for (const line of lines ?? []) {
      destination.push(line);
    }
  }

  #finish(result: ProcessResult): void {
    if (this.#finished) {
      return;
    }

    this.#finished = true;
    this.stdout.close();
    this.stderr.close();
    this.#resolve(result);
  }
}

class LineBuffer implements AsyncIterable<string> {
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string | undefined) => void> = [];
  #closed = false;

  push(line: string): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
      return;
    }

    this.#lines.push(line);
  }

  close(): void {
    this.#closed = true;

    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.(undefined);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      const line = await this.#next();
      if (line === undefined) {
        return;
      }

      yield line;
    }
  }

  #next(): Promise<string | undefined> {
    const line = this.#lines.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }

    if (this.#closed) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

function captureLines(
  stream: NodeJS.ReadableStream | null,
  destination: LineBuffer,
  chunks: string[],
): void {
  // No pipe means the child was spawned with `stdio: "ignore"`. Closing the buffer
  // straight away is what keeps `for await (const line of handle.stdout)` a loop that
  // ends immediately rather than one that never yields and never returns.
  if (stream === null) {
    destination.close();
    return;
  }

  let remainder = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    chunks.push(chunk);
    const completeLines = `${remainder}${chunk}`.split(/\r?\n/);
    remainder = completeLines.pop() ?? "";

    for (const line of completeLines) {
      destination.push(line);
    }
  });
  stream.on("end", () => {
    if (remainder !== "") {
      destination.push(remainder);
    }
    destination.close();
  });
}

function matches(matcher: ProcessMatcher, invocation: ProcessInvocation): boolean {
  return (
    matchesPart(matcher.command, invocation.command) &&
    matcher.args.length === invocation.args.length &&
    matcher.args.every((argument, index) => matchesPart(argument, invocation.args[index] ?? ""))
  );
}

function matchesPart(matcher: string | RegExp, value: string): boolean {
  return typeof matcher === "string" ? matcher === value : matcher.test(value);
}

function defaultResult(expectation: ScriptedProcessExpectation): ProcessResult {
  return {
    code: 0,
    stderr: (expectation.stderrLines ?? []).join("\n"),
    stdout: (expectation.stdoutLines ?? []).join("\n"),
  };
}

function isNoSuchProcessError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
