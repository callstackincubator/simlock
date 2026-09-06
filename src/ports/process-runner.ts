import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { constants } from "node:os";

// `close` normally follows `exit` within the same tick, once the child's own stdio
// pipes report EOF. But a child that forks a grandchild before it dies leaves that
// grandchild holding the inherited write end of our pipe open -- it was handed the
// same descriptors, and nothing takes them back -- so `close` never fires even
// though the process we actually care about is long gone. (`detached: true` is not
// the cause; it is why the grandchild is reachable to kill, since it puts the whole
// tree in one process group.) After `exit`, `wait()` therefore stops waiting for
// `close` once the pipes have gone quiet for this long.
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

/**
 * ADR 0005 §19a's spawn: a child whose output is handed to the caller chunk by chunk as it
 * arrives and is never accumulated anywhere in this process.
 *
 * Deliberately a second method rather than an option on `spawn`: `ProcessHandle` exposes its
 * output as line-delimited `AsyncIterable`s *and* keeps every chunk so `wait()` can hand back
 * a complete `stdout`/`stderr` -- exactly right for the driver calls that parse a tool's whole
 * answer, and exactly wrong for `device.exec`, which must forward bytes as they appear and
 * hold none of them (§19e: "Output is streamed, never buffered, so there is no size cap").
 * Bolting a "don't buffer" flag onto `spawn` would have left `ProcessResult`'s `stdout`/`stderr`
 * silently empty for that mode; a separate return type says so in the type system instead.
 *
 * Chunks are whatever the child wrote, decoded UTF-8, unsplit: no line assembly, so a caller
 * that wants lines does that itself.
 */
export interface ProcessStreamOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /**
   * Written to the child's stdin, which is then closed -- the one-shot `stdin` of ADR §19c.
   * Omitted leaves stdin open and unwritten (a child that reads it simply blocks until its
   * own timeout), matching `ProcessRunOptions.input`.
   */
  readonly input?: string;
  /**
   * Called with each chunk as it arrives. **May return a promise**, and if it does, this
   * runner stops reading that stream until it resolves -- which is how backpressure reaches
   * the child: a consumer that cannot place a chunk yet (an SSE client that is not reading, a
   * socket that has not drained) slows the command down instead of accumulating its output
   * somewhere. ADR 0005 §19e says output is streamed and never buffered; that is only true
   * end to end if the slow end can push back, so the callback's promise is the seam that
   * makes it true rather than a claim about the fast path only.
   */
  readonly onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}

/** How a streamed child ended. `code` is null when a signal killed it, in which case
 * `signal` names it -- `exitCodeOf` below turns the pair into the single number a shell
 * would report. */
export interface StreamingProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface StreamingProcessHandle {
  readonly pid: number;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<StreamingProcessResult>;
}

/**
 * The single number a shell reports for a finished process: its own exit code, or
 * `128 + signal` when a signal ended it. Lives here, in the port's adapter layer, because
 * turning a signal *name* into its number needs `node:os` -- which application code (the
 * dispatcher that answers `device.exec` with an `exitCode`) may not import (architecture
 * rule 9). Mirrors what `src/cli/passthrough.ts` does for a locally-spawned passthrough, so
 * the same command reports the same number whether it ran here or there.
 */
export function exitCodeOf(result: StreamingProcessResult): number {
  if (result.code !== null) return result.code;
  if (result.signal === null) return 1;
  return 128 + (constants.signals[result.signal] ?? 0);
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
  /** ADR 0005 §19a: spawns a child and forwards its output chunk by chunk, buffering none of
   * it. See `ProcessStreamOptions`. */
  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle;
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

  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    const child = spawnChildProcess(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: process.platform !== "win32",
      stdio: "pipe",
    });

    if (child.pid === undefined) {
      // Same reasoning as `spawn` above: attach a listener before throwing, or Node's
      // asynchronous `error` takes the daemon down instead of rejecting one operation.
      child.once("error", () => undefined);
      throw new ProcessSpawnError(command, args);
    }

    const handle = new NodeStreamingProcessHandle(child, child.pid, options.onChunk);
    if (options.input !== undefined) {
      // One shot, then closed (ADR 0005 §19c): a command reading stdin sees exactly this and
      // then EOF. `end` is safe even if the child already exited -- the EPIPE that produces is
      // swallowed below rather than left to surface as an unhandled `error` on the stream.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    return handle;
  }
}

/**
 * `spawnStreaming`'s handle. Holds no output: every chunk is handed to `onChunk` the moment
 * the stream emits it and is then forgotten, which is what lets `device.exec` stream
 * arbitrarily large output through a daemon that never grows for it.
 *
 * Settling repeats `NodeProcessHandle`'s `exit`-then-quiet-window dance for the same reason
 * (see `EXIT_TO_CLOSE_GRACE_MS`): a grandchild holding the inherited pipe open (`adb
 * start-server` is exactly this) means `close` may never fire even though the process the
 * caller asked about is gone.
 */
class NodeStreamingProcessHandle implements StreamingProcessHandle {
  readonly pid: number;
  readonly #result: Promise<StreamingProcessResult>;
  #chunkCount = 0;

  constructor(
    private readonly child: ChildProcess,
    pid: number,
    onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>,
  ) {
    this.pid = pid;
    this.#forward(child.stdout, "stdout", onChunk);
    this.#forward(child.stderr, "stderr", onChunk);
    this.#result = new Promise<StreamingProcessResult>((resolve, reject) => {
      child.once("error", reject);

      let settled = false;
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        resolve({ code, signal });
      };

      child.once("close", (code, signal) => {
        settle(code, signal);
      });
      child.once("exit", (code, signal) => {
        const deadline = Date.now() + EXIT_TO_CLOSE_MAX_DEFERRAL_MS;
        const armGrace = (chunksAtArm: number): void => {
          const timer = setTimeout(() => {
            if (this.#chunkCount !== chunksAtArm && Date.now() < deadline) {
              armGrace(this.#chunkCount);
              return;
            }
            settle(code, signal);
          }, EXIT_TO_CLOSE_GRACE_MS);
          timer.unref();
        };
        armGrace(this.#chunkCount);
      });
    });
    // A late `error` on a handle whose `wait()` nobody kept (a caller that killed and walked
    // away) must not become an unhandled rejection and end the daemon; a caller that does
    // await `wait()` still sees the rejection.
    this.#result.catch(() => undefined);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    killProcessTree(this.child, this.pid, signal);
  }

  wait(): Promise<StreamingProcessResult> {
    return this.#result;
  }

  #forward(
    stream: NodeJS.ReadableStream | null,
    name: "stdout" | "stderr",
    onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>,
  ): void {
    if (stream === null) return;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#chunkCount += 1;
      const delivered = onChunk(name, chunk);
      if (delivered === undefined) return;
      // The consumer is not ready for more yet. Pausing the readable stops this child at the
      // pipe -- it fills the OS buffer and then blocks in its own `write` -- which is the only
      // place backpressure can be applied without holding the bytes somewhere. Resumed on
      // either outcome: a failed delivery (a dead socket) must not wedge the process, and the
      // exec timeout still bounds a child nobody drains.
      stream.pause();
      void Promise.resolve(delivered).then(
        () => stream.resume(),
        () => stream.resume(),
      );
    });
  }
}

/**
 * Signals the child's whole process group (children are spawned `detached`, so the group is
 * the unit that actually dies), falling back to the child alone on Windows and treating an
 * already-exited process as success. Extracted so `ProcessHandle` and `StreamingProcessHandle`
 * kill identically -- a timeout that only reached the direct child would leave a tool's own
 * subprocesses running.
 */
function killProcessTree(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (isNoSuchProcessError(error)) {
      return;
    }

    throw error;
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
    killProcessTree(this.child, this.pid, signal);
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
  /**
   * Raw chunks for `spawnStreaming`, emitted in this exact order across both streams --
   * which `stdoutLines`/`stderrLines` cannot express, since they are two separate lists with
   * no ordering between them. A test asserting that interleaved output reaches a caller in
   * arrival order needs that, so it is stated here rather than inferred. When absent,
   * `spawnStreaming` falls back to the line lists (stdout then stderr, newline-terminated).
   */
  readonly chunks?: readonly { readonly stream: "stdout" | "stderr"; readonly chunk: string }[];
  /**
   * Models a child that ignores `SIGTERM` -- only `SIGKILL` ends it. Without this a scripted
   * `hangs` process dies on the first signal, so the escalation every timeout path depends on
   * (`SIGTERM`, then `SIGKILL` after a grace window) is never actually exercised: the code that
   * sends the second signal would be dead and nothing would notice.
   */
  readonly ignoresSigterm?: boolean;
}

export class ScriptedProcessRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
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

    return new ScriptedProcessHandle(this.#nextPid++, expectation);
  }

  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    const invocation = {
      args: [...args],
      command,
      // Recorded as a `ProcessRunOptions` so `calls` stays one list a test can read uniformly;
      // `onChunk` is a callback, not configuration, and nothing would assert on it.
      options: {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.input === undefined ? {} : { input: options.input }),
      },
    };
    this.calls.push(invocation);
    const expectation = this.#expectations.shift();

    if (expectation === undefined || !matches(expectation.match, invocation)) {
      throw new Error(`Unexpected process invocation: ${command} ${args.join(" ")}`);
    }

    return new ScriptedStreamingProcessHandle(this.#nextPid++, expectation, options.onChunk);
  }
}

/**
 * The scripted counterpart of `NodeStreamingProcessHandle`: emits the expectation's chunks
 * synchronously (so a test needs no timers to see them), then settles unless the expectation
 * `hangs` -- in which case only `kill()` settles it, reporting the signal the way a real
 * killed child does. That is what makes the daemon's exec timeout testable without a real
 * process or a real clock.
 */
class ScriptedStreamingProcessHandle implements StreamingProcessHandle {
  readonly #result: Promise<StreamingProcessResult>;
  #resolve!: (result: StreamingProcessResult) => void;
  #finished = false;

  readonly #ignoresSigterm: boolean;

  constructor(
    readonly pid: number,
    expectation: ScriptedProcessExpectation,
    onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>,
  ) {
    this.#ignoresSigterm = expectation.ignoresSigterm ?? false;
    this.#result = new Promise<StreamingProcessResult>((resolve) => {
      this.#resolve = resolve;
    });
    void this.#deliver(expectation, onChunk);
  }

  /**
   * One chunk at a time, awaiting each delivery before the next -- the same discipline
   * `NodeStreamingProcessHandle` gets by pausing a readable, so a test that stalls a delivery
   * sees the scripted child stall too rather than racing ahead of it. The command settles only
   * once its output is delivered, which keeps "output, then exit code" true here as well.
   */
  async #deliver(
    expectation: ScriptedProcessExpectation,
    onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>,
  ): Promise<void> {
    for (const { chunk, stream } of scriptedChunks(expectation)) {
      if (this.#finished) return;
      await onChunk(stream, chunk);
    }
    if (!expectation.hangs) {
      this.#finish({ code: expectation.result?.code ?? 0, signal: null });
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.#ignoresSigterm && signal !== "SIGKILL") return;
    this.#finish({ code: null, signal });
  }

  wait(): Promise<StreamingProcessResult> {
    return this.#result;
  }

  #finish(result: StreamingProcessResult): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#resolve(result);
  }
}

function scriptedChunks(
  expectation: ScriptedProcessExpectation,
): readonly { readonly stream: "stdout" | "stderr"; readonly chunk: string }[] {
  if (expectation.chunks !== undefined) return expectation.chunks;
  return [
    ...(expectation.stdoutLines ?? []).map((line) => ({
      chunk: `${line}\n`,
      stream: "stdout" as const,
    })),
    ...(expectation.stderrLines ?? []).map((line) => ({
      chunk: `${line}\n`,
      stream: "stderr" as const,
    })),
  ];
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
