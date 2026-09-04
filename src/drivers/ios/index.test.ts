import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BootTimeoutError,
  DriverCrashError,
  OwnedRootError,
  OWNED_ROOT_MARKER_FILE,
  PassthroughRefusedError,
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

/** Runners handed to a driver built by `createDriver`; drained by the invariant below. */
const scopedRunners: ScriptedProcessRunner[] = [];

/**
 * The one global invariant, asserted over everything every test in this file recorded
 * rather than per call site: scoping is what makes ownership provable, so a spawn that
 * reached `xcrun` without `simctl --set <root>` in front of it would address the machine's
 * default device set (safety rule 8). Per-test argv equality proves today's calls are
 * scoped; only this proves the next one added is, whether or not it goes through
 * `#invokeSimctl`.
 */
afterEach(() => {
  for (const call of scopedRunners.splice(0).flatMap((runner) => runner.calls)) {
    expect(call.command).toBe("xcrun");
    expect(call.args.slice(0, 3)).toEqual(["simctl", "--set", deviceRoot]);
  }
});

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
    // Handled up front so a failure below reports itself rather than surfacing as an
    // unhandled rejection in whichever test happens to run next.
    void ready.catch(() => undefined);

    await waitForCalls(runner, 2);
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

  it("leaves neither provenance mark when the erasable half cannot be written", async () => {
    const filesystem = new MemoryFilesystem();
    const runner = new ScriptedProcessRunner([
      { match: simctl("shutdown", driverData.udid) },
      { match: simctl("erase", driverData.udid) },
    ]);
    const driver = await createDriver(runner, new FakeClock(), filesystem);
    // The device directory exists, its data container does not, and `writeFileAtomic`
    // creates no parents -- the erasable write cannot land.
    await filesystem.mkdirp(`${deviceRoot}/${driverData.udid}`);

    await expect(
      driver.reclaim(
        { address: driverData.udid, deviceId: driverData.udid, driverData },
        { clean: "full" },
      ),
    ).rejects.toThrow();

    // A durable mark standing alone is exactly what `Doctor` reads as a foreign erase, so
    // a half-written pair would have `doctor` accusing the user of erasing the device
    // Simlock itself just erased. Neither half is what "never marked" looks like.
    expect(await filesystem.exists(durableMarkPath)).toBe(false);
    expect(await filesystem.exists(erasableMarkPath)).toBe(false);
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

  it("refuses the platform, not the daemon, when the configured device root is not a path", async () => {
    const failure = await IosSimctlDriver.create({
      clock: new FakeClock(),
      driverConfig: { deviceRoot: true },
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "device-1" },
      instanceId,
      processRunner: new ScriptedProcessRunner([]),
      simlockHome: "/home/.simlock",
    })
      .then(() => undefined)
      .catch((error: unknown) => error);

    // An `OwnedRootError` costs iOS alone; anything else takes the daemon down with it,
    // and with it every way of finding out why -- `"deviceRoot": true` and
    // `"deviceRoot": "devices/ios"` must not differ by that much.
    expect(failure).toBeInstanceOf(OwnedRootError);
    expect(failure).toMatchObject({ platform: "ios", reason: "not-absolute" });
    expect(failure).toMatchObject({ message: expect.stringContaining("true") });
  });

  it("hands a lease holder the device set its simulator cannot be addressed without", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(driver.leaseEnvironment()).toEqual({ SIMLOCK_IOS_DEVICE_SET: deviceRoot });
  });

  it("scopes a simctl passthrough to the device set the way its own calls are scoped", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(driver.passthrough(["install", "booted", "./MyApp.app"])).toEqual({
      args: ["simctl", "--set", deviceRoot, "install", "booted", "./MyApp.app"],
      command: "xcrun",
      env: {},
    });
  });

  it.each([["create"], ["erase"], ["delete"]])(
    "refuses to proxy %s, naming the command that reclaims a device properly",
    async (verb) => {
      const driver = await createDriver(new ScriptedProcessRunner([]));

      expect(() => driver.passthrough([verb, "ABCD"])).toThrow(PassthroughRefusedError);
      expect(() => driver.passthrough([verb, "ABCD"])).toThrow(/simlock release/);
      expect(() => driver.passthrough([verb, "ABCD"])).toThrow(/simlock cleanup/);
    },
  );

  it("finds the refused verb past a leading flag rather than only in first position", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(() => driver.passthrough(["--verbose", "delete", "ABCD"])).toThrow(
      PassthroughRefusedError,
    );
  });

  it("proxies a refused word that is an argument rather than the subcommand", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(driver.passthrough(["spawn", "booted", "log", "erase"]).args).toContain("erase");
  });

  it.each([
    [["--profiles", "/tmp", "erase", "all"]],
    [["--set", "/tmp", "delete", "all"]],
    [["--set=/tmp", "create", "sim"]],
  ])(
    "refuses a caller-supplied scoping flag rather than reading its value as the subcommand: %j",
    async (args) => {
      const driver = await createDriver(new ScriptedProcessRunner([]));

      // The bug this pins was not the flag itself: the flag's separated value was found as
      // the subcommand, so the refused verb behind it was never seen, and the wrapper
      // answered with `--set <simlockRoot>` prepended -- Simlock handing over the very path
      // that contains every other agent's devices.
      expect(() => driver.passthrough(args)).toThrow(PassthroughRefusedError);
      expect(() => driver.passthrough(args)).toThrow(/supplies the device set itself/);
    },
  );

  it("refuses to shut down every device in the set at once", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(() => driver.passthrough(["shutdown", "all"])).toThrow(PassthroughRefusedError);
    expect(() => driver.passthrough(["shutdown", "all"])).toThrow(/simlock release/);
  });

  it("still proxies shutting a single device down by udid", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(driver.passthrough(["shutdown", "ABCD"]).args).toEqual([
      "simctl",
      "--set",
      deviceRoot,
      "shutdown",
      "ABCD",
    ]);
  });

  it("refuses to delete a runtime it cannot download back", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(() => driver.passthrough(["runtime", "delete", "26.5"])).toThrow(
      PassthroughRefusedError,
    );
    expect(() => driver.passthrough(["runtime", "delete", "26.5"])).toThrow(/through Xcode/);
  });

  it("still proxies the runtime operations that only read", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(driver.passthrough(["runtime", "list"]).args).toContain("list");
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
  scopedRunners.push(runner);
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
  scopedRunners.push(runner);
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

/**
 * Bounded on purpose. An unexpected invocation makes `ScriptedProcessRunner.spawn` throw
 * synchronously, `#invokeSimctl` turns that into a `DriverCrashError`, and the call this
 * is waiting for never arrives -- an unbounded spin then hangs the whole suite instead of
 * reporting which argv the driver actually produced.
 */
async function waitForCalls(runner: ScriptedProcessRunner, count: number): Promise<void> {
  for (let tick = 0; tick < 1_000 && runner.calls.length < count; tick += 1) {
    await Promise.resolve();
  }

  expect(
    runner.calls.map((call) => call.args),
    `simctl never reached ${String(count)} calls`,
  ).toHaveLength(count);
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
