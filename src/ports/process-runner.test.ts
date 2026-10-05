import { describe, expect, it, vi } from "vitest";

import {
  exitCodeOf,
  ExecOutputDeliveryStalledError,
  NodeProcessRunner,
  ProcessSpawnError,
  ScriptedProcessRunner,
} from "./index.js";

/** Signal-0 liveness probe: asks the kernel whether the pid exists without signalling it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a process condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ScriptedProcessRunner", () => {
  it("returns the scripted result for a matching invocation", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { command: "simctl", args: ["list", "devices"] },
        result: { code: 0, stderr: "", stdout: "device list" },
      },
    ]);

    await expect(runner.run("simctl", ["list", "devices"])).resolves.toEqual({
      code: 0,
      stderr: "",
      stdout: "device list",
    });
    expect(runner.calls).toEqual([{ args: ["list", "devices"], command: "simctl", options: {} }]);
  });

  it("rejects unexpected invocations", () => {
    const runner = new ScriptedProcessRunner([]);

    expect(() => runner.spawn("adb", ["devices"])).toThrow("Unexpected process invocation");
  });

  it("matches command and argument patterns in FIFO order", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { command: /simctl/, args: [/list/, "devices"] },
        result: { code: 0, stderr: "", stdout: "matched" },
      },
    ]);

    await expect(runner.run("xcrun-simctl", ["list", "devices"])).resolves.toMatchObject({
      stdout: "matched",
    });
  });

  it("resolves a hanging process after it is killed", async () => {
    const runner = new ScriptedProcessRunner([
      {
        hangs: true,
        match: { command: "emulator", args: ["@simlock"] },
      },
    ]);
    const process = runner.spawn("emulator", ["@simlock"]);

    const result = process.wait();
    process.kill("SIGTERM");

    await expect(result).resolves.toEqual({ code: null, stderr: "", stdout: "" });
  });

  it("replays scripted output through line streams", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { command: "adb", args: ["logcat"] },
        stdoutLines: ["booting", "ready"],
      },
    ]);
    const process = runner.spawn("adb", ["logcat"]);
    const lines: string[] = [];

    for await (const line of process.stdout) {
      lines.push(line);
    }

    expect(lines).toEqual(["booting", "ready"]);
  });
});

describe("ScriptedProcessRunner: spawnStreaming", () => {
  it("replays scripted chunks in order across both streams", async () => {
    const runner = new ScriptedProcessRunner([
      {
        chunks: [
          { chunk: "out-1", stream: "stdout" },
          { chunk: "err-1", stream: "stderr" },
          { chunk: "out-2", stream: "stdout" },
        ],
        match: { args: ["logcat"], command: "adb" },
        result: { code: 4, stderr: "", stdout: "" },
      },
    ]);
    const seen: string[] = [];

    const handle = runner.spawnStreaming("adb", ["logcat"], {
      onChunk: (stream, chunk) => {
        seen.push(`${stream}:${chunk}`);
      },
    });

    // The chunks are delivered one at a time, each awaited before the next -- so they land by
    // the time the command reports its exit, which is the ordering every consumer relies on.
    await expect(handle.wait()).resolves.toEqual({ code: 4, signal: null });
    expect(seen).toEqual(["stdout:out-1", "stderr:err-1", "stdout:out-2"]);
  });

  it("waits for a slow consumer before delivering the next chunk", async () => {
    // The scripted counterpart of pausing a real child's readable: a delivery that has not
    // resolved is a consumer that cannot take more yet, and nothing may run ahead of it.
    const runner = new ScriptedProcessRunner([
      {
        chunks: [
          { chunk: "one", stream: "stdout" },
          { chunk: "two", stream: "stdout" },
        ],
        match: { args: ["logcat"], command: "adb" },
      },
    ]);
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstDelivered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const handle = runner.spawnStreaming("adb", ["logcat"], {
      onChunk: (_stream, chunk) => {
        seen.push(chunk);
        return seen.length === 1 ? firstDelivered : undefined;
      },
    });
    await Promise.resolve();
    expect(seen).toEqual(["one"]);

    releaseFirst();
    await handle.wait();
    expect(seen).toEqual(["one", "two"]);
  });

  it("models a child that ignores SIGTERM, so only SIGKILL settles it", async () => {
    const runner = new ScriptedProcessRunner([
      { hangs: true, ignoresSigterm: true, match: { args: ["logcat"], command: "adb" } },
    ]);
    const handle = runner.spawnStreaming("adb", ["logcat"], { onChunk: () => {} });
    let settled = false;
    void handle.wait().then(() => (settled = true));

    handle.kill("SIGTERM");
    await Promise.resolve();
    expect(settled).toBe(false);

    handle.kill("SIGKILL");
    await expect(handle.wait()).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("records the invocation and settles a hanging command only when it is killed", async () => {
    const runner = new ScriptedProcessRunner([
      { hangs: true, match: { args: ["logcat"], command: "adb" } },
    ]);

    const handle = runner.spawnStreaming("adb", ["logcat"], {
      env: { PATH: "/usr/bin" },
      input: "y\n",
      onChunk: () => {},
    });
    expect(runner.calls).toEqual([
      { args: ["logcat"], command: "adb", options: { env: { PATH: "/usr/bin" }, input: "y\n" } },
    ]);

    const result = handle.wait();
    handle.kill("SIGKILL");
    await expect(result).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });
});

describe("NodeProcessRunner: spawnStreaming", () => {
  it("stops reading the child while a delivery is pending, and resumes once it resolves", async () => {
    // ADR 0005 §19e end to end: "never buffered" only holds if the slow end can push back, so
    // a delivery that has not resolved pauses the child's stream. The child below writes far
    // more than a pipe buffer holds, so if this leaked the whole thing would arrive anyway.
    const runner = new NodeProcessRunner();
    const seen: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const handle = runner.spawnStreaming(
      process.execPath,
      [
        "-e",
        "const line = 'x'.repeat(16 * 1024);" +
          "for (let index = 0; index < 64; index += 1) process.stdout.write(line);",
      ],
      {
        onChunk: (_stream, chunk) => {
          seen.push(chunk);
          return seen.length === 1 ? blocked : undefined;
        },
      },
    );

    // Long enough for an unpaused stream to have delivered the rest several times over.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toHaveLength(1);

    release();
    await handle.wait();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.join("").length).toBe(64 * 16 * 1024);
  });

  it("does not settle wait() while a chunk's delivery is still pending past the exit grace window, even though a real pipe already delivered what the child wrote after it", async () => {
    // The defect this guards: a paused readable never emits `close`, so the exit-to-close
    // grace window used to treat "quiet because we paused it" the same as "quiet because the
    // child is gone" and settled `wait()` while a chunk still sat undelivered. Round 4's test-
    // title finding: the second chunk here ("before-exit-B") is *not* what proves the guard --
    // a real OS pipe drains whatever it already held once the child exits, pause or not (see
    // `NodeStreamingProcessHandle`'s own doc comment), so `seen` already holds both chunks well
    // before `releaseFirst()` is ever called; the assertion below confirms exactly that. What
    // the guard actually protects is `wait()` refusing to settle while the *first* chunk's
    // delivery is still unresolved, regardless of what a chatty pipe delivered around it.
    const runner = new NodeProcessRunner({ exitGraceMs: 100 });
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const handle = runner.spawnStreaming(
      process.execPath,
      [
        "-e",
        "process.stdout.write('before-exit-A');" +
          "setTimeout(() => { process.stdout.write('before-exit-B'); process.exit(0); }, 20);",
      ],
      {
        onChunk: (_stream, chunk) => {
          seen.push(chunk);
          return seen.length === 1 ? firstDelivery : undefined;
        },
      },
    );

    // Comfortably past the child's own exit (20ms) and past the exit-to-close grace window
    // (100ms here) the old code settled on, while the first chunk's delivery is deliberately still
    // unresolved.
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Both chunks already arrived -- the paused stream drained at EOF -- and `wait()` still
    // has not settled, since the first delivery is what it is actually waiting on.
    expect(seen.join("")).toBe("before-exit-Abefore-exit-B");
    let settledEarly = false;
    void handle.wait().then(() => {
      settledEarly = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      settledEarly,
      "wait() settled while a chunk's delivery was still pending -- its output, and anything the child wrote after it, may have been dropped silently",
    ).toBe(false);

    releaseFirst();
    const result = await handle.wait();

    expect(result.code).toBe(0);
    expect(seen.join("")).toBe("before-exit-Abefore-exit-B");
  }, 10_000);

  it("rejects wait() instead of silently truncating when a chunk's delivery never resolves after exit", async () => {
    // The deferral this handle allows for an outstanding delivery is not unbounded -- but
    // reaching that bound with a delivery still stuck must not look like a clean exit. A
    // caller that got `{ exitCode: 0 }` here would have no way to know the command's output
    // was incomplete; a rejection is the visible failure ADR 0005 §19e's "streamed, never
    // buffered" requires instead.
    const runner = new NodeProcessRunner({ exitDeferralCapMs: 100 });
    const seen: string[] = [];

    const handle = runner.spawnStreaming(
      process.execPath,
      ["-e", "process.stdout.write('stuck'); process.exit(0);"],
      {
        onChunk: (_stream, chunk) => {
          seen.push(chunk);
          return new Promise<void>(() => {
            // Never resolves: models a consumer (an SSE write, a socket write) whose
            // backpressure never clears.
          });
        },
      },
    );

    const startedAt = Date.now();
    const error = await handle.wait().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExecOutputDeliveryStalledError);
    expect((error as Error).message).toContain("still unresolved 100ms later");
    expect(Date.now() - startedAt, "rejected only after the default 5 s cap").toBeLessThan(2_500);
    expect(seen).toEqual(["stuck"]);
  }, 10_000);

  it("forwards chunks as they arrive and reports the child's exit code", async () => {
    const runner = new NodeProcessRunner();
    const seen: Array<{ stream: string; chunk: string }> = [];

    const handle = runner.spawnStreaming(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 5;"],
      {
        onChunk: (stream, chunk) => {
          seen.push({ chunk, stream });
        },
      },
    );
    const result = await handle.wait();

    expect(result.code).toBe(5);
    expect(seen.filter((entry) => entry.stream === "stdout").map((entry) => entry.chunk)).toEqual([
      "out",
    ]);
    expect(seen.filter((entry) => entry.stream === "stderr").map((entry) => entry.chunk)).toEqual([
      "err",
    ]);
  });

  it("does not crash the process when onChunk throws synchronously -- treated as a failed delivery instead", async () => {
    // `onChunk` is typed `void | Promise<void>`, but nothing stops a transport's own
    // implementation from throwing synchronously. Called bare inside a `data` listener (round
    // 4 hardening), that throw becomes an uncaughtException that takes the whole daemon down
    // over one bad chunk -- latent today because both real callers (`daemon/server.ts`,
    // `http/app.ts`) happen to be `async`, but nothing enforces that. A `process.on
    // ("uncaughtException", ...)` listener is the only way to observe the pre-fix crash from
    // inside a test without actually taking this process down, so this registers one, asserts
    // it never fires, and removes it again in `finally` regardless of outcome.
    const uncaught: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaughtException);

    try {
      const runner = new NodeProcessRunner();
      const handle = runner.spawnStreaming(
        process.execPath,
        ["-e", "process.stdout.write('boom'); process.exit(0);"],
        {
          onChunk: () => {
            throw new Error("onChunk threw synchronously");
          },
        },
      );

      const result = await handle.wait();
      expect(result.code).toBe(0);
    } finally {
      process.off("uncaughtException", onUncaughtException);
    }

    expect(uncaught).toEqual([]);
  }, 10_000);

  it("writes `input` to the child's stdin and then closes it", async () => {
    // ADR 0005 §19c's one-shot stdin: the child sees the string and then EOF, which is what
    // lets a line-oriented command that reads stdin finish at all.
    const runner = new NodeProcessRunner();
    let stdout = "";

    const handle = runner.spawnStreaming(
      process.execPath,
      ["-e", "process.stdin.on('data', (d) => process.stdout.write(`saw:${d}`));"],
      {
        input: "hello",
        onChunk: (_stream, chunk) => {
          stdout += chunk;
        },
      },
    );
    await handle.wait();

    expect(stdout).toBe("saw:hello");
  });

  it("kills the child's whole process group, so a signalled command reports one", async () => {
    const runner = new NodeProcessRunner();

    const handle = runner.spawnStreaming(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      onChunk: () => {},
    });
    handle.kill("SIGKILL");

    const result = await handle.wait();
    expect(result.code).toBeNull();
    expect(exitCodeOf(result)).toBeGreaterThan(128);
  });

  it("does not signal a process group once the child has already exited (round 4 hardening)", async () => {
    // `killProcessTree` calls `process.kill(-pid, signal)` directly, bypassing
    // `ChildProcess.kill`'s own "already exited" guard. `wait()` can be deferred up to
    // `EXIT_TO_CLOSE_MAX_DEFERRAL_MS` past the real `exit` event (a chatty grandchild, a
    // stalled delivery), and Node frees a reaped pid for the kernel to recycle once it has
    // been waited on -- so a timeout firing in that window used to risk signalling a process
    // group the kernel had already handed to an unrelated process. Guarded on
    // `child.exitCode`/`child.signalCode`, both still `null` only while genuinely running.
    const runner = new NodeProcessRunner();
    const killSpy = vi.spyOn(process, "kill");

    try {
      const handle = runner.spawnStreaming(process.execPath, ["-e", "process.exit(0)"], {
        onChunk: () => {},
      });
      const result = await handle.wait();
      expect(result.code).toBe(0);

      handle.kill("SIGTERM");

      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("kills the grandchildren too, because the signal goes to the process group", async () => {
    // The reason `kill` signals `-pid` rather than the child: a tool that forks (an
    // `adb`/`emulator` wrapper script, `simctl spawn`) leaves the work in a *grandchild*, and a
    // timeout that reaped only the direct child would leave that running with nothing left to
    // reap it. Verified against a real grandchild rather than asserted from the code: with the
    // group kill removed, the grandchild below survives and this fails.
    const runner = new NodeProcessRunner();
    let stdout = "";

    const handle = runner.spawnStreaming(
      process.execPath,
      [
        "-e",
        // The parent prints the grandchild's pid, then both sit still. `detached` on the
        // grandchild puts it in this group but out of the parent's own reach, which is the
        // case that matters.
        "const { spawn } = require('node:child_process');" +
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
          "process.stdout.write(String(child.pid));" +
          "setInterval(() => {}, 1000);",
      ],
      {
        onChunk: (_stream, chunk) => {
          stdout += chunk;
        },
      },
    );

    await waitUntil(() => stdout !== "");
    const grandchildPid = Number(stdout.trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);

    handle.kill("SIGKILL");
    await handle.wait();
    await waitUntil(() => !isAlive(grandchildPid));
    expect(isAlive(grandchildPid)).toBe(false);
  });

  it("reports a spawn that never produced a process, like `spawn` does", async () => {
    const runner = new NodeProcessRunner();

    expect(() =>
      runner.spawnStreaming("/nonexistent/simlock-adb", [], { onChunk: () => {} }),
    ).toThrow(ProcessSpawnError);
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe("NodeProcessRunner", () => {
  it("captures stdout, stderr, and the exit code", async () => {
    const runner = new NodeProcessRunner();

    await expect(
      runner.run(process.execPath, [
        "-e",
        "process.stdout.write('standard out'); process.stderr.write('standard error'); process.exit(7)",
      ]),
    ).resolves.toEqual({
      code: 7,
      stderr: "standard error",
      stdout: "standard out",
    });
  });

  it("captures nothing and ends its line streams when output is ignored", async () => {
    const runner = new NodeProcessRunner();

    const handle = runner.spawn(
      process.execPath,
      ["-e", "process.stdout.write('noise'); process.stderr.write('more noise'); process.exit(0)"],
      { stdio: "ignore" },
    );
    const lines: string[] = [];
    for await (const line of handle.stdout) {
      lines.push(line);
    }

    expect(lines).toEqual([]);
    expect(handle.pid).toBeGreaterThan(0);
    await expect(handle.wait()).resolves.toEqual({ code: 0, stderr: "", stdout: "" });
  });

  it("still kills a process whose output is ignored", async () => {
    const runner = new NodeProcessRunner();

    const handle = runner.spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
    });
    handle.kill("SIGKILL");

    await expect(handle.wait()).resolves.toMatchObject({ stderr: "", stdout: "" });
  });

  it("reports a spawn that never produced a process instead of crashing the daemon", async () => {
    // Node reports a failed spawn by emitting `error` asynchronously, and an `error` with no
    // listener ends the process outright -- no catch can help. So the listener is attached
    // before anything throws, and the failure comes back as something a caller can handle:
    // an `adb` that is not executable, `ETXTBSY` mid-update, or `EAGAIN` under the memory
    // pressure of several running emulators must cost the Android driver, not the daemon.
    const runner = new NodeProcessRunner();

    expect(() => runner.spawn("/nonexistent/simlock-adb", ["-P", "5038"])).toThrow(
      ProcessSpawnError,
    );

    // Past the tick the `error` event would arrive on: still here, still able to assert.
    await new Promise((resolve) => setImmediate(resolve));
    await expect(runner.run("/nonexistent/simlock-adb", [])).rejects.toBeInstanceOf(
      ProcessSpawnError,
    );
  });

  it("kills a process that exceeds its timeout", async () => {
    const runner = new NodeProcessRunner();

    await expect(
      runner.run(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ code: null, stderr: "", stdout: "" });
  });

  // Real end-to-end coverage of the SIGTERM -> SIGKILL escalation: a child that installs a
  // no-op SIGTERM handler survives the initial signal `run()` sends on timeout, so this only
  // resolves at all if the follow-up SIGKILL actually lands once the grace period elapses.
  // The grace is shortened through the constructor; the child is still real.
  it("escalates to SIGKILL when a timed-out process ignores SIGTERM, within the configured grace", async () => {
    const runner = new NodeProcessRunner({ sigkillGraceMs: 100 });
    const startedAt = Date.now();

    await expect(
      runner.run(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
        { timeoutMs: 100 },
      ),
    ).resolves.toEqual({ code: null, stderr: "", stdout: "" });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 15_000);

  it("keeps a 10 s SIGTERM-to-SIGKILL grace, a 5 s exit deferral cap and a 1 s exit grace when no options are given", () => {
    const runner = new NodeProcessRunner();

    expect(runner.sigkillGraceMs).toBe(10_000);
    expect(runner.exitDeferralCapMs).toBe(5_000);
    expect(runner.exitGraceMs).toBe(1_000);
  });

  it("settles wait() when a detached grandchild keeps the stdio pipe open after the process exits", async () => {
    const runner = new NodeProcessRunner({ exitGraceMs: 100 });
    // The child forks its own detached grandchild that inherits our pipe's write
    // end, prints the grandchild's pid, then exits immediately -- reproducing the
    // real defect, where a surviving grandchild silences `close` even though the
    // process wait() is meant to be waiting for is already gone.
    const handle = runner.spawn(process.execPath, [
      "-e",
      `
          const { spawn } = require("node:child_process");
          const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
            detached: true,
            stdio: "inherit",
          });
          grandchild.unref();
          require("node:fs").writeSync(1, String(grandchild.pid) + "\\n");
          process.exit(3);
        `,
    ]);

    let grandchildPid: number | undefined;
    try {
      const lines = handle.stdout[Symbol.asyncIterator]();
      grandchildPid = Number((await lines.next()).value);
      const printedAt = Date.now();

      // Race a generous but bounded timeout so a regression here fails as a clear
      // assertion instead of vitest's own suite-wide test timeout.
      const result = await Promise.race([
        handle.wait(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("wait() did not settle while a grandchild held stdio open")),
            2_000,
          ).unref();
        }),
      ]);

      expect(result.code).toBe(3);
      expect(Date.now() - printedAt, "settled only after the default 1 s exit grace").toBeLessThan(
        900,
      );
    } finally {
      if (grandchildPid !== undefined) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // Already gone by the time we get here.
        }
      }
    }
  }, 4_000);

  it("keeps waiting while output is still arriving after the process exits", async () => {
    const runner = new NodeProcessRunner({ exitGraceMs: 300 });
    // Same shape as above, but the pipe is still delivering when the process goes:
    // the grandchild emits a chunk every 100ms for well over a 300ms grace window, then
    // goes quiet. Settling on a bare post-exit timer would cut the capture off at
    // the first chunk -- a truncated capture surfaces later as a parse error, far
    // from its cause -- so the window has to restart while output keeps arriving.
    const handle = runner.spawn(process.execPath, [
      "-e",
      `
          const { spawn } = require("node:child_process");
          const grandchild = spawn(
            process.execPath,
            [
              "-e",
              // console.log appends its own newline, which keeps this three-deep
              // nested source free of escape sequences that have to survive two
              // rounds of string parsing on the way down.
              "let n = 0; const t = setInterval(() => { console.log('chunk-' + n); if (++n === 6) { clearInterval(t); setTimeout(() => {}, 3_000); } }, 100);",
            ],
            { detached: true, stdio: "inherit" },
          );
          grandchild.unref();
          require("node:fs").writeSync(1, String(grandchild.pid) + "\\n");
          process.exit(0);
        `,
    ]);

    let grandchildPid: number | undefined;
    try {
      const lines = handle.stdout[Symbol.asyncIterator]();
      grandchildPid = Number((await lines.next()).value);

      const result = await handle.wait();

      expect(result.code).toBe(0);
      expect(result.stdout, "capture was cut off while the pipe was still delivering").toContain(
        "chunk-5",
      );
    } finally {
      if (grandchildPid !== undefined) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // Already gone by the time we get here.
        }
      }
    }
  }, 8_000);
});

describe("NodeProcessRunner: line ends", () => {
  // Writes each argument as its own chunk, 50 ms apart, so a test controls where one chunk
  // ends and the next begins.
  const writeChunks =
    "const parts = process.argv.slice(1); let i = 0;" +
    "const next = () => { if (i === parts.length) return; process.stdout.write(parts[i++]); setTimeout(next, 50); };" +
    "next();";

  async function linesOf(lines: AsyncIterable<string>): Promise<string[]> {
    const read: string[] = [];
    for await (const line of lines) read.push(line);
    return read;
  }

  it('ends a line at each bare carriage return on stdout and stderr with lineEnd "carriage-return-too", and still yields an unended last line', async () => {
    const handle = new NodeProcessRunner().spawn(
      process.execPath,
      ["-e", "process.stdout.write('10%\\r20%\\r30%\\n'); process.stderr.write('a\\rb')"],
      { lineEnd: "carriage-return-too" },
    );

    const [stdout, stderr] = await Promise.all([linesOf(handle.stdout), linesOf(handle.stderr)]);

    expect(stdout).toEqual(["10%", "20%", "30%"]);
    expect(stderr).toEqual(["a", "b"]);
  });

  it("keeps a bare carriage return inside the line by default", async () => {
    const handle = new NodeProcessRunner().spawn(process.execPath, [
      "-e",
      "process.stdout.write('10%\\r20%\\r30%\\n')",
    ]);

    expect(await linesOf(handle.stdout)).toEqual(["10%\r20%\r30%"]);
  });

  it.each(["newline", "carriage-return-too"] as const)(
    "reads a \\r\\n pair as one line end, not an empty line, with lineEnd %s",
    async (lineEnd) => {
      const handle = new NodeProcessRunner().spawn(
        process.execPath,
        ["-e", "process.stdout.write('a\\r\\nb\\r\\n')"],
        { lineEnd },
      );

      expect(await linesOf(handle.stdout)).toEqual(["a", "b"]);
    },
  );

  it("yields a \\r-ended line while the process is still running", async () => {
    const handle = new NodeProcessRunner().spawn(
      process.execPath,
      ["-e", "process.stdout.write('10%\\r'); setTimeout(() => undefined, 30000)"],
      { lineEnd: "carriage-return-too" },
    );
    const iterator = handle.stdout[Symbol.asyncIterator]();
    let timer: NodeJS.Timeout | undefined;
    const noLineYet = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("no line within 2 s"), 2_000);
    });

    try {
      const first = await Promise.race([iterator.next().then((next) => next.value), noLineYet]);
      expect(first).toBe("10%");
    } finally {
      clearTimeout(timer);
      handle.kill("SIGKILL");
      await handle.wait();
    }
  });

  it("captures the same stdout whichever lineEnd is chosen", async () => {
    const runner = new NodeProcessRunner();
    const args = ["-e", writeChunks, "[=  ] 10%\r", "\n[== ] 20%\r\n", "\r[===] 30%\n"];

    const byDefault = await runner.run(process.execPath, args);
    const carriageReturnToo = await runner.run(process.execPath, args, {
      lineEnd: "carriage-return-too",
    });

    expect(byDefault.stdout).toBe("[=  ] 10%\r\n[== ] 20%\r\n\r[===] 30%\n");
    expect(carriageReturnToo.stdout).toBe(byDefault.stdout);
  });
});

describe("ScriptedProcessRunner: line ends", () => {
  it.each([
    ["newline", ["10%\r20%", "30%"]],
    ["carriage-return-too", ["10%", "20%", "30%"]],
  ] as const)(
    "splits a scripted line at a bare \\r only under carriage-return-too, with lineEnd %s",
    async (lineEnd, expected) => {
      const runner = new ScriptedProcessRunner([
        { match: { args: [], command: "installer" }, stdoutLines: ["10%\r20%", "30%"] },
      ]);
      const handle = runner.spawn("installer", [], { lineEnd });
      const lines: string[] = [];
      for await (const line of handle.stdout) lines.push(line);

      expect(lines).toEqual(expected);
    },
  );

  it.each(["newline", "carriage-return-too"] as const)(
    "reads a \\r ending one chunk and a \\n starting the next as one line end, and keeps an unended last line, with lineEnd %s",
    async (lineEnd) => {
      const runner = new ScriptedProcessRunner([
        {
          chunks: [
            { chunk: "a\r", stream: "stdout" },
            { chunk: "\nb", stream: "stdout" },
          ],
          match: { args: [], command: "installer" },
        },
      ]);
      const handle = runner.spawn("installer", [], { lineEnd });
      const lines: string[] = [];
      for await (const line of handle.stdout) lines.push(line);

      expect(lines).toEqual(["a", "b"]);
      await expect(handle.wait()).resolves.toEqual({ code: 0, stderr: "", stdout: "a\r\nb" });
    },
  );
});
