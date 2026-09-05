import { describe, expect, it } from "vitest";

import { NodeProcessRunner, ProcessSpawnError, ScriptedProcessRunner } from "./index.js";

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
  // `SIGTERM_TO_SIGKILL_GRACE_MS` is a fixed 10s (see process-runner.ts), hence the generous
  // per-test timeout below -- there is no faster way to prove the real runner's own timers
  // actually escalate without mocking out `child_process`, which every other test in this
  // `describe` block deliberately avoids.
  it("escalates to SIGKILL when a timed-out process ignores SIGTERM", async () => {
    const runner = new NodeProcessRunner();

    await expect(
      runner.run(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
        { timeoutMs: 100 },
      ),
    ).resolves.toEqual({ code: null, stderr: "", stdout: "" });
  }, 15_000);

  it("settles wait() when a detached grandchild keeps the stdio pipe open after the process exits", async () => {
    const runner = new NodeProcessRunner();
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
    const runner = new NodeProcessRunner();
    // Same shape as above, but the pipe is still delivering when the process goes:
    // the grandchild emits a chunk every 200ms for well over a grace window, then
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
              "let n = 0; const t = setInterval(() => { console.log('chunk-' + n); if (++n === 6) { clearInterval(t); setTimeout(() => {}, 3_000); } }, 200);",
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
