import { describe, expect, it } from "vitest";
import { MemoryFilesystem, FakeClock, ScriptedProcessRunner } from "../../ports/index.js";
import { deviceRoot, driverData, plantManagedDevice, sourcesSetPath } from "./test-slim.js";
import {
  createDriver,
  listFixture,
  listInvocation,
  plantSeedClone,
  seededDatabase,
  seedUdid,
  sourcesSimctl,
  spec,
  throwawaySeedSteps,
  throwawayUdid,
} from "./test-index.js";

const goneUdid = "00000000-0000-0000-0000-0000000000cc";
const copyUdid = "00000000-0000-0000-0000-000000000002";

describe("IosSimctlDriver: a seed whose simulator is gone", () => {
  /** why: the seed's row says ready; `sources` is what the filesystem holds of the sources set. */
  async function provisionWorld(sources: "present" | "emptied" | "missing", provisions: 1 | 2) {
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    if (sources === "present") await plantSeedClone(filesystem, sourcesSetPath, goneUdid);
    if (sources === "emptied") await filesystem.mkdirp(sourcesSetPath);
    const database = await seededDatabase({ udid: goneUdid });
    const copy = (from: string, to: string) => ({
      match: sourcesSimctl("clone", from, driverData.name, deviceRoot),
      result: { code: 0, stderr: "", stdout: `${to}\n` },
    });
    const [create, ...afterCreate] = throwawaySeedSteps();
    const listings = Array.from({ length: provisions }, () => ({
      match: listInvocation,
      result: { code: 0, stderr: "", stdout: listFixture },
    }));
    const remade = sources !== "present";
    const runner = new ScriptedProcessRunner([
      ...listings,
      ...(remade
        ? [
            create,
            ...afterCreate.map((step) =>
              step.match.args.includes("clone") && step.match.args.includes(throwawayUdid)
                ? {
                    ...step,
                    onSpawn: () => plantSeedClone(filesystem),
                  }
                : step,
            ),
          ]
        : []),
      copy(remade ? seedUdid : goneUdid, driverData.udid),
      ...(provisions === 2 ? [copy(remade ? seedUdid : goneUdid, copyUdid)] : []),
    ]);
    await filesystem.mkdirp(`${deviceRoot}/${copyUdid}/data`);
    const driver = await createDriver(runner, new FakeClock(), filesystem, database);
    return { database, driver, runner };
  }

  const callsOf = (runner: ScriptedProcessRunner, verb: string) =>
    runner.calls.filter((call) => call.args[3] === verb);

  it("provisions on a copy of a seed whose folder is present, and on a new seed when it was deleted by hand or its sources set is missing, once for two provisions at once, dropping the gone row without a simctl call", async () => {
    const present = await provisionWorld("present", 1);
    await present.driver.provision(spec);
    expect(callsOf(present.runner, "create")).toHaveLength(0);
    expect(present.database.prepare("SELECT udid FROM ios_source_data").all()).toEqual([
      { udid: goneUdid },
    ]);

    for (const sources of ["emptied", "missing"] as const) {
      const { database, driver, runner } = await provisionWorld(sources, 1);
      await driver.provision(spec).catch(() => undefined);
      expect(callsOf(runner, "create"), sources).toHaveLength(1);
      expect(
        runner.calls.some((call) => call.args.includes(goneUdid)),
        sources,
      ).toBe(false);
      expect(database.prepare("SELECT udid, state FROM ios_source_data").all(), sources).toEqual([
        { state: "ready", udid: seedUdid },
      ]);
    }

    const both = await provisionWorld("emptied", 2);
    const first = both.driver.provision(spec);
    const second = both.driver.provision(spec);
    const settled = await Promise.allSettled([first, second]);
    expect(callsOf(both.runner, "create")).toHaveLength(1);
    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});
