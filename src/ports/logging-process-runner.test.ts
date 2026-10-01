import { describe, expect, it } from "vitest";

import { FakeClock } from "./clock.js";
import { LoggingProcessRunner } from "./logging-process-runner.js";
import { JsonLinesLogger, MemoryLogSink } from "./logger.js";
import { ScriptedProcessRunner, type ProcessRunner } from "./process-runner.js";

function wrap(inner: ProcessRunner) {
  const clock = new FakeClock(1_000);
  const sink = new MemoryLogSink();
  const runner = new LoggingProcessRunner({
    clock,
    inner,
    logger: new JsonLinesLogger({ clock, level: "debug", module: "process", sink }),
  });
  return { runner, sink };
}

describe("LoggingProcessRunner", () => {
  it("run logs the command, arguments, exit code and duration, and never the environment or the input", async () => {
    const clock = new FakeClock(1_000);
    const inner: ProcessRunner = {
      run: async () => {
        clock.advance(25);
        return { code: 3, stderr: "boom-stderr", stdout: "boom-stdout" };
      },
      spawn: () => {
        throw new Error("unused");
      },
      spawnStreaming: () => {
        throw new Error("unused");
      },
    };
    const sink = new MemoryLogSink();
    const runner = new LoggingProcessRunner({
      clock,
      inner,
      logger: new JsonLinesLogger({ clock, level: "debug", module: "process", sink }),
    });

    const result = await runner.run("xcrun", ["simctl", "boot", "ABC"], {
      env: { SECRET_TOKEN: "env-secret" },
      input: "stdin-secret",
    });

    expect(result.code).toBe(3);
    expect(sink.records).toEqual([
      {
        timestamp: 1_025,
        level: "debug",
        module: "process",
        message: "process",
        fields: { command: "xcrun", args: ["simctl", "boot", "ABC"], code: 3, durationMs: 25 },
      },
    ]);
    expect(JSON.stringify(sink.records)).not.toMatch(/env-secret|SECRET_TOKEN|stdin-secret|boom-/);
  });

  it("a run that throws logs the error and rethrows it", async () => {
    const failure = new Error("spawn ENOENT");
    const { runner, sink } = wrap({
      run: () => Promise.reject(failure),
      spawn: () => {
        throw new Error("unused");
      },
      spawnStreaming: () => {
        throw new Error("unused");
      },
    });

    await expect(runner.run("adb", ["devices"])).rejects.toBe(failure);

    expect(sink.records).toEqual([
      expect.objectContaining({
        message: "process",
        fields: { command: "adb", args: ["devices"], error: "spawn ENOENT", durationMs: 0 },
      }),
    ]);
  });

  it("a spawn that cannot start logs the error and rethrows it", () => {
    const failure = new Error("spawn EACCES");
    const { runner, sink } = wrap({
      run: () => Promise.reject(new Error("unused")),
      spawn: () => {
        throw failure;
      },
      spawnStreaming: () => {
        throw new Error("unused");
      },
    });

    expect(() => runner.spawn("emulator", ["-avd", "a"])).toThrow(failure);

    expect(sink.records).toEqual([
      expect.objectContaining({
        message: "process",
        fields: { command: "emulator", args: ["-avd", "a"], error: "spawn EACCES", durationMs: 0 },
      }),
    ]);
  });

  it("spawn logs once, when the process exits", async () => {
    const inner = new ScriptedProcessRunner([
      { hangs: true, match: { args: ["-avd", "a"], command: "emulator" } },
    ]);
    const { runner, sink } = wrap(inner);

    const handle = runner.spawn("emulator", ["-avd", "a"]);
    await Promise.resolve();
    expect(sink.records).toEqual([]);

    handle.kill("SIGTERM");
    await handle.wait();
    await Promise.resolve();

    expect(sink.records).toEqual([
      expect.objectContaining({
        message: "process",
        fields: expect.objectContaining({ command: "emulator", args: ["-avd", "a"] }),
      }),
    ]);
  });

  it("spawnStreaming logs once, when the process exits, and no chunk of its output", async () => {
    const inner = new ScriptedProcessRunner([
      {
        chunks: [{ chunk: "chunk-output-text", stream: "stdout" }],
        match: { args: ["shell", "ls"], command: "adb" },
        result: { code: 0, stderr: "", stdout: "" },
      },
    ]);
    const { runner, sink } = wrap(inner);
    const seen: string[] = [];

    const handle = runner.spawnStreaming("adb", ["shell", "ls"], {
      onChunk: (_stream, chunk) => {
        seen.push(chunk);
      },
    });
    await handle.wait();
    await Promise.resolve();

    expect(seen).toEqual(["chunk-output-text"]);
    expect(sink.records).toEqual([
      expect.objectContaining({
        message: "process",
        fields: { command: "adb", args: ["shell", "ls"], code: 0, durationMs: 0 },
      }),
    ]);
    expect(JSON.stringify(sink.records)).not.toContain("chunk-output-text");
  });
});
