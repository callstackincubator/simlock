import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase, plantSource } from "./testing.js";
import {
  deviceHubEdit,
  deviceRoot,
  sourcesSetPath,
  driverData,
  instanceId,
  plantManagedDevice,
  simctl,
  unownedSourcesSet,
} from "./test-slim.js";
import {
  RecordingLogger,
  listFixture,
  logsRoot,
  scopedRunners,
  listInvocation,
  plantSeedClone,
  seedUdid,
  sourcesSimctl,
  spec,
  throwawaySeedSteps,
  throwawayUdid,
} from "./test-index.js";

afterEach(() => {
  scopedRunners.length = 0;
});

class BrokenLogRemoval extends MemoryFilesystem {
  override async rm(path: string): Promise<void> {
    if (path.startsWith(logsRoot)) throw new Error("denied");
    await super.rm(path);
  }
}

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
    sourcesSet: sourcesSetPath,
  },
  {
    config: { deviceSet: "default" },
    devicesDir: join(coreSimulatorRoot, "Devices"),
    isDefault: true,
    label: "default set",
    sourcesSet: unownedSourcesSet,
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
        {
          ...step(inSet("clone", throwawayUdid, name, world.sourcesSet), `${seedUdid}\n`),
          onSpawn: () => {
            void filesystem.mkdirp(`${world.sourcesSet}/${seedUdid}`);
          },
        },
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
      await filesystem.mkdirp(join(logsRoot, throwawayUdid));
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
      await expect(filesystem.exists(join(logsRoot, throwawayUdid)), world.label).resolves.toBe(
        false,
      );
    }

    const whole = throwawaySeedSteps();
    const [create, boot, bootstatus, listapps, shutdown, clone, remove] = whole;
    const failed = { code: 1, stderr: "boom", stdout: "" };
    const copy = {
      match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
      result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
    };
    const failures = [
      ...["", "../.."].map((printed) => ({
        label: `create prints ${JSON.stringify(printed)}`,
        steps: [{ ...create, result: { code: 0, stderr: "", stdout: `${printed}\n` } }],
        error: /no device UDID/,
        rows: [],
        logFolder: true,
        warnings: [],
      })),
      {
        label: "boot fails",
        steps: [create, boot, { ...bootstatus, result: failed }, shutdown, remove],
        error: /did not boot/,
        rows: [],
        logFolder: false,
        warnings: [],
      },
      {
        label: "clone fails",
        steps: [
          create,
          boot,
          bootstatus,
          listapps,
          shutdown,
          { ...clone, result: failed },
          shutdown,
          remove,
        ],
        error: /boom/,
        rows: [],
        logFolder: false,
        warnings: [],
      },
      {
        label: "throwaway delete fails",
        steps: [
          create,
          boot,
          bootstatus,
          listapps,
          shutdown,
          clone,
          { ...remove, result: failed },
          { match: sourcesSimctl("shutdown", seedUdid) },
          { match: sourcesSimctl("delete", seedUdid) },
        ],
        error: /boom/,
        rows: [{ state: "making", throwaway_udid: throwawayUdid, udid: seedUdid }],
        logFolder: true,
        warnings: [],
      },
      {
        label: "log folder delete fails",
        steps: [...whole, copy],
        filesystem: new BrokenLogRemoval(),
        rows: [{ state: "ready", throwaway_udid: throwawayUdid, udid: seedUdid }],
        logFolder: true,
        warnings: [`could not delete log folder ${join(logsRoot, throwawayUdid)}: denied`],
      },
      {
        label: "log folder absent",
        steps: [...whole, copy],
        absent: true,
        rows: [{ state: "ready", throwaway_udid: throwawayUdid, udid: seedUdid }],
        logFolder: false,
        warnings: [],
      },
    ];
    for (const failure of failures) {
      const database = await memorySourceDatabase();
      const logger = new RecordingLogger();
      const filesystem = failure.filesystem ?? new MemoryFilesystem();
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        ...failure.steps,
      ]);
      scopedRunners.push(runner);
      await plantManagedDevice(filesystem);
      await plantSeedClone(filesystem);
      await filesystem.mkdirp(`${deviceRoot}/${copyUdid}/data`);
      if (failure.absent !== true) await filesystem.mkdirp(join(logsRoot, throwawayUdid));
      const driver = await IosSimctlDriver.create({
        clock: new FakeClock(),
        database,
        driverConfig: { deviceRoot },
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        logger,
        logsRoot,
        processRunner: runner,
        simlockHome: "/home/.simlock",
      });

      const outcome = await driver.provision(spec).then(
        () => undefined,
        (error: unknown) => error as Error,
      );

      if (failure.error === undefined) expect(outcome, failure.label).toBeUndefined();
      else expect(outcome?.message, failure.label).toMatch(failure.error);
      expect(
        database.prepare("SELECT state, udid, throwaway_udid FROM ios_source_data").all(),
        failure.label,
      ).toEqual(failure.rows);
      await expect(filesystem.exists(join(logsRoot, throwawayUdid)), failure.label).resolves.toBe(
        failure.logFolder,
      );
      expect(logger.warnings, failure.label).toEqual(failure.warnings);
      expect(runner.calls.length, failure.label).toBe(failure.steps.length + 1);
    }
  });

  it("listManaged leaves out a throwaway a making row names", async () => {
    const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
    const own = "00000000-0000-0000-0000-0000000000e1";
    const listed = JSON.stringify({
      devices: {
        [runtime]: [throwawayUdid, own].map((udid) => ({
          dataPath: `/x/${udid}/data`,
          name: udid,
          state: "Shutdown",
          udid,
        })),
      },
    });
    const cases = [
      { label: "simlock set, a making row", world: worlds[0]!, state: "making", left: [own] },
      { label: "default set, a making row", world: worlds[1]!, state: "making", left: [own] },
      {
        label: "simlock set, a ready row",
        world: worlds[0]!,
        state: "ready",
        left: [throwawayUdid, own],
      },
    ] as const;
    for (const { label, left, state, world } of cases) {
      const database = plantSource(await memorySourceDatabase(), {
        deviceTypeId: driverData.deviceTypeId,
        runtimeId: driverData.runtimeId,
        state,
        throwawayUdid,
        udid: seedUdid,
      });
      const filesystem = new MemoryFilesystem();
      if (!world.isDefault) await plantManagedDevice(filesystem);
      for (const udid of [throwawayUdid, own]) {
        await filesystem.mkdirp(`${world.devicesDir}/${udid}/data`);
        if (world.isDefault) {
          const mark = JSON.stringify({ instanceId, token: "t", udid });
          await filesystem.writeFileAtomic(`${world.devicesDir}/${udid}/simlock-mark.json`, mark);
          await filesystem.writeFileAtomic(
            `${world.devicesDir}/${udid}/data/simlock-mark.json`,
            mark,
          );
        }
      }
      const runner = new ScriptedProcessRunner([
        {
          match: simctlIn(world, undefined, "list", "-j", "devices"),
          result: { code: 0, stderr: "", stdout: listed },
        },
      ]);
      scopedRunners.push(runner);
      const driver = await IosSimctlDriver.create({
        clock: new FakeClock(),
        coreSimulatorRoot,
        database,
        driverConfig: world.config,
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: runner,
        simlockHome: "/home/.simlock",
      });

      const reality = await driver.listManaged();

      expect(reality.devices.map((device) => device.deviceId).sort(), label).toEqual(
        [...left].sort(),
      );
    }
  });

  it("a restart mid-make: the first source read deletes the throwaway, its log folder, the seed clone and the row", async () => {
    const invalid = { code: 1, stderr: `Invalid device: ${throwawayUdid}`, stdout: "" };
    const cases = [
      {
        label: "throwaway only",
        udid: undefined,
        steps: [
          { match: simctl("shutdown", throwawayUdid) },
          { match: simctl("delete", throwawayUdid) },
        ],
      },
      {
        label: "throwaway and seed",
        udid: seedUdid,
        steps: [
          { match: sourcesSimctl("shutdown", seedUdid) },
          { match: sourcesSimctl("delete", seedUdid) },
          { match: simctl("shutdown", throwawayUdid) },
          { match: simctl("delete", throwawayUdid) },
        ],
      },
      {
        label: "throwaway already gone",
        udid: undefined,
        steps: [
          { match: simctl("shutdown", throwawayUdid) },
          { match: simctl("delete", throwawayUdid), result: invalid },
        ],
      },
    ];
    for (const { label, steps, udid } of cases) {
      const database = plantSource(await memorySourceDatabase(), {
        deviceTypeId: driverData.deviceTypeId,
        runtimeId: driverData.runtimeId,
        state: "making",
        throwawayUdid,
        ...(udid === undefined ? {} : { udid }),
      });
      const runner = new ScriptedProcessRunner(steps);
      scopedRunners.push(runner);
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await filesystem.mkdirp(join(logsRoot, throwawayUdid));
      const driver = await IosSimctlDriver.create({
        clock: new FakeClock(),
        database,
        driverConfig: { deviceRoot },
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        logsRoot,
        processRunner: runner,
        simlockHome: "/home/.simlock",
      });

      await expect(driver.listSources(), label).resolves.toEqual([]);

      expect(runner.calls.length, label).toBe(steps.length);
      expect(database.prepare("SELECT COUNT(*) AS n FROM ios_source_data").get(), label).toEqual({
        n: 0,
      });
      await expect(filesystem.exists(join(logsRoot, throwawayUdid)), label).resolves.toBe(false);
    }
  });

  it("baseline.save deletes the saved-from lease's log folder", async () => {
    const baselineName = "simlock-baseline-device-1";
    const leaseLogs = join(logsRoot, driverData.udid);
    const clone = simctl("clone", driverData.udid, baselineName, sourcesSetPath);
    const cloneUdid = "00000000-0000-0000-0000-0000000000cc";
    const cases = [
      { label: "present", plant: true, clone: "ok", logs: false, warnings: [] },
      { label: "absent", plant: false, clone: "ok", logs: false, warnings: [] },
      {
        label: "delete fails",
        plant: true,
        clone: "ok",
        fs: new BrokenLogRemoval(),
        logs: true,
        warnings: [`could not delete log folder ${leaseLogs}: denied`],
      },
      { label: "clone fails", plant: true, clone: "fails", logs: true, warnings: [] },
    ] as const;
    for (const scenario of cases) {
      const database = await memorySourceDatabase();
      const logger = new RecordingLogger();
      const filesystem = "fs" in scenario ? scenario.fs : new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await filesystem.mkdirp(`${deviceRoot}/sources/${cloneUdid}`);
      if (scenario.plant) await filesystem.mkdirp(leaseLogs);
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        { match: simctl("shutdown", driverData.udid) },
        scenario.clone === "ok"
          ? { match: clone, result: { code: 0, stderr: "", stdout: `${cloneUdid}\n` } }
          : { match: clone, result: { code: 1, stderr: "no space", stdout: "" } },
      ]);
      scopedRunners.push(runner);
      const driver = await IosSimctlDriver.create({
        clock: new FakeClock(),
        database,
        driverConfig: { deviceRoot },
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        logger,
        logsRoot,
        processRunner: runner,
        simlockHome: "/home/.simlock",
      });

      const saved = await driver
        .saveSource({
          address: driverData.udid,
          deviceId: driverData.udid,
          driverData,
          physical: false,
        })
        .then(
          () => "saved",
          () => "failed",
        );

      expect(saved, scenario.label).toBe(scenario.clone === "ok" ? "saved" : "failed");
      await expect(filesystem.exists(leaseLogs), scenario.label).resolves.toBe(scenario.logs);
      expect(logger.warnings, scenario.label).toEqual(scenario.warnings);
    }
  });
});
