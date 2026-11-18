import { readFileSync } from "node:fs";
import { afterEach, expect, it, describe } from "vitest";
import { OWNED_ROOT_MARKER_FILE, OwnedRootError } from "../../core/index.js";
import { ScriptedProcessRunner, MemoryFilesystem, FakeClock } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import {
  deviceRoot,
  sourcesSetPath,
  driverData,
  dataPath,
  plantManagedDevice,
  instanceId,
} from "./test-slim.js";
import {
  PHYSICAL_DEVICE,
  UNSCOPED_LEGACY_CALLS,
  createDriver,
  deviceListResponse,
  legacyUdid,
  listDevicesInvocation,
  listFixture,
  listInvocation,
  scopedRunners,
  scriptedListRunner,
  seedUdid,
  seededDatabase,
  sourcesSimctl,
  spec,
} from "./test-index.js";

const listDevicesFixture = readFileSync(
  new URL("./fixtures/simctl-list-devices.json", import.meta.url),
  "utf8",
);

const durableMarkPath = `${deviceRoot}/${driverData.udid}/simlock-mark.json`;

const erasableMarkPath = `${dataPath}/simlock-mark.json`;

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
    expect([deviceRoot, sourcesSetPath]).toContain(call.args[2]);
  }
});

describe("IosSimctlDriver", () => {
  it("shells out to simctl exactly once per listCatalog call", async () => {
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

    // why: The fixture's last device carries no `simlock-` prefix. Membership in the set is the
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

  it("leaves neither provenance mark when the erasable half cannot be written", async () => {
    const filesystem = new MemoryFilesystem();
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
    ]);
    const driver = await createDriver(runner, new FakeClock(), filesystem, await seededDatabase());
    // why: The device directory exists, its data container does not, and `writeFileAtomic`
    // creates no parents -- the erasable write cannot land.
    await filesystem.mkdirp(`${deviceRoot}/${driverData.udid}`);
    await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });

    await expect(driver.provision(spec)).rejects.toThrow(
      `ENOENT: no such file or directory, open '${dataPath}'`,
    );

    // why: A durable mark standing alone is exactly what `Doctor` reads as a foreign erase, so
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
    await plantManagedDevice(filesystem);
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
    await plantManagedDevice(filesystem);
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
    await plantManagedDevice(filesystem);

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
    await plantManagedDevice(filesystem);
    await filesystem.writeFileAtomic(durableMarkPath, "not json");
    await filesystem.writeFileAtomic(erasableMarkPath, JSON.stringify({ notAToken: true }));

    const reality = await driver.listManaged();

    expect(reality.devices[0]?.mark).toBeUndefined();
  });

  it("creates and marks its device root under SIMLOCK_HOME when none is configured", async () => {
    const filesystem = new MemoryFilesystem();

    const driver = await IosSimctlDriver.create({
      database: await memorySourceDatabase(),
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

    // why: Fails closed: no fallback to the machine's default device set (safety rule 9).
    expect(failure).toBeInstanceOf(OwnedRootError);
    expect(failure).toMatchObject({ platform: "ios", reason: "wrong-instance" });
  });

  it("refuses the platform, not the daemon, when the configured device root is not a path", async () => {
    const failure = await IosSimctlDriver.create({
      database: await memorySourceDatabase(),
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

    // why: An `OwnedRootError` costs iOS alone; anything else takes the daemon down with it,
    // and with it every way of finding out why -- `"deviceRoot": true` and
    // `"deviceRoot": "devices/ios"` must not differ by that much.
    expect(failure).toBeInstanceOf(OwnedRootError);
    expect(failure).toMatchObject({ platform: "ios", reason: "not-absolute" });
    expect(failure).toMatchObject({ message: expect.stringContaining("true") });
  });

  it("re-proves an intact root by re-running the validation its start was judged by", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    await expect(driver.revalidateRoot()).resolves.toBeUndefined();
  });

  it("refuses to re-prove a root that has become a symlink since startup", async () => {
    const filesystem = new MemoryFilesystem();
    const driver = await createDriver(new ScriptedProcessRunner([]), new FakeClock(), filesystem);
    // why: The case the re-proof exists for: ownership was proven at startup and the path has
    // been swapped since, so `listManaged` now answers from somewhere else entirely.
    filesystem.defineSymlink(deviceRoot, "/Users/someone/Library/Developer/CoreSimulator/Devices");

    const failure = await driver
      .revalidateRoot()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OwnedRootError);
    expect(failure).toMatchObject({ platform: "ios", reason: "symlink" });
  });

  it("finds a pre-root device in the machine's default set, without --set", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["simctl", "list", "-j", "devices"], command: "xcrun" },
        result: {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                {
                  dataPath: `/Library/Devices/${legacyUdid}/data`,
                  name: "simlock-old",
                  state: "Shutdown",
                  udid: legacyUdid,
                },
              ],
            },
          }),
        },
      },
    ]);
    const driver = await createDriver(runner);

    await expect(driver.findLegacy(legacyUdid)).resolves.toMatchObject({
      device: { deviceId: legacyUdid },
      path: `/Library/Devices/${legacyUdid}`,
    });
  });

  it("reports no pre-root device when the default set does not hold the udid", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["simctl", "list", "-j", "devices"], command: "xcrun" },
        result: { code: 0, stderr: "", stdout: JSON.stringify({ devices: {} }) },
      },
    ]);
    const driver = await createDriver(runner);

    await expect(driver.findLegacy(legacyUdid)).resolves.toBeUndefined();
  });

  it("destroys a pre-root device through the unscoped path it actually lives on", async () => {
    const runner = new ScriptedProcessRunner([
      { match: { args: ["simctl", "shutdown", legacyUdid], command: "xcrun" } },
      { match: { args: ["simctl", "delete", legacyUdid], command: "xcrun" } },
    ]);
    const driver = await createDriver(runner);

    await driver.destroyLegacy({
      address: legacyUdid,
      deviceId: legacyUdid,
      driverData: { ...driverData, udid: legacyUdid },
    });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "shutdown", legacyUdid],
      ["simctl", "delete", legacyUdid],
    ]);
  });

  it("answers uninstall for the reclaim strategy of a physical device", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(driver.reclaimStrategy(PHYSICAL_DEVICE, { clean: "standard" })).toBe("uninstall");
    expect(driver.reclaimStrategy(PHYSICAL_DEVICE, { clean: "full" })).toBe("uninstall");
  });
});
