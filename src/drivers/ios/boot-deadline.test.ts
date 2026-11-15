import { describe, expect, it, vi } from "vitest";

import { BootTimeoutError } from "../../core/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessRunner,
} from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import {
  deviceRoot,
  driverData,
  flushMicrotasks221,
  instanceId,
  overridesRoot,
  plantManagedDevice,
  prepareSlim,
  settledValue,
  simctlArgs,
  waitForCalls,
} from "./test-slim.js";

const slim18_5 = { ...driverData, runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-5" };
const prepareFull = { mode: "full", purpose: "prepare" } as const;

// why: #1560 — ios.full/slim.bootTimeoutMs is one deadline from before `simctl boot`; index.test.ts is at its size limit.
describe("IosSimctlDriver boot deadline", () => {
  const bootBudgets = [
    {
      budgetMs: 400_000,
      config: { full: { bootTimeoutMs: 400_000 } },
      data: driverData,
      key: "ios.full.bootTimeoutMs",
      options: prepareFull,
    },
    {
      budgetMs: 250_000,
      config: { slim: { bootTimeoutMs: 250_000, categories: ["widgets"] } },
      data: slim18_5,
      key: "ios.slim.bootTimeoutMs",
      options: prepareSlim,
    },
  ] as const;

  async function bootBudgetDriver(
    runner: ScriptedProcessRunner,
    clock: FakeClock,
    config: (typeof bootBudgets)[number]["config"],
  ) {
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    return await IosSimctlDriver.create({
      database: await memorySourceDatabase(),
      driverConfig: { deviceRoot },
      instanceId,
      simlockHome: "/home/.simlock",
      clock,
      filesystem,
      idGenerator: { generate: () => "device-1" },
      launchdOverridesRoot: overridesRoot,
      processRunner: runner,
      config,
    });
  }

  it.each(bootBudgets)(
    "a simctl boot that hangs waits the whole $key, not a fixed 30 s, then fails with BootTimeoutError (#1560)",
    async ({ budgetMs, config, data, options }) => {
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        { hangs: true, match: { command: "xcrun", args: simctlArgs("boot", data.udid) } },
      ]);
      const driver = await bootBudgetDriver(runner, clock, config);

      const ready = driver.makeReady(
        { address: data.udid, deviceId: data.udid, driverData: data },
        options,
      );
      void ready.catch(() => undefined);
      await waitForCalls(runner, 1);
      const readyState = promiseState(ready);

      expect(runner.calls[0]?.options).toEqual({ timeoutMs: budgetMs });
      clock.advance(budgetMs - 1);
      await flushMicrotasks221();
      expect(readyState.state).toBe("pending");

      clock.advance(1);
      expect(await settledValue(ready)).toBeInstanceOf(BootTimeoutError);
    },
  );

  it.each(bootBudgets)(
    "a 100 s simctl boot is spent from $key: bootstatus gets only the rest, and the boot fails when the whole budget is gone (#1560)",
    async ({ budgetMs, config, data, options }) => {
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        {
          match: { command: "xcrun", args: simctlArgs("boot", data.udid) },
          onSpawn: () => clock.advance(100_000),
        },
        {
          hangs: true,
          match: { command: "xcrun", args: simctlArgs("bootstatus", data.udid, "-b") },
        },
        { match: { command: "xcrun", args: simctlArgs("shutdown", data.udid) } },
      ]);
      const driver = await bootBudgetDriver(runner, clock, config);

      const ready = driver.makeReady(
        { address: data.udid, deviceId: data.udid, driverData: data },
        options,
      );
      void ready.catch(() => undefined);
      await waitForCalls(runner, 2);
      const readyState = promiseState(ready);

      expect(runner.calls[1]?.options).toEqual({ timeoutMs: budgetMs - 100_000 });
      clock.advance(budgetMs - 100_000 - 1);
      await flushMicrotasks221();
      expect(readyState.state).toBe("pending");

      clock.advance(1);
      expect(await settledValue(ready)).toBeInstanceOf(BootTimeoutError);
      expect(runner.calls.map((call) => call.args)).toEqual([
        simctlArgs("boot", data.udid),
        simctlArgs("bootstatus", data.udid, "-b"),
        simctlArgs("shutdown", data.udid),
      ]);
    },
  );

  it("a refresh of an already booted device boots again with only the time left of ios.full.bootTimeoutMs (#1560)", async () => {
    const clock = new FakeClock();
    const budgetMs = 400_000;
    const bootArgs = ["xcrun", "simctl", "boot", driverData.udid];
    const calls: { args: readonly string[]; options: unknown }[] = [];
    let boots = 0;
    const runner: ProcessRunner = {
      run: () => Promise.reject(new Error("the driver runs commands through spawn")),
      spawn(command, args, options) {
        calls.push({ args: [command, ...args], options });
        const isBoot = [command, ...args].join(" ") === bootArgs.join(" ");
        const isShutdown = args[1] === "shutdown";
        const first = isBoot && boots++ === 0;
        const entry = {
          match: { command, args: [...args] },
          ...(isBoot && !first ? { hangs: true } : {}),
          ...(first
            ? {
                onSpawn: () => clock.advance(100_000),
                result: {
                  code: 1,
                  stderr: "Unable to boot device in current state: Booted",
                  stdout: "",
                },
              }
            : {}),
          ...(isShutdown ? { onSpawn: () => clock.advance(20_000) } : {}),
        };
        return new ScriptedProcessRunner([entry]).spawn(command, args, options);
      },
      spawnStreaming: () => {
        throw new Error("the driver streams nothing here");
      },
    };
    const driver = await IosSimctlDriver.create({
      database: await memorySourceDatabase(),
      driverConfig: { deviceSet: "default" },
      coreSimulatorRoot: "/Users/u/Library/Developer/CoreSimulator",
      instanceId,
      simlockHome: "/home/.simlock",
      clock,
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "device-1" },
      processRunner: runner,
      config: { full: { bootTimeoutMs: budgetMs } },
    });

    const ready = driver.makeReady(
      { address: driverData.udid, deviceId: driverData.udid, driverData },
      prepareFull,
    );
    void ready.catch(() => undefined);
    await vi.waitFor(() => expect(boots).toBe(2));
    const readyState = promiseState(ready);

    const secondBoot = calls.filter((call) => call.args.join(" ") === bootArgs.join(" ")).at(1);
    expect(secondBoot?.options).toEqual({ timeoutMs: budgetMs - 120_000 });
    clock.advance(budgetMs - 120_000 - 1);
    await flushMicrotasks221();
    expect(readyState.state).toBe("pending");

    clock.advance(1);
    expect(await settledValue(ready)).toBeInstanceOf(BootTimeoutError);
  });
});
