import { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeBytePipeLauncher, NodeProcessRunner } from "./index.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const quiet = [process.execPath, ["-e", ""]] as const;

/**
 * why: the daemon has no console, so on Windows every console program it starts without
 * `windowsHide` opens a visible window of its own. The window cannot be seen from a test, whose
 * runner has a console the child would share hidden or not, so these check the option each
 * adapter hands `spawn`.
 */
describe("the children the ports start ask Windows for no console window", () => {
  afterEach(() => {
    vi.mocked(spawn).mockClear();
  });

  it.each([
    ["NodeProcessRunner.run", () => new NodeProcessRunner().run(...quiet)],
    [
      "NodeProcessRunner.spawnStreaming",
      () => new NodeProcessRunner().spawnStreaming(...quiet, { onChunk: () => undefined }).wait(),
    ],
    [
      "NodeBytePipeLauncher.start",
      () => new NodeBytePipeLauncher().start(...quiet, { env: process.env }).exited,
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
