import { describe, expect, it } from "vitest";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { memorySourceDatabase, plantSource } from "./testing.js";
import { deviceRoot, driverData, plantManagedDevice, simctl } from "./test-slim.js";
import {
  createDriver,
  listFixture,
  listInvocation,
  logsRoot,
  plantSeedClone,
  seedUdid,
  sourcesSimctl,
  spec,
  throwawaySeedSteps,
} from "./test-index.js";

const lineage = ["AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB"];
const base = { deviceTypeId: driverData.deviceTypeId, lineage, runtimeId: driverData.runtimeId };
const partialUdid = "00000000-0000-0000-0000-0000000000dd";
const copyUdid = "00000000-0000-0000-0000-0000000000cc";
const listed = { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } };
const sourceRows = (database: Awaited<ReturnType<typeof memorySourceDatabase>>) =>
  database.prepare("SELECT udid, state FROM ios_source_data ORDER BY udid").all();

describe("IosSimctlDriver settle leftovers", () => {
  it("a restart's leftovers of a settle are swept, and a make within the process never sweeps a settle", async () => {
    const quickId = `planted-${seedUdid}-${driverData.runtimeId}`;
    const sweeps = [
      {
        name: "another process's settle row, with its copy and partial seed",
        planted: [
          { ...base, udid: seedUdid },
          {
            ...base,
            maker: "old",
            settleOf: quickId,
            state: "making" as const,
            throwawayUdid: copyUdid,
            udid: partialUdid,
          },
        ],
        calls: [
          sourcesSimctl("shutdown", partialUdid),
          sourcesSimctl("delete", partialUdid),
          simctl("shutdown", copyUdid),
          simctl("delete", copyUdid),
        ],
        left: [{ state: "ready", udid: seedUdid }],
      },
      {
        name: "the row of a quick seed a settle retired",
        planted: [
          { ...base, udid: partialUdid },
          { ...base, maker: "old", settleOf: "settled", state: "making" as const, udid: seedUdid },
        ],
        calls: [sourcesSimctl("shutdown", seedUdid), sourcesSimctl("delete", seedUdid)],
        left: [{ state: "ready", udid: partialUdid }],
      },
    ];
    for (const { name, planted, calls, left } of sweeps) {
      const database = await memorySourceDatabase();
      for (const source of planted) plantSource(database, source);
      const runner = new ScriptedProcessRunner([...calls.map((match) => ({ match })), listed]);
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp(`${logsRoot}/${copyUdid}`);
      const driver = await createDriver(
        runner,
        new FakeClock(),
        filesystem,
        database,
        undefined,
        undefined,
        {
          logsRoot,
        },
      );

      await driver.listSources();

      expect(sourceRows(database), name).toEqual(left);
      expect(
        runner.calls.map((call) => call.args.join(" ")),
        name,
      ).toEqual([...calls.map((call) => call.args.join(" ")), listInvocation.args.join(" ")]);
      expect(
        await filesystem.exists(`${logsRoot}/${copyUdid}`),
        `${name}: the copy's log folder`,
      ).toBe(!calls.some((call) => call.args.includes(copyUdid)));
    }

    const database = await memorySourceDatabase();
    plantSource(database, {
      ...base,
      createdAt: 0,
      maker: "device-1",
      settleOf: quickId,
      state: "making",
      throwawayUdid: copyUdid,
      udid: partialUdid,
    });
    const runner = new ScriptedProcessRunner([
      listed,
      ...throwawaySeedSteps(),
      {
        match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
        result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
      },
    ]);
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    await plantSeedClone(filesystem);
    await filesystem.mkdirp(`${deviceRoot}/${copyUdid}/data`);
    const clock = new FakeClock(360_000);
    const driver = await createDriver(runner, clock, filesystem, database);

    await expect(
      driver.provision(spec),
      "the make is served without touching the settle's row",
    ).resolves.toBeDefined();

    expect(
      sourceRows(database),
      "a make of the kind six minutes into this process's settle leaves the settle's row",
    ).toEqual([
      { state: "making", udid: partialUdid },
      { state: "ready", udid: seedUdid },
    ]);
  });
});
