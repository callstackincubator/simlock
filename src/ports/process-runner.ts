import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";

import { childLaunch } from "./windows-command.js";

// why: `close` normally follows `exit` within the same tick, once the child's own stdio
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

// why: A grandchild that inherits the pipe *and* chatters on it would otherwise restart the
// grace window forever, so the deferral is capped. Reaching this cap means the output
// may be incomplete; nothing else is waiting on it by then.
const EXIT_TO_CLOSE_MAX_DEFERRAL_MS = 5_000;

// why: A hard bound on how long `run()` waits after a timeout-triggered SIGTERM before escalating to
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
   * why: `"ignore"` detaches the child's output entirely: nothing is captured and nothing is
   * iterable. A long-lived supervised process would otherwise accumulate every line it ever
   * wrote in this handle's buffers for as long as it runs. `{ file }` appends the child's
   * stdout and stderr to that file (created 0600 when missing, whose directory must exist),
   * with the same effect on the handle: nothing is captured.
   */
  readonly stdio?: "pipe" | "ignore" | { readonly file: string };
  readonly input?: string;
  readonly lineEnd?: LineEnd;
}

export type LineEnd = "newline" | "carriage-return-too";

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessStreamOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly input?: string;
  readonly onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}

export interface StreamingProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface StreamingProcessHandle {
  readonly pid: number;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<StreamingProcessResult>;
}

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
  unref(): void;
  wait(): Promise<ProcessResult>;
}

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

export class NodeProcessRunner implements ProcessRunner {
  readonly sigkillGraceMs: number;
  readonly exitDeferralCapMs: number;
  readonly exitGraceMs: number;

  constructor(options: NodeProcessRunnerOptions = {}) {
    this.sigkillGraceMs = options.sigkillGraceMs ?? SIGTERM_TO_SIGKILL_GRACE_MS;
    this.exitDeferralCapMs = options.exitDeferralCapMs ?? EXIT_TO_CLOSE_MAX_DEFERRAL_MS;
    this.exitGraceMs = options.exitGraceMs ?? EXIT_TO_CLOSE_GRACE_MS;
  }

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
            }
            // why: SIGTERM is a request, not a guarantee -- a child that ignores it (or is itself
            // hung) must not be able to keep this `run()` call waiting indefinitely. Escalate to
            // SIGKILL if it hasn't exited within the grace period; cleared below like `timeout`
            // itself the moment `process.wait()` actually settles, so a child that does exit
            // promptly after SIGTERM never sees the follow-up signal.
            killTimeout = setTimeout(() => {
              try {
                process.kill("SIGKILL");
              } catch {
              }
            }, this.sigkillGraceMs);
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
    const launch = childLaunch(command, args);
    const logFd =
      typeof options.stdio === "object" ? openSync(options.stdio.file, "a", 0o600) : undefined;
    const child = spawnChildProcess(launch.command, launch.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: process.platform !== "win32",
      stdio: childStdio(options.stdio, logFd),
      // why: the daemon has no console, so on Windows a console program it starts (adb, the
      // emulator, node) would otherwise get a new, visible one.
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    // why: the child holds its own copy of the descriptor; keeping ours would leak one per start.
    if (logFd !== undefined) closeSync(logFd);

    if (child.pid === undefined) {
      // why: The spawn failed, and Node will say why by emitting `error` on the next tick. An
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

    return new NodeProcessHandle(
      child,
      child.pid,
      options.lineEnd ?? "newline",
      this.exitDeferralCapMs,
      this.exitGraceMs,
      launch.windowsVerbatimArguments,
    );
  }

  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    const launch = childLaunch(command, args);
    const child = spawnChildProcess(launch.command, launch.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: process.platform !== "win32",
      stdio: "pipe",
      // why: as in `spawn`: no visible console window for a child of a daemon that has none.
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });

    if (child.pid === undefined) {
      // why: Same reasoning as `spawn` above: attach a listener before throwing, or Node's
      // asynchronous `error` takes the daemon down instead of rejecting one operation.
      child.once("error", () => undefined);
      throw new ProcessSpawnError(command, args);
    }

    const handle = new NodeStreamingProcessHandle(
      child,
      child.pid,
      options.onChunk,
      this.exitDeferralCapMs,
      this.exitGraceMs,
      launch.windowsVerbatimArguments,
    );
    if (options.input !== undefined) {
      // why: One shot, then closed (ADR 0005 §19c): a command reading stdin sees exactly this and
      // then EOF. `end` is safe even if the child already exited -- the EPIPE that produces is
      // swallowed below rather than left to surface as an unhandled `error` on the stream.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    return handle;
  }
}

export class ExecOutputDeliveryStalledError extends Error {
  constructor(deferralCapMs: number = EXIT_TO_CLOSE_MAX_DEFERRAL_MS) {
    super(
      "The command exited, but delivering one of its output chunks was still unresolved " +
        `${String(deferralCapMs)}ms later; treating this as a clean exit could ` +
        "have reported an exit code while silently dropping the tail of the command's output.",
    );
    this.name = "ExecOutputDeliveryStalledError";
  }
}

class NodeStreamingProcessHandle implements StreamingProcessHandle {
  readonly pid: number;
  readonly #result: Promise<StreamingProcessResult>;
  #chunkCount = 0;
  #pendingDeliveries = 0;
  #pendingByStream: Record<"stdout" | "stderr", number> = { stderr: 0, stdout: 0 };
  #deliveryWaiters: Array<() => void> = [];
  #killedWith: NodeJS.Signals | undefined;

  constructor(
    private readonly child: ChildProcess,
    pid: number,
    onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>,
    private readonly exitDeferralCapMs: number,
    private readonly exitGraceMs: number,
    private readonly wrapped: boolean,
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
        const killedWith = this.#killedWith;
        resolve(
          wrapped && killedWith !== undefined
            ? { code: null, signal: killedWith }
            : { code, signal },
        );
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      // why: Neither `close` nor the exit grace window may resolve this promise while a chunk's
      // delivery is still outstanding -- both funnel through here instead of settling
      // directly, each with its own budget for how long it will wait on a delivery that
      // never finishes before giving up and failing loudly instead. Re-checked against a
      // timer at the deadline, not only woken by a delivery settling: a delivery that never
      // settles at all -- the case this exists for -- would otherwise leave nothing to wake
      // this back up and notice the deadline has passed.
      const settleWhenDrained = (deadline: number, onDrained: () => void): void => {
        if (settled) return;
        if (this.#pendingDeliveries === 0) {
          onDrained();
          return;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          fail(new ExecOutputDeliveryStalledError(this.exitDeferralCapMs));
          return;
        }
        let deadlineTimer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<void>((resolve) => {
          deadlineTimer = setTimeout(resolve, remainingMs);
          deadlineTimer.unref();
        });
        void Promise.race([this.#nextDeliverySettled(), timedOut]).then(() => {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          settleWhenDrained(deadline, onDrained);
        });
      };

      child.once("close", (code, signal) => {
        settleWhenDrained(Date.now() + this.exitDeferralCapMs, () => settle(code, signal));
      });
      child.once("exit", (code, signal) => {
        const deadline = Date.now() + this.exitDeferralCapMs;
        const armGrace = (chunksAtArm: number): void => {
          const timer = setTimeout(() => {
            if (settled) return;
            // why: A pending delivery always wins over "chunk count still changing": it is this
            // handle's own state, not an inference, and it is checked first so a chattering
            // stream with one stuck delivery does not keep re-arming past it forever.
            if (
              this.#pendingDeliveries === 0 &&
              this.#chunkCount !== chunksAtArm &&
              Date.now() < deadline
            ) {
              armGrace(this.#chunkCount);
              return;
            }
            settleWhenDrained(deadline, () => settle(code, signal));
          }, this.exitGraceMs);
          timer.unref();
        };
        armGrace(this.#chunkCount);
      });
    });
    // why: A late `error` on a handle whose `wait()` nobody kept (a caller that killed and walked
    // away) must not become an unhandled rejection and end the daemon; a caller that does
    // await `wait()` still sees the rejection.
    this.#result.catch(() => undefined);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (isRunning(this.child)) this.#killedWith ??= signal;
    killProcessTree(this.child, this.pid, signal, this.wrapped);
  }

  wait(): Promise<StreamingProcessResult> {
    return this.#result;
  }

  #nextDeliverySettled(): Promise<void> {
    return new Promise((resolve) => {
      this.#deliveryWaiters.push(resolve);
    });
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
      // why: `onChunk` is typed `void | Promise<void>`, but nothing enforces that a transport's
      // implementation never throws synchronously (a bug in a socket write, say). Called bare
      // inside a `data` listener, that throw would become an uncaught exception and take the
      // whole daemon down over one bad chunk delivery -- caught here and treated exactly like
      // a delivery whose returned promise rejected: a failed delivery, not a crash.
      let delivered: void | Promise<void>;
      try {
        delivered = onChunk(name, chunk);
      } catch (error) {
        delivered = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (delivered === undefined) return;
      // why: The consumer is not ready for more yet. Pausing the readable stops this child at the
      // pipe -- it fills the OS buffer and then blocks in its own `write` -- which is the only
      // place backpressure can be applied without holding the bytes somewhere. Resumed on
      // either outcome: a failed delivery (a dead socket) must not wedge the process, and the
      // exec timeout still bounds a child nobody drains. Tracked in `#pendingDeliveries` so the
      // exit settle path can tell "paused waiting on the consumer" apart from "child is gone",
      // and separately in `#pendingByStream` so `resume()` fires only once *this* stream's own
      // outstanding count reaches zero -- not on any delivery settling, which would resume a
      // stream while one of its own other deliveries (two chunks landing before either
      // resolves, e.g. at EOF) is still unaccounted for.
      this.#pendingDeliveries += 1;
      this.#pendingByStream[name] += 1;
      stream.pause();
      const settleDelivery = (): void => {
        this.#pendingDeliveries -= 1;
        this.#pendingByStream[name] -= 1;
        if (this.#pendingByStream[name] === 0) stream.resume();
        const waiters = this.#deliveryWaiters;
        this.#deliveryWaiters = [];
        for (const waiter of waiters) waiter();
      };
      void Promise.resolve(delivered).then(settleDelivery, settleDelivery);
    });
  }
}

const TASKKILL_TIMEOUT_MS = 10_000;

/**
 * why: Windows has no process groups, and a batch file runs under a `cmd.exe` wrapper
 * (`windows-command.ts`): signalling the wrapper alone would leave the script's own processes,
 * `sdkmanager`'s Java, running. `taskkill /T` walks the tree from the wrapper's pid, so it runs
 * while the wrapper is still alive; the wrapper outlives what it runs, since a script runs its
 * commands in the foreground. Windows ends a process on any signal, so `/F` is no harsher than
 * `child.kill`. `taskkill` makes the wrapper exit with a code where `child.kill` reports a
 * signal, so the handle reports the signal it sent instead. Should `taskkill` itself fail, the
 * wrapper alone is killed as before.
 */
function killWindowsProcessTree(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  const fallback = () => {
    if (isRunning(child)) child.kill(signal);
  };
  const taskkill = spawnChildProcess("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    timeout: TASKKILL_TIMEOUT_MS,
    windowsHide: true,
  });
  taskkill.once("error", fallback);
  taskkill.once("exit", (code) => {
    if (code !== 0) fallback();
  });
}

/**
 * why: Signals the child's whole process group (children are spawned `detached`, so the group is
 * the unit that actually dies), or on Windows a batch file's whole tree and any other child
 * alone, treating an already-exited process as success. Extracted so `ProcessHandle` and `StreamingProcessHandle`
 * kill identically -- a timeout that only reached the direct child would leave a tool's own
 * subprocesses running.
 *
 * Guarded on `child.exitCode`/`child.signalCode` -- both still `null` only while the child is
 * actually running -- before ever calling `process.kill(-pid, signal)` directly: that call
 * bypasses `ChildProcess.kill`'s own "already exited" guard, and `wait()` can defer settling
 * up to `EXIT_TO_CLOSE_MAX_DEFERRAL_MS` past the real `exit` event (a chatty grandchild holding
 * stdio open, or a stalled delivery). Node frees a reaped pid for the kernel to recycle, so a
 * timeout firing in that window without this guard could signal a process group the kernel has
 * already handed to someone else -- latent before this PR, but `device.exec` is what makes the
 * timing remotely triggerable.
 */
function killProcessTree(
  child: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
  wrapped: boolean,
): void {
  if (!isRunning(child)) return;

  if (process.platform === "win32") {
    if (wrapped) killWindowsProcessTree(child, pid, signal);
    else child.kill(signal);
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

// why: a wrapper that already exited, its output still held open by a grandchild, is never
// signalled, so its own exit code stands rather than a kill nobody sent.
function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

class NodeProcessHandle implements ProcessHandle {
  readonly pid: number;
  readonly stdout = new LineBuffer();
  readonly stderr = new LineBuffer();
  readonly #stdoutChunks: string[] = [];
  readonly #stderrChunks: string[] = [];
  readonly #result: Promise<ProcessResult>;
  #killedWith: NodeJS.Signals | undefined;

  constructor(
    private readonly child: ChildProcess,
    pid: number,
    lineEnd: LineEnd,
    private readonly exitDeferralCapMs: number,
    private readonly exitGraceMs: number,
    private readonly wrapped: boolean,
  ) {
    this.pid = pid;
    captureLines(child.stdout, this.stdout, this.#stdoutChunks, lineEnd);
    captureLines(child.stderr, this.stderr, this.#stderrChunks, lineEnd);
    this.#result = new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", reject);

      let settled = false;
      const settle = (code: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          code: wrapped && this.#killedWith !== undefined ? null : code,
          stderr: this.#stderrChunks.join(""),
          stdout: this.#stdoutChunks.join(""),
        });
      };

      child.once("close", (code) => {
        settle(code);
      });
      child.once("exit", (code) => {
        const deadline = Date.now() + this.exitDeferralCapMs;
        const capturedSoFar = (): number => this.#stdoutChunks.length + this.#stderrChunks.length;
        const armGrace = (chunksAtArm: number): void => {
          const timer = setTimeout(() => {
            if (capturedSoFar() !== chunksAtArm && Date.now() < deadline) {
              armGrace(capturedSoFar());
              return;
            }
            settle(code);
          }, this.exitGraceMs);
          // why: A pending grace timer must never keep the Node process alive on its own.
          timer.unref();
        };
        armGrace(capturedSoFar());
      });
    });
    // why: A child nobody waits on (the supervised adb server) would otherwise turn a late
    // `error` into an unhandled rejection, which ends the daemon. Marking the promise
    // handled here changes nothing for a caller that does await `wait()`.
    this.#result.catch(() => undefined);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (isRunning(this.child)) this.#killedWith ??= signal;
    killProcessTree(this.child, this.pid, signal, this.wrapped);
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
  readonly chunks?: readonly { readonly stream: "stdout" | "stderr"; readonly chunk: string }[];
  readonly ignoresSigterm?: boolean;
  readonly onSpawn?: (args: readonly string[]) => void | Promise<void>;
}

export class ScriptedProcessRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
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

    void expectation.onSpawn?.([...args]);
    const handle = new ScriptedProcessHandle(
      this.#nextPid++,
      expectation,
      options.lineEnd ?? "newline",
    );
    this.handles.push(handle);
    return handle;
  }

  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    const invocation = {
      args: [...args],
      command,
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
  unreffed = false;
  readonly stdout = new LineBuffer();
  readonly stderr = new LineBuffer();
  readonly #result: Promise<ProcessResult>;
  #resolve!: (result: ProcessResult) => void;
  #finished = false;

  constructor(
    readonly pid: number,
    private readonly expectation: ScriptedProcessExpectation,
    lineEnd: LineEnd,
  ) {
    this.#result = new Promise<ProcessResult>((resolve) => {
      this.#resolve = resolve;
    });
    if (expectation.chunks === undefined) {
      this.#writeLines(expectation.stdoutLines, this.stdout, lineEnd);
      this.#writeLines(expectation.stderrLines, this.stderr, lineEnd);
    } else {
      this.#writeChunks(expectation.chunks, lineEnd);
    }

    if (!expectation.hangs) {
      this.#finish(expectation.result ?? defaultResult(expectation));
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.expectation.ignoresSigterm === true && signal !== "SIGKILL") return;
    this.#finish({ code: null, stderr: "", stdout: "" });
  }

  unref(): void {
    this.unreffed = true;
  }

  wait(): Promise<ProcessResult> {
    return this.#result;
  }

  #writeLines(
    lines: readonly string[] | undefined,
    destination: LineBuffer,
    lineEnd: LineEnd,
  ): void {
    const splitter = new LineSplitter(lineEnd);
    for (const line of lines ?? []) {
      for (const split of splitter.feed(`${line}\n`)) destination.push(split);
    }
  }

  #writeChunks(chunks: NonNullable<ScriptedProcessExpectation["chunks"]>, lineEnd: LineEnd): void {
    const splitters = { stderr: new LineSplitter(lineEnd), stdout: new LineSplitter(lineEnd) };
    for (const { chunk, stream } of chunks) {
      for (const line of splitters[stream].feed(chunk)) this[stream].push(line);
    }
    for (const stream of ["stdout", "stderr"] as const) {
      for (const line of splitters[stream].end()) this[stream].push(line);
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

class LineSplitter {
  #remainder = "";

  constructor(private readonly lineEnd: LineEnd) {}

  feed(chunk: string): string[] {
    const parts = `${this.#remainder}${chunk}`.split(
      this.lineEnd === "carriage-return-too" ? /\r\n|\r|\n/ : /\r?\n/,
    );
    this.#remainder = parts.pop() ?? "";
    return this.#kept(parts);
  }

  end(): string[] {
    const tail = this.#remainder;
    this.#remainder = "";
    return tail === "" ? [] : this.#kept([tail]);
  }

  #kept(lines: string[]): string[] {
    return this.lineEnd === "carriage-return-too" ? lines.filter((line) => line !== "") : lines;
  }
}

function captureLines(
  stream: NodeJS.ReadableStream | null,
  destination: LineBuffer,
  chunks: string[],
  lineEnd: LineEnd,
): void {
  // why: No pipe means the child was spawned with `stdio: "ignore"`. Closing the buffer
  // straight away is what keeps `for await (const line of handle.stdout)` a loop that
  // ends immediately rather than one that never yields and never returns.
  if (stream === null) {
    destination.close();
    return;
  }

  const splitter = new LineSplitter(lineEnd);
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    chunks.push(chunk);
    for (const line of splitter.feed(chunk)) {
      destination.push(line);
    }
  });
  stream.on("end", () => {
    for (const line of splitter.end()) {
      destination.push(line);
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
  if (expectation.chunks !== undefined) {
    const text = (stream: "stdout" | "stderr"): string =>
      expectation.chunks
        ?.filter((chunk) => chunk.stream === stream)
        .map(({ chunk }) => chunk)
        .join("") ?? "";
    return { code: 0, stderr: text("stderr"), stdout: text("stdout") };
  }
  return {
    code: 0,
    stderr: (expectation.stderrLines ?? []).join("\n"),
    stdout: (expectation.stdoutLines ?? []).join("\n"),
  };
}

function isNoSuchProcessError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function childStdio(
  stdio: ProcessRunOptions["stdio"],
  logFd: number | undefined,
): "pipe" | "ignore" | ["ignore", number, number] {
  if (logFd !== undefined) return ["ignore", logFd, logFd];
  return stdio === undefined || typeof stdio === "object" ? "pipe" : stdio;
}
