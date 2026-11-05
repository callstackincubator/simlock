import { describe, expect, it } from "vitest";

import { BootTimeoutError, DriverCrashError } from "../../core/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";

const deviceRoot = "/Devices";
const driverData = {
  deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  name: "simlock-device-1",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  udid: "00000000-0000-0000-0000-000000000001",
} as const;
const { udid } = driverData;
const device = { address: udid, deviceId: udid, driverData };
const slimBudgetMs = 300_000;
const slowBootMs = 59_000;

const purposes = [
  { name: "a full boot", options: { mode: "full", purpose: "prepare" }, readinessMs: 120_000 },
  { name: "a slim boot", options: { mode: "slim", purpose: "prepare" }, readinessMs: slimBudgetMs },
  { name: "a recovery boot", options: { mode: "slim", purpose: "recover" }, readinessMs: 120_000 },
] as const;

function simctl(...args: readonly string[]) {
  return { args: ["simctl", "--set", deviceRoot, ...args], command: "xcrun" };
}

function finishesAfter(clock: FakeClock, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimer(milliseconds, resolve);
  });
}

async function createDriver(runner: ScriptedProcessRunner, clock: FakeClock) {
  return IosSimctlDriver.create({
    clock,
    database: await memorySourceDatabase(),
    driverConfig: { deviceRoot },
    filesystem: new MemoryFilesystem(),
    idGenerator: { generate: () => "device-1" },
    instanceId: "instance-1",
    launchdOverridesRoot: "/overrides",
    processRunner: runner,
    simlockHome: "/home/.simlock",
    slim: { bootTimeoutMs: slimBudgetMs, categories: ["widgets"] },
  });
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
}

/** why: the driver reaches its next command after real I/O on the source database and filesystem. */
async function untilCalls(runner: ScriptedProcessRunner, count: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && runner.calls.length < count; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(runner.calls.map((call) => call.args[3])).toHaveLength(count);
}

function commands(runner: ScriptedProcessRunner): readonly (string | undefined)[] {
  return runner.calls.map((call) => call.args[3]);
}

describe("the `simctl boot` budget", () => {
  it.each(purposes)(
    "$name is still waiting just before 60 s, then times out at 60 s, signals its child and runs nothing else",
    async ({ options }) => {
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([{ hangs: true, match: simctl("boot", udid) }]);
      const driver = await createDriver(runner, clock);

      const ready = driver.makeReady(device, options).catch((error: unknown) => error);
      const state = promiseState(ready);
      await untilCalls(runner, 1);
      clock.advance(59_999);
      await flush();
      expect(state.state).toBe("pending");

      clock.advance(1);

      expect(await ready).toBeInstanceOf(BootTimeoutError);
      expect(await ready).toMatchObject({
        diagnostics: { budgetMs: 60_000, elapsedMs: 60_000, phase: "boot-command" },
      });
      expect(runner.calls).toEqual([{ ...simctl("boot", udid), options: { timeoutMs: 60_000 } }]);
      await expect(runner.handles[0]?.wait()).resolves.toMatchObject({ code: null });
    },
  );

  it("reports the time a boot really took, not its budget, when the timer fires late", async () => {
    const clock = new FakeClock();
    const runner = new ScriptedProcessRunner([
      { hangs: true, match: simctl("boot", udid), onSpawn: () => clock.advance(1_500) },
    ]);
    const driver = await createDriver(runner, clock);

    const ready = driver.makeReady(device, purposes[0].options).catch((error: unknown) => error);
    await untilCalls(runner, 1);
    clock.advance(60_000);

    expect(await ready).toMatchObject({
      diagnostics: { budgetMs: 60_000, elapsedMs: 61_500, phase: "boot-command" },
    });
  });

  it("goes on when a late `simctl boot` says the device is already booted, and fails as a crash when it exits with an error", async () => {
    const clock = new FakeClock();
    const finishing = (stderr: string): ScriptedProcessExpectation => ({
      finishesOn: finishesAfter(clock, 45_000),
      match: simctl("boot", udid),
      result: { code: 149, stderr, stdout: "" },
    });
    const runner = new ScriptedProcessRunner([
      finishing("Unable to boot device in current state: Booted"),
      { match: simctl("bootstatus", udid, "-b") },
      { match: simctl("listapps", udid) },
      finishing("simctl could not start the device"),
    ]);
    const driver = await createDriver(runner, clock);

    const booted = driver.makeReady(device, purposes[0].options);
    await untilCalls(runner, 1);
    clock.advance(45_000);
    await expect(booted).resolves.toMatchObject({ deviceId: udid });

    const crashed = await driver
      .makeReady(device, purposes[0].options)
      .catch((error: unknown) => error);

    expect(crashed).toBeInstanceOf(DriverCrashError);
    expect((crashed as Error).message).toContain("simctl could not start the device");
    expect(commands(runner)).toEqual(["boot", "bootstatus", "listapps", "boot"]);
  });
});

describe("the readiness budget after a slow `simctl boot`", () => {
  it.each(purposes)(
    "$name gives a hung bootstatus its whole budget, and the cleanup after it counts for nothing",
    async ({ options, readinessMs }) => {
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        { finishesOn: finishesAfter(clock, slowBootMs), match: simctl("boot", udid) },
        { hangs: true, match: simctl("bootstatus", udid, "-b") },
        { match: simctl("shutdown", udid), onSpawn: () => clock.advance(5_000) },
      ]);
      const driver = await createDriver(runner, clock);

      const ready = driver.makeReady(device, options).catch((error: unknown) => error);
      const state = promiseState(ready);
      await untilCalls(runner, 1);
      clock.advance(slowBootMs);
      await untilCalls(runner, 2);
      clock.advance(readinessMs - 1);
      await flush();
      expect(state.state).toBe("pending");

      clock.advance(1);

      expect(await ready).toBeInstanceOf(BootTimeoutError);
      expect(await ready).toMatchObject({
        diagnostics: { budgetMs: readinessMs, elapsedMs: readinessMs, phase: "bootstatus" },
      });
      expect(runner.calls).toEqual([
        { ...simctl("boot", udid), options: { timeoutMs: 60_000 } },
        { ...simctl("bootstatus", udid, "-b"), options: { timeoutMs: readinessMs } },
        { ...simctl("shutdown", udid), options: { timeoutMs: 30_000 } },
      ]);
    },
  );

  it.each(purposes)(
    "$name shares that budget with the installer probe, measured from the end of the boot",
    async ({ options, readinessMs }) => {
      const clock = new FakeClock();
      const untilProbe = readinessMs - 500;
      const runner = new ScriptedProcessRunner([
        { finishesOn: finishesAfter(clock, slowBootMs), match: simctl("boot", udid) },
        {
          finishesOn: finishesAfter(clock, slowBootMs + untilProbe),
          match: simctl("bootstatus", udid, "-b"),
        },
        { hangs: true, match: simctl("listapps", udid) },
        { match: simctl("shutdown", udid) },
      ]);
      const driver = await createDriver(runner, clock);

      const ready = driver.makeReady(device, options).catch((error: unknown) => error);
      const state = promiseState(ready);
      await untilCalls(runner, 1);
      clock.advance(slowBootMs);
      await untilCalls(runner, 2);
      clock.advance(untilProbe);
      await untilCalls(runner, 3);
      clock.advance(499);
      await flush();
      expect(state.state).toBe("pending");

      clock.advance(1);

      expect(await ready).toMatchObject({
        diagnostics: { budgetMs: readinessMs, elapsedMs: readinessMs, phase: "installer" },
      });
      expect(runner.calls[2]?.options).toEqual({ timeoutMs: 500 });
      expect(commands(runner)).toEqual(["boot", "bootstatus", "listapps", "shutdown"]);
    },
  );

  it.each([
    {
      phase: "bootstatus",
      script: (clock: FakeClock): readonly ScriptedProcessExpectation[] => [
        { hangs: true, match: simctl("bootstatus", udid, "-b"), onSpawn: () => clock.advance(700) },
      ],
      steps: [{ calls: 2, advance: 120_000 }],
    },
    {
      phase: "installer",
      script: (clock: FakeClock): readonly ScriptedProcessExpectation[] => [
        { finishesOn: finishesAfter(clock, 119_500), match: simctl("bootstatus", udid, "-b") },
        { hangs: true, match: simctl("listapps", udid), onSpawn: () => clock.advance(700) },
      ],
      steps: [
        { calls: 2, advance: 119_500 },
        { calls: 3, advance: 500 },
      ],
    },
  ])(
    "reports the time $phase really took, not its budget, when the timer fires late",
    async ({ phase, script, steps }) => {
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        { match: simctl("boot", udid) },
        ...script(clock),
        { match: simctl("shutdown", udid) },
      ]);
      const driver = await createDriver(runner, clock);

      const ready = driver.makeReady(device, purposes[0].options).catch((error: unknown) => error);
      for (const { advance, calls } of steps) {
        await untilCalls(runner, calls);
        clock.advance(advance);
      }

      expect(await ready).toMatchObject({
        diagnostics: { budgetMs: 120_000, elapsedMs: 120_700, phase },
      });
    },
  );
});
