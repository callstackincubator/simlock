import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NodeProcessRunner } from "./index.js";
import { childLaunch } from "./windows-command.js";

const sdkmanager = String.raw`C:\Android\Sdk/cmdline-tools/latest/bin/sdkmanager.bat`;

// why: pure quoting logic with many cases, which the runner's surface could only reach on Windows.
describe("childLaunch", () => {
  it.each([
    ["linux", "/sdk/cmdline-tools/latest/bin/sdkmanager"],
    ["darwin", "/sdk/cmdline-tools/latest/bin/sdkmanager"],
    ["win32", String.raw`C:\Android\Sdk\platform-tools\adb.exe`],
  ] as const)("spawns anything but a Windows batch file as it is (%s)", (platform, command) => {
    expect(childLaunch(command, ["50%"], platform, "cmd.exe")).toEqual({
      command,
      args: ["50%"],
      windowsVerbatimArguments: false,
    });
  });

  it("runs a batch file through cmd.exe /d /s /c, with backslashes in its path", () => {
    expect(childLaunch(sdkmanager, ["--version"], "win32", "cmd.exe")).toEqual({
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`"C:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat ^"--version^""`,
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("uses the ComSpec it is given, and matches .cmd in any case", () => {
    const launch = childLaunch(String.raw`C:\tools\AVDMANAGER.CMD`, [], "win32", "C:\\cmd.exe");

    expect(launch.command).toBe("C:\\cmd.exe");
    expect(launch.args.at(-1)).toBe(String.raw`"C:\tools\AVDMANAGER.CMD"`);
  });

  it.each([
    [
      "semicolons",
      "system-images;android-36;google_apis;x86_64",
      String.raw`^"system-images^;android-36^;google_apis^;x86_64^"`,
    ],
    ["a command separator", "x & calc", String.raw`^"x^ ^&^ calc^"`],
    ["a trailing backslash", "C:\\dir\\", String.raw`^"C:\dir\\^"`],
  ])("escapes an argument holding %s so cmd.exe reads it as text", (_case, argument, escaped) => {
    const line = childLaunch(String.raw`C:\t.bat`, [argument], "win32", "cmd.exe").args.at(-1);

    expect(line).toBe(`"C:\\t.bat ${escaped}"`);
  });

  it.each([
    ["a percent sign", "%PATH%"],
    ["a double quote", 'a"b'],
    ["a line break", "a\r\nb"],
  ])("refuses to run a batch file with an argument holding %s", (_case, argument) => {
    expect(() => childLaunch(String.raw`C:\t.bat`, [argument], "win32", "cmd.exe")).toThrow(
      /cmd\.exe cannot pass to a batch file unchanged/,
    );
  });
});

describe.runIf(process.platform === "win32")("NodeProcessRunner on Windows", () => {
  /**
   * why: the SDK's Gradle-generated batch files test `"x%~1"`, collect `%*` into a variable and
   * expand it on the `java` line, so cmd.exe parses every argument there twice more; this script
   * reads its arguments with those same lines and prints what arrived.
   */
  it("passes every argument unchanged through a batch file that reads them the way the SDK's do", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock bat "));
    const printer = join(directory, "print-args.cjs");
    const script = join(directory, "forward args.bat");
    await writeFile(printer, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(
      script,
      [
        "@echo off",
        "set CMD_LINE_ARGS=",
        'if "x%~1" == "x" goto execute',
        "set CMD_LINE_ARGS=%*",
        ":execute",
        `"${process.execPath}" "${printer}" %CMD_LINE_ARGS%`,
        "",
      ].join("\r\n"),
    );
    const args = [
      "--install",
      "system-images;android-36;google_apis;x86_64",
      "with space",
      "x & echo injected",
      "C:\\trailing\\",
      "(paren) <angle> |pipe| ^caret! `tick`",
    ];
    try {
      const result = await new NodeProcessRunner().run(script, args, { timeoutMs: 10_000 });

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("ends what a batch file started when its run times out, not only the cmd.exe running it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock bat "));
    const pidFile = join(directory, "child.pid");
    const script = join(directory, "long running.bat");
    await writeFile(
      script,
      `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "${pidFile}"\r\n`,
    );
    let childPid: number | undefined;
    try {
      const run = new NodeProcessRunner().run(script, [], { timeoutMs: 1_000 });
      await expect
        .poll(() => readFile(pidFile, "utf8").catch(() => ""), { timeout: 5_000 })
        .not.toBe("");
      childPid = Number(await readFile(pidFile, "utf8"));

      await expect(run).resolves.toMatchObject({ code: null });

      await expect.poll(() => isAlive(childPid ?? 0), { timeout: 5_000 }).toBe(false);
    } finally {
      if (childPid !== undefined && isAlive(childPid)) process.kill(childPid);
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
