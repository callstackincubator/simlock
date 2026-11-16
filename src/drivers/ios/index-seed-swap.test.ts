import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { plantBytes, readBytes } from "./testing.js";
import { deviceRoot, driverData, plantManagedDevice } from "./test-slim.js";
import {
  createDriver,
  listFixture,
  listInvocation,
  scopedRunners,
  seedUdid,
  seededDatabase,
  sourcesSimctl,
  spec,
} from "./test-index.js";

afterEach(() => {
  scopedRunners.length = 0;
});

const lineageUdid = "AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB";
const copyUdid = "CCCCCCCC-4444-5555-6666-DDDDDDDDDDDD";

describe("IosSimctlDriver copy swap", () => {
  it("a copy keeps its source's lineage and swaps the lineage's UDIDs in every recorded file for its own before its first boot", async () => {
    const database = await seededDatabase({
      files: [{ kind: "file", relativePath: "data/Library/note.plist" }],
      lineage: [lineageUdid],
    });
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      {
        match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
        result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
      },
    ]);
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    const file = `${deviceRoot}/${copyUdid}/data/Library/note.plist`;
    await plantBytes(filesystem, file, Buffer.from(`path /Devices/${lineageUdid}/data end`));
    const driver = await createDriver(runner, new FakeClock(), filesystem, database);

    const device = await driver.provision(spec);

    expect((await readBytes(filesystem, file)).toString("latin1")).toBe(
      `path /Devices/${copyUdid}/data end`,
    );
    expect(device.driverData).toMatchObject({ lineage: [lineageUdid] });
  });
});
