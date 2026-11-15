import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OwnedRootError, OWNED_ROOT_MARKER_FILE } from "../../core/index.js";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase, plantSource } from "./testing.js";
import { deviceRoot, driverData, instanceId, sourcesRoot } from "./test-slim.js";

const listFixture = readFileSync(new URL("./fixtures/simctl-list.json", import.meta.url), "utf8");
const spec = { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

describe("IosSimctlDriver sources folder", () => {
  const listInvocation = {
    args: ["simctl", "--set", deviceRoot, "list", "-j", "devicetypes", "runtimes"],
    command: "xcrun",
  };
  const simctlIn = (set: string, ...args: readonly string[]) => ({
    args: ["simctl", "--set", set, ...args],
    command: "xcrun",
  });

  it("makes the sources folder an owned root with a path as long as the device set's, under both settings", async () => {
    const xcodeSim = "/Users/al/Library/Developer/CoreSimulator";
    const cases = [
      {
        name: "simlock, default root",
        home: "/home/.simlock",
        config: {},
        devices: "/home/.simlock/devices/ios",
        sources: "/home/.simlock/devices/src",
      },
      {
        name: "simlock, configured deviceRoot that fits",
        home: "/home/.simlock",
        config: { deviceRoot: "/Volumes/simulators/devices" },
        devices: "/Volumes/simulators/devices",
        sources: "/home/.simlock/devices/src_",
      },
      {
        name: "default under the user's home",
        home: "/Users/al/.simlock",
        config: { deviceSet: "default" },
        devices: `${xcodeSim}/Devices`,
        sources: `/Users/al/.simlock/devices/src${"_".repeat(19)}`,
        madeBeforeCreate: true,
      },
      {
        name: "default with SIMLOCK_HOME on another volume",
        home: "/Volumes/Fast/simlock",
        config: { deviceSet: "default" },
        devices: `${xcodeSim}/Devices`,
        sources: `/Volumes/Fast/simlock/devices/src${"_".repeat(16)}`,
        madeBeforeCreate: true,
      },
      {
        name: "simlock with both under /private",
        home: "/private/tmp/h",
        config: {},
        devices: "/private/tmp/h/devices/ios",
        sources: "/private/tmp/h/devices/src",
      },
      {
        name: "default with Xcode's Devices not made yet",
        home: "/Users/al/.simlock",
        config: { deviceSet: "default" },
        devices: `${xcodeSim}/Devices`,
        sources: `/Users/al/.simlock/devices/src${"_".repeat(19)}`,
      },
    ] as const;
    const seed = "00000000-0000-0000-0000-0000000000aa";
    const copy = "00000000-0000-0000-0000-0000000000bb";

    for (const entry of cases) {
      const scoped = !("deviceSet" in entry.config);
      const step = (args: readonly (string | RegExp)[], stdout = "", anySet = true) => ({
        match: { args: ["simctl", ...(anySet ? ["--set", /.*/] : []), ...args], command: "xcrun" },
        result: { code: 0, stderr: "", stdout },
      });
      const runner = new ScriptedProcessRunner([
        step(["list", "-j", "devicetypes", "runtimes"], listFixture, scoped),
        step(
          ["create", "simlock-seed-device-1", driverData.deviceTypeId, driverData.runtimeId],
          `${seed}\n`,
        ),
        step(["boot", seed]),
        step(["bootstatus", seed, "-b"]),
        step(["listapps", seed]),
        step(["shutdown", seed]),
        step(["clone", seed, /^simlock-/, entry.devices], `${copy}\n`),
      ]);
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp(entry.home);
      if ("madeBeforeCreate" in entry) await filesystem.mkdirp(entry.devices);
      const driver = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        coreSimulatorRoot: xcodeSim,
        driverConfig: entry.config,
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: runner,
        simlockHome: entry.home,
      });
      await filesystem.mkdirp(`${entry.devices}/${copy}/data`);

      await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });
      await driver.provision(spec);

      const sourceSets = runner.calls.slice(1).map((call) => call.args[2]);
      expect(sourceSets, entry.name).toEqual(Array.from({ length: 6 }, () => entry.sources));
      expect(entry.sources.length, entry.name).toBe(entry.devices.length);
      await expect(
        filesystem.exists(`${entry.sources}/${OWNED_ROOT_MARKER_FILE}`),
        entry.name,
      ).resolves.toBe(true);
    }
  });

  it("refuses iOS with sources-path-unfit and one message per cause where no sources folder can have the device set's path length, and starts where one can", async () => {
    const xcodeSim = "/Users/al/Library/Developer/CoreSimulator";
    const xcodeDevices = `${xcodeSim}/Devices`;
    const longHome = "/Users/al/very-long-folder-name/ssssss";
    const cases = [
      {
        name: "default, home under /private (a)",
        home: "/private/tmp/h",
        config: { deviceSet: "default" },
        message: `Refusing the ios device set: /private/tmp/h is under /private, where iOS stores each path in two spellings, but Xcode's set ${xcodeDevices} is not. Set SIMLOCK_HOME to a folder outside /tmp and /var.`,
      },
      {
        name: "default, home too long (b)",
        home: longHome,
        config: { deviceSet: "default" },
        message: `Refusing the ios device set: the sources folder must have a path as long as ${xcodeDevices} (49 characters), but ${longHome}/devices/ leaves 2 characters for its name, fewer than 3. Set SIMLOCK_HOME to a folder whose real path is at most 37 characters.`,
      },
      {
        name: "simlock, deviceRoot too short (c)",
        home: "/home/.simlock",
        config: { deviceRoot: "/d" },
        message:
          "Refusing the ios device set: the sources folder must have a path as long as drivers.ios.deviceRoot /d (2 characters), but /home/.simlock/devices/ leaves 0 characters for its name, fewer than 3. Remove drivers.ios.deviceRoot, or set it to a path of at least 26 characters that is under /private only when SIMLOCK_HOME is.",
      },
      {
        name: "simlock, only the root under /private (c)",
        home: "/home/.simlock",
        config: { deviceRoot: "/private/tmp/simlock-devices" },
        message:
          "Refusing the ios device set: the sources folder must have a path as long as drivers.ios.deviceRoot /private/tmp/simlock-devices (28 characters), but only one of /private/tmp/simlock-devices and /home/.simlock is under /private. Remove drivers.ios.deviceRoot, or set it to a path of at least 26 characters that is under /private only when SIMLOCK_HOME is.",
      },
      {
        name: "default, home that fits",
        home: "/Users/al/.simlock",
        config: { deviceSet: "default" },
      },
    ] as const;

    for (const entry of cases) {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp(entry.home);
      const failure = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        coreSimulatorRoot: xcodeSim,
        driverConfig: entry.config,
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: new ScriptedProcessRunner([]),
        simlockHome: entry.home,
      })
        .then(() => undefined)
        .catch((error: unknown) => error);

      if ("message" in entry) {
        expect(failure, entry.name).toBeInstanceOf(OwnedRootError);
        expect(failure, entry.name).toMatchObject({
          message: entry.message,
          platform: "ios",
          reason: "sources-path-unfit",
        });
      } else {
        expect(failure, entry.name).toBeUndefined();
      }
    }
  });

  it("lists a baseline saved in another set as stale with the reason to save it again, one in the sources folder as fresh, and destroys the old one in its own set", async () => {
    const [old, fresh] = [
      "00000000-0000-0000-0000-0000000002a0",
      "00000000-0000-0000-0000-0000000002b0",
    ] as [string, string];
    const oldSet = "/home/.simlock/devices/ios-sources";
    const kind = { deviceTypeId: driverData.deviceTypeId, runtimeId: driverData.runtimeId };
    const database = await memorySourceDatabase();
    plantSource(database, { ...kind, kind: "baseline", setPath: oldSet, udid: old });
    plantSource(database, { ...kind, kind: "baseline", setPath: sourcesRoot, udid: fresh });
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { match: simctlIn(oldSet, "shutdown", old) },
      { match: simctlIn(oldSet, "delete", old) },
    ]);
    const driver = await IosSimctlDriver.create({
      database,
      clock: new FakeClock(),
      driverConfig: { deviceRoot },
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "device-1" },
      instanceId,
      processRunner: runner,
      simlockHome: "/home/.simlock",
    });

    const listed = await driver.listSources();

    expect(listed.map((source) => source.staleReason)).toEqual([
      `saved in ${oldSet}, which copies cannot be fixed from; save it again`,
      undefined,
    ]);
    const oldId = listed[0]?.id ?? "";
    await driver.destroySource(oldId);
    expect(runner.calls.slice(1).map((call) => [call.args[2], call.args[3]])).toEqual([
      [oldSet, "shutdown"],
      [oldSet, "delete"],
    ]);
  });
});
