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
    ["NodeProcessRunner.run", async () => new NodeProcessRunner().run(...quiet)],
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
