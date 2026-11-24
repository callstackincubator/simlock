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
  deviceHubDisable,
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
  listFixture,
  listInvocation,
  logsRoot,
  plantLaunchServices,
  RecordingLogger,
  seedUdid,
  sourcesSimctl,
  spec,
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
  readsFail = false,
): Promise<void> {
  const state = promiseState(settle);
  for (let step = 0; step < 600 && state.state === "pending"; step += 1) {
    table.set(processes(clock.now()));
    if (readsFail) table.failNext(new Error("ps unavailable"));
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

const defaultWorld: World = {
  config: { deviceSet: "default" },
  devicesDir: `${coreSimulatorRoot}/Devices`,
  isDefault: true,
  label: "default set",
  sourcesSet: "/home/.simlock/devices/ios-sources",
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
  /** why: every read of the process table fails, so nothing is ever observed. */
  readonly readsFail?: boolean;
}

const quiet = () => 3;
function quietCase(name: string): Omit<SettleCase, "world"> {
  return { copyCpu: quiet, name, reason: "idle", settledAfterMs: 180_000 };
}
const settleCases: readonly SettleCase[] = [
  {
    copyCpu: quiet,
    name: "idle at 180 s",
    reason: "idle",
    settledAfterMs: 180_000,
    world: simlockWorld,
  },
  {
    ...quietCase("idle at 180 s, the copy marked and its clipboard sync off"),
    world: defaultWorld,
  },
  {
    copyCpu: (nowMs) => (Math.min(nowMs, 790_000) / 1_000) * 2,
    name: "busy until 790 s, so quiet enough only after the cap: saved at 900 s",
    reason: "cap",
    settledAfterMs: 900_000,
    world: simlockWorld,
  },
  {
    copyCpu: (nowMs) => (nowMs / 1_000) * 2,
    name: "still busy at 900 s: saved all the same",
    reason: "cap",
    settledAfterMs: 900_000,
    world: simlockWorld,
  },
  {
    copyCpu: quiet,
    name: "every process-table read fails: skipped, and the 900 s cap still ends the wait",
    reason: "cap",
    readsFail: true,
    settledAfterMs: 900_000,
    world: simlockWorld,
  },
];

describe("IosSimctlDriver settleSeed", () => {
  it("replaces a quick seed with its settled copy: cloned as a provision clones, booted, read until idle, saved as the new seed, the quick seed deleted in its turn", async () => {
    for (const { name, world, copyCpu, reason, settledAfterMs, readsFail } of settleCases) {
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
        ...(world.isDefault ? deviceHubDisable(copyUdid) : []),
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

      await runToEnd(
        settle as Promise<unknown>,
        clock,
        table,
        (nowMs) => [
          launchd(world, 100, copyUdid),
          { command: "backboardd", cpuSeconds: copyCpu(nowMs), pid: 101, ppid: 100 },
          { ...launchd(world, 200, otherUdid), cpuSeconds: (nowMs / 1_000) * 4 },
        ],
        "fulfilled",
        readsFail,
      );

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

  it("a settle deletes the quick seed only after a clone of it still in flight has ended", async () => {
    const database = plantReadySeed(await memorySourceDatabase(), {
      deviceTypeId: driverData.deviceTypeId,
      lineage: [lineageUdid],
      runtimeId: driverData.runtimeId,
      udid: seedUdid,
    });
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    await plantLaunchServices(filesystem, `${deviceRoot}/${copyUdid}`);
    await plantLaunchServices(filesystem, `${sourcesSet}/${settledUdid}`);
    const clock = new FakeClock();
    const clockAtOldDelete: number[] = [];
    const cloneSeed = sourcesSimctl("clone", seedUdid, "simlock-device-1", deviceRoot);
    const runner = new ScriptedProcessRunner([
      { match: cloneSeed, result: { code: 0, stderr: "", stdout: `${copyUdid}\n` } },
      { match: simctl("boot", copyUdid) },
      { match: simctl("bootstatus", copyUdid, "-b") },
      { match: simctl("listapps", copyUdid) },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { hangs: true, match: cloneSeed },
      { match: simctl("shutdown", copyUdid) },
      {
        match: simctl("clone", copyUdid, "simlock-seed-device-1", sourcesSet),
        result: { code: 0, stderr: "", stdout: `${settledUdid}\n` },
      },
      {
        match: sourcesSimctl("shutdown", seedUdid),
        onSpawn: () => void clockAtOldDelete.push(clock.now()),
      },
      { match: sourcesSimctl("delete", seedUdid) },
      { match: simctl("delete", copyUdid) },
    ]);
    const table = new FakeProcessTable();
    const driver = await createDriver(runner, clock, filesystem, database, undefined, undefined, {
      logsRoot,
      processTable: table,
    });
    const settle = driver.settleSeed?.(quickSourceId, { signal: new AbortController().signal });
    let lease: Promise<unknown> = Promise.resolve();

    await runToEnd(settle as Promise<unknown>, clock, table, (nowMs) => {
      // why: ten seconds in, a lease's clone of the quick seed starts, hangs, and is given up at its limit.
      if (nowMs === 10_000) lease = driver.provision(spec).catch(() => undefined);
      return [launchd(simlockWorld, 100, copyUdid)];
    });

    await lease;
    await expect(settle).resolves.toMatchObject({ reason: "idle", settledAfterMs: 180_000 });
    expect(
      clockAtOldDelete,
      "the quick seed was not deleted until the hung clone's process had been killed, 5 min after its 30 s limit",
    ).toEqual([340_000]);
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
          clock.advance(299_999);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(runner.calls, "the boot still has its last millisecond").toHaveLength(2);
          clock.advance(1);
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

  it("a settle that cannot delete a simulator it made keeps a making row naming it, and the next start's sweep deletes it", async () => {
    class Stopped extends Error {}
    const failed = { code: 1, stderr: "busy", stdout: "" };
    const clonedCopy = {
      match: sourcesSimctl("clone", seedUdid, "simlock-device-1", deviceRoot),
      result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
    };
    const booted = [
      clonedCopy,
      { match: simctl("boot", copyUdid) },
      { match: simctl("bootstatus", copyUdid, "-b") },
      { match: simctl("listapps", copyUdid) },
    ];
    const toSwap = [
      ...booted,
      { match: simctl("shutdown", copyUdid) },
      {
        match: simctl("clone", copyUdid, "simlock-seed-device-1", sourcesSet),
        result: { code: 0, stderr: "", stdout: `${settledUdid}\n` },
      },
      { match: sourcesSimctl("shutdown", seedUdid) },
    ];
    const quickRow = {
      source_id: quickSourceId,
      state: "ready",
      udid: seedUdid,
      throwaway_udid: null,
    };
    const cases = [
      {
        name: "it is aborted while the copy is read, and the copy's delete fails",
        script: [
          ...booted,
          { match: simctl("shutdown", copyUdid) },
          { match: simctl("delete", copyUdid), result: failed },
        ],
        abort: true,
        left: [
          { source_id: "device-1", state: "making", udid: null, throwaway_udid: copyUdid },
          quickRow,
        ],
        swept: [simctl("shutdown", copyUdid), simctl("delete", copyUdid)],
        remaining: [quickRow],
      },
      {
        name: "the quick seed's delete fails after the swap committed",
        script: [
          ...toSwap,
          { match: sourcesSimctl("delete", seedUdid), result: failed },
          { match: simctl("delete", copyUdid) },
        ],
        abort: false,
        left: [
          { source_id: "device-1", state: "ready", udid: settledUdid, throwaway_udid: null },
          { ...quickRow, state: "making", throwaway_udid: copyUdid },
        ],
        swept: [
          sourcesSimctl("shutdown", seedUdid),
          sourcesSimctl("delete", seedUdid),
          simctl("shutdown", copyUdid),
          simctl("delete", copyUdid),
        ],
        remaining: [
          { source_id: "device-1", state: "ready", udid: settledUdid, throwaway_udid: null },
        ],
      },
      {
        name: "the copy's delete fails after the swap committed",
        script: [
          ...toSwap,
          { match: sourcesSimctl("delete", seedUdid) },
          { match: simctl("delete", copyUdid), result: failed },
        ],
        abort: false,
        left: [
          { source_id: "device-1", state: "ready", udid: settledUdid, throwaway_udid: null },
          { ...quickRow, state: "making", throwaway_udid: copyUdid },
        ],
        swept: [
          sourcesSimctl("shutdown", seedUdid),
          sourcesSimctl("delete", seedUdid),
          simctl("shutdown", copyUdid),
          simctl("delete", copyUdid),
        ],
        remaining: [
          { source_id: "device-1", state: "ready", udid: settledUdid, throwaway_udid: null },
        ],
      },
    ];
    for (const { name, script, abort, left, swept, remaining } of cases) {
      const database = plantReadySeed(await memorySourceDatabase(), {
        deviceTypeId: driverData.deviceTypeId,
        lineage: [lineageUdid],
        runtimeId: driverData.runtimeId,
        udid: seedUdid,
      });
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await plantLaunchServices(filesystem, `${deviceRoot}/${copyUdid}`);
      await plantLaunchServices(filesystem, `${sourcesSet}/${settledUdid}`);
      const runner = new ScriptedProcessRunner(script);
      const clock = new FakeClock();
      const table = new FakeProcessTable();
      const logger = new RecordingLogger();
      const driver = await createDriver(runner, clock, filesystem, database, logger, undefined, {
        logsRoot,
        processTable: table,
      });
      const controller = new AbortController();
      const settle = driver.settleSeed?.(quickSourceId, { signal: controller.signal });
      const rows = () =>
        database
          .prepare(
            "SELECT source_id, state, udid, throwaway_udid FROM ios_source_data ORDER BY source_id",
          )
          .all();

      if (abort) {
        const state = promiseState(settle as Promise<unknown>);
        await waitForCalls(runner, 4);
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort(new Stopped("daemon stopping"));
        clock.advance(2_000);
        await expect(settle, name).rejects.toBeInstanceOf(Stopped);
        expect(state.state).toBe("rejected");
      } else {
        await runToEnd(settle as Promise<unknown>, clock, table, () => [
          launchd(simlockWorld, 100, copyUdid),
        ]);
        await expect(settle, `${name}: the settle answers the new seed`).resolves.toMatchObject({
          sourceId: "device-1",
        });
        expect(logger.warnings, `${name}: the failure is logged`).toEqual([
          expect.stringContaining("could not delete"),
        ]);
      }
      expect(rows(), `${name}: a making row still names what was left`).toEqual(left);

      const restart = new ScriptedProcessRunner([
        ...swept.map((match) => ({ match })),
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      ]);
      const next = await IosSimctlDriver.create({
        clock: new FakeClock(),
        database,
        driverConfig: { deviceRoot },
        filesystem,
        idGenerator: { generate: () => "restart-1" },
        instanceId,
        logsRoot,
        processRunner: restart,
        simlockHome: "/home/.simlock",
      });
      await next.listSources();
      expect(
        restart.calls.slice(0, swept.length).map((call) => call.args.join(" ")),
        `${name}: the sweep deletes them`,
      ).toEqual(swept.map((step) => step.args.join(" ")));
      expect(rows(), `${name}: the sweep leaves the ready seeds`).toEqual(remaining);
    }
  });
});

interface Context {
  readonly runner: ScriptedProcessRunner;
  readonly clock: FakeClock;
  readonly controller: AbortController;
}
