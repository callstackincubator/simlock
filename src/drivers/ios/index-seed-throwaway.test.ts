import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import {
  deviceHubEdit,
  deviceRoot,
  driverData,
  instanceId,
  plantManagedDevice,
} from "./test-slim.js";
import {
  listFixture,
  logsRoot,
  scopedRunners,
  seedUdid,
  spec,
  throwawayUdid,
} from "./test-index.js";

afterEach(() => {
  scopedRunners.length = 0;
});

const copyUdid = "00000000-0000-0000-0000-000000000002";
const name = "simlock-seed-device-1";
const coreSimulatorRoot = "/CoreSim";

interface World {
  readonly label: string;
  readonly config: Record<string, string>;
  readonly devicesDir: string;
  readonly sourcesSet: string;
  readonly isDefault: boolean;
}

const worlds: readonly World[] = [
  {
    config: { deviceRoot },
    devicesDir: deviceRoot,
    isDefault: false,
    label: "simlock set",
    sourcesSet: `${deviceRoot}/sources`,
  },
  {
    config: { deviceSet: "default" },
    devicesDir: `${coreSimulatorRoot}/Devices`,
    isDefault: true,
    label: "default set",
    sourcesSet: "/home/.simlock/devices/ios-sources",
  },
];

function simctlIn(world: World, set: string | undefined, ...args: readonly string[]) {
  const scoped = set ?? (world.isDefault ? undefined : world.devicesDir);
  return {
    args: scoped === undefined ? ["simctl", ...args] : ["simctl", "--set", scoped, ...args],
    command: "xcrun",
  };
}

describe("IosSimctlDriver seed throwaway", () => {
  it("the first provision of a kind makes its seed from a throwaway", async () => {
    for (const world of worlds) {
      const step = (match: { command: string; args: readonly string[] }, stdout?: string) => ({
        match,
        ...(stdout === undefined ? {} : { result: { code: 0, stderr: "", stdout } }),
      });
      const inSet = (...args: string[]) => simctlIn(world, undefined, ...args);
      const hub = (command: string) =>
        world.isDefault ? deviceHubEdit(command).map((match) => ({ match })) : [];
      const database = await memorySourceDatabase();
      const markedAtBoot: Promise<boolean>[] = [];
      const filesystem = new MemoryFilesystem();
      const runner = new ScriptedProcessRunner([
        step(
          world.isDefault
            ? { args: ["simctl", "list", "-j", "devicetypes", "runtimes"], command: "xcrun" }
            : inSet("list", "-j", "devicetypes", "runtimes"),
          listFixture,
        ),
        step(
          inSet("create", name, driverData.deviceTypeId, driverData.runtimeId),
          `${throwawayUdid}\n`,
        ),
        ...hub(`Set :DevicePreferences:${throwawayUdid}:pasteboardSyncEnabled false`),
        {
          match: inSet("boot", throwawayUdid),
          onSpawn: () => {
            markedAtBoot.push(
              filesystem.exists(`${world.devicesDir}/${throwawayUdid}/simlock-mark.json`),
            );
          },
        },
        step(inSet("bootstatus", throwawayUdid, "-b")),
        step(inSet("listapps", throwawayUdid)),
        step(inSet("shutdown", throwawayUdid)),
        step(inSet("clone", throwawayUdid, name, world.sourcesSet), `${seedUdid}\n`),
        step(inSet("delete", throwawayUdid)),
        ...hub(`Delete :DevicePreferences:${throwawayUdid}`),
        step(
          simctlIn(world, world.sourcesSet, "clone", seedUdid, driverData.name, world.devicesDir),
          `${copyUdid}\n`,
        ),
      ]);
      scopedRunners.push(runner);
      if (!world.isDefault) await plantManagedDevice(filesystem);
      await filesystem.mkdirp(`${world.devicesDir}/${throwawayUdid}/data`);
      await filesystem.mkdirp(`${world.devicesDir}/${copyUdid}/data`);
      await filesystem.mkdirp(`${logsRoot}/${throwawayUdid}`);
      const driver = await IosSimctlDriver.create({
        clock: new FakeClock(),
        coreSimulatorRoot,
        database,
        driverConfig: world.config,
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        logsRoot,
        processRunner: runner,
        simlockHome: "/home/.simlock",
      });

      await expect(driver.provision(spec), world.label).resolves.toMatchObject({
        deviceId: copyUdid,
      });

      expect(await Promise.all(markedAtBoot), world.label).toEqual([world.isDefault]);
      expect(
        database.prepare("SELECT state, udid, throwaway_udid FROM ios_source_data").all(),
        world.label,
      ).toEqual([{ state: "ready", throwaway_udid: throwawayUdid, udid: seedUdid }]);
      await expect(filesystem.exists(`${logsRoot}/${throwawayUdid}`), world.label).resolves.toBe(
        false,
      );
    }
  });
});
