import { describe, expect, it, vi } from "vitest";

import type { ComponentInstallProgress } from "../core/index.js";
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

  it("reports each percentage of a progress bar redrawn with carriage returns", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["install"], command },
        stdoutLines: ["[=  ] 10% a\r[== ] 20% b\r[===] 30% c"],
      },
    ]);
    const clock = new FakeClock();

    const { outcome, progress } = run(runner, clock);
    await outcome;

    expect(progress.map((report) => report.percent)).toEqual([10, 20, 30]);
  });

  it("reads a percentage written with a decimal comma, as xcodebuild prints it in a region that uses one", async () => {
    // Byte for byte as `xcodebuild -downloadPlatform iOS -buildVersion 18.4` wrote it under
    // language English, region Poland: one `\n`, then `\r`-separated redraws, a line with only
    // the title, a "Preparing" line, comma decimals in the percentage and the sizes, and a
    // redraw padded with trailing spaces.
    const title = "Downloading iOS 18.4 Universal Simulator (22E238):";
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["install"], command },
        stderrLines: [
          [
            "Finding content...\n",
            `${title} `,
            `${title} Preparing to download...`,
            `${title} 0,0% (73 kB of 8,86 GB)`,
            `${title} 0,4% (39,4 MB of 8,86 GB)`,
            `${title} 2,7% (235 MB of 8,86 GB)  `,
            `${title} 9,7% (857,8 MB of 8,86 GB)`,
          ].join("\r"),
        ],
      },
    ]);
    const clock = new FakeClock();

    const { outcome, progress } = run(runner, clock);
    await outcome;

    expect(progress.map((report) => report.percent)).toEqual([0, 0.4, 2.7, 9.7]);
  });

  it("reports each percentage while the installer is still running, before it exits", async () => {
    const runner = new ScriptedProcessRunner([
      {
        hangs: true,
        match: { args: ["install"], command },
        stdoutLines: ["[=  ] 10% a\r[== ] 20% b\r[===] 30% c"],
      },
    ]);
    const clock = new FakeClock();
    const controller = new AbortController();
    let exited = false;

    const { outcome, progress } = run(runner, clock, { signal: controller.signal });
    void outcome.then(() => (exited = true));
    await vi.waitFor(() => {
      expect(progress.map((report) => report.percent)).toEqual([10, 20, 30]);
    });

    expect(exited).toBe(false);
    controller.abort();
    await outcome;
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
