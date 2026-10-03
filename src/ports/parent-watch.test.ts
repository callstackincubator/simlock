import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { promiseState } from "../test-support/promise-state.js";
import { FakeParentWatch, NodeParentWatch } from "./index.js";

describe("FakeParentWatch", () => {
  it("fires onExit when the watched pid is reported exited", () => {
    const watch = new FakeParentWatch();
    let exited = false;

    watch.watch(4321, () => {
      exited = true;
    });
    watch.exit(4321);

    expect(exited).toBe(true);
  });

  it("does not fire for an unrelated pid", () => {
    const watch = new FakeParentWatch();
    let exited = false;

    watch.watch(4321, () => {
      exited = true;
    });
    watch.exit(9999);

    expect(exited).toBe(false);
  });

  it("does not fire again once stopped", () => {
    const watch = new FakeParentWatch();
    let exitCount = 0;

    const handle = watch.watch(4321, () => {
      exitCount += 1;
    });
    handle.stop();
    watch.exit(4321);

    expect(exitCount).toBe(0);
  });

  it("fires at most once even if exit() is somehow observed twice", () => {
    const watch = new FakeParentWatch();
    let exitCount = 0;

    watch.watch(4321, () => {
      exitCount += 1;
    });
    watch.exit(4321);
    watch.exit(4321);

    expect(exitCount).toBe(1);
  });
});

describe("NodeParentWatch", () => {
  it("notifies once a real watched process exits", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const watch = new NodeParentWatch(20);
    const exited = new Promise<void>((resolve) => {
      watch.watch(child.pid as number, resolve);
    });

    const exitedState = promiseState(exited);

    child.kill("SIGKILL");

    // Real time against a 20ms poll, so bounded generously -- but a watch that never notices
    // fails here, by name, rather than on the test's own timeout.
    await vi.waitFor(() => expect(exitedState.state).toBe("fulfilled"), {
      interval: 20,
      timeout: 2_000,
    });
  });

  it("stop() prevents onExit from firing", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const watch = new NodeParentWatch(10);
    let exited = false;
    const handle = watch.watch(child.pid as number, () => {
      exited = true;
    });
    handle.stop();
    child.kill("SIGKILL");

    // Give the poll interval a few chances to fire were the watch still active.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(exited).toBe(false);
  });
});
