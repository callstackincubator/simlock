import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BootTimeoutError,
  DriverCrashError,
  RuntimeMissingError,
  UnknownModelError,
} from "../../core/index.js";
import {
  FakeClock,
  NodeProcessRunner,
  ScriptedProcessRunner,
  SystemClock,
} from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";

const listFixture = readFileSync(new URL("./fixtures/simctl-list.json", import.meta.url), "utf8");
const listDevicesFixture = readFileSync(
  new URL("./fixtures/simctl-list-devices.json", import.meta.url),
  "utf8",
);
const listInvocation = {
  command: "xcrun",
  args: ["simctl", "list", "-j", "devicetypes", "runtimes"],
} as const;
const listDevicesInvocation = {
  command: "xcrun",
  args: ["simctl", "list", "-j", "devices"],
} as const;
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const driverData = {
  deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  name: "pitlane-device-1",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  udid: "00000000-0000-0000-0000-000000000001",
} as const;

describe("IosSimctlDriver", () => {
  it("resolves an exact model and requested installed runtime", async () => {
    const runner = scriptedListRunner();
    const driver = createDriver(runner);

    await expect(
      driver.resolveSpec(
        { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
        { allowDownload: false },
      ),
    ).resolves.toEqual({ model: "iPhone 16", osVersion: "18.4", platform: "ios" });
    expect(runner.calls).toEqual([{ ...listInvocation, options: { timeoutMs: 30_000 } }]);
  });

  it("selects the newest installed iOS runtime by default", async () => {
    const driver = createDriver(scriptedListRunner());

    await expect(
      driver.resolveSpec({ model: "iPhone 16", platform: "ios" }, { allowDownload: false }),
    ).resolves.toEqual(spec);
  });

  it("matches model names case-insensitively while preserving the simctl name", async () => {
    const driver = createDriver(scriptedListRunner());

    await expect(
      driver.resolveSpec(
        { model: "iphone 16", osVersion: "26.5", platform: "ios" },
        { allowDownload: false },
      ),
    ).resolves.toEqual(spec);
  });

  it("rejects an unknown model", async () => {
    const driver = createDriver(scriptedListRunner());

    await expect(
      driver.resolveSpec({ model: "iPhone 99", platform: "ios" }, { allowDownload: false }),
    ).rejects.toBeInstanceOf(UnknownModelError);
  });

  it("rejects malformed simctl catalog JSON without trusting partial data", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: '{"devicetypes":[]}' },
      },
    ]);

    await expect(
      createDriver(runner).resolveSpec(
        { model: "iPhone 16", platform: "ios" },
        { allowDownload: false },
      ),
    ).rejects.toBeInstanceOf(DriverCrashError);
  });

  it("rejects missing runtimes even when downloads are allowed", async () => {
    const driver = createDriver(scriptedListRunner());
    const result = await driver
      .resolveSpec(
        { model: "iPhone 16", osVersion: "27", platform: "ios" },
        { allowDownload: true },
      )
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(RuntimeMissingError);
    expect(result).toMatchObject({ message: expect.stringContaining("install it via Xcode") });
  });

  it("provisions with the exact simctl argv and returns opaque iOS driver data", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: {
          command: "xcrun",
          args: [
            "simctl",
            "create",
            "pitlane-device-1",
            driverData.deviceTypeId,
            driverData.runtimeId,
          ],
        },
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
    ]);
    const driver = createDriver(runner);
    await driver.resolveSpec(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      { allowDownload: false },
    );

    await expect(driver.provision(spec)).resolves.toEqual({
      deviceId: driverData.udid,
      driverData,
    });
    expect(runner.calls).toEqual([
      { ...listInvocation, options: { timeoutMs: 30_000 } },
      {
        args: [
          "simctl",
          "create",
          "pitlane-device-1",
          driverData.deviceTypeId,
          driverData.runtimeId,
        ],
        command: "xcrun",
        options: { timeoutMs: 30_000 },
      },
    ]);
  });

  it("surfaces simctl failures with stderr", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: {
          command: "xcrun",
          args: [
            "simctl",
            "create",
            "pitlane-device-1",
            driverData.deviceTypeId,
            driverData.runtimeId,
          ],
        },
        result: { code: 1, stderr: "Invalid runtime", stdout: "" },
      },
    ]);
    const driver = createDriver(runner);
    await driver.resolveSpec(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      { allowDownload: false },
    );

    await expect(driver.provision(spec)).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringContaining("Invalid runtime"),
        name: "DriverCrashError",
      }),
    );
  });

  it("boots then waits for bootstatus with the documented timeout", async () => {
    const runner = new ScriptedProcessRunner([
      { match: { command: "xcrun", args: ["simctl", "boot", driverData.udid] } },
      { match: { command: "xcrun", args: ["simctl", "bootstatus", driverData.udid, "-b"] } },
    ]);

    await expect(
      createDriver(runner).makeReady({ deviceId: driverData.udid, driverData }),
    ).resolves.toBeUndefined();
    expect(runner.calls).toEqual([
      {
        args: ["simctl", "boot", driverData.udid],
        command: "xcrun",
        options: { timeoutMs: 30_000 },
      },
      {
        args: ["simctl", "bootstatus", driverData.udid, "-b"],
        command: "xcrun",
        options: { timeoutMs: 120_000 },
      },
    ]);
  });

  it("times out bootstatus and issues a best-effort shutdown", async () => {
    const clock = new FakeClock();
    const runner = new ScriptedProcessRunner([
      { match: { command: "xcrun", args: ["simctl", "boot", driverData.udid] } },
      {
        hangs: true,
        match: { command: "xcrun", args: ["simctl", "bootstatus", driverData.udid, "-b"] },
      },
      { match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] } },
    ]);
    const ready = createDriver(runner, clock).makeReady({ deviceId: driverData.udid, driverData });

    while (runner.calls.length < 2) {
      await Promise.resolve();
    }
    clock.advance(120_000);

    await expect(ready).rejects.toBeInstanceOf(BootTimeoutError);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "boot", driverData.udid],
      ["simctl", "bootstatus", driverData.udid, "-b"],
      ["simctl", "shutdown", driverData.udid],
    ]);
  });

  it("reclaims by tolerating an already-shutdown response, then erasing", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] },
        result: {
          code: 149,
          stderr: "Unable to shutdown device in current state: Shutdown",
          stdout: "",
        },
      },
      { match: { command: "xcrun", args: ["simctl", "erase", driverData.udid] } },
    ]);

    await expect(
      createDriver(runner).reclaim({ deviceId: driverData.udid, driverData }, { clean: "full" }),
    ).resolves.toEqual({ state: "shutdown", strategy: "erase" });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "shutdown", driverData.udid],
      ["simctl", "erase", driverData.udid],
    ]);
  });

  it("shuts down before deleting and uses benchmark estimates", async () => {
    const runner = new ScriptedProcessRunner([
      { match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] } },
      { match: { command: "xcrun", args: ["simctl", "delete", driverData.udid] } },
    ]);
    const driver = createDriver(runner);

    await driver.destroy({ deviceId: driverData.udid, driverData });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "shutdown", driverData.udid],
      ["simctl", "delete", driverData.udid],
    ]);
    expect(driver.estimate("provision", spec)).toBe(500);
    expect(driver.estimate("boot", spec)).toBe(30_000);
    expect(driver.estimate("reclaim", spec)).toBe(1_000);
  });

  it("lists resolvable models and installed runtimes, defaulting to the newest", async () => {
    const driver = createDriver(scriptedListRunner());

    await expect(driver.listCatalog()).resolves.toEqual({
      defaultRuntime: "26.5",
      models: ["iPhone 17 Pro", "iPhone 16", "iPhone 15 Pro"],
      runtimes: ["18.4", "26.5"],
    });
  });

  it("shells out to simctl exactly once per listCatalog call, reusing the catalog parse", async () => {
    const runner = scriptedListRunner();
    const driver = createDriver(runner);

    await driver.listCatalog();

    expect(runner.calls).toEqual([{ ...listInvocation, options: { timeoutMs: 30_000 } }]);
  });

  it("maps simctl device state to runState and filters to pitlane- devices", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listDevicesInvocation, result: { code: 0, stderr: "", stdout: listDevicesFixture } },
    ]);
    const driver = createDriver(runner);

    const reality = await driver.listManaged();

    expect(
      reality.devices.map((device) => ({ deviceId: device.deviceId, runState: device.runState })),
    ).toEqual([
      { deviceId: "00000000-0000-0000-0000-000000000101", runState: "running" },
      { deviceId: "00000000-0000-0000-0000-000000000102", runState: "stopped" },
      { deviceId: "00000000-0000-0000-0000-000000000103", runState: "transitioning" },
      { deviceId: "00000000-0000-0000-0000-000000000104", runState: "transitioning" },
    ]);
  });

  it("populates processes from booted managed devices only", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listDevicesInvocation, result: { code: 0, stderr: "", stdout: listDevicesFixture } },
    ]);
    const driver = createDriver(runner);

    const reality = await driver.listManaged();

    expect(reality.processes).toEqual([
      expect.objectContaining({
        deviceId: "00000000-0000-0000-0000-000000000101",
        runState: "running",
      }),
    ]);
  });

  it.skipIf(process.env.PITLANE_LIVE_IOS !== "1")(
    "runs a provision-to-destroy smoke test against simctl",
    async () => {
      const driver = new IosSimctlDriver({
        clock: new SystemClock(),
        idGenerator: { generate: () => `test-${process.pid}` },
        processRunner: new NodeProcessRunner(),
      });
      let device: Awaited<ReturnType<IosSimctlDriver["provision"]>> | undefined;

      try {
        const liveSpec = await driver.resolveSpec(
          { model: "iPhone 17 Pro", platform: "ios" },
          { allowDownload: false },
        );
        device = await driver.provision(liveSpec);
        await driver.makeReady(device);
        await driver.reclaim(device, { clean: "standard" });
      } finally {
        if (device !== undefined) {
          await driver.destroy(device);
        }
      }
    },
    150_000,
  );
});

function createDriver(runner: ScriptedProcessRunner, clock = new FakeClock()): IosSimctlDriver {
  return new IosSimctlDriver({
    clock,
    idGenerator: { generate: () => "device-1" },
    processRunner: runner,
  });
}

function scriptedListRunner(): ScriptedProcessRunner {
  return new ScriptedProcessRunner([
    {
      match: listInvocation,
      result: { code: 0, stderr: "", stdout: listFixture },
    },
  ]);
}
