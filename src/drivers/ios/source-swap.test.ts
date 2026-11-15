import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase, plantReadySeed } from "./testing.js";
import {
  deviceRoot,
  driverData,
  instanceId,
  plantManagedDevice,
  simctl,
  sourcesRoot,
} from "./test-slim.js";

const listFixture = readFileSync(new URL("./fixtures/simctl-list.json", import.meta.url), "utf8");
const spec = { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const logsRoot = "/home/Library/Logs/CoreSimulator";
const seedUdid = "00000000-0000-0000-0000-0000000000AA";
const copyUdid = driverData.udid;

async function provisionCopy(
  setup: (filesystem: MemoryFilesystem) => Promise<void>,
  files: readonly { readonly relativePath: string; readonly kind: "link" | "file" }[],
): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await plantManagedDevice(filesystem);
  await setup(filesystem);
  const database = plantReadySeed(await memorySourceDatabase(), {
    deviceTypeId: driverData.deviceTypeId,
    files,
    runtimeId: driverData.runtimeId,
    udid: seedUdid,
  });
  const runner = new ScriptedProcessRunner([
    {
      match: simctl("list", "-j", "devicetypes", "runtimes"),
      result: { code: 0, stderr: "", stdout: listFixture },
    },
    {
      match: {
        args: ["simctl", "--set", sourcesRoot, "clone", seedUdid, driverData.name, deviceRoot],
        command: "xcrun",
      },
      result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
    },
  ]);
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
  await driver.resolveSpec(spec);
  await driver.provision(spec);
  return filesystem;
}

describe("a lease's copy before its first boot", () => {
  it("swaps every recorded foreign folder for its own, length unchanged", async () => {
    const link = `${deviceRoot}/${copyUdid}/data/Library/Logs`;

    const filesystem = await provisionCopy(
      async (fs) => {
        await fs.mkdirp(`${deviceRoot}/${copyUdid}/data/Library`);
        fs.defineSymlink(link, `${logsRoot}/${seedUdid}`);
      },
      [{ kind: "link", relativePath: "data/Library/Logs" }],
    );

    expect(await filesystem.readlink(link)).toBe(`${logsRoot}/${copyUdid}`);
  });
});
