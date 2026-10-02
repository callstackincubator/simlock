import { describe, expect, it } from "vitest";

import {
  type ProcessResult,
  type ProcessRunner,
  ProcessSpawnError,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { iosPrerequisites } from "./prerequisites.js";

function xcodebuild(args: readonly string[], result: ProcessResult): ScriptedProcessExpectation {
  return { match: { args: [...args], command: "xcodebuild" }, result };
}

const passed: ProcessResult = { code: 0, stderr: "", stdout: "" };
const XCODE_VERSION = xcodebuild(["-version"], {
  code: 0,
  stderr: "",
  stdout: "Xcode 26.0\nBuild version 17A324\n",
});

describe("iosPrerequisites", () => {
  it("reports nothing missing when Xcode is selected, licensed and set up, starting only the three xcodebuild commands, 15 seconds each", async () => {
    const runner = new ScriptedProcessRunner([
      XCODE_VERSION,
      xcodebuild(["-license", "check"], passed),
      xcodebuild(["-checkFirstLaunchStatus"], passed),
    ]);

    await expect(iosPrerequisites({ processRunner: runner }).check()).resolves.toEqual([]);
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["xcodebuild", "-version"],
      ["xcodebuild", "-license", "check"],
      ["xcodebuild", "-checkFirstLaunchStatus"],
    ]);
    expect(runner.calls.map((call) => call.options.timeoutMs)).toEqual([15_000, 15_000, 15_000]);
  });

  it("reports xcode when xcodebuild says it requires Xcode, and runs neither later command", async () => {
    const runner = new ScriptedProcessRunner([
      xcodebuild(["-version"], {
        code: 1,
        stderr:
          "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance\n",
        stdout: "",
      }),
    ]);

    const missing = await iosPrerequisites({ processRunner: runner }).check();

    expect(missing).toEqual([
      expect.objectContaining({
        prerequisite: "xcode",
        remedy: expect.stringContaining("xcode-select") as unknown,
      }),
    ]);
    expect(runner.calls).toHaveLength(1);
  });

  it("reports xcode when there is no xcodebuild to start", async () => {
    const runner: ProcessRunner = {
      run: (command, args) => Promise.reject(new ProcessSpawnError(command, args)),
      spawn: () => {
        throw new Error("unused");
      },
      spawnStreaming: () => {
        throw new Error("unused");
      },
    };

    const missing = await iosPrerequisites({ processRunner: runner }).check();

    expect(missing.map((found) => found.prerequisite)).toEqual(["xcode"]);
  });

  it("reports xcode-license when the license check exits non-zero", async () => {
    const runner = new ScriptedProcessRunner([
      XCODE_VERSION,
      xcodebuild(["-license", "check"], { code: 69, stderr: "", stdout: "" }),
      xcodebuild(["-checkFirstLaunchStatus"], passed),
    ]);

    const missing = await iosPrerequisites({ processRunner: runner }).check();

    expect(missing).toEqual([
      expect.objectContaining({
        prerequisite: "xcode-license",
        remedy: expect.stringContaining("sudo xcodebuild -license accept") as unknown,
      }),
    ]);
  });

  it("reports xcode-first-launch when the first-launch check exits non-zero", async () => {
    const runner = new ScriptedProcessRunner([
      XCODE_VERSION,
      xcodebuild(["-license", "check"], passed),
      xcodebuild(["-checkFirstLaunchStatus"], { code: 1, stderr: "", stdout: "" }),
    ]);

    const missing = await iosPrerequisites({ processRunner: runner }).check();

    expect(missing).toEqual([
      expect.objectContaining({
        prerequisite: "xcode-first-launch",
        remedy: expect.stringContaining("sudo xcodebuild -runFirstLaunch") as unknown,
      }),
    ]);
  });

  it("rejects when xcodebuild -version fails for a reason other than no Xcode", async () => {
    const runner = new ScriptedProcessRunner([
      xcodebuild(["-version"], { code: 1, stderr: "something else broke\n", stdout: "" }),
    ]);

    await expect(iosPrerequisites({ processRunner: runner }).check()).rejects.toThrow(
      /exited with 1/,
    );
  });

  it("rejects when a command times out", async () => {
    const runner = new ScriptedProcessRunner([
      XCODE_VERSION,
      xcodebuild(["-license", "check"], { code: null, stderr: "", stdout: "" }),
    ]);

    await expect(iosPrerequisites({ processRunner: runner }).check()).rejects.toThrow(
      /did not finish/,
    );
  });
});
