export interface ProcessRunOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /**
   * why: `"ignore"` detaches the child's output entirely: nothing is captured and nothing is
   * iterable. A long-lived supervised process would otherwise accumulate every line it ever
   * wrote in this handle's buffers for as long as it runs. `{ file }` appends the child's
   * stdout and stderr to that file (created 0600 when missing, whose directory must exist),
   * with the same effect on the handle: nothing is captured.
   */
  readonly stdio?: "pipe" | "ignore" | { readonly file: string };
  readonly input?: string;
  /**
   * why: ends the child when the caller no longer wants its answer: aborting kills the child's
   * whole process group, and `run` answers `endedBy: "aborted"`.
   */
  readonly signal?: AbortSignal;
  /**
   * why: a bound on a child's stdout, counted in bytes as it arrives: past it the runner kills the
   * child and answers `endedBy: "output-limit"`. Output is kept in memory until the child ends, so
   * a caller that reads an answer from an untrusted program sets it.
   */
  readonly maxStdoutBytes?: number;
  /**
   * why: Where `spawn`'s `stdout` and `stderr` iterables end a line. `"newline"` (the default) ends
   * one only at `\n`. `"carriage-return-too"` also ends one at a bare `\r`, and yields no empty
   * lines: an installer such as `sdkmanager` redraws its progress bar in place with `\r`, so
   * without this every update waits in one unfinished line until the process prints its final
   * newline. The captured `ProcessResult` text is the same either way.
   */
  readonly lineEnd?: LineEnd;
  /**
   * why: `kill` ends the child's whole process group, or on Windows the child alone, and a
   * grandchild can be a process others use (the first emulator's qemu starts the host's one
   * `netsimd`, and every emulator's network goes through it), and an `adb` client can start the
   * shared adb server, so no adb command sets this. With this, `kill` ends the child alone off
   * Windows, and on Windows also the child's own children (`emulator.exe` runs qemu). Under
   * `outlivesCaller` the child is a `conhost.exe` wrapper, so that is the program and its children;
   * the processes qemu starts (`netsimd`) are never ended.
   */
  readonly killChildren?: boolean;
  /**
   * why: a long-lived child the daemon starts for others to use (the emulator, Simlock's adb
   * server) must outlive the daemon (ADR 0004, ADR 0019). Off Windows every child is detached
   * already; on Windows only a detached child leaves Node's kill-on-exit job, which would end it
   * with the daemon while its own children live on and hold the logon task's console open
   * (#1759). On Windows it also runs under `conhost.exe --headless` (`headlessLaunch`), so the qemu
   * of an emulator opens no window; `kill` still ends the wrapper's program and, with
   * `killChildren`, that program's own children. The supervisor's daemon is not one: ending the
   * supervisor ends it (ADR 0086 section 2).
   */
  readonly outlivesCaller?: boolean;
}

export type LineEnd = "newline" | "carriage-return-too";

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** why: set when the runner itself killed the child, and why: its `timeoutMs`, `maxStdoutBytes` or `signal`. */
  readonly endedBy?: "timeout" | "output-limit" | "aborted";
  /** why: the name of the signal that ended the child, whoever sent it; absent when it exited by itself. */
  readonly signal?: NodeJS.Signals;
}

/**
 * why: ADR 0005 §19a's spawn: a child whose output is handed to the caller chunk by chunk as it
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
  readonly input?: string;
  /**
   * why: Piped to the child's stdin and then closed, for input too big to hold as a string.
   * Given together with `input`, `inputStream` is ignored.
   */
  readonly inputStream?: ReadableStream<Uint8Array>;
  /**
   * why: Called with each chunk as it arrives. **May return a promise**, and if it does, this
   * runner stops reading that stream until it resolves -- which is how backpressure reaches
   * the child: a consumer that cannot place a chunk yet (an SSE client that is not reading, a
   * socket that has not drained) slows the command down instead of accumulating its output
   * somewhere. ADR 0005 §19e says output is streamed and never buffered; that is only true
   * end to end if the slow end can push back, so the callback's promise is the seam that
   * makes it true rather than a claim about the fast path only.
   */
  readonly onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}

export interface StreamingProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface StreamingProcessHandle {
  readonly pid: number;
  /**
   * why: Only on a child spawned with `inputStream`: rejects when that stream fails to be read
   * to its end, with the bytes written to the child by then. A child that closes its stdin
   * early is not a failure and never rejects it.
   */
  inputFailed?: Promise<never>;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<StreamingProcessResult>;
}

export interface ProcessHandle {
  readonly pid: number;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  kill(signal?: NodeJS.Signals): void;
  /**
   * why: Stops this child from keeping the parent's event loop alive. Only for a process that
   * is meant to outlive the daemon and is reaped by pid instead of by exit (Simlock's adb
   * server): everything else is awaited through `wait()` and must keep the loop open.
   */
  unref(): void;
  wait(): Promise<ProcessResult>;
}

/**
 * why: A child that could not be started at all -- a binary that exists but is not executable,
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
  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle;
}

export interface NodeProcessRunnerOptions {
  readonly sigkillGraceMs?: number;
  readonly exitDeferralCapMs?: number;
  readonly exitGraceMs?: number;
}

/** why: the input stream of a streamed child failed to be read to its end; `bytesWritten` is what the child's stdin had been handed by then. */
export class InputStreamFailedError extends Error {
  constructor(
    readonly bytesWritten: number,
    cause: unknown,
  ) {
    super(`Reading the input stream failed after ${String(bytesWritten)} bytes`, { cause });
    this.name = "InputStreamFailedError";
  }
}
