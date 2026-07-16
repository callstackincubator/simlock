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
});
