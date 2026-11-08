import { describe, expect, it } from "vitest";

import { OwnedRootError } from "../../core/index.js";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import { IosSimctlDriver, type WindowFailedFact } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import { deviceHubEdit } from "./test-slim.js";

const instanceId = "instance-1";
const overridesRoot = "/private/var/tmp";
const driverData = {
  deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  name: "simlock-device-1",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  udid: "00000000-0000-0000-0000-000000000001",
} as const;

/** why: Lets queued continuations run, so a test can see that something has not happened yet. */
async function flushMicrotasks(): Promise<void> {
  for (let count = 0; count < 100; count += 1) await Promise.resolve();
}

/** why: a call the test waits for that never arrives fails a named assertion, not the suite's timeout. */
async function waitForCalls(runner: ScriptedProcessRunner, count: number): Promise<void> {
  for (let tick = 0; tick < 1_000 && runner.calls.length < count; tick += 1) {
    await Promise.resolve();
  }
  expect(runner.calls, `the driver never made ${String(count)} calls`).toHaveLength(count);
}

describe("IosSimctlDriver ios.simulator.headless refusal", () => {
  const coreSimulatorRoot = "/CoreSim";

  it.each([
    ["false with default", { deviceSet: "default" }, false, undefined],
    ["true with simlock", { deviceSet: "simlock" }, true, undefined],
    ["false with simlock", { deviceSet: "simlock" }, false, "simlock"],
    ["false with the set unset", {}, false, "simlock"],
    ["false with a bad value", { deviceSet: "Default" }, false, "Default"],
  ] as const)(
    "refuses iOS with invalid-device-set when ios.simulator.headless is false and the device set is Simlock's own: %s",
    async (_case, driverConfig, headless, refusedRoot) => {
      const failure = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        coreSimulatorRoot,
        driverConfig,
        filesystem: new MemoryFilesystem(),
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: new ScriptedProcessRunner([]),
        simlockHome: "/home/.simlock",
        config: { simulator: { audio: true, headless } },
      })
        .then(() => undefined)
        .catch((error: unknown) => error);

      if (refusedRoot === undefined) {
        expect(failure).toBeUndefined();
        return;
      }
      expect(failure).toBeInstanceOf(OwnedRootError);
      expect(failure).toMatchObject({
        path: refusedRoot,
        platform: "ios",
        reason: "invalid-device-set",
      });
      expect((failure as Error).message).toBe(
        refusedRoot === "Default"
          ? 'Refusing the ios device set: drivers.ios.deviceSet must be "simlock" or "default", but it is "Default"'
          : 'Refusing the ios device set: ios.simulator.headless is false, which needs drivers.ios.deviceSet "default". Set drivers.ios.deviceSet to "default", or ios.simulator.headless to true.',
      );
    },
  );
});

describe("IosSimctlDriver simulator window", () => {
  const udid = driverData.udid;
  const slimData = { ...driverData, runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-5" };
  const xcrun = (...args: string[]) => ({ command: "xcrun", args: ["simctl", ...args] });
  const open = (...args: string[]) => ({ command: "open", args: ["-g", ...args] });
  const clipboard = deviceHubEdit(`Set :DevicePreferences:${udid}:pasteboardSyncEnabled false`);
  const bootCalls = [xcrun("boot", udid), xcrun("bootstatus", udid, "-b"), xcrun("listapps", udid)];
  const deviceHub = open(
    "-b",
    "com.apple.dt.Devices",
    "--args",
    "-shutdownStartedDevicesOnQuit",
    "NO",
  );
  const deviceHubArgs = "-g -b com.apple.dt.Devices --args -shutdownStartedDevicesOnQuit NO";
  const select = open(`devices://manage/select?id=${udid}`);
  const simulatorApp = open(
    "-b",
    "com.apple.iphonesimulator",
    "--args",
    "-CurrentDeviceUDID",
    udid,
    "-DetachOnWindowClose",
    "YES",
    "-DetachOnAppQuit",
    "YES",
  );
  const readback = xcrun("spawn", udid, "launchctl", "print-disabled", "system");
  const notInstalled = {
    code: 1,
    stderr: "LSCopyApplicationURLsForBundleIdentifier() failed",
    stdout: "",
  };

  it.each([
    { name: "DeviceHub installed", expected: [...bootCalls, deviceHub, select] },
    {
      name: "DeviceHub not installed",
      deviceHubResult: notInstalled,
      expected: [...bootCalls, deviceHub, simulatorApp],
    },
    {
      name: "recover",
      options: { mode: "full", purpose: "recover" } as const,
      expected: [...bootCalls, deviceHub, select],
    },
    {
      name: "slim, opened before the readback",
      data: slimData,
      options: { mode: "slim", purpose: "prepare" } as const,
      expected: [...bootCalls, deviceHub, select, readback],
    },
    { name: "the setting true", headless: true, expected: bootCalls },
  ])(
    "shows a simulator in a window without taking focus when ios.simulator.headless is false: $name",
    async (c) => {
      const runner = new ScriptedProcessRunner(
        [...clipboard, ...c.expected].map((match) => ({
          match,
          ...(match === deviceHub && c.deviceHubResult !== undefined
            ? { result: c.deviceHubResult }
            : {}),
        })),
      );
      const driver = await IosSimctlDriver.create({
        clock: new FakeClock(),
        database: await memorySourceDatabase(),
        driverConfig: { deviceSet: "default" },
        filesystem: new MemoryFilesystem(),
        idGenerator: { generate: () => "device-1" },
        instanceId,
        launchdOverridesRoot: overridesRoot,
        processRunner: runner,
        simlockHome: "/home/.simlock",
        config: {
          simulator: { audio: true, headless: c.headless ?? false },
          slim: { bootTimeoutMs: 300_000, categories: ["widgets"] },
        },
      });

      await expect(
        driver.makeReady(
          { address: udid, deviceId: udid, driverData: c.data ?? driverData },
          c.options ?? { mode: "full", purpose: "prepare" },
        ),
      ).resolves.toMatchObject({ address: udid });
      expect(runner.calls.map(({ command, args }) => ({ command, args }))).toEqual([
        ...clipboard,
        ...c.expected,
      ]);
    },
  );

  it.each([
    {
      name: "select exits non-zero",
      script: [
        { match: deviceHub },
        { match: select, result: { code: 1, stderr: " boom\n", stdout: "" } },
      ],
      detail: "boom",
    },
    {
      name: "Simulator.app exits non-zero",
      script: [
        { match: deviceHub, result: notInstalled },
        { match: simulatorApp, result: { code: 1, stderr: "no app", stdout: "" } },
      ],
      detail: "no app",
    },
    {
      name: "a call times out",
      script: [{ match: deviceHub }, { match: select, hangs: true }],
      detail: "timed out",
    },
    {
      name: "the DeviceHub call times out",
      script: [{ match: deviceHub, hangs: true }],
      detail: "timed out",
    },
    {
      name: "the DeviceHub call cannot start",
      script: [],
      detail: `Could not start ${deviceHubArgs}: Unexpected process invocation: open ${deviceHubArgs}`,
    },
    {
      name: "a call cannot start",
      script: [{ match: deviceHub }],
      detail: `Could not start -g devices://manage/select?id=${udid}: Unexpected process invocation: open -g devices://manage/select?id=${udid}`,
    },
  ])(
    "makes the simulator ready and reports the failure when opening its window fails: $name",
    async (c) => {
      const runner = new ScriptedProcessRunner([
        ...[...clipboard, ...bootCalls].map((match) => ({ match })),
        ...c.script,
      ]);
      const clock = new FakeClock();
      const failures: WindowFailedFact[] = [];
      const driver = await IosSimctlDriver.create({
        clock,
        database: await memorySourceDatabase(),
        driverConfig: { deviceSet: "default" },
        filesystem: new MemoryFilesystem(),
        idGenerator: { generate: () => "device-1" },
        instanceId,
        launchdOverridesRoot: overridesRoot,
        onWindowFailed: (fact) => failures.push(fact),
        processRunner: runner,
        simlockHome: "/home/.simlock",
        config: { simulator: { audio: true, headless: false } },
      });

      const ready = driver.makeReady(
        { address: udid, deviceId: udid, driverData },
        { mode: "full", purpose: "prepare" },
      );
      if (c.script.some((step) => "hangs" in step)) {
        const state = promiseState(ready);
        await waitForCalls(runner, clipboard.length + bootCalls.length + c.script.length);
        clock.advance(29_999);
        await flushMicrotasks();
        expect(state.state).toBe("pending");
        clock.advance(1);
        await flushMicrotasks();
        expect(state.state).toBe("fulfilled");
      }
      const device = await ready;

      expect(device.address).toBe(udid);
      expect(failures).toEqual([{ deviceId: udid, detail: c.detail }]);
    },
  );
});
