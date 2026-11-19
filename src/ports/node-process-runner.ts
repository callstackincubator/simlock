import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { Writable } from "node:stream";

import { LineBuffer, captureLines } from "./process-line-buffer.js";
import {
  isRunning,
  killProcessTree,
  reportsKillSignal,
  runLimits,
  type WindowsKill,
} from "./process-tree-kill.js";
import { childLaunch } from "./windows-command.js";
import {
  InputStreamFailedError,
  ProcessSpawnError,
  type LineEnd,
  type NodeProcessRunnerOptions,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessStreamOptions,
  type StreamingProcessHandle,
  type StreamingProcessResult,
} from "./process-runner-types.js";

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
    const process = this.#launch(command, args, options);
    let killTimeout: NodeJS.Timeout | undefined;
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            try {
              process.kill("SIGTERM", "timeout");
            } catch {
              // why: The child may have exited between the timer firing and the kill.
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
                // why: The child may have exited between the timer firing and the kill.
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
    return this.#launch(command, args, options);
  }

  #launch(command: string, args: readonly string[], options: ProcessRunOptions): NodeProcessHandle {
    const launch = childLaunch(command, args);
    const logFd =
      typeof options.stdio === "object" ? openSync(options.stdio.file, "a", 0o600) : undefined;
    const child = spawnChildProcess(launch.command, launch.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      // why: on Windows only a detached child leaves Node's kill-on-exit job (see `outlivesCaller`).
      detached: process.platform !== "win32" || options.outlivesCaller === true,
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
      windowsKillOf(launch.windowsVerbatimArguments, options.killChildren === true),
      runLimits(options),
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
      windowsKillOf(launch.windowsVerbatimArguments, false),
    );
    if (options.input !== undefined) {
      // why: One shot, then closed (ADR 0005 §19c): a command reading stdin sees exactly this and
      // then EOF. `end` is safe even if the child already exited -- the EPIPE that produces is
      // swallowed below rather than left to surface as an unhandled `error` on the stream.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    } else if (options.inputStream !== undefined && child.stdin) {
      const inputFailed = pumpInput(options.inputStream, child.stdin);
      // why: a caller that never looks at `inputFailed` must not turn a read error into an unhandled rejection that ends the daemon.
      inputFailed.catch(() => undefined);
      handle.inputFailed = inputFailed;
    }
    return handle;
  }
}

/**
 * why: writes the stream to the child's stdin chunk by chunk, waiting for `drain` so a slow child holds the read back (nothing is buffered, ADR 0005 §19e), then closes stdin. A child that closes its stdin early (EPIPE) cancels the read quietly; only a read error rejects the returned promise, which never resolves otherwise.
 */
function pumpInput(source: ReadableStream<Uint8Array>, stdin: Writable): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const reader = source.getReader();
    let written = 0;
    let closed = false;
    const onClosed = (): void => {
      closed = true;
      void reader.cancel().catch(() => undefined);
    };
    stdin.on("error", onClosed);
    stdin.on("close", onClosed);
    void (async () => {
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          if (!closed) reject(new InputStreamFailedError(written, error));
          return;
        }
        if (closed) return;
        if (result.done) {
          stdin.end();
          return;
        }
        written += result.value.byteLength;
        if (!stdin.write(result.value) && !closed) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              stdin.off("drain", done);
              stdin.off("close", done);
              resolve();
            };
            stdin.once("drain", done);
            stdin.once("close", done);
          });
        }
      }
    })();
  });
}

/**
 * why: Thrown by `NodeStreamingProcessHandle#wait()` when the child exited but a chunk's delivery
 * -- the promise `onChunk` returned, which this handle was waiting on before resuming the
 * pipe for backpressure (ADR 0005 §19e) -- was still outstanding `EXIT_TO_CLOSE_MAX_DEFERRAL_MS`
 * later. A paused readable never reaches `close` and stops emitting `data`, so nothing here can
 * *prove* the remaining output was delivered; resolving `{ exitCode }` as if it had been would
 * be exactly the silent truncation streaming without buffering exists to avoid. The caller sees
 * this as `device.exec`'s terminal error, the same shape a `PASSTHROUGH_REFUSED` or
 * `EXEC_TIMEOUT` already is on both transports -- not a clean exit that quietly drops a tail.
 */
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

/**
 * why: `spawnStreaming`'s handle. Holds no output: every chunk is handed to `onChunk` the moment
 * the stream emits it and is then forgotten, which is what lets `device.exec` stream
 * arbitrarily large output through a daemon that never grows for it.
 *
 * Settling repeats `NodeProcessHandle`'s `exit`-then-quiet-window dance for the same reason
 * (see `EXIT_TO_CLOSE_GRACE_MS`): a grandchild holding the inherited pipe open (`adb
 * start-server` is exactly this) means `close` may never fire even though the process the
 * caller asked about is gone.
 *
 * The quiet window that dance relies on only means anything when the pipe is idle because the
 * child has nothing left to write. `#forward` below pauses the readable while a chunk's
 * delivery to the consumer is outstanding (the backpressure ADR 0005 §19e asks for): a paused
 * readable emits no `data`, so `#chunkCount` stops moving for a reason that has nothing to do
 * with the child being gone. Settling under that -- as this class once did -- resolves `wait()`
 * while a chunk still sits undelivered in the paused pipe, and the caller returns `{ exitCode }`
 * having silently dropped it.
 *
 * `close` itself is not the all-clear it looks like, either: verified against real Node (a
 * child that writes two small chunks in quick succession and calls `process.exit()`), the
 * stdio pipe's `close` can fire in the very same tick as a `data` event delivering a chunk
 * this handle just paused on -- Node drains whatever the OS pipe was already holding as part
 * of noticing EOF, pause or no pause. So both `close` and the exit grace window fail closed
 * through the same `#settleWhenDrained`: `#pendingDeliveries` is this handle's own state (it is
 * the one that called `pause()`), checked directly rather than inferred from the chunk counter
 * the grandchild case already overloads, and only `EXIT_TO_CLOSE_MAX_DEFERRAL_MS` with a
 * delivery still outstanding at that deadline ends the wait -- as a rejection
 * (`ExecOutputDeliveryStalledError`), not a settle, because at that point something really may
 * have been dropped and pretending otherwise is the one thing this class must not do. A chatty
 * grandchild with **no** pending delivery hitting the same deadline still settles as before:
 * nothing of the command's own output is waiting on anyone in that case, only unrelated noise
 * this handle was never going to forward to a live consumer anyway (see `#execDevice` in
 * `daemon/server-requests.ts`, torn down by then).
 */
class NodeStreamingProcessHandle implements StreamingProcessHandle {
  readonly pid: number;
  inputFailed?: Promise<never>;
  readonly #result: Promise<StreamingProcessResult>;
  #chunkCount = 0;
  #pendingDeliveries = 0;
  /** why: Per-stream half of `#pendingDeliveries` -- the total is what the exit-settle path needs
   * ("is anything at all still outstanding"), this is what `#forward`'s own `resume()` needs
   * ("is *this* stream's own last outstanding delivery the one that just settled"). A stream
   * can hold more than one outstanding delivery at once (a paused readable still drains
   * whatever it already had at EOF -- see the class doc), so resuming on any settle rather
   * than this stream's own count reaching zero would resume it while another delivery on the
   * same stream is still unaccounted for. */
  #pendingByStream: Record<"stdout" | "stderr", number> = { stderr: 0, stdout: 0 };
  #deliveryWaiters: Array<() => void> = [];
  #killedWith: NodeJS.Signals | undefined;

  constructor(
    private readonly child: ChildProcess,
    pid: number,
    onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>,
    private readonly exitDeferralCapMs: number,
    private readonly exitGraceMs: number,
    private readonly windowsKill: WindowsKill,
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
          reportsKillSignal(windowsKill) && killedWith !== undefined
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
    killProcessTree(this.child, this.pid, signal, this.windowsKill);
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

class NodeProcessHandle implements ProcessHandle {
  readonly pid: number;
  readonly stdout = new LineBuffer();
  readonly stderr = new LineBuffer();
  readonly #stdoutChunks: string[] = [];
  readonly #stderrChunks: string[] = [];
  readonly #result: Promise<ProcessResult>;
  #killedWith: NodeJS.Signals | undefined;
  #endedBy: ProcessResult["endedBy"];

  constructor(
    private readonly child: ChildProcess,
    pid: number,
    lineEnd: LineEnd,
    private readonly exitDeferralCapMs: number,
    private readonly exitGraceMs: number,
    private readonly windowsKill: WindowsKill,
    limits: Pick<ProcessRunOptions, "maxStdoutBytes" | "signal"> = {},
  ) {
    this.pid = pid;
    captureLines(child.stdout, this.stdout, this.#stdoutChunks, lineEnd);
    captureLines(child.stderr, this.stderr, this.#stderrChunks, lineEnd);
    this.#watchLimits(limits);
    this.#result = new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", reject);

      let settled = false;
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          code: reportsKillSignal(windowsKill) && this.#killedWith !== undefined ? null : code,
          stderr: this.#stderrChunks.join(""),
          stdout: this.#stdoutChunks.join(""),
          ...(this.#endedBy === undefined ? {} : { endedBy: this.#endedBy }),
          ...(signal === null ? {} : { signal }),
        });
      };

      child.once("close", (code, signal) => {
        settle(code, signal);
      });
      child.once("exit", (code, signal) => {
        const deadline = Date.now() + this.exitDeferralCapMs;
        const capturedSoFar = (): number => this.#stdoutChunks.length + this.#stderrChunks.length;
        const armGrace = (chunksAtArm: number): void => {
          const timer = setTimeout(() => {
            if (capturedSoFar() !== chunksAtArm && Date.now() < deadline) {
              armGrace(capturedSoFar());
              return;
            }
            settle(code, signal);
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

  /**
   * why: the output bound counts bytes as they arrive, and an aborted signal ends the child the
   * same way; both kill with SIGKILL, since the caller has no use for a graceful end of a child
   * that is printing without end or whose answer nobody wants.
   */
  #watchLimits({
    maxStdoutBytes,
    signal,
  }: Pick<ProcessRunOptions, "maxStdoutBytes" | "signal">): void {
    if (maxStdoutBytes !== undefined) {
      let received = 0;
      this.child.stdout?.on("data", (chunk: string | Buffer) => {
        received += Buffer.byteLength(chunk);
        if (received > maxStdoutBytes) this.kill("SIGKILL", "output-limit");
      });
    }
    if (signal !== undefined) {
      const abort = (): void => this.kill("SIGKILL", "aborted");
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      this.child.once("close", () => signal.removeEventListener("abort", abort));
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM", endedBy?: ProcessResult["endedBy"]): void {
    if (isRunning(this.child)) {
      this.#killedWith ??= signal;
      this.#endedBy ??= endedBy;
    }
    killProcessTree(this.child, this.pid, signal, this.windowsKill);
  }

  unref(): void {
    this.child.unref();
  }

  wait(): Promise<ProcessResult> {
    return this.#result;
  }
}

function childStdio(
  stdio: ProcessRunOptions["stdio"],
  logFd: number | undefined,
): "pipe" | "ignore" | ["ignore", number, number] {
  if (logFd !== undefined) return ["ignore", logFd, logFd];
  return stdio === undefined || typeof stdio === "object" ? "pipe" : stdio;
}

// why: a batch file's `cmd.exe` wrapper dies with its whole tree; a `killChildren` child alone
// off Windows (its process group would end what it started for others) and with its own children
// on Windows; any other child alone there, and off Windows its whole process group.
function windowsKillOf(wrapped: boolean, killChildren: boolean): WindowsKill {
  if (wrapped) return "tree";
  return killChildren ? "children" : "child";
}
