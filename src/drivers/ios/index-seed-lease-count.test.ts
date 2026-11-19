import { describe, expect, it } from "vitest";
import { DriverCrashError } from "../../core/index.js";
import { MemoryFilesystem, ScriptedProcessRunner, FakeClock } from "../../ports/index.js";
import { memorySourceDatabase, plantSource } from "./testing.js";
import { deviceRoot, driverData, plantManagedDevice } from "./test-slim.js";
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

const copyUdid = "00000000-0000-0000-0000-000000000002";
const baselineUdid = "00000000-0000-0000-0000-0000000000ab";
const quick = {
  deviceTypeId: driverData.deviceTypeId,
  lineage: ["AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB"],
  runtimeId: driverData.runtimeId,
  udid: seedUdid,
};
const seedId = `planted-${seedUdid}-${driverData.runtimeId}`;
const baselineId = `planted-${baselineUdid}-${driverData.runtimeId}`;
const listed = { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } };
const copySeed = (from: string) => ({
  match: sourcesSimctl("clone", from, driverData.name, deviceRoot),
  result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
});

function seedEntry(extra: object) {
  return { id: seedId, kind: "seed", model: "iPhone 16", osVersion: "26.5", ...extra };
}

describe("IosSimctlDriver seed lease count", () => {
  it("a plain lease adds one to its seed's lease count", async () => {
    const cases = [
      {
        name: "a plain provision",
        database: async () => plantSource(await memorySourceDatabase(), quick),
        script: [listed, copySeed(seedUdid), listed],
        provision: undefined,
        expected: [seedEntry({ leases: 1, settled: false })],
      },
      {
        name: "a baseline copy leaves its seed's count",
        database: async () =>
          plantSource(plantSource(await memorySourceDatabase(), quick), {
            ...quick,
            kind: "baseline",
            udid: baselineUdid,
          }),
        script: [listed, listed, copySeed(baselineUdid), listed],
        provision: { source: baselineId },
        expected: [
          seedEntry({ leases: 0, settled: false }),
          { id: baselineId, kind: "baseline", model: "iPhone 16", osVersion: "26.5" },
        ],
      },
      {
        name: "a clone that fails",
        database: async () => plantSource(await memorySourceDatabase(), quick),
        script: [
          listed,
          { ...copySeed(seedUdid), result: { code: 1, stderr: "clone failed", stdout: "" } },
          listed,
        ],
        provision: undefined,
        rejects: true,
        expected: [seedEntry({ leases: 0, settled: false })],
      },
      {
        name: "a seed from before this feature, which no lease has used",
        database: async () => plantSource(await memorySourceDatabase(), quick),
        script: [listed],
        provision: undefined,
        leased: false,
        expected: [seedEntry({ leases: 0, settled: false })],
      },
      {
        name: "the first lease of a new kind",
        database: async () => memorySourceDatabase(),
        script: [listed, ...throwawaySeedSteps(), copySeed(seedUdid), listed],
        provision: undefined,
        expected: [{ ...seedEntry({ leases: 1, settled: false }), id: "device-1", sizeBytes: 0 }],
      },
    ];
    for (const { name, database, script, provision, expected, ...rest } of cases) {
      const runner = new ScriptedProcessRunner(script);
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await plantSeedClone(filesystem);
      await filesystem.mkdirp(`${deviceRoot}/${copyUdid}/data`);
      const driver = await createDriver(runner, new FakeClock(), filesystem, await database());

      if (!("leased" in rest)) {
        const leased = driver.provision(spec, provision);
        if ("rejects" in rest) await expect(leased, name).rejects.toBeInstanceOf(DriverCrashError);
        else await expect(leased, name).resolves.toBeDefined();
      }

      await expect(driver.listSources(), name).resolves.toEqual(expected);
    }
  });
});
