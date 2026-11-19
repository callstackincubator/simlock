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
import { deviceRoot, driverData, plantManagedDevice, simctl, waitForCalls } from "./test-slim.js";
import {
  createDriver,
  logsRoot,
  plantLaunchServices,
  seedUdid,
  sourcesSimctl,
} from "./test-index.js";

const sourcesSet = `${deviceRoot}/sources`;
const lineageUdid = "AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB";
const copyUdid = "00000000-0000-0000-0000-0000000000cc";
const settledUdid = "00000000-0000-0000-0000-0000000000dd";
const otherUdid = "00000000-0000-0000-0000-0000000000ee";
const quickSourceId = `planted-${seedUdid}-${driverData.runtimeId}`;

/** why: a launchd_sim as `ps` prints it: the program, then the bootstrap file inside the simulator's own folder. */
function launchd(pid: number, udid: string): ProcessEntry {
  return {
    command: `/Runtimes/iOS.simruntime/usr/libexec/launchd_sim ${deviceRoot}/${udid}/data/var/run/launchd_bootstrap.plist`,
    cpuSeconds: 1,
    pid,
    ppid: 1,
  };
}

/** why: the copy's tree is quiet; another simulator's launchd_sim burns four cores, so a root picked by anything but the folder never goes idle. */
function processesAt(nowMs: number): readonly ProcessEntry[] {
  return [
    launchd(100, copyUdid),
    { command: "backboardd", cpuSeconds: 3, pid: 101, ppid: 100 },
    { ...launchd(200, otherUdid), cpuSeconds: (nowMs / 1_000) * 4 },
  ];
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

describe("IosSimctlDriver settleSeed", () => {
  it("replaces a quick seed with its settled copy: cloned as a provision clones, booted, read until idle, saved as the new seed, the quick seed deleted in its turn", async () => {
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
    await filesystem.writeFileAtomic(`${sourcesSet}/${settledUdid}/data/state`, "12345");
    await filesystem.mkdirp(`${logsRoot}/${copyUdid}`);
    const rowsAtBoot: unknown[] = [];
    const rowsAtOldDelete: unknown[] = [];
    const runner = new ScriptedProcessRunner([
      {
        match: sourcesSimctl("clone", seedUdid, "simlock-device-1", deviceRoot),
        result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
      },
      {
        match: simctl("boot", copyUdid),
        onSpawn: () => void rowsAtBoot.push(...selectRows(database)),
      },
      { match: simctl("bootstatus", copyUdid, "-b") },
      { match: simctl("listapps", copyUdid) },
      { match: simctl("shutdown", copyUdid) },
      {
        match: simctl("clone", copyUdid, "simlock-seed-device-1", sourcesSet),
        result: { code: 0, stderr: "", stdout: `${settledUdid}\n` },
      },
      {
        match: sourcesSimctl("shutdown", seedUdid),
        onSpawn: () => void rowsAtOldDelete.push(...selectRows(database)),
      },
      { match: sourcesSimctl("delete", seedUdid) },
      { match: simctl("delete", copyUdid) },
    ]);
    const clock = new FakeClock();
    const table = new FakeProcessTable();
    const driver = await createDriver(runner, clock, filesystem, database, undefined, undefined, {
      logsRoot,
      processTable: table,
    });
    const settle = driver.settleSeed?.(quickSourceId, { signal: new AbortController().signal });
    expect(settle, "an iOS driver given a process table settles seeds").toBeDefined();

    await runToEnd(settle as Promise<unknown>, clock, table, processesAt);

    await expect(settle).resolves.toEqual({
      reason: "idle",
      settledAfterMs: 180_000,
      sizeBytes: 5,
      sourceId: "device-1",
    });
    expect(rowsAtBoot, "while the copy boots the quick seed is still the ready seed").toEqual([
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
      "the swap is one step: the new seed is ready, the old one retired",
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
    expect(runner.calls.map((call) => call.args.join(" "))).toEqual(
      [
        sourcesSimctl("clone", seedUdid, "simlock-device-1", deviceRoot),
        simctl("boot", copyUdid),
        simctl("bootstatus", copyUdid, "-b"),
        simctl("listapps", copyUdid),
        simctl("shutdown", copyUdid),
        simctl("clone", copyUdid, "simlock-seed-device-1", sourcesSet),
        sourcesSimctl("shutdown", seedUdid),
        sourcesSimctl("delete", seedUdid),
        simctl("delete", copyUdid),
      ].map((call) => call.args.join(" ")),
    );
    expect(
      await filesystem.exists(
        `${deviceRoot}/${copyUdid}/data/var/db/lsd/com.apple.LaunchServices-33554481-v2.csstore`,
      ),
      "the copy's LaunchServices database was dropped before its boot",
    ).toBe(false);
    expect(
      await filesystem.exists(
        `${sourcesSet}/${settledUdid}/data/var/db/lsd/com.apple.LaunchServices-33554481-v2.csstore`,
      ),
      "the new seed's LaunchServices database was dropped",
    ).toBe(false);
    expect(
      await filesystem.exists(`${logsRoot}/${copyUdid}`),
      "the copy's log folder is deleted",
    ).toBe(false);
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
