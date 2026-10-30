import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NodeProcessRunner,
  NodeProcessSupervisor,
  ScriptedProcessRunner,
  type ProcessResult,
} from "./index.js";

function nodeSupervisor(): NodeProcessSupervisor {
  return new NodeProcessSupervisor({
    platform: process.platform,
    processRunner: new NodeProcessRunner(),
  });
}

/**
 * Runs a process to completion and hands back the pid it no longer occupies. `wait()` can
 * settle on the stdio close that precedes the OS reaping the child, so callers still have
 * to wait for the pid itself to go.
 */
async function retiredPid(): Promise<number> {
  const handle = new NodeProcessRunner().spawn(process.execPath, ["-e", ""]);
  await handle.wait();
  return handle.pid;
}

async function goneFrom(supervisor: NodeProcessSupervisor, pid: number): Promise<void> {
  await vi.waitFor(() => {
    expect(supervisor.isAlive(pid)).toBe(false);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NodeProcessSupervisor", () => {
  it("reports a running process as alive", () => {
    expect(nodeSupervisor().isAlive(process.pid)).toBe(true);
  });

  it("reports a process that has exited as gone", async () => {
    const supervisor = nodeSupervisor();

    await goneFrom(supervisor, await retiredPid());
  });

  it.each([0, -1, -4242, 7.5, Number.NaN, 2 ** 31])(
    "reports a pid that addresses no single process as not alive (%s)",
    (pid) => {
      // `process.kill(0, ...)` signals this daemon's whole process group and `-1` every
      // process the user owns, so a pid read back from a corrupt record on disk must never
      // reach it. Answering "alive" is what would send the caller looking for it with a
      // SIGKILL.
      expect(nodeSupervisor().isAlive(pid)).toBe(false);
    },
  );

  it.each([0, -1, 7.5])("refuses to signal anything for the pid %s", (pid) => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    nodeSupervisor().signal(pid, "SIGKILL");

    expect(kill).not.toHaveBeenCalled();
  });

  it("treats signalling a process that is already gone as a no-op", async () => {
    const supervisor = nodeSupervisor();
    const pid = await retiredPid();
    await goneFrom(supervisor, pid);

    expect(() => supervisor.signal(pid, "SIGTERM")).not.toThrow();
  });
});

const posixRead = ["-ww", "-o", "args=", "-p", "4242"];
const windowsRead = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=4242').CommandLine",
];

function answering(
  command: string,
  args: readonly string[],
  result: Partial<ProcessResult>,
): ScriptedProcessRunner {
  return new ScriptedProcessRunner([
    { match: { args, command }, result: { code: 0, stderr: "", stdout: "", ...result } },
  ]);
}

describe("NodeProcessSupervisor.commandLine", () => {
  it.each([
    {
      args: posixRead,
      command: "ps",
      line: "/opt/node/bin/node /opt/ad/daemon.js --simlock-home=/home/a b/.simlock",
      platform: "linux",
      stdout: "/opt/node/bin/node /opt/ad/daemon.js --simlock-home=/home/a b/.simlock\n",
    },
    {
      args: posixRead,
      command: "ps",
      line: "/sdk/platform-tools/adb -P 5038 nodaemon server",
      platform: "darwin",
      stdout: "/sdk/platform-tools/adb -P 5038 nodaemon server\n",
    },
    {
      args: windowsRead,
      command: "powershell.exe",
      line: String.raw`C:\Program Files\nodejs\node.exe C:\ad\daemon.js --simlock-home=C:\Users\John Smith\.simlock`,
      platform: "win32",
      stdout:
        String.raw`"C:\Program Files\nodejs\node.exe" C:\ad\daemon.js "--simlock-home=C:\Users\John Smith\.simlock"` +
        "\r\n",
    },
    {
      args: windowsRead,
      command: "powershell.exe",
      line: String.raw`C:\Sdk/platform-tools/adb.exe -P 5038 nodaemon server`,
      platform: "win32",
      stdout: String.raw`C:\Sdk/platform-tools/adb.exe -P 5038 nodaemon server` + "\r\n",
    },
    {
      args: windowsRead,
      command: "powershell.exe",
      line: String.raw`C:\x.exe a"b c\ d\e  f`,
      platform: "win32",
      stdout: String.raw`C:\x.exe "a\"b" "c\\" d\e "" f` + "\r\n",
    },
  ] as const)(
    "reads a $platform pid's arguments through $command, bounded at 5 s, and answers them unquoted, joined by single spaces: $line",
    async ({ args, command, line, platform, stdout }) => {
      const runner = answering(command, args, { stdout });
      const supervisor = new NodeProcessSupervisor({ platform, processRunner: runner });

      await expect(supervisor.commandLine(4242)).resolves.toBe(line);
      expect(runner.calls.map((call) => call.options.timeoutMs)).toEqual([5_000]);
    },
  );

  it.each([
    ["linux", "exits non-zero", "ps", posixRead, { code: 1 }],
    ["linux", "prints nothing", "ps", posixRead, { stdout: "\n" }],
    ["win32", "exits non-zero", "powershell.exe", windowsRead, { code: 1 }],
    ["win32", "prints nothing", "powershell.exe", windowsRead, { stdout: "\r\n" }],
    ["win32", "is ended at its time limit", "powershell.exe", windowsRead, { code: null }],
  ] as const)(
    "answers undefined on %s when the read %s",
    async (platform, _case, command, args, result) => {
      const runner = answering(command, args, result);

      await expect(
        new NodeProcessSupervisor({ platform, processRunner: runner }).commandLine(4242),
      ).resolves.toBeUndefined();
      expect(runner.calls).toHaveLength(1);
    },
  );

  it.each(["linux", "win32"] as const)(
    "answers undefined on %s when the read cannot be started at all",
    async (platform) => {
      const runner = new ScriptedProcessRunner([]);

      await expect(
        new NodeProcessSupervisor({ platform, processRunner: runner }).commandLine(4242),
      ).resolves.toBeUndefined();
      expect(runner.calls).toHaveLength(1);
    },
  );

  it.each([0, -1, 7.5, 2 ** 31])(
    "answers undefined and runs nothing for the pid %s, which addresses no single process",
    async (pid) => {
      const runner = new ScriptedProcessRunner([]);

      await expect(
        new NodeProcessSupervisor({ platform: "win32", processRunner: runner }).commandLine(pid),
      ).resolves.toBeUndefined();
      expect(runner.calls).toEqual([]);
    },
  );
});

describe.runIf(process.platform === "win32")("NodeProcessSupervisor on a Windows host", () => {
  it("reads a running child's real command line, a quoted path and a non-ASCII argument included", async () => {
    const runner = new NodeProcessRunner();
    const child = runner.spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
      "marker with spaces",
      "Zoë",
    ]);
    try {
      const line = await new NodeProcessSupervisor({
        platform: "win32",
        processRunner: runner,
      }).commandLine(child.pid);

      expect(line).toBe(
        `${process.execPath} -e setInterval(() => {}, 1000) marker with spaces Zoë`,
      );
    } finally {
      child.kill("SIGKILL");
      await child.wait();
    }
  }, 30_000);
});
