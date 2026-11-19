import { afterEach, expect, describe, it } from "vitest";
import {
  type ProcessResult,
  ScriptedProcessRunner,
  FakeClock,
  MemoryFilesystem,
} from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import { type SilenceFailedFact, IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import {
  deviceRoot,
  driverData,
  simctlArgs,
  simctl,
  instanceId,
  overridesRoot,
  waitForCalls,
  flushMicrotasks221,
} from "./test-slim.js";
import { UNSCOPED_LEGACY_CALLS, scopedRunners, wantedReadback } from "./test-index.js";

/**
 * why: The one global invariant, asserted over everything every test in this file recorded
 * rather than per call site: scoping is what makes ownership provable, so a spawn that
 * reached `xcrun` without `simctl --set <root>` in front of it would address the machine's
 * default device set (safety rule 8). Per-test argv equality proves today's calls are
 * scoped; only this proves the next one added is, whether or not it goes through
 * `#invokeSimctl`.
 */
afterEach(() => {
  for (const call of scopedRunners.splice(0).flatMap((runner) => runner.calls)) {
    // why: Not every spawn addresses a device: `xcodebuild -downloadPlatform` installs a runtime
    // and has no device set to point at. The invariant is about the calls that *do* -- a
    // `simctl` that reached the machine's default set is the leak this guards.
    if (call.command !== "xcrun" || call.args[0] !== "simctl") continue;
    if (UNSCOPED_LEGACY_CALLS.has(call.args.join(" "))) continue;
    expect(call.args.slice(0, 2)).toEqual(["simctl", "--set"]);
    expect([deviceRoot, `${deviceRoot}/sources`]).toContain(call.args[2]);
  }
});

describe("IosSimctlDriver simulator audio", () => {
  const volumeState = "com.apple.springboard.volumestate";
  const udid = driverData.udid;
  const slimData = { ...driverData, runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-5" };

  const silence = [
    simctlArgs("spawn", udid, "notifyutil", "-s", volumeState, "0"),
    simctlArgs("spawn", udid, "notifyutil", "-p", volumeState),
  ];
  const renameCall = simctlArgs("rename", udid, driverData.name);
  const bootCalls = [
    simctlArgs("boot", udid),
    simctlArgs("bootstatus", udid, "-b"),
    simctlArgs("listapps", udid),
  ];
  const readbackCall = simctlArgs("spawn", udid, "launchctl", "print-disabled", "system");

  it.each([
    {
      name: "prepare",
      options: { mode: "full", purpose: "prepare" } as const,
      expected: [renameCall, ...bootCalls, ...silence],
    },
    {
      name: "recover",
      options: { mode: "full", purpose: "recover" } as const,
      expected: [...bootCalls, ...silence],
    },
    {
      name: "a slim prepare, silenced before the readback",
      data: slimData,
      options: { mode: "slim", purpose: "prepare" } as const,
      expected: [renameCall, ...bootCalls, ...silence, readbackCall],
    },
    {
      name: "the setting true",
      audio: true,
      options: { mode: "full", purpose: "prepare" } as const,
      expected: [renameCall, ...bootCalls],
    },
    {
      name: "a volume command that fails",
      volume: { code: 1, stderr: "boom", stdout: "" },
      options: { mode: "full", purpose: "prepare" } as const,
      expected: [renameCall, ...bootCalls, silence[0]],
      failure: "boom",
    },
    {
      name: "a volume command that times out",
      volume: "hangs" as const,
      options: { mode: "full", purpose: "prepare" } as const,
      expected: [renameCall, ...bootCalls, silence[0]],
      failure: "timed out",
    },
  ])(
    "sets a simulator's volume to 0 before handing it on when ios.simulator.audio is false: $name",
    async (c) => {
      const data = c.data ?? driverData;
      const silenceCall = (index: number, result?: ProcessResult) => ({
        match: { args: silence[index]!, command: "xcrun" },
        ...(result === undefined ? {} : { result }),
      });
      const runner = new ScriptedProcessRunner([
        ...(c.options.purpose === "prepare"
          ? [{ match: simctl("rename", udid, driverData.name) }]
          : []),
        { match: simctl("boot", udid) },
        { match: simctl("bootstatus", udid, "-b") },
        { match: simctl("listapps", udid) },
        ...(c.audio === true
          ? []
          : c.volume === "hangs"
            ? [{ ...silenceCall(0), hangs: true }]
            : c.volume !== undefined
              ? [silenceCall(0, c.volume)]
              : [silenceCall(0), silenceCall(1)]),
        ...(c.options.mode === "slim"
          ? [
              {
                match: simctl("spawn", udid, "launchctl", "print-disabled", "system"),
                result: { code: 0, stderr: "", stdout: wantedReadback() },
              },
            ]
          : []),
      ]);
      scopedRunners.push(runner);
      const clock = new FakeClock();
      const failures: SilenceFailedFact[] = [];
      const driver = await IosSimctlDriver.create({
        clock,
        database: await memorySourceDatabase(),
        driverConfig: { deviceRoot },
        filesystem: new MemoryFilesystem(),
        idGenerator: { generate: () => "device-1" },
        instanceId,
        launchdOverridesRoot: overridesRoot,
        onSilenceFailed: (fact) => failures.push(fact),
        processRunner: runner,
        simlockHome: "/home/.simlock",
        config: {
          simulator: { audio: c.audio ?? false, createTimeoutMs: 30_000, headless: true },
          slim: { bootTimeoutMs: 300_000, categories: ["widgets"] },
        },
      });

      const ready = driver.makeReady(
        { address: udid, deviceId: udid, driverData: data },
        c.options,
      );
      if (c.volume === "hangs") {
        const state = promiseState(ready);
        await waitForCalls(runner, c.expected.length);
        clock.advance(29_999);
        await flushMicrotasks221();
        expect(state.state).toBe("pending");
        clock.advance(1);
        await flushMicrotasks221();
        expect(state.state).toBe("fulfilled");
      }
      const device = await ready;

      expect(device.address).toBe(udid);
      expect(runner.calls.map((call) => call.args)).toEqual(c.expected);
      expect(failures).toEqual(
        c.failure === undefined ? [] : [{ deviceId: udid, detail: c.failure }],
      );
    },
  );
});
