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
  MemoryFilesystem,
  NodeFilesystem,
  NodeProcessRunner,
  ScriptedProcessRunner,
  SystemClock,
  type Filesystem,
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
  name: "simlock-device-1",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  udid: "00000000-0000-0000-0000-000000000001",
} as const;
const dataPath = `/Devices/${driverData.udid}/data`;
const durableMarkPath = `/Devices/${driverData.udid}/simlock-mark.json`;
const erasableMarkPath = `${dataPath}/simlock-mark.json`;

function deviceListResponse(state: string): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
        { name: driverData.name, udid: driverData.udid, state, dataPath },
      ],
    },
  });
}

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
            "simlock-device-1",
            driverData.deviceTypeId,
            driverData.runtimeId,
          ],
        },
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    const driver = createDriver(runner, new FakeClock(), filesystem);
    await driver.resolveSpec(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      { allowDownload: false },
    );

    await expect(driver.provision(spec)).resolves.toEqual({
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData,
    });
    expect(runner.calls).toEqual([
      { ...listInvocation, options: { timeoutMs: 30_000 } },
      {
        args: [
          "simctl",
          "create",
          "simlock-device-1",
          driverData.deviceTypeId,
          driverData.runtimeId,
        ],
        command: "xcrun",
        options: { timeoutMs: 30_000 },
      },
      { ...listDevicesInvocation, options: { timeoutMs: 30_000 } },
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
            "simlock-device-1",
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
      createDriver(runner).makeReady({
        address: driverData.udid,
        deviceId: driverData.udid,
        driverData,
      }),
    ).resolves.toEqual({ address: driverData.udid, deviceId: driverData.udid, driverData });
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
    const ready = createDriver(runner, clock).makeReady({
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData,
    });

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
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);

    await expect(
      createDriver(runner, new FakeClock(), filesystem).reclaim(
        { address: driverData.udid, deviceId: driverData.udid, driverData },
        { clean: "full" },
      ),
    ).resolves.toEqual({ state: "shutdown", strategy: "erase" });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "shutdown", driverData.udid],
      ["simctl", "erase", driverData.udid],
      ["simctl", "list", "-j", "devices"],
    ]);
  });

  it("writes a fresh, different token on reclaim than the one written on provision", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
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
            "simlock-device-1",
            driverData.deviceTypeId,
            driverData.runtimeId,
          ],
        },
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
      { match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] } },
      { match: { command: "xcrun", args: ["simctl", "erase", driverData.udid] } },
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const driver = createTokenDriver(runner, filesystem);
    await driver.resolveSpec(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      { allowDownload: false },
    );
    await driver.provision(spec);

    const provisionedDurable = JSON.parse(await filesystem.readFile(durableMarkPath)) as {
      token: string;
    };
    const provisionedErasable = JSON.parse(await filesystem.readFile(erasableMarkPath)) as {
      token: string;
    };
    expect(provisionedDurable.token).toBe(provisionedErasable.token);

    await driver.reclaim(
      { address: driverData.udid, deviceId: driverData.udid, driverData },
      { clean: "full" },
    );

    const reclaimedDurable = JSON.parse(await filesystem.readFile(durableMarkPath)) as {
      token: string;
    };
    const reclaimedErasable = JSON.parse(await filesystem.readFile(erasableMarkPath)) as {
      token: string;
    };
    expect(reclaimedDurable.token).toBe(reclaimedErasable.token);
    expect(reclaimedDurable.token).not.toBe(provisionedDurable.token);
  });

  it("shuts down before deleting and uses benchmark estimates", async () => {
    const runner = new ScriptedProcessRunner([
      { match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] } },
      { match: { command: "xcrun", args: ["simctl", "delete", driverData.udid] } },
    ]);
    const driver = createDriver(runner);

    await driver.destroy({ address: driverData.udid, deviceId: driverData.udid, driverData });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "shutdown", driverData.udid],
      ["simctl", "delete", driverData.udid],
    ]);
    expect(driver.estimate({ operation: "provision" }, spec)).toBe(500);
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(60_000);
  });

  it("prices reclaim as the erase it always runs, at either clean level", () => {
    const driver = createDriver(new ScriptedProcessRunner([]));

    // `reclaimStrategy` answers `erase` for both levels, so both must be priced as one --
    // and as tens of seconds, not the ~1s the estimate used to claim (#56).
    expect(driver.reclaimStrategy({ clean: "standard" })).toBe("erase");
    expect(driver.reclaimStrategy({ clean: "full" })).toBe("erase");
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, spec)).toBe(34_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, spec)).toBe(34_000);
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

  it("maps simctl device state to runState and filters to simlock- devices", async () => {
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

  it("derives the data path from the cached devices root instead of re-listing", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
      { match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] } },
      { match: { command: "xcrun", args: ["simctl", "erase", driverData.udid] } },
    ]);
    const driver = createDriver(runner, new FakeClock(), filesystem);

    await driver.listManaged();
    await driver.reclaim(
      { address: driverData.udid, deviceId: driverData.udid, driverData },
      { clean: "full" },
    );

    // `simctl list` costs ~260ms and reclaim runs on every release, so the
    // devices root learned during listManaged must keep it off the lease path.
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "list", "-j", "devices"],
      ["simctl", "shutdown", driverData.udid],
      ["simctl", "erase", driverData.udid],
    ]);
    expect(await filesystem.exists(erasableMarkPath)).toBe(true);
    expect(await filesystem.exists(durableMarkPath)).toBe(true);
  });

  it("reports matching provenance tokens for a healthy managed device", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    await filesystem.writeFileAtomic(durableMarkPath, JSON.stringify({ token: "tok-1" }));
    await filesystem.writeFileAtomic(erasableMarkPath, JSON.stringify({ token: "tok-1" }));
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);

    const reality = await createDriver(runner, new FakeClock(), filesystem).listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({
        mark: { durable: "tok-1", erasable: "tok-1", erasableReadable: true },
      }),
    ]);
  });

  it("reports erasable undefined when the data-container mark is gone (foreign erase)", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    await filesystem.writeFileAtomic(durableMarkPath, JSON.stringify({ token: "tok-1" }));
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);

    const reality = await createDriver(runner, new FakeClock(), filesystem).listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({
        mark: { durable: "tok-1", erasable: undefined, erasableReadable: true },
      }),
    ]);
  });

  it("reports mark undefined when both provenance regions are absent (pre-upgrade device)", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);

    const reality = await createDriver(runner, new FakeClock(), filesystem).listManaged();

    expect(reality.devices[0]?.mark).toBeUndefined();
  });

  it("reads a corrupt mark file as undefined without throwing", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    await filesystem.writeFileAtomic(durableMarkPath, "not json");
    await filesystem.writeFileAtomic(erasableMarkPath, JSON.stringify({ notAToken: true }));
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);

    const reality = await createDriver(runner, new FakeClock(), filesystem).listManaged();

    expect(reality.devices[0]?.mark).toBeUndefined();
  });

  it.skipIf(process.env.SIMLOCK_LIVE_IOS !== "1")(
    "runs a provision-to-destroy smoke test against simctl",
    async () => {
      const driver = new IosSimctlDriver({
        clock: new SystemClock(),
        filesystem: new NodeFilesystem(),
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

function createDriver(
  runner: ScriptedProcessRunner,
  clock = new FakeClock(),
  filesystem: Filesystem = new MemoryFilesystem(),
): IosSimctlDriver {
  return new IosSimctlDriver({
    clock,
    filesystem,
    idGenerator: { generate: () => "device-1" },
    processRunner: runner,
  });
}

/**
 * `#idGenerator.generate()` names the device on its first call and mints
 * mark tokens on every later call, so the first call must stay "device-1"
 * to match `driverData.name` while later calls vary to prove the reclaim
 * token differs from the provision token.
 */
function createTokenDriver(
  runner: ScriptedProcessRunner,
  filesystem: Filesystem = new MemoryFilesystem(),
): IosSimctlDriver {
  let calls = 0;
  return new IosSimctlDriver({
    clock: new FakeClock(),
    filesystem,
    idGenerator: {
      generate: () => {
        calls += 1;
        return calls === 1 ? "device-1" : `tok-${String(calls)}`;
      },
    },
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
