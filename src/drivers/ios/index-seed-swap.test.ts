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
      `swapped 9 files and 1 links in 40 ms for ${copyUdid}; 1 unreadable, 0 missing`,
    ]);
  });

  it("a copy whose source recorded a file and a link it no longer has skips them, swaps the rest and logs them as missing", async () => {
    const database = await seededDatabase({
      files: [
        { kind: "file", relativePath: "data/gone.plist" },
        { kind: "link", relativePath: "data/GoneLogs" },
        { kind: "file", relativePath: "data/kept.plist" },
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
    const filesystem = new MemoryFilesystem();
    const logger = new RecordingLogger();
    await plantManagedDevice(filesystem);
    const kept = `${deviceRoot}/${copyUdid}/data/kept.plist`;
    await plantBytes(filesystem, kept, Buffer.from(`/Devices/${lineageUdid}/data`));
    const driver = await createDriver(runner, new FakeClock(), filesystem, database, logger);

    await driver.provision(spec);

    expect((await readBytes(filesystem, kept)).toString()).toBe(`/Devices/${copyUdid}/data`);
    expect(runner.calls.some((call) => call.args.includes("delete"))).toBe(false);
    expect(logger.debugs).toEqual([
      `swapped 1 files and 0 links in 0 ms for ${copyUdid}; 0 unreadable, 2 missing`,
    ]);
  });

  it("a copy whose swap fails is deleted and the provision fails", async () => {
    class FailingWrites extends MemoryFilesystem {
      override async writeAt(): Promise<void> {
        throw new Error("disk full");
      }
    }
    class LockedLinks extends MemoryFilesystem {
      override async readlink(path: string): Promise<string> {
        throw Object.assign(new Error(`EACCES: permission denied, readlink '${path}'`), {
          code: "EACCES",
        });
      }
    }
    const file = `${deviceRoot}/${copyUdid}/data/Library/note.plist`;
    const cases = [
      { label: "control: a swap that works", error: undefined },
      {
        label: "a write that fails",
        filesystem: new FailingWrites(),
        error: /disk full/,
      },
      {
        label: "a recorded link that cannot be read",
        filesystem: new LockedLinks(),
        link: true,
        error: /EACCES/,
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
        files: [
          { kind: "file", relativePath: "data/Library/note.plist" },
          ...(attempt.link === true ? [{ kind: "link" as const, relativePath: "data/Logs" }] : []),
        ],
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
        file,
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

  it("a copy whose swap fails and whose delete fails logs the UDID it could not delete and still fails the provision with the swap's error", async () => {
    class FailingWrites extends MemoryFilesystem {
      override async writeAt(): Promise<void> {
        throw new Error("disk full");
      }
    }
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
      {
        match: simctl("delete", copyUdid),
        result: { code: 1, stderr: "Unable to delete device", stdout: "" },
      },
    ]);
    const filesystem = new FailingWrites();
    await plantManagedDevice(filesystem);
    await plantBytes(
      filesystem,
      `${deviceRoot}/${copyUdid}/data/Library/note.plist`,
      Buffer.from(`/Devices/${lineageUdid}/`),
    );
    const logger = new RecordingLogger();
    const driver = await createDriver(runner, new FakeClock(), filesystem, database, logger);

    await expect(driver.provision(spec)).rejects.toThrow(/disk full/);

    expect(logger.warnings).toEqual([
      expect.stringMatching(new RegExp(`${copyUdid}.*Unable to delete device`)),
    ]);
  });

  it("a copy swaps every file and link its seed recorded even when the seed is destroyed between the clone and the swap", async () => {
    let reachedSwap!: () => void;
    const atSwap = new Promise<void>((resolve) => {
      reachedSwap = resolve;
    });
    let releaseSwap!: () => void;
    const swapReleased = new Promise<void>((resolve) => {
      releaseSwap = resolve;
    });
    const launchServicesFolder = `${deviceRoot}/${copyUdid}/data/var/db/lsd`;
    class HeldAfterClone extends MemoryFilesystem {
      override async exists(path: string): Promise<boolean> {
        if (path === launchServicesFolder) {
          reachedSwap();
          await swapReleased;
        }
        return super.exists(path);
      }
    }
    const database = await seededDatabase({
      files: [
        { kind: "file", relativePath: "data/first.plist" },
        { kind: "file", relativePath: "data/second.plist" },
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
      { match: sourcesSimctl("shutdown", seedUdid) },
      { match: sourcesSimctl("delete", seedUdid) },
    ]);
    const filesystem = new HeldAfterClone();
    await plantManagedDevice(filesystem);
    for (const name of ["first", "second"]) {
      await plantBytes(
        filesystem,
        `${deviceRoot}/${copyUdid}/data/${name}.plist`,
        Buffer.from(`/Devices/${lineageUdid}/${name}`),
      );
    }
    const linkTarget = (udid: string): string => `/Users/x/Library/Logs/CoreSimulator/${udid}`;
    filesystem.defineSymlink(`${deviceRoot}/${copyUdid}/data/Logs`, linkTarget(lineageUdid));
    const driver = await createDriver(runner, new FakeClock(), filesystem, database);
    const seedSource = database
      .prepare("SELECT source_id FROM ios_source_data WHERE udid = ?")
      .get(seedUdid)?.["source_id"] as string;

    const provision = driver.provision(spec);
    await atSwap;
    await driver.destroySource(seedSource);
    releaseSwap();
    const device = await provision;

    expect(runner.calls.map((call) => call.args.slice(3).join(" "))).toEqual([
      "list -j devicetypes runtimes",
      `clone ${seedUdid} ${driverData.name} ${deviceRoot}`,
      `shutdown ${seedUdid}`,
      `delete ${seedUdid}`,
    ]);
    for (const name of ["first", "second"]) {
      const bytes = await readBytes(filesystem, `${deviceRoot}/${copyUdid}/data/${name}.plist`);
      expect(bytes.toString(), name).toBe(`/Devices/${copyUdid}/${name}`);
    }
    expect(await filesystem.readlink(`${deviceRoot}/${copyUdid}/data/Logs`)).toBe(
      linkTarget(copyUdid),
    );
    expect(device.driverData).toMatchObject({ lineage: [lineageUdid] });
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
