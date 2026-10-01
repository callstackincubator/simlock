import { arch, release, type } from "node:os";

import { describe, expect, it } from "vitest";

import { NodeHostInfo, ScriptedProcessRunner } from "./index.js";

const SW_VERS_OUTPUT = "ProductName:\t\tmacOS\nProductVersion:\t\t15.5\nBuildVersion:\t\t24F74\n";

describe("NodeHostInfo", () => {
  it("reports the macOS product name and version from sw_vers", async () => {
    const processRunner = new ScriptedProcessRunner([
      {
        match: { args: [], command: "sw_vers" },
        result: { code: 0, stderr: "", stdout: SW_VERS_OUTPUT },
      },
    ]);

    const system = await new NodeHostInfo({ platform: "darwin", processRunner }).read();

    expect(system).toEqual({ arch: arch(), os: "macOS", osVersion: "15.5" });
    expect(processRunner.calls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it("falls back to the kernel name and release when sw_vers fails", async () => {
    const processRunner = new ScriptedProcessRunner([
      {
        match: { args: [], command: "sw_vers" },
        // Output that would parse, so only the exit code can be what turns it away.
        result: { code: 1, stderr: "boom", stdout: SW_VERS_OUTPUT },
      },
    ]);

    const system = await new NodeHostInfo({ platform: "darwin", processRunner }).read();

    expect(system).toMatchObject({ os: type(), osVersion: release() });
  });

  it("falls back to the kernel name and release when sw_vers cannot be started", async () => {
    // No scripted invocation: the runner refuses to start it, as a spawn failure would.
    const system = await new NodeHostInfo({
      platform: "darwin",
      processRunner: new ScriptedProcessRunner([]),
    }).read();

    expect(system).toMatchObject({ os: type(), osVersion: release() });
  });

  it("does not run sw_vers on another operating system", async () => {
    const processRunner = new ScriptedProcessRunner([]);

    const system = await new NodeHostInfo({ platform: "linux", processRunner }).read();

    expect(system).toMatchObject({ os: type(), osVersion: release() });
    expect(processRunner.calls).toEqual([]);
  });
});
