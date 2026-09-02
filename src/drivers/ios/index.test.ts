import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BootTimeoutError,
  DriverCrashError,
  OwnedRootError,
  OWNED_ROOT_MARKER_FILE,
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
const deviceRoot = "/Devices";
const instanceId = "instance-1";
const listInvocation = simctl("list", "-j", "devicetypes", "runtimes");
const listDevicesInvocation = simctl("list", "-j", "devices");
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const driverData = {
  deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  name: "simlock-device-1",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  udid: "00000000-0000-0000-0000-000000000001",
} as const;
const createInvocation = simctl(
  "create",
  driverData.name,
  driverData.deviceTypeId,
  driverData.runtimeId,
);
const dataPath = `${deviceRoot}/${driverData.udid}/data`;
const durableMarkPath = `${deviceRoot}/${driverData.udid}/simlock-mark.json`;
const erasableMarkPath = `${dataPath}/simlock-mark.json`;

/** Every simctl call the driver makes is scoped to its device set; so is every expectation. */
function simctlArgs(...args: readonly string[]): string[] {
  return ["simctl", "--set", deviceRoot, ...args];
}

function simctl(...args: readonly string[]): { readonly command: string; readonly args: string[] } {
  return { args: simctlArgs(...args), command: "xcrun" };
}

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
    const driver = await createDriver(runner);

    await expect(
      driver.resolveSpec(
        { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
        { allowDownload: false },
      ),
    ).resolves.toEqual({ model: "iPhone 16", osVersion: "18.4", platform: "ios" });
    expect(runner.calls).toEqual([{ ...listInvocation, options: { timeoutMs: 30_000 } }]);
  });

  it("selects the newest installed iOS runtime by default", async () => {
    const driver = await createDriver(scriptedListRunner());

    await expect(
      driver.resolveSpec({ model: "iPhone 16", platform: "ios" }, { allowDownload: false }),
    ).resolves.toEqual(spec);
  });

  it("matches model names case-insensitively while preserving the simctl name", async () => {
    const driver = await createDriver(scriptedListRunner());

    await expect(
      driver.resolveSpec(
        { model: "iphone 16", osVersion: "26.5", platform: "ios" },
        { allowDownload: false },
      ),
    ).resolves.toEqual(spec);
  });

  it("rejects an unknown model", async () => {
    const driver = await createDriver(scriptedListRunner());

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
    const driver = await createDriver(runner);

    await expect(
      driver.resolveSpec({ model: "iPhone 16", platform: "ios" }, { allowDownload: false }),
    ).rejects.toBeInstanceOf(DriverCrashError);
  });

  it("rejects missing runtimes even when downloads are allowed", async () => {
    const driver = await createDriver(scriptedListRunner());
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
        match: createInvocation,
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
    ]);
    const filesystem = new MemoryFilesystem();
    const driver = await createDriver(runner, new FakeClock(), filesystem);
    await filesystem.mkdirp(dataPath);
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
      { ...createInvocation, options: { timeoutMs: 30_000 } },
    ]);
  });

  it("surfaces simctl failures with stderr", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: createInvocation,
        result: { code: 1, stderr: "Invalid runtime", stdout: "" },
      },
    ]);
    const driver = await createDriver(runner);
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
      { match: simctl("boot", driverData.udid) },
      { match: simctl("bootstatus", driverData.udid, "-b") },
    ]);
    const driver = await createDriver(runner);

    await expect(
      driver.makeReady({
        address: driverData.udid,
        deviceId: driverData.udid,
        driverData,
      }),
    ).resolves.toEqual({ address: driverData.udid, deviceId: driverData.udid, driverData });
    expect(runner.calls).toEqual([
      { ...simctl("boot", driverData.udid), options: { timeoutMs: 30_000 } },
      { ...simctl("bootstatus", driverData.udid, "-b"), options: { timeoutMs: 120_000 } },
    ]);
  });

  it("times out bootstatus and issues a best-effort shutdown", async () => {
    const clock = new FakeClock();
    const runner = new ScriptedProcessRunner([
      { match: simctl("boot", driverData.udid) },
      { hangs: true, match: simctl("bootstatus", driverData.udid, "-b") },
      { match: simctl("shutdown", driverData.udid) },
    ]);
    const driver = await createDriver(runner, clock);
    const ready = driver.makeReady({
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
      simctlArgs("boot", driverData.udid),
      simctlArgs("bootstatus", driverData.udid, "-b"),
      simctlArgs("shutdown", driverData.udid),
    ]);
  });

  it("reclaims by tolerating an already-shutdown response, then erasing", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: simctl("shutdown", driverData.udid),
        result: {
          code: 149,
          stderr: "Unable to shutdown device in current state: Shutdown",
          stdout: "",
        },
      },
      { match: simctl("erase", driverData.udid) },
    ]);
    const filesystem = new MemoryFilesystem();
    const driver = await createDriver(runner, new FakeClock(), filesystem);
    await filesystem.mkdirp(dataPath);

    await expect(
      driver.reclaim(
        { address: driverData.udid, deviceId: driverData.udid, driverData },
        { clean: "full" },
      ),
    ).resolves.toEqual({ state: "shutdown", strategy: "erase" });
    expect(runner.calls.map((call) => call.args)).toEqual([
      simctlArgs("shutdown", driverData.udid),
      simctlArgs("erase", driverData.udid),
    ]);
  });

  it("writes a fresh, different token on reclaim than the one written on provision", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: createInvocation,
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
      { match: simctl("shutdown", driverData.udid) },
      { match: simctl("erase", driverData.udid) },
    ]);
    const filesystem = new MemoryFilesystem();
    const driver = await createTokenDriver(runner, filesystem);
    await filesystem.mkdirp(dataPath);
    await driver.resolveSpec(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      { allowDownload: false },
    );
    await driver.provision(spec);

    const provisionedDurable = await readToken(filesystem, durableMarkPath);
    const provisionedErasable = await readToken(filesystem, erasableMarkPath);
    expect(provisionedDurable).toBe(provisionedErasable);

    await driver.reclaim(
      { address: driverData.udid, deviceId: driverData.udid, driverData },
      { clean: "full" },
    );

    expect(await readToken(filesystem, durableMarkPath)).toBe(
      await readToken(filesystem, erasableMarkPath),
    );
    expect(await readToken(filesystem, durableMarkPath)).not.toBe(provisionedDurable);
  });

  it("shuts down before deleting and uses benchmark estimates", async () => {
    const runner = new ScriptedProcessRunner([
      { match: simctl("shutdown", driverData.udid) },
      { match: simctl("delete", driverData.udid) },
    ]);
    const driver = await createDriver(runner);

    await driver.destroy({ address: driverData.udid, deviceId: driverData.udid, driverData });

    expect(runner.calls.map((call) => call.args)).toEqual([
      simctlArgs("shutdown", driverData.udid),
      simctlArgs("delete", driverData.udid),
    ]);
    expect(driver.estimate({ operation: "provision" }, spec)).toBe(500);
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(60_000);
  });

  it("prices reclaim as the erase it always runs, at either clean level", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    // `reclaimStrategy` answers `erase` for both levels, so both must be priced as one --
    // and as tens of seconds, not the ~1s the estimate used to claim (#56).
    expect(driver.reclaimStrategy({ clean: "standard" })).toBe("erase");
    expect(driver.reclaimStrategy({ clean: "full" })).toBe("erase");
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, spec)).toBe(34_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, spec)).toBe(34_000);
  });

  it("lists resolvable models and installed runtimes, defaulting to the newest", async () => {
    const driver = await createDriver(scriptedListRunner());

    await expect(driver.listCatalog()).resolves.toEqual({
      defaultRuntime: "26.5",
      models: ["iPhone 17 Pro", "iPhone 16", "iPhone 15 Pro"],
      runtimes: ["18.4", "26.5"],
    });
  });

  it("shells out to simctl exactly once per listCatalog call, reusing the catalog parse", async () => {
    const runner = scriptedListRunner();
    const driver = await createDriver(runner);

    await driver.listCatalog();

    expect(runner.calls).toEqual([{ ...listInvocation, options: { timeoutMs: 30_000 } }]);
  });

  it("reports every device in its set, whatever the device is named", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listDevicesInvocation, result: { code: 0, stderr: "", stdout: listDevicesFixture } },
    ]);
    const driver = await createDriver(runner);

    const reality = await driver.listManaged();

    // The fixture's last device carries no `simlock-` prefix. Membership in the set is the
    // ownership proof (safety rule 8), so it is Simlock's like every other entry here.
    expect(
      reality.devices.map((device) => ({ deviceId: device.deviceId, runState: device.runState })),
    ).toEqual([
      { deviceId: "00000000-0000-0000-0000-000000000101", runState: "running" },
      { deviceId: "00000000-0000-0000-0000-000000000102", runState: "stopped" },
      { deviceId: "00000000-0000-0000-0000-000000000103", runState: "transitioning" },
      { deviceId: "00000000-0000-0000-0000-000000000104", runState: "transitioning" },
      { deviceId: "00000000-0000-0000-0000-000000000105", runState: "running" },
    ]);
  });

  it("populates processes from booted managed devices only", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listDevicesInvocation, result: { code: 0, stderr: "", stdout: listDevicesFixture } },
    ]);
    const driver = await createDriver(runner);

    const reality = await driver.listManaged();

    expect(reality.processes.map((device) => device.deviceId)).toEqual([
      "00000000-0000-0000-0000-000000000101",
      "00000000-0000-0000-0000-000000000105",
    ]);
  });

  it("derives mark paths from its own root without shelling out to locate a device", async () => {
    const filesystem = new MemoryFilesystem();
    const runner = new ScriptedProcessRunner([
      { match: simctl("shutdown", driverData.udid) },
      { match: simctl("erase", driverData.udid) },
    ]);
    const driver = await createDriver(runner, new FakeClock(), filesystem);
    await filesystem.mkdirp(dataPath);

    await driver.reclaim(
      { address: driverData.udid, deviceId: driverData.udid, driverData },
      { clean: "full" },
    );

    // Owning the set means the data container's path is known, so `reclaim` -- which runs
    // on every release -- never pays for the `simctl list` it used to need to find it.
    expect(runner.calls.map((call) => call.args)).toEqual([
      simctlArgs("shutdown", driverData.udid),
      simctlArgs("erase", driverData.udid),
    ]);
    expect(await filesystem.exists(erasableMarkPath)).toBe(true);
    expect(await filesystem.exists(durableMarkPath)).toBe(true);
  });

  it("reports matching provenance tokens for a healthy managed device", async () => {
    const filesystem = new MemoryFilesystem();
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const driver = await createDriver(runner, new FakeClock(), filesystem);
    await filesystem.mkdirp(dataPath);
    await filesystem.writeFileAtomic(durableMarkPath, JSON.stringify({ token: "tok-1" }));
    await filesystem.writeFileAtomic(erasableMarkPath, JSON.stringify({ token: "tok-1" }));

    const reality = await driver.listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({
        mark: { durable: "tok-1", erasable: "tok-1", erasableReadable: true },
      }),
    ]);
  });

  it("reports erasable undefined when the data-container mark is gone (foreign erase)", async () => {
    const filesystem = new MemoryFilesystem();
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const driver = await createDriver(runner, new FakeClock(), filesystem);
    await filesystem.mkdirp(dataPath);
    await filesystem.writeFileAtomic(durableMarkPath, JSON.stringify({ token: "tok-1" }));

    const reality = await driver.listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({
        mark: { durable: "tok-1", erasable: undefined, erasableReadable: true },
      }),
    ]);
  });

  it("reports mark undefined when both provenance regions are absent (pre-upgrade device)", async () => {
    const filesystem = new MemoryFilesystem();
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const driver = await createDriver(runner, new FakeClock(), filesystem);
    await filesystem.mkdirp(dataPath);

    const reality = await driver.listManaged();

    expect(reality.devices[0]?.mark).toBeUndefined();
  });

  it("reads a corrupt mark file as undefined without throwing", async () => {
    const filesystem = new MemoryFilesystem();
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const driver = await createDriver(runner, new FakeClock(), filesystem);
    await filesystem.mkdirp(dataPath);
    await filesystem.writeFileAtomic(durableMarkPath, "not json");
    await filesystem.writeFileAtomic(erasableMarkPath, JSON.stringify({ notAToken: true }));

    const reality = await driver.listManaged();

    expect(reality.devices[0]?.mark).toBeUndefined();
  });

  it("creates and marks its device root under SIMLOCK_HOME when none is configured", async () => {
    const filesystem = new MemoryFilesystem();

    const driver = await IosSimctlDriver.create({
      clock: new FakeClock(),
      driverConfig: {},
      filesystem,
      idGenerator: { generate: () => "device-1" },
      instanceId,
      processRunner: new ScriptedProcessRunner([]),
      simlockHome: "/home/.simlock",
    });

    expect(driver.deviceRoot).toBe("/home/.simlock/devices/ios");
    await expect(
      filesystem.exists(`/home/.simlock/devices/ios/${OWNED_ROOT_MARKER_FILE}`),
    ).resolves.toBe(true);
  });

  it("does not start when its device root belongs to another Simlock instance", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(deviceRoot);
    await filesystem.writeFileAtomic(
      `${deviceRoot}/${OWNED_ROOT_MARKER_FILE}`,
      JSON.stringify({
        instanceId: "someone-else",
        owner: "simlock",
        platform: "ios",
        schemaVersion: 1,
      }),
    );

    const failure = await createDriver(new ScriptedProcessRunner([]), new FakeClock(), filesystem)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Fails closed: no fallback to the machine's default device set (safety rule 9).
    expect(failure).toBeInstanceOf(OwnedRootError);
    expect(failure).toMatchObject({ platform: "ios", reason: "wrong-instance" });
  });

  it("does not start when the configured device root is not a path at all", async () => {
    await expect(
      IosSimctlDriver.create({
        clock: new FakeClock(),
        driverConfig: { deviceRoot: 42 },
        filesystem: new MemoryFilesystem(),
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: new ScriptedProcessRunner([]),
        simlockHome: "/home/.simlock",
      }),
    ).rejects.toBeInstanceOf(DriverCrashError);
  });

  it("hands a lease holder the device set its simulator cannot be addressed without", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(driver.leaseEnvironment()).toEqual({ SIMLOCK_IOS_DEVICE_SET: deviceRoot });
  });

  it.skipIf(process.env.SIMLOCK_LIVE_IOS !== "1")(
    "runs a provision-to-destroy smoke test against simctl",
    async () => {
      const driver = await IosSimctlDriver.create({
        clock: new SystemClock(),
        driverConfig: {},
        filesystem: new NodeFilesystem(),
        idGenerator: { generate: () => `test-${process.pid}` },
        instanceId: `live-${process.pid}`,
        processRunner: new NodeProcessRunner(),
        simlockHome: join(tmpdir(), `simlock-live-ios-${process.pid}`),
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
): Promise<IosSimctlDriver> {
  return IosSimctlDriver.create({
    clock,
    driverConfig: { deviceRoot },
    filesystem,
    idGenerator: { generate: () => "device-1" },
    instanceId,
    processRunner: runner,
    simlockHome: "/home/.simlock",
  });
}

/**
 * `#idGenerator.generate()` is called once while the root is being created, then names
 * the device, then mints a mark token per write -- so the second call must stay
 * "device-1" to match `driverData.name` while later ones vary, proving the reclaim token
 * differs from the provision token.
 */
function createTokenDriver(
  runner: ScriptedProcessRunner,
  filesystem: Filesystem,
): Promise<IosSimctlDriver> {
  let calls = 0;
  return IosSimctlDriver.create({
    clock: new FakeClock(),
    driverConfig: { deviceRoot },
    filesystem,
    idGenerator: {
      generate: () => {
        calls += 1;
        if (calls === 1) return "root-staging";
        return calls === 2 ? "device-1" : `tok-${String(calls)}`;
      },
    },
    instanceId,
    processRunner: runner,
    simlockHome: "/home/.simlock",
  });
}

async function readToken(filesystem: Filesystem, path: string): Promise<string> {
  return (JSON.parse(await filesystem.readFile(path)) as { readonly token: string }).token;
}

function scriptedListRunner(): ScriptedProcessRunner {
  return new ScriptedProcessRunner([
    {
      match: listInvocation,
      result: { code: 0, stderr: "", stdout: listFixture },
    },
  ]);
}
