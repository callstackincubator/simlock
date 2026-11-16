import { afterEach, describe, expect, it } from "vitest";
import { DriverCrashError } from "../../core/index.js";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { plantBytes, readBytes } from "./testing.js";
import { deviceRoot, driverData, plantManagedDevice, simctl } from "./test-slim.js";
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

  it("a copy whose swap fails is deleted and the provision fails", async () => {
    class FailingWrites extends MemoryFilesystem {
      override async writeAt(): Promise<void> {
        throw new Error("disk full");
      }
    }
    const file = `${deviceRoot}/${copyUdid}/data/Library/note.plist`;
    const cases = [
      { label: "control: a swap that works", error: undefined },
      { label: "a recorded file gone", gone: true, error: /ENOENT/ },
      {
        label: "a write that fails",
        filesystem: new FailingWrites(),
        error: /disk full/,
      },
      {
        label: "a result of another length",
        lineage: ["AAAAAAAA-1111-2222-3333-BBBBBBBBBBB"],
        crash: true,
        error: new RegExp(`${file}.*length`),
      },
    ];
    for (const attempt of cases) {
      const database = await seededDatabase({
        files: [{ kind: "file", relativePath: "data/Library/note.plist" }],
        lineage: attempt.lineage ?? [lineageUdid],
      });
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        {
          match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
          result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
        },
        { match: simctl("delete", copyUdid) },
      ]);
      const filesystem = attempt.filesystem ?? new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await plantBytes(
        filesystem as MemoryFilesystem,
        attempt.gone === true ? `${deviceRoot}/${copyUdid}/data/other` : file,
        Buffer.from(`/Devices/${lineageUdid}/ AAAAAAAA-1111-2222-3333-BBBBBBBBBBB`),
      );
      const driver = await createDriver(runner, new FakeClock(), filesystem, database);

      const outcome = await driver.provision(spec).then(
        () => undefined,
        (error: unknown) => error as Error,
      );

      const deleted = runner.calls.some((call) =>
        call.args.join(" ").endsWith(`delete ${copyUdid}`),
      );
      if (attempt.error === undefined) {
        expect(outcome, attempt.label).toBeUndefined();
        expect(deleted, attempt.label).toBe(false);
      } else {
        expect(outcome?.message ?? "no error", attempt.label).toMatch(attempt.error);
        expect(deleted, attempt.label).toBe(true);
        if (attempt.crash === true) expect(outcome, attempt.label).toBeInstanceOf(DriverCrashError);
      }
    }
  });
});
