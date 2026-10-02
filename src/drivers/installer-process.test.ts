import { describe, expect, it } from "vitest";

import type { ComponentInstallProgress } from "../core/driver.js";
import { FakeClock, ScriptedProcessRunner } from "../ports/index.js";
import { runInstallerProcess } from "./installer-process.js";

const command = "installer";

function run(
  runner: ScriptedProcessRunner,
  clock: FakeClock,
  options: { readonly signal?: AbortSignal } = {},
) {
  const progress: ComponentInstallProgress[] = [];
  const outcome = runInstallerProcess(runner, clock, command, ["install"], {
    onProgress: (report) => progress.push(report),
    signal: options.signal ?? new AbortController().signal,
  });
  return { outcome, progress };
}

describe("runInstallerProcess", () => {
  it("reports the last percentage within 0-100 on each line before it resolves, and nothing for a line without one", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["install"], command },
        stdoutLines: [
          "[====   ] 10% then 40% Downloading",
          "Unzipping",
          "Disk at 250% of something",
          "[=======] 100%",
        ],
      },
    ]);
    const clock = new FakeClock();

    const { outcome, progress } = run(runner, clock);
    await outcome;

    expect(progress).toEqual([
      { percent: 40, stage: "downloading" },
      { percent: 100, stage: "downloading" },
    ]);
  });

  it("starts nothing for a signal that already fired", async () => {
    const runner = new ScriptedProcessRunner([]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      run(runner, new FakeClock(), { signal: controller.signal }).outcome,
    ).resolves.toEqual({ result: { code: null, stderr: "", stdout: "" }, stopped: true });
    expect(runner.calls).toEqual([]);
  });

  it("leaves no timer behind once the process has ended", async () => {
    const runner = new ScriptedProcessRunner([
      { hangs: true, ignoresSigterm: true, match: { args: ["install"], command } },
    ]);
    const clock = new FakeClock();
    const controller = new AbortController();

    const { outcome } = run(runner, clock, { signal: controller.signal });
    controller.abort();
    runner.handles[0]?.kill("SIGKILL");
    await expect(outcome).resolves.toMatchObject({ stopped: true });

    expect(clock.pendingTimerCount).toBe(0);
  });
});
