import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NodeProcessRunner, type ProcessHandle, type ProcessRunOptions } from "./index.js";
import { windowsKillScript } from "./process-tree-kill.js";
import { childLaunch, headlessLaunch } from "./windows-command.js";

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
    ["a CRLF line break", "a\r\nb"],
    ["a bare carriage return", "a\rb"],
    ["a bare line feed", "a\nb"],
  ])("refuses to run a batch file with an argument holding %s", (_case, argument) => {
    expect(() => childLaunch(String.raw`C:\t.bat`, [argument], "win32", "cmd.exe")).toThrow(
      /cmd\.exe cannot pass to a batch file unchanged/,
    );
  });
});

// why: the launch a detached child gets is pure string work the runner's surface shows only on Windows.
describe("headlessLaunch", () => {
  it.each([
    ["linux", "/sdk/emulator/emulator"],
    ["darwin", "/sdk/emulator/emulator"],
  ] as const)("leaves a command off Windows as it is (%s)", (platform, command) => {
    const launch = { command, args: ["-avd", "x"], windowsVerbatimArguments: false };

    expect(headlessLaunch(launch, platform, String.raw`C:\Windows`)).toBe(launch);
  });

  it("runs an .exe under conhost.exe --headless from the system folder", () => {
    expect(
      headlessLaunch(
        {
          command: String.raw`D:\Android\Sdk\emulator\emulator.exe`,
          args: ["-avd", "simlock"],
          windowsVerbatimArguments: false,
        },
        "win32",
        String.raw`C:\Windows`,
      ),
    ).toEqual({
      command: String.raw`C:\Windows\System32\conhost.exe`,
      args: ["--headless", String.raw`D:\Android\Sdk\emulator\emulator.exe`, "-avd", "simlock"],
      windowsVerbatimArguments: false,
    });
  });
});

// why: the PowerShell that ends a wrapper's tree cannot run off Windows; its depth decides
// whether qemu (the emulator's child) is ended with the emulator.
describe("windowsKillScript", () => {
  it("ends the process and its children at depth 1, and their children too at depth 2", () => {
    expect(windowsKillScript(42, 1)).toContain("$grandchildren = @()");
    expect(windowsKillScript(42, 2)).toContain("ParentProcessId = $($c.ProcessId)");
    expect(windowsKillScript(42, 2)).toContain("Stop-Process -Id 42 -Force");
  });
});

describe.runIf(process.platform === "win32")("NodeProcessRunner on Windows", () => {
  /**
   * why: a detached child of the daemon runs under a headless `conhost.exe` (#1759), so the child
   * Node holds is the wrapper; killing it must still end the program under it (the emulator) and
   * that program's child (qemu), and leave qemu's own child (netsimd) running.
   */
  it("ends a detached killChildren child through its conhost wrapper: the program and its child, not the grandchild", async () => {
    await withProcessChain(
      { killChildren: true, outlivesCaller: true },
      async (handle, { child, grandchild }) => {
        handle.kill("SIGKILL");

        await expect(handle.wait()).resolves.toMatchObject({ code: null });
        await expect.poll(() => isAlive(child), { timeout: 10_000 }).toBe(false);
        expect(isAlive(grandchild)).toBe(true);
      },
    );
  });

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

  /**
   * why: `emulator.exe` runs qemu as its child, and a kill that reached only the parent left qemu
   * running with the guest's RAM. The first emulator's qemu also starts the host's one
   * `netsimd.exe`, which every emulator's network goes through, so the grandchild here must
   * outlive the kill. Each process is `detached` because libuv otherwise puts it in a job
   * object that ends it with its parent, which neither `emulator.exe` nor qemu does.
   */
  it("ends an .exe spawned with killChildren and its child, leaves its grandchild running, and reports no exit code", async () => {
    await withProcessChain({ killChildren: true }, async (handle, { child, grandchild }) => {
      handle.kill("SIGKILL");

      await expect(handle.wait()).resolves.toMatchObject({ code: null });
      await expect.poll(() => isAlive(child), { timeout: 10_000 }).toBe(false);
      expect(isAlive(grandchild)).toBe(true);
    });
  });

  /**
   * why: an `adb` client can start the adb server as its child, and for a phone that is the
   * shared 5037 server, which a timed-out command must not take down with it.
   */
  it("kills an .exe spawned without killChildren alone, leaving its children running", async () => {
    await withProcessChain({}, async (handle, { child }) => {
      handle.kill("SIGKILL");

      await handle.wait();
      expect(isAlive(child)).toBe(true);
    });
  });

  it("reports a batch file's own exit code when kill comes after cmd.exe exited but a grandchild still holds its output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock bat "));
    const pidFile = join(directory, "grandchild.pid");
    const script = join(directory, "exits early.bat");
    await writeFile(
      script,
      `@echo off
start /b "" "${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 4000)" "${pidFile}"
exit /b 0
`,
    );
    let grandchildPid: number | undefined;
    try {
      const handle = new NodeProcessRunner({ exitDeferralCapMs: 10_000, exitGraceMs: 8_000 }).spawn(
        script,
        [],
      );
      await expect
        .poll(() => readFile(pidFile, "utf8").catch(() => ""), { timeout: 5_000 })
        .not.toBe("");
      grandchildPid = Number(await readFile(pidFile, "utf8"));
      await expect.poll(() => isAlive(handle.pid), { timeout: 5_000 }).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 200));

      handle.kill();

      await expect(handle.wait()).resolves.toMatchObject({ code: 0 });
    } finally {
      if (grandchildPid !== undefined && isAlive(grandchildPid)) process.kill(grandchildPid);
      await rm(directory, { force: true, recursive: true });
    }
  });
});

async function withProcessChain(
  options: ProcessRunOptions,
  use: (handle: ProcessHandle, pids: { child: number; grandchild: number }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "simlock exe "));
  const childPidFile = join(directory, "child.pid");
  const grandchildPidFile = join(directory, "grandchild.pid");
  const grandchild = `require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`;
  const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[2]], { detached: true, stdio: 'ignore' }); require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`;
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}, process.argv[1], process.argv[2]], { detached: true, stdio: 'ignore' }); setInterval(() => {}, 1000)`;
  let handle: ProcessHandle | undefined;
  const pids: number[] = [];
  try {
    handle = new NodeProcessRunner().spawn(
      process.execPath,
      ["-e", parent, childPidFile, grandchildPidFile],
      options,
    );
    for (const file of [childPidFile, grandchildPidFile]) {
      await expect
        .poll(() => readFile(file, "utf8").catch(() => ""), { timeout: 10_000 })
        .not.toBe("");
      pids.push(Number(await readFile(file, "utf8")));
    }
    await use(handle, { child: pids[0] ?? 0, grandchild: pids[1] ?? 0 });
  } finally {
    handle?.kill("SIGKILL");
    for (const pid of pids) if (isAlive(pid)) process.kill(pid);
    await rm(directory, { force: true, recursive: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
