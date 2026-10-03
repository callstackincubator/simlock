import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeProcessRunner, NodeProcessSupervisor } from "./index.js";

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
    expect(new NodeProcessSupervisor().isAlive(process.pid)).toBe(true);
  });

  it("reports a process that has exited as gone", async () => {
    const supervisor = new NodeProcessSupervisor();

    await goneFrom(supervisor, await retiredPid());
  });

  it.each([0, -1, -4242, 7.5, Number.NaN, 2 ** 31])(
    "reports a pid that addresses no single process as not alive (%s)",
    (pid) => {
      // `process.kill(0, ...)` signals this daemon's whole process group and `-1` every
      // process the user owns, so a pid read back from a corrupt record on disk must never
      // reach it. Answering "alive" is what would send the caller looking for it with a
      // SIGKILL.
      expect(new NodeProcessSupervisor().isAlive(pid)).toBe(false);
    },
  );

  it.each([0, -1, 7.5])("refuses to signal anything for the pid %s", (pid) => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    new NodeProcessSupervisor().signal(pid, "SIGKILL");

    expect(kill).not.toHaveBeenCalled();
  });

  it("treats signalling a process that is already gone as a no-op", async () => {
    const supervisor = new NodeProcessSupervisor();
    const pid = await retiredPid();
    await goneFrom(supervisor, pid);

    expect(() => supervisor.signal(pid, "SIGTERM")).not.toThrow();
  });
});
