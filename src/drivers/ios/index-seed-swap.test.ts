import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriverCrashError } from "../../core/index.js";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { plantBytes, readBytes } from "./testing.js";
import { deviceRoot, driverData, plantManagedDevice, simctl } from "./test-slim.js";
import {
  RecordingLogger,
  createDriver,
  listFixture,
  listInvocation,
  plantLaunchServices,
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("IosSimctlDriver copy swap", () => {
  it("a copy keeps its source's lineage, swaps the lineage's UDIDs in every recorded file and link for its own before its first boot and logs the swap", async () => {
    class TickingWrites extends MemoryFilesystem {
      constructor(private readonly clock: FakeClock) {
        super();
      }

      override async writeAt(path: string, offset: number, bytes: Uint8Array): Promise<void> {
        this.clock.advance(5);
        await super.writeAt(path, offset, bytes);
      }
    }
    const utf16le = (text: string): Buffer => Buffer.from(text, "utf16le");
    const utf16be = (text: string): Buffer => utf16le(text).swap16();
    const ascii = (text: string): Buffer => Buffer.from(text, "latin1");
    const lower = lineageUdid.toLowerCase();
    const ownLower = copyUdid.toLowerCase();
    const window = 1_048_576;
    const spanning = (udid: Buffer, at: number): Buffer => {
      const bytes = Buffer.alloc(window + 200, 0x20);
      udid.copy(bytes, at);
      return bytes;
    };
    const big = Buffer.alloc(64 * window + 100);
    const bigTail = ascii(`/${lineageUdid}/`);
    bigTail.copy(big, big.length - bigTail.length);
    const bigSwapped = Buffer.from(big);
    ascii(`/${copyUdid}/`).copy(bigSwapped, big.length - bigTail.length);
    const files = [
      {
        name: "ascii",
        before: ascii(`path /Devices/${lineageUdid}/data end`),
        after: ascii(`path /Devices/${copyUdid}/data end`),
      },
      { name: "lower", before: ascii(`/logs/${lower}/x`), after: ascii(`/logs/${ownLower}/x`) },
      { name: "le", before: utf16le(`a ${lineageUdid} b`), after: utf16le(`a ${copyUdid} b`) },
      { name: "be", before: utf16be(`a ${lower} b`), after: utf16be(`a ${ownLower} b`) },
      {
        name: "span-ascii",
        before: spanning(ascii(lineageUdid), window - 18),
        after: spanning(ascii(copyUdid), window - 18),
      },
      {
        name: "span-utf16",
        before: spanning(utf16le(lineageUdid), window - 36),
        after: spanning(utf16le(copyUdid), window - 36),
      },
      {
        name: "edge-utf16",
        before: spanning(utf16le(lineageUdid), window - 1),
        after: spanning(utf16le(copyUdid), window - 1),
      },
      { name: "big", before: big, after: bigSwapped },
      { name: "own", before: ascii(`own ${copyUdid}`), after: ascii(`own ${copyUdid}`) },
      {
        name: "unreadable",
        before: ascii(`x ${lineageUdid}`),
        after: ascii(`x ${lineageUdid}`),
        kind: "unreadable" as const,
      },
    ];
    const linkTarget = (udid: string): string => `/Users/x/Library/Logs/CoreSimulator/${udid}`;
    const database = await seededDatabase({
      files: [
        ...files.map((file) => ({
          kind: file.kind ?? ("file" as const),
          relativePath: `data/${file.name}`,
        })),
        { kind: "link", relativePath: "data/Logs" },
      ],
      lineage: [lineageUdid],
    });
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      {
        match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
        result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
      },
    ]);
    const clock = new FakeClock();
    const filesystem = new TickingWrites(clock);
    const logger = new RecordingLogger();
    await plantManagedDevice(filesystem);
    for (const file of files) {
      await plantBytes(filesystem, `${deviceRoot}/${copyUdid}/data/${file.name}`, file.before);
    }
    filesystem.defineSymlink(`${deviceRoot}/${copyUdid}/data/Logs`, linkTarget(lineageUdid));
    const driver = await createDriver(runner, clock, filesystem, database, logger);

    const device = await driver.provision(spec);

    for (const file of files) {
      const bytes = await readBytes(filesystem, `${deviceRoot}/${copyUdid}/data/${file.name}`);
      expect(bytes.equals(file.after), file.name).toBe(true);
    }
    expect(await filesystem.readlink(`${deviceRoot}/${copyUdid}/data/Logs`)).toBe(
      linkTarget(copyUdid),
    );
    expect(device.driverData).toMatchObject({ lineage: [lineageUdid] });
    expect(logger.debugs).toEqual([
      `swapped 9 files and 1 links in 40 ms for ${copyUdid}; 1 unreadable`,
    ]);
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
        error: new RegExp(
          `${escapeRegExp(`${join(deviceRoot, copyUdid)}/data/Library/note.plist`)}.*length`,
        ),
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

  it("a LaunchServices database the seed recorded is dropped from the copy and is not swapped", async () => {
    const csstore = "data/var/db/lsd/com.apple.LaunchServices-33554481-v2.csstore";
    const database = await seededDatabase({
      files: [{ kind: "file", relativePath: csstore }],
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
    await plantLaunchServices(filesystem, `${deviceRoot}/${copyUdid}`);
    const driver = await createDriver(runner, new FakeClock(), filesystem, database);

    await driver.provision(spec);

    expect(await filesystem.exists(`${deviceRoot}/${copyUdid}/${csstore}`)).toBe(false);
  });
});
