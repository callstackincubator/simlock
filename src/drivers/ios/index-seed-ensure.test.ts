import { describe, expect, it } from "vitest";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { memorySourceDatabase, plantSource } from "./testing.js";
import { driverData, plantManagedDevice } from "./test-slim.js";
import {
  createDriver,
  listFixture,
  listInvocation,
  plantSeedClone,
  seedUdid,
  sourcesSimctl,
  spec,
  throwawaySeedSteps,
} from "./test-index.js";

const quick = {
  deviceTypeId: driverData.deviceTypeId,
  lineage: ["AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB"],
  runtimeId: driverData.runtimeId,
  udid: seedUdid,
};
const seedId = `planted-${seedUdid}-${driverData.runtimeId}`;
const listed = { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } };
const made = { leases: 0, settled: false, sizeBytes: 0, sourceId: "device-1" };

describe("IosSimctlDriver ensureSeed", () => {
  it("answers the kind's fresh ready seed, or makes it as a provision would, without creating a device", async () => {
    const cases = [
      {
        name: "fresh",
        planted: { ...quick, sizeBytes: 7 },
        script: [listed],
        calls: 1,
        expected: [{ leases: 0, settled: false, sizeBytes: 7, sourceId: seedId }],
      },
      {
        name: "stale: remade",
        planted: { ...quick, lineage: null },
        script: [
          listed,
          { match: sourcesSimctl("shutdown", seedUdid) },
          { match: sourcesSimctl("delete", seedUdid) },
          ...throwawaySeedSteps(),
        ],
        calls: 1,
        expected: [made],
      },
      {
        name: "none: made",
        planted: undefined,
        script: [listed, ...throwawaySeedSteps()],
        calls: 1,
        expected: [made],
      },
      {
        name: "two calls at once make one seed",
        planted: undefined,
        script: [listed, listed, ...throwawaySeedSteps()],
        calls: 2,
        expected: [made, made],
      },
    ];
    for (const { name, planted, script, calls, expected } of cases) {
      const database = await memorySourceDatabase();
      if (planted !== undefined) plantSource(database, planted);
      const runner = new ScriptedProcessRunner(script);
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await plantSeedClone(filesystem);
      const driver = await createDriver(runner, new FakeClock(), filesystem, database);

      const answers = await Promise.all(
        Array.from({ length: calls }, () => driver.ensureSeed?.(spec)),
      );

      expect(answers, name).toEqual(expected);
      expect(
        runner.calls.map((call) => call.args.join(" ")),
        `${name}: only the catalog read and the make's own steps ran, no copy was cloned`,
      ).toEqual(script.map((step) => step.match.args.join(" ")));
    }
  });
});
