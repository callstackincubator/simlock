import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DriverCrashError, OWNED_ROOT_MARKER_FILE } from "../../core/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type Logger,
} from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { FakeSqliteOpener, memorySourceDatabase, plantReadySeed } from "./testing.js";
import { deviceRoot, driverData, instanceId, sourcesRoot } from "./test-slim.js";

const listFixture = readFileSync(new URL("./fixtures/simctl-list.json", import.meta.url), "utf8");
const spec = { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const logsRoot = "/home/Library/Logs/CoreSimulator";
const seedUdid = "00000000-0000-0000-0000-0000000000AA";
const usedUdid = "00000000-0000-0000-0000-0000000000BB";
const copyUdid = driverData.udid;

/** why: a device set of another depth than the sources folder, as long as it, so an escaped path swapped into it changes length. */
const deepRoot = "/home/.simlock/a/b/c/devices-d";

/** why: the clock moves when a file is read, so the swap's logged time is what the clock measured. */
class SlowReadFilesystem extends MemoryFilesystem {
  constructor(private readonly clock: FakeClock) {
    super();
  }

  failWrites = false;

  override async overwriteSameLength(path: string, bytes: Uint8Array): Promise<void> {
    if (this.failWrites) throw new Error("disk full");
    await super.overwriteSameLength(path, bytes);
  }

  override async readBytes(path: string): Promise<Uint8Array> {
    this.clock.advance(7);
    return super.readBytes(path);
  }
}

class LineLogger implements Logger {
  readonly lines: string[] = [];

  debug(message: string): void {
    this.lines.push(message);
  }
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

interface Rig {
  readonly filesystem: SlowReadFilesystem;
  readonly simctlCalls: () => readonly string[];
  readonly logger: LineLogger;
  provision(): Promise<unknown>;
}

async function rigWith(
  root: string,
  files: readonly { readonly relativePath: string; readonly kind: "link" | "file" }[],
  plant: (filesystem: SlowReadFilesystem, copy: string) => Promise<void>,
): Promise<Rig> {
  const clock = new FakeClock();
  const filesystem = new SlowReadFilesystem(clock);
  const logger = new LineLogger();
  await filesystem.mkdirp(`${root}/${copyUdid}`);
  await filesystem.writeFileAtomic(
    `${root}/${OWNED_ROOT_MARKER_FILE}`,
    JSON.stringify({ instanceId, owner: "simlock", platform: "ios", schemaVersion: 1 }),
  );
  await plant(filesystem, `${root}/${copyUdid}`);
  const database = plantReadySeed(await memorySourceDatabase(), {
    deviceTypeId: driverData.deviceTypeId,
    files,
    runtimeId: driverData.runtimeId,
    udid: seedUdid,
  });
  const runner = new ScriptedProcessRunner([
    {
      match: {
        args: ["simctl", "--set", root, "list", "-j", "devicetypes", "runtimes"],
        command: "xcrun",
      },
      result: { code: 0, stderr: "", stdout: listFixture },
    },
    {
      match: {
        args: ["simctl", "--set", sourcesRoot, "clone", seedUdid, driverData.name, root],
        command: "xcrun",
      },
      result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
    },
    { match: { args: ["simctl", "--set", root, "delete", copyUdid], command: "xcrun" } },
  ]);
  const driver = await IosSimctlDriver.create({
    clock,
    database,
    driverConfig: { deviceRoot: root },
    filesystem,
    idGenerator: { generate: () => "device-1" },
    instanceId,
    logger,
    logsRoot,
    processRunner: runner,
    simlockHome: "/home/.simlock",
  });
  await driver.resolveSpec(spec);
  return {
    filesystem,
    logger,
    provision: () => driver.provision(spec),
    simctlCalls: () => runner.calls.map((call) => call.args.slice(3).join(" ")),
  };
}

describe("a lease's copy before its first boot", () => {
  it("swaps every recorded foreign folder for its own, length unchanged, and logs how long it took", async () => {
    const copy = `${deviceRoot}/${copyUdid}`;
    const rig = await rigWith(
      deviceRoot,
      [
        { kind: "link", relativePath: "data/Library/Logs" },
        { kind: "file", relativePath: "data/prefs.bin" },
        { kind: "file", relativePath: "data/Media/state.json" },
      ],
      async (fs) => {
        await fs.mkdirp(`${copy}/data/Library`);
        await fs.mkdirp(`${copy}/data/Media`);
        fs.defineSymlink(`${copy}/data/Library/Logs`, `${logsRoot}/${seedUdid}`);
        await fs.writeFileAtomic(
          `${copy}/data/prefs.bin`,
          `\u0001bplist\u0000${sourcesRoot}/${seedUdid}/data\u0002`,
        );
        await fs.writeFileAtomic(
          `${copy}/data/Media/state.json`,
          `{"from":"${deviceRoot}/${usedUdid}/data"}`,
        );
        await fs.writeFileAtomic(`${copy}/data/unrecorded.txt`, `${sourcesRoot}/${seedUdid}`);
      },
    );

    await rig.provision();

    expect(await rig.filesystem.readlink(`${copy}/data/Library/Logs`), "a link").toBe(
      `${logsRoot}/${copyUdid}`,
    );
    expect(await rig.filesystem.readFile(`${copy}/data/prefs.bin`), "a binary file").toBe(
      `\u0001bplist\u0000${deviceRoot}/${copyUdid}/data\u0002`,
    );
    expect(
      await rig.filesystem.readFile(`${copy}/data/Media/state.json`),
      "a saved-from folder",
    ).toBe(`{"from":"${deviceRoot}/${copyUdid}/data"}`);
    expect(
      await rig.filesystem.readFile(`${copy}/data/unrecorded.txt`),
      "only recorded files",
    ).toBe(`${sourcesRoot}/${seedUdid}`);
    expect(rig.logger.lines).toContain(`swapped 2 files and 1 links in 14 ms for ${copyUdid}`);
  });

  it("refuses a file whose swap would change its length", async () => {
    const copy = `${deepRoot}/${copyUdid}`;
    const escaped = (root: string, udid: string): string =>
      `${root}/${udid}`.replaceAll("/", "\\/");
    const rig = await rigWith(
      deepRoot,
      [{ kind: "file", relativePath: "data/escaped.json" }],
      async (fs) => {
        await fs.mkdirp(`${copy}/data`);
        await fs.writeFileAtomic(
          `${copy}/data/escaped.json`,
          `"${escaped(sourcesRoot, seedUdid)}"`,
        );
      },
    );

    const failed = await rig.provision().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(DriverCrashError);
    expect((failed as Error).message).toContain("data/escaped.json");
  });
});

describe("a copy whose swap fails", () => {
  it.each([
    {
      name: "a recorded file is gone",
      plantFile: false,
      failWrites: false,
      message: "data/prefs.bin",
    },
    { name: "a write fails", plantFile: true, failWrites: true, message: "disk full" },
  ])("is deleted and fails the provision: $name", async ({ plantFile, failWrites, message }) => {
    const copy = `${deviceRoot}/${copyUdid}`;
    const rig = await rigWith(
      deviceRoot,
      [{ kind: "file", relativePath: "data/prefs.bin" }],
      async (fs) => {
        await fs.mkdirp(`${copy}/data`);
        if (plantFile) {
          await fs.writeFileAtomic(`${copy}/data/prefs.bin`, `${sourcesRoot}/${seedUdid}`);
        }
        fs.failWrites = failWrites;
      },
    );

    await expect(rig.provision()).rejects.toThrow(message);

    expect(rig.simctlCalls()).toContain(`delete ${copyUdid}`);
  });
});

describe("a source made", () => {
  const cloneUdid = "00000000-0000-0000-0000-0000000000CC";
  const sourceFolder = (udid: string): string => `${sourcesRoot}/${udid}`;
  const device = {
    address: copyUdid,
    deviceId: copyUdid,
    driverData,
    physical: false,
  } as const;
  const scoped = (...args: readonly string[]) => ({
    args: ["simctl", "--set", sourcesRoot, ...args],
    command: "xcrun",
  });
  const own = (...args: readonly string[]) => ({
    args: ["simctl", "--set", deviceRoot, ...args],
    command: "xcrun",
  });
  const ok = { code: 0, stderr: "", stdout: "" };

  it.each([
    {
      name: "a seed with two WALs: both flushed before its files are read",
      make: "seed",
      failing: [],
      tree: {
        "data/a.sqlite": (udid: string) => `${sourceFolder(udid)}/data`,
        "data/a.sqlite-wal": (udid: string) => `${sourceFolder(udid)}/data`,
        "data/b.sqlite": () => "plain",
        "data/b.sqlite-wal": (udid: string) => `${sourceFolder(udid)}/x`,
        "data/note.txt": () => "no folder here",
      },
      link: true,
      recorded: [
        ["data/Library/Logs", "link"],
        ["data/a.sqlite", "file"],
      ],
      flushed: ["data/a.sqlite", "data/b.sqlite"],
      warned: [],
    },
    {
      name: "a baseline saved from a used copy names that copy's folder",
      make: "baseline",
      failing: [],
      tree: { "data/Media/state.plist": () => `${deviceRoot}/${copyUdid}/data/Media` },
      link: false,
      recorded: [["data/Media/state.plist", "file"]],
      flushed: [],
      warned: [],
    },
    {
      name: "a WAL that cannot be flushed is logged and left out, and the source is still made",
      make: "baseline",
      failing: ["data/b.sqlite"],
      tree: {
        "data/b.sqlite": () => "plain",
        "data/b.sqlite-wal": (udid: string) => `${sourceFolder(udid)}/x`,
      },
      link: false,
      recorded: [],
      flushed: [],
      warned: ["data/b.sqlite"],
    },
    {
      name: "a source that names no folder has no rows and is indexed",
      make: "baseline",
      failing: [],
      tree: { "data/note.txt": () => "nothing" },
      link: false,
      recorded: [],
      flushed: [],
      warned: [],
    },
  ] as const)(
    "flushes its WALs and records the files and links that name a folder: $name",
    async ({ make, failing, tree, link, recorded, flushed, warned }) => {
      const udid = make === "seed" ? seedUdid : cloneUdid;
      const filesystem = new MemoryFilesystem();
      const sqlite = new FakeSqliteOpener(filesystem);
      const warnings: string[] = [];
      const logger = Object.assign(new LineLogger(), {
        warn: (message: string) => void warnings.push(message),
      });
      await filesystem.mkdirp(sourcesRoot, { mode: 0o700 });
      await filesystem.writeFileAtomic(
        `${sourcesRoot}/${OWNED_ROOT_MARKER_FILE}`,
        JSON.stringify({ instanceId, owner: "simlock", platform: "ios", schemaVersion: 1 }),
      );
      await filesystem.mkdirp(deviceRoot);
      await filesystem.writeFileAtomic(
        `${deviceRoot}/${OWNED_ROOT_MARKER_FILE}`,
        JSON.stringify({ instanceId, owner: "simlock", platform: "ios", schemaVersion: 1 }),
      );
      for (const folder of [sourceFolder(udid), `${deviceRoot}/${copyUdid}`]) {
        for (const [path, contents] of Object.entries(tree)) {
          const at = `${folder}/${path}`;
          await filesystem.mkdirp(at.slice(0, at.lastIndexOf("/")));
          await filesystem.writeFileAtomic(at, contents(udid));
        }
        if (link) {
          await filesystem.mkdirp(`${folder}/data/Library`);
          filesystem.defineSymlink(`${folder}/data/Library/Logs`, `${logsRoot}/${udid}`);
        }
      }
      for (const path of failing) sqlite.failing.add(`${sourceFolder(udid)}/${path}`);
      const database = await memorySourceDatabase();
      const runner = new ScriptedProcessRunner([
        {
          match: own("list", "-j", "devicetypes", "runtimes"),
          result: { ...ok, stdout: listFixture },
        },
        ...(make === "seed"
          ? [
              {
                match: scoped(
                  "create",
                  "simlock-seed-device-1",
                  driverData.deviceTypeId,
                  driverData.runtimeId,
                ),
                result: { ...ok, stdout: `${udid}\n` },
              },
              { match: scoped("boot", udid) },
              { match: scoped("bootstatus", udid, "-b") },
              { match: scoped("listapps", udid) },
              { match: scoped("shutdown", udid) },
              {
                match: scoped("clone", udid, driverData.name, deviceRoot),
                result: { ...ok, stdout: `${copyUdid}\n` },
              },
            ]
          : [
              { match: own("shutdown", copyUdid) },
              {
                match: own("clone", copyUdid, "simlock-baseline-device-1", sourcesRoot),
                result: { ...ok, stdout: `${udid}\n` },
              },
            ]),
      ]);
      const driver = await IosSimctlDriver.create({
        clock: new FakeClock(),
        database,
        driverConfig: { deviceRoot },
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        logger,
        logsRoot,
        processRunner: runner,
        simlockHome: "/home/.simlock",
        sqlite,
      });
      if (make === "seed") await driver.resolveSpec(spec);

      await (make === "seed" ? driver.provision(spec) : driver.saveSource(device));

      expect(
        database
          .prepare("SELECT relative_path, kind FROM ios_source_files ORDER BY relative_path")
          .all(),
        "the files and links that name a folder",
      ).toEqual(recorded.map(([relativePath, kind]) => ({ kind, relative_path: relativePath })));
      expect(database.prepare("SELECT indexed FROM ios_source_data").all()).toEqual([
        { indexed: 1 },
      ]);
      expect(sqlite.flushed, "the databases whose WAL was flushed").toEqual(
        flushed.map((path) => `${sourceFolder(udid)}/${path}`),
      );
      expect(warnings).toEqual(
        warned.map((path) => `could not flush ${sourceFolder(udid)}/${path}: database is locked`),
      );
    },
  );
});
