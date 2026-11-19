import { describe, expect, it } from "vitest";

import { NodeProcessTable, ScriptedProcessRunner, type ProcessResult } from "./index.js";

const PS_ARGS = ["-axo", "pid=,ppid=,time=,command="];

function table(platform: NodeJS.Platform, result: ProcessResult) {
  const runner = new ScriptedProcessRunner([
    {
      match: {
        args: platform === "win32" ? [/./, /./, /./, /Win32_Process/] : PS_ARGS,
        command: platform === "win32" ? "powershell.exe" : "ps",
      },
      result,
    },
  ]);
  return { runner, table: new NodeProcessTable({ platform, processRunner: runner }) };
}

const ok = (stdout: string): ProcessResult => ({ code: 0, stderr: "", stdout });

describe("NodeProcessTable", () => {
  it("reads every ps time format as seconds, keeps the command whole and skips a line it cannot read", async () => {
    const { table: processes, runner } = table(
      "darwin",
      ok(
        [
          "    1     0   0:01.50 /sbin/launchd",
          "  200     1  1:02.50 /Applications/Xcode.app/Contents/MacOS/Xcode -arg with spaces",
          "  300   200 01:02:03 sim",
          "  400   300 2-01:02:03 long",
          "garbage line",
          "  500   1 notatime broken",
          "",
        ].join("\n"),
      ),
    );

    expect(await processes.list()).toEqual([
      { command: "/sbin/launchd", cpuSeconds: 1.5, pid: 1, ppid: 0 },
      {
        command: "/Applications/Xcode.app/Contents/MacOS/Xcode -arg with spaces",
        cpuSeconds: 62.5,
        pid: 200,
        ppid: 1,
      },
      { command: "sim", cpuSeconds: 3723, pid: 300, ppid: 200 },
      { command: "long", cpuSeconds: 176_523, pid: 400, ppid: 300 },
    ]);
    expect(runner.calls[0]?.options.timeoutMs).toBe(5_000);
  });

  it("reads a PowerShell answer in 100-nanosecond units, with a process that has no command line", async () => {
    const { table: processes, runner } = table(
      "win32",
      ok("4 0 25000000 System\r\n812 4 10000000 C:\\emu\\emulator.exe -avd x\r\n9 4 5 \r\n"),
    );

    expect(await processes.list()).toEqual([
      { command: "System", cpuSeconds: 2.5, pid: 4, ppid: 0 },
      { command: "C:\\emu\\emulator.exe -avd x", cpuSeconds: 1, pid: 812, ppid: 4 },
      { command: "", cpuSeconds: 5e-7, pid: 9, ppid: 4 },
    ]);
    expect(runner.calls[0]?.options.timeoutMs).toBe(15_000);
  });

  it.each([
    ["a read that timed out", { code: null, endedBy: "timeout" as const, stderr: "", stdout: "" }],
    ["a non-zero exit", { code: 1, stderr: "boom", stdout: "" }],
  ])("throws on %s, so the caller counts no reading", async (_name, result) => {
    await expect(table("darwin", result).table.list()).rejects.toThrow(/process table/);
  });
});
