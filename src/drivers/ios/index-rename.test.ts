import { afterEach, expect, describe, it } from "vitest";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import {
  createSlimDriver,
  deviceRoot,
  driverData,
  flushMicrotasks221,
  simctl,
  simctlArgs,
  waitForCalls,
} from "./test-slim.js";
import { RecordingLogger, UNSCOPED_LEGACY_CALLS, scopedRunners } from "./test-index.js";

afterEach(() => {
  for (const call of scopedRunners.splice(0).flatMap((runner) => runner.calls)) {
    if (call.command !== "xcrun" || call.args[0] !== "simctl") continue;
    if (UNSCOPED_LEGACY_CALLS.has(call.args.join(" "))) continue;
    expect(call.args.slice(0, 3)).toEqual(["simctl", "--set", deviceRoot]);
  }
});

describe("IosSimctlDriver naming a simulator at its boot", () => {
  const udid = driverData.udid;
  const boot = [
    simctlArgs("boot", udid),
    simctlArgs("bootstatus", udid, "-b"),
    simctlArgs("listapps", udid),
  ];

  it.each([
    {
      name: "a label",
      options: { mode: "full", purpose: "prepare", label: "feature-x" } as const,
      expected: [simctlArgs("rename", udid, "feature-x"), ...boot],
    },
    {
      name: "no label names it back to its stored name",
      options: { mode: "full", purpose: "prepare" } as const,
      expected: [simctlArgs("rename", udid, driverData.name), ...boot],
    },
    {
      name: "a recovery boot renames nothing",
      options: { mode: "full", purpose: "recover", label: "feature-x" } as const,
      expected: boot,
    },
    {
      name: "a rename that exits non-zero",
      rename: { code: 1, stderr: "Invalid device", stdout: "" },
      options: { mode: "full", purpose: "prepare", label: "feature-x" } as const,
      expected: [simctlArgs("rename", udid, "feature-x"), ...boot],
      warned: `could not rename ${udid} to feature-x: Invalid device`,
    },
    {
      name: "a rename that hangs past 5 s",
      rename: "hangs" as const,
      options: { mode: "full", purpose: "prepare", label: "feature-x" } as const,
      expected: [simctlArgs("rename", udid, "feature-x"), ...boot],
      warned: `could not rename ${udid} to feature-x: timed out after 5000ms`,
    },
  ])("runs simctl rename before simctl boot on a prepare boot: $name", async (c) => {
    const renames = c.expected.length > boot.length;
    const runner = new ScriptedProcessRunner([
      ...(!renames
        ? []
        : [
            {
              match: simctl("rename", udid, c.expected[0]![5]!),
              ...(c.rename === "hangs"
                ? { hangs: true }
                : c.rename === undefined
                  ? {}
                  : { result: c.rename }),
            },
          ]),
      { match: simctl("boot", udid) },
      { match: simctl("bootstatus", udid, "-b") },
      { match: simctl("listapps", udid) },
    ]);
    scopedRunners.push(runner);
    const clock = new FakeClock();
    const logger = new RecordingLogger();
    const driver = await createSlimDriver(
      runner,
      new MemoryFilesystem(),
      { bootTimeoutMs: 300_000, categories: ["widgets"] },
      undefined,
      undefined,
      false,
      clock,
      logger,
    );

    const ready = driver.makeReady({ address: udid, deviceId: udid, driverData }, c.options);
    if (c.rename === "hangs") {
      const state = promiseState(ready);
      await waitForCalls(runner, 1);
      clock.advance(4_999);
      await flushMicrotasks221();
      expect(state.state).toBe("pending");
      clock.advance(1);
      await flushMicrotasks221();
    }
    const device = await ready;

    expect(device.address).toBe(udid);
    expect(runner.calls.map((call) => call.args)).toEqual(c.expected);
    expect(logger.warnings).toEqual(c.warned === undefined ? [] : [c.warned]);
  });
});
