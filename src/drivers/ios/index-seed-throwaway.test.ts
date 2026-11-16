import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import { deviceRoot, driverData, instanceId, plantManagedDevice, simctl } from "./test-slim.js";
import {
  listFixture,
  listInvocation,
  logsRoot,
  scopedRunners,
  seedUdid,
  sourcesSimctl,
  spec,
  throwawayUdid,
} from "./test-index.js";

afterEach(() => {
  scopedRunners.length = 0;
});

describe("IosSimctlDriver seed throwaway", () => {
  it("the first provision of a kind makes its seed from a throwaway", async () => {
    const copyUdid = "00000000-0000-0000-0000-000000000002";
    const name = "simlock-seed-device-1";
    const cases = [
      {
        label: "simlock set",
        steps: [
          {
            match: simctl("create", name, driverData.deviceTypeId, driverData.runtimeId),
            result: { code: 0, stderr: "", stdout: `${throwawayUdid}\n` },
          },
          { match: simctl("boot", throwawayUdid) },
          { match: simctl("bootstatus", throwawayUdid, "-b") },
          { match: simctl("listapps", throwawayUdid) },
          { match: simctl("shutdown", throwawayUdid) },
          {
            match: simctl("clone", throwawayUdid, name, `${deviceRoot}/sources`),
            result: { code: 0, stderr: "", stdout: `${seedUdid}\n` },
          },
          { match: simctl("delete", throwawayUdid) },
        ],
      },
    ];
    for (const scenario of cases) {
      const database = await memorySourceDatabase();
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        ...scenario.steps,
        {
          match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
          result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
        },
      ]);
      scopedRunners.push(runner);
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await filesystem.mkdirp(`${deviceRoot}/${copyUdid}/data`);
      await filesystem.mkdirp(`${logsRoot}/${throwawayUdid}`);
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

      await expect(driver.provision(spec), scenario.label).resolves.toMatchObject({
        deviceId: copyUdid,
      });

      expect(runner.calls.length, scenario.label).toBe(scenario.steps.length + 2);
      expect(
        database.prepare("SELECT state, udid, throwaway_udid FROM ios_source_data").all(),
        scenario.label,
      ).toEqual([{ state: "ready", throwaway_udid: throwawayUdid, udid: seedUdid }]);
      await expect(filesystem.exists(`${logsRoot}/${throwawayUdid}`), scenario.label).resolves.toBe(
        false,
      );
    }
  });
});
