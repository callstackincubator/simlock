import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NodeBytePipeLauncher,
  NodeDaemonLauncher,
  NodeProcessRunner,
  NodeUpdaterLauncher,
} from "./index.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const quiet = [process.execPath, ["-e", ""]] as const;

/**
 * why: the daemon has no console, so on Windows every console program it starts without
 * `windowsHide` opens a visible window of its own, and a detached child started from the CLI gets
 * one too. The window cannot be seen from a test, whose runner has a console the child would share
 * hidden or not, so these check the option each adapter hands `spawn`.
 */
describe("the children the ports start ask Windows for no console window", () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.mocked(spawn).mockClear();
    for (const directory of directories.splice(0)) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  async function scratch(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "simlock-child-window-"));
    directories.push(directory);
    return directory;
  }

  it.each([
    [
      "NodeProcessRunner.run",
      async () => new NodeProcessRunner().run(...quiet, { timeoutMs: 30_000 }),
    ],
    [
      "NodeProcessRunner.spawnStreaming",
      async () =>
        new NodeProcessRunner().spawnStreaming(...quiet, { onChunk: () => undefined }).wait(),
    ],
    [
      "NodeBytePipeLauncher.start",
      async () => new NodeBytePipeLauncher().start(...quiet, { env: process.env }).exited,
    ],
    [
      "NodeDaemonLauncher.launch",
      async () => {
        const directory = await scratch();
        const launched = await new NodeDaemonLauncher({
          args: ["-e", ""],
          command: process.execPath,
          logPath: join(directory, "daemon.log"),
          simlockHome: directory,
        }).launch();
        await launched.exited;
      },
    ],
    [
      "NodeUpdaterLauncher.launch",
      async () => {
        const directory = await scratch();
        const entry = join(directory, "updater.cjs");
        await writeFile(entry, "");
        const launched = await new NodeUpdaterLauncher().launch({
          entry,
          from: "1.0.0",
          logPath: join(directory, "update.log"),
          pid: process.pid,
          role: "worker",
          simlockHome: directory,
          to: "1.0.1",
        });
        await launched.exited;
      },
    ],
  ])("%s", async (_adapter, run) => {
    await run();

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ windowsHide: true }),
    );
  });
});

/**
 * why: Node puts every child it does not start detached on Windows into a job that kills the
 * child when Node exits, and the child shares Node's console. An emulator or adb server spawned
 * that way dies with the daemon while its own children live on, holding the logon task's
 * console open (#1759). The supervisor's daemon must stay in that job, so that ending the
 * supervisor ends it (ADR 0086 section 2). Neither the job nor the console can be seen from a
 * test off Windows, so this checks the option `spawn` hands Node with the platform set.
 */
describe("a child that outlives its caller is detached on every platform, and one that does not is detached off Windows only", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  let directory: string | undefined;

  afterEach(async () => {
    if (original !== undefined) Object.defineProperty(process, "platform", original);
    vi.mocked(spawn).mockClear();
    if (directory !== undefined) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it.each([
    ["win32", true, true, true],
    ["darwin", true, true, false],
    ["linux", true, true, false],
    ["win32", false, false, false],
    ["darwin", false, true, false],
    ["linux", false, true, false],
  ] as const)(
    "on %s, outlivesCaller %s is started detached: %s, under conhost --headless: %s",
    async (platform, outlivesCaller, detached, headless) => {
      directory = await mkdtemp(join(tmpdir(), "simlock-child-detach-"));
      const file = join(directory, "child.log");
      Object.defineProperty(process, "platform", { value: platform });
      if (headless) {
        // why: conhost.exe does not exist off Windows; the quiet program stands in for it.
        const actual =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        vi.mocked(spawn).mockImplementationOnce(((
          _command: string,
          _args: string[],
          options: object,
        ) => actual.spawn(...quiet, options)) as unknown as typeof spawn);
      }

      await new NodeProcessRunner().spawn(...quiet, { outlivesCaller, stdio: { file } }).wait();

      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        headless ? expect.stringMatching(/conhost\.exe$/i) : process.execPath,
        headless ? ["--headless", process.execPath, "-e", ""] : ["-e", ""],
        expect.objectContaining({ detached }),
      );
    },
  );
});
