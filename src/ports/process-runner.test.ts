import { describe, expect, it } from "vitest";

import { NodeProcessRunner, ScriptedProcessRunner } from "./index.js";

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
        match: { command: "emulator", args: ["@pitlane"] },
      },
    ]);
    const process = runner.spawn("emulator", ["@pitlane"]);

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

  it("kills a process that exceeds its timeout", async () => {
    const runner = new NodeProcessRunner();

    await expect(
      runner.run(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ code: null, stderr: "", stdout: "" });
  });

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
});
