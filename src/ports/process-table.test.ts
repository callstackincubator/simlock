import { readFileSync } from "node:fs";

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

  it("reads a PowerShell answer captured on a real Windows host in 100-nanosecond units, with a process that has no command line", async () => {
    // why: captured with the query NodeProcessTable runs, on Windows 11 (10.0.22631) via `ssh DesktopWindows`; the first 20 lines of 104.
    const fixture = readFileSync(
      new URL("./fixtures/win32-process-table.txt", import.meta.url),
      "utf8",
    );
    const { table: processes, runner } = table("win32", ok(fixture));

    const entries = await processes.list();

    expect(entries).toHaveLength(20);
    expect(entries.slice(0, 3)).toEqual([
      { command: "", cpuSeconds: 1996.171875, pid: 0, ppid: 0 },
      { command: "", cpuSeconds: 4.6875, pid: 4, ppid: 0 },
      { command: "", cpuSeconds: 0, pid: 172, ppid: 4 },
    ]);
    expect(entries.find((entry) => entry.pid === 1508)).toEqual({
      command: "C:\\Windows\\system32\\svchost.exe -k DcomLaunch -p",
      cpuSeconds: 0.015625,
      pid: 1508,
      ppid: 1276,
    });
    expect(entries.find((entry) => entry.pid === 1536)?.command).toBe('"fontdrvhost.exe"');
    expect(runner.calls[0]?.options.timeoutMs).toBe(15_000);
  });

  it.each([
    ["a read that timed out", { code: null, endedBy: "timeout" as const, stderr: "", stdout: "" }],
    ["a non-zero exit", { code: 1, stderr: "boom", stdout: "" }],
  ])("throws on %s, so the caller counts no reading", async (_name, result) => {
    await expect(table("darwin", result).table.list()).rejects.toThrow(/process table/);
  });
});
