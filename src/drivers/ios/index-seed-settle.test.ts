import { describe, expect, it } from "vitest";
import {
  FakeClock,
  FakeProcessTable,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessEntry,
  type SqliteDatabase,
} from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import { plantReadySeed, memorySourceDatabase } from "./testing.js";
import { deviceRoot, driverData, plantManagedDevice, simctl } from "./test-slim.js";
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
});
