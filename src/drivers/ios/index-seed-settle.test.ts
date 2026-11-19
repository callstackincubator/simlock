import { describe, expect, it } from "vitest";
import { BootTimeoutError, DriverCrashError } from "../../core/index.js";
import {
  FakeClock,
  FakeProcessTable,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessEntry,
  type SqliteDatabase,
} from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import { plantReadySeed, plantSource, memorySourceDatabase } from "./testing.js";
import { IosSimctlDriver } from "./index.js";
import {
  deviceHubEdit,
  deviceRoot,
  driverData,
  instanceId,
  plantManagedDevice,
  simctl,
  waitForCalls,
} from "./test-slim.js";
import {
  createDriver,
  logsRoot,
  plantLaunchServices,
  seedUdid,
  sourcesSimctl,
} from "./test-index.js";

const sourcesSet = `${deviceRoot}/sources`;
const coreSimulatorRoot = "/CoreSim";
const lineageUdid = "AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB";
const copyUdid = "00000000-0000-0000-0000-0000000000cc";
const settledUdid = "00000000-0000-0000-0000-0000000000dd";
const otherUdid = "00000000-0000-0000-0000-0000000000ee";
const quickSourceId = `planted-${seedUdid}-${driverData.runtimeId}`;

/** why: a launchd_sim as `ps` prints it: the program, then the bootstrap file inside the simulator's own folder. */
function launchd(world: World, pid: number, udid: string): ProcessEntry {
  return {
    command: `/Runtimes/iOS.simruntime/usr/libexec/launchd_sim ${world.devicesDir}/${udid}/data/var/run/launchd_bootstrap.plist`,
    cpuSeconds: 1,
    pid,
    ppid: 1,
  };
}

/** why: the fake clock never moves by itself; the poll waits on a timer, so the test steps it until the settle ends. */
async function runToEnd<T>(
  settle: Promise<T>,
  clock: FakeClock,
  table: FakeProcessTable,
  processes: (nowMs: number) => readonly ProcessEntry[],
  ends: "fulfilled" | "rejected" = "fulfilled",
): Promise<void> {
  const state = promiseState(settle);
  for (let step = 0; step < 600 && state.state === "pending"; step += 1) {
    table.set(processes(clock.now()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (state.state === "pending") clock.advance(2_000);
  }
  expect(state.state, "the settle ended within 20 simulated minutes").toBe(ends);
}

function selectRows(database: SqliteDatabase): unknown[] {
  return database
    .prepare(
      "SELECT source_id, state, settled, lease_count, settle_of, udid, lineage FROM ios_source_data ORDER BY source_id",
    )
    .all();
}

interface World {
  readonly label: string;
  readonly config: Record<string, string>;
  readonly devicesDir: string;
  readonly sourcesSet: string;
  readonly isDefault: boolean;
}

const simlockWorld: World = {
  config: { deviceRoot },
  devicesDir: deviceRoot,
  isDefault: false,
  label: "simlock set",
  sourcesSet,
};

function simctlIn(world: World, set: string | undefined, ...args: readonly string[]) {
  const scoped = set ?? (world.isDefault ? undefined : world.devicesDir);
  return {
    args: scoped === undefined ? ["simctl", ...args] : ["simctl", "--set", scoped, ...args],
    command: "xcrun",
  };
}

interface SettleCase {
  readonly name: string;
  readonly world: World;
  /** why: the copy's own CPU by time; the other simulator's is always busy. */
  readonly copyCpu: (nowMs: number) => number;
  readonly reason: "idle" | "cap";
  readonly settledAfterMs: number;
}

const quiet = () => 3;
const settleCases: readonly SettleCase[] = [
  {
    copyCpu: quiet,
    name: "idle at 180 s",
    reason: "idle",
    settledAfterMs: 180_000,
    world: simlockWorld,
  },
  {
    copyCpu: (nowMs) => (Math.min(nowMs, 600_000) / 1_000) * 2,
    name: "busy until 600 s, idle once the last two minutes used under 0.15 cores, at 712 s",
    reason: "idle",
    settledAfterMs: 712_000,
    world: simlockWorld,
  },
  {
    copyCpu: (nowMs) => (nowMs / 1_000) * 2,
    name: "still busy at 900 s: saved all the same",
    reason: "cap",
    settledAfterMs: 900_000,
    world: simlockWorld,
  },
];

describe("IosSimctlDriver settleSeed", () => {
  it("replaces a quick seed with its settled copy: cloned as a provision clones, booted, read until idle, saved as the new seed, the quick seed deleted in its turn", async () => {
    for (const { name, world, copyCpu, reason, settledAfterMs } of settleCases) {
      const hub = (command: string) =>
        world.isDefault ? deviceHubEdit(command).map((match) => ({ match })) : [];
      const inSet = (...args: string[]) => simctlIn(world, undefined, ...args);
      const inSources = (...args: string[]) => simctlIn(world, world.sourcesSet, ...args);
      const database = plantReadySeed(await memorySourceDatabase(), {
        deviceTypeId: driverData.deviceTypeId,
        lineage: [lineageUdid],
        runtimeId: driverData.runtimeId,
        udid: seedUdid,
      });
      const filesystem = new MemoryFilesystem();
      if (!world.isDefault) await plantManagedDevice(filesystem);
      await plantLaunchServices(filesystem, `${world.devicesDir}/${copyUdid}`);
      await plantLaunchServices(filesystem, `${world.sourcesSet}/${settledUdid}`);
      await filesystem.writeFileAtomic(`${world.sourcesSet}/${settledUdid}/data/state`, "12345");
      await filesystem.mkdirp(`${logsRoot}/${copyUdid}`);
      const rowsAtBoot: unknown[] = [];
      const rowsAtOldDelete: unknown[] = [];
      const markedAtBoot: Promise<boolean>[] = [];
      const runner = new ScriptedProcessRunner([
        {
          match: inSources("clone", seedUdid, "simlock-device-1", world.devicesDir),
          result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
        },
        ...hub(`Set :DevicePreferences:${copyUdid}:pasteboardSyncEnabled false`),
        {
          match: inSet("boot", copyUdid),
          onSpawn: () => {
            rowsAtBoot.push(...selectRows(database));
            markedAtBoot.push(
              filesystem.exists(`${world.devicesDir}/${copyUdid}/simlock-mark.json`),
            );
          },
        },
        { match: inSet("bootstatus", copyUdid, "-b") },
        { match: inSet("listapps", copyUdid) },
        { match: inSet("shutdown", copyUdid) },
        {
          match: inSet("clone", copyUdid, "simlock-seed-device-1", world.sourcesSet),
          result: { code: 0, stderr: "", stdout: `${settledUdid}\n` },
        },
        {
          match: inSources("shutdown", seedUdid),
          onSpawn: () => void rowsAtOldDelete.push(...selectRows(database)),
        },
        { match: inSources("delete", seedUdid) },
        { match: inSet("delete", copyUdid) },
        ...hub(`Delete :DevicePreferences:${copyUdid}`),
      ]);
      const clock = new FakeClock();
      const table = new FakeProcessTable();
      const driver = await IosSimctlDriver.create({
        clock,
        coreSimulatorRoot,
        database,
        driverConfig: world.config,
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        logsRoot,
        processRunner: runner,
        processTable: table,
        simlockHome: "/home/.simlock",
      });
      const settle = driver.settleSeed?.(quickSourceId, { signal: new AbortController().signal });
      expect(settle, "an iOS driver given a process table settles seeds").toBeDefined();

      await runToEnd(settle as Promise<unknown>, clock, table, (nowMs) => [
        launchd(world, 100, copyUdid),
        { command: "backboardd", cpuSeconds: copyCpu(nowMs), pid: 101, ppid: 100 },
        { ...launchd(world, 200, otherUdid), cpuSeconds: (nowMs / 1_000) * 4 },
      ]);

      const label = `${world.label}, ${name}`;
      await expect(settle, label).resolves.toEqual({
        reason,
        settledAfterMs,
        sizeBytes: 5,
        sourceId: "device-1",
      });
      expect(
        rowsAtBoot,
        `${label}: while the copy boots the quick seed is still the ready seed`,
      ).toEqual([
        {
          lease_count: 0,
          lineage: null,
          settle_of: quickSourceId,
          settled: 0,
          source_id: "device-1",
          state: "making",
          udid: null,
        },
        {
          lease_count: 0,
          lineage: JSON.stringify([lineageUdid]),
          settle_of: null,
          settled: 0,
          source_id: quickSourceId,
          state: "ready",
          udid: seedUdid,
        },
      ]);
      expect(
        rowsAtOldDelete,
        `${label}: the swap is one step: the new seed is ready, the old one retired`,
      ).toEqual([
        {
          lease_count: 0,
          lineage: JSON.stringify([copyUdid.toUpperCase(), lineageUdid]),
          settle_of: null,
          settled: 1,
          source_id: "device-1",
          state: "ready",
          udid: settledUdid,
        },
        {
          lease_count: 0,
          lineage: JSON.stringify([lineageUdid]),
          settle_of: "device-1",
          settled: 0,
          source_id: quickSourceId,
          state: "making",
          udid: seedUdid,
        },
      ]);
      expect(selectRows(database).map((row) => (row as { source_id: string }).source_id)).toEqual([
        "device-1",
      ]);
      expect(
        await Promise.all(markedAtBoot),
        `${label}: the copy is marked before it boots`,
      ).toEqual([true]);
      expect(
        await filesystem.exists(
          `${world.devicesDir}/${copyUdid}/data/var/db/lsd/com.apple.LaunchServices-33554481-v2.csstore`,
        ),
        `${label}: the copy's LaunchServices database was dropped before its boot`,
      ).toBe(false);
      expect(
        await filesystem.exists(
          `${world.sourcesSet}/${settledUdid}/data/var/db/lsd/com.apple.LaunchServices-33554481-v2.csstore`,
        ),
        `${label}: the new seed's LaunchServices database was dropped`,
      ).toBe(false);
      expect(
        await filesystem.exists(`${logsRoot}/${copyUdid}`),
        `${label}: the copy's log folder is deleted`,
      ).toBe(false);
    }
  });

  it("a settle that does not finish, or is asked of a source that is no ready quick seed, throws and leaves the rows and the quick seed as they were, with no copy", async () => {
    class Stopped extends Error {}
    const quick = {
      deviceTypeId: driverData.deviceTypeId,
      lineage: [lineageUdid],
      runtimeId: driverData.runtimeId,
      udid: seedUdid,
    };
    const cloneCopy = {
      match: sourcesSimctl("clone", seedUdid, "simlock-device-1", deviceRoot),
      result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
    };
    const booted = [
      cloneCopy,
      { match: simctl("boot", copyUdid) },
      { match: simctl("bootstatus", copyUdid, "-b") },
      { match: simctl("listapps", copyUdid) },
    ];
    const copyDeleted = [
      { match: simctl("shutdown", copyUdid) },
      { match: simctl("delete", copyUdid) },
    ];
    const cases = [
      {
        name: "the boot times out",
        script: [cloneCopy, { hangs: true, match: simctl("boot", copyUdid) }, ...copyDeleted],
        run: async ({ runner, clock }: Context) => {
          await waitForCalls(runner, 2);
          clock.advance(300_000);
        },
        rejects: BootTimeoutError,
      },
      {
        name: "it is aborted while the copy is being read",
        script: [...booted, ...copyDeleted],
        run: async ({ runner, clock, controller }: Context) => {
          await waitForCalls(runner, 4);
          await new Promise<void>((resolve) => setImmediate(resolve));
          controller.abort(new Stopped("daemon stopping"));
          clock.advance(2_000);
        },
        rejects: Stopped,
      },
      ...[
        { name: "the id names no source", planted: undefined },
        { name: "it is a baseline", planted: { ...quick, kind: "baseline" as const } },
        { name: "it is a seed still being made", planted: { ...quick, state: "making" as const } },
        { name: "it is settled already", planted: { ...quick, settled: true } },
      ].map(({ name, planted }) => ({
        name,
        planted,
        script: [],
        run: async () => {},
        rejects: DriverCrashError,
      })),
    ];
    for (const { name, script, run, rejects, ...rest } of cases) {
      const planted = "planted" in rest ? rest.planted : quick;
      const database = await memorySourceDatabase();
      if (planted !== undefined) plantSource(database, planted);
      const before = selectRows(database);
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await plantLaunchServices(filesystem, `${deviceRoot}/${copyUdid}`);
      await filesystem.mkdirp(`${logsRoot}/${copyUdid}`);
      const runner = new ScriptedProcessRunner(script);
      const clock = new FakeClock();
      const driver = await createDriver(runner, clock, filesystem, database, undefined, undefined, {
        logsRoot,
        processTable: new FakeProcessTable(),
      });
      const controller = new AbortController();
      const sourceId =
        planted === undefined ? "no-such-source" : `planted-${planted.udid}-${planted.runtimeId}`;
      const settle = driver.settleSeed?.(sourceId, { signal: controller.signal });

      const state = promiseState(settle as Promise<unknown>);
      await run({ runner, clock, controller });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(state.state, `${name}: the settle ended`).toBe("rejected");
      await expect(settle, name).rejects.toBeInstanceOf(rejects);
      expect(selectRows(database), `${name}: the rows are as they were`).toEqual(before);
      expect(
        runner.calls.map((call) => call.args.join(" ")),
        `${name}: the copy is deleted`,
      ).toEqual(script.map((step) => step.match.args.join(" ")));
      expect(
        await filesystem.exists(`${logsRoot}/${copyUdid}`),
        `${name}: the copy's log folder is deleted`,
      ).toBe(script.length === 0);
    }
  });
});

interface Context {
  readonly runner: ScriptedProcessRunner;
  readonly clock: FakeClock;
  readonly controller: AbortController;
}
