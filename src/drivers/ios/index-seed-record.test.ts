import { afterEach, describe, expect, it } from "vitest";
import {
  FakeClock,
  FakeSqliteOpener,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type SqliteDatabase,
} from "../../ports/index.js";
import { memorySourceDatabase, plantBytes } from "./testing.js";
import { deviceRoot, driverData, sourcesSetPath, plantManagedDevice, simctl } from "./test-slim.js";
import {
  RecordingLogger,
  createDriver,
  listFixture,
  listInvocation,
  logsRoot,
  scopedRunners,
  seedUdid,
  sourcesSimctl,
  spec,
  throwawaySeedSteps,
  throwawayUdid,
} from "./test-index.js";

afterEach(() => {
  scopedRunners.length = 0;
});

const copyUdid = "CCCCCCCC-4444-5555-6666-DDDDDDDDDDDD";
const lineageUdid = throwawayUdid.toUpperCase();
const seedFolder = `${sourcesSetPath}/${seedUdid}`;
const SQLITE_HEADER = Buffer.from("SQLite format 3\u0000");
const MEBIBYTE = 1_048_576;

function utf16be(text: string): Buffer {
  return Buffer.from(text, "utf16le").swap16();
}

class UnreadableFiles extends MemoryFilesystem {
  readonly unreadable = new Set<string>();
  /** why: CoreSimulator's atomic write lists a `*.sb-*` temp file and renames it away before the walk reaches it. */
  readonly vanishing = new Set<string>();
  /** why: the same rename can land just after the walk's lstat, before the file is read. */
  readonly vanishingAfterLstat = new Set<string>();

  override async lstat(path: string): ReturnType<MemoryFilesystem["lstat"]> {
    if (this.vanishing.has(path)) await this.rm(path);
    const details = await super.lstat(path);
    if (this.vanishingAfterLstat.has(path)) await this.rm(path);
    return details;
  }

  override async openFile(path: string): ReturnType<MemoryFilesystem["openFile"]> {
    if (this.unreadable.has(path)) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
        code: "EACCES",
      });
    }
    return super.openFile(path);
  }
}

interface Made {
  readonly database: SqliteDatabase;
  readonly error: unknown;
  readonly filesystem: UnreadableFiles;
  readonly logger: RecordingLogger;
  readonly opener: FakeSqliteOpener;
  readonly runner: ScriptedProcessRunner;
}

/** why: the first provision of a kind, with `plant` writing what the seed's clone holds and `fail` naming what the fake filesystem and opener refuse. */
async function provisionNewSeed(options: {
  readonly plant: (filesystem: UnreadableFiles) => Promise<void>;
  readonly failingPaths?: readonly string[];
  readonly unreadablePaths?: readonly string[];
  readonly failingDatabases?: readonly string[];
  readonly keepingFrames?: readonly string[];
}): Promise<Made> {
  const database = await memorySourceDatabase();
  const filesystem = new UnreadableFiles();
  await plantManagedDevice(filesystem);
  await filesystem.mkdirp(`${logsRoot}/${throwawayUdid}`);
  await options.plant(filesystem);
  // why: `simctl clone` gives the copy what the seed holds, and the scripted runner cannot.
  await filesystem.mkdirp(seedFolder);
  await filesystem.copyTree(seedFolder, `${deviceRoot}/${copyUdid}`, { timeoutMs: 1 });
  for (const path of options.failingPaths ?? []) filesystem.defineFailure(path, "EACCES");
  for (const path of options.unreadablePaths ?? []) filesystem.unreadable.add(path);
  const opener = new FakeSqliteOpener(filesystem, {
    failing: options.failingDatabases ?? [],
    keepingFrames: options.keepingFrames ?? [],
  });
  const logger = new RecordingLogger();
  const runner = new ScriptedProcessRunner([
    { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
    ...throwawaySeedSteps(),
    {
      match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
      result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
    },
    ...[sourcesSimctl("shutdown", seedUdid), sourcesSimctl("delete", seedUdid)].map((match) => ({
      match,
    })),
  ]);
  const driver = await createDriver(
    runner,
    new FakeClock(),
    filesystem,
    database,
    logger,
    undefined,
    {
      sqliteOpener: opener,
    },
  );
  const error = await driver.provision(spec).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return { database, error, filesystem, logger, opener, runner };
}

const baselineUdid = "EEEEEEEE-7777-8888-9999-FFFFFFFFFFFF";

/** why: a save of the lease `driverData` made, with the clone's files planted, so the baseline's record can be read back. */
async function saveBaseline(options: {
  readonly lineage?: readonly string[];
  readonly plant: (filesystem: UnreadableFiles) => Promise<void>;
  readonly vanishingPaths?: readonly string[];
  readonly vanishingAfterLstatPaths?: readonly string[];
}): Promise<Made> {
  const database = await memorySourceDatabase();
  const filesystem = new UnreadableFiles();
  await plantManagedDevice(filesystem);
  await options.plant(filesystem);
  for (const path of options.vanishingPaths ?? []) filesystem.vanishing.add(path);
  for (const path of options.vanishingAfterLstatPaths ?? []) {
    filesystem.vanishingAfterLstat.add(path);
  }
  const opener = new FakeSqliteOpener(filesystem);
  const logger = new RecordingLogger();
  const runner = new ScriptedProcessRunner([
    { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
    { match: simctl("shutdown", driverData.udid) },
    {
      match: simctl("clone", driverData.udid, "simlock-baseline-device-1", sourcesSetPath),
      result: { code: 0, stderr: "", stdout: `${baselineUdid}\n` },
    },
  ]);
  const driver = await createDriver(
    runner,
    new FakeClock(),
    filesystem,
    database,
    logger,
    undefined,
    {
      sqliteOpener: opener,
    },
  );
  const error = await driver
    .saveSource({
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData: {
        ...driverData,
        ...(options.lineage === undefined ? {} : { lineage: options.lineage }),
      },
      physical: false,
    })
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
  return { database, error, filesystem, logger, opener, runner };
}

function recorded(database: SqliteDatabase): unknown[] {
  return database
    .prepare("SELECT relative_path, kind FROM ios_source_files ORDER BY relative_path")
    .all();
}

function storedLineage(database: SqliteDatabase): unknown {
  return database.prepare("SELECT lineage, saved_without_lineage FROM ios_source_data").get();
}

describe("IosSimctlDriver source records", () => {
  it("a source made is flushed, its lineage stored and every file or link naming the lineage recorded before it turns ready", async () => {
    const naming = Buffer.from(`root /Devices/${lineageUdid}/data`);
    const big = Buffer.alloc(64 * MEBIBYTE + 100);
    naming.copy(big, big.length - naming.length);

    const seed = await provisionNewSeed({
      plant: async (filesystem) => {
        await plantBytes(filesystem, `${seedFolder}/data/a.plist`, naming);
        await plantBytes(filesystem, `${seedFolder}/data/big.bin`, big);
        await plantBytes(filesystem, `${seedFolder}/data/wide.bin`, utf16be(lineageUdid));
        await plantBytes(filesystem, `${seedFolder}/data/none.txt`, Buffer.from("nothing"));
        await plantBytes(filesystem, `${seedFolder}/data/one.db`, SQLITE_HEADER);
        await plantBytes(filesystem, `${seedFolder}/data/one.db-wal`, naming);
        await plantBytes(filesystem, `${seedFolder}/data/one.db-shm`, Buffer.from("index"));
        await plantBytes(filesystem, `${seedFolder}/data/two.db`, SQLITE_HEADER);
        await plantBytes(filesystem, `${seedFolder}/data/two.db-wal`, naming);
        filesystem.defineSymlink(`${seedFolder}/data/Logs`, `${logsRoot}/${lineageUdid}`);
      },
    });

    expect(seed.error).toBeUndefined();
    expect(seed.opener.checkpoints.sort()).toEqual([
      `${seedFolder}/data/one.db`,
      `${seedFolder}/data/two.db`,
    ]);
    expect(storedLineage(seed.database)).toEqual({
      lineage: JSON.stringify([lineageUdid]),
      saved_without_lineage: 0,
    });
    expect(recorded(seed.database)).toEqual([
      { kind: "link", relative_path: "data/Logs" },
      { kind: "file", relative_path: "data/a.plist" },
      { kind: "file", relative_path: "data/big.bin" },
      { kind: "file", relative_path: "data/one.db" },
      { kind: "file", relative_path: "data/two.db" },
      { kind: "file", relative_path: "data/wide.bin" },
    ]);
    expect(seed.logger.warnings).toEqual([]);

    const unflushed = await provisionNewSeed({
      failingDatabases: [`${seedFolder}/data/one.db`],
      keepingFrames: [`${seedFolder}/data/two.db`],
      plant: async (filesystem) => {
        await plantBytes(filesystem, `${seedFolder}/data/one.db`, SQLITE_HEADER);
        await plantBytes(filesystem, `${seedFolder}/data/one.db-wal`, naming);
        await plantBytes(filesystem, `${seedFolder}/data/two.db`, SQLITE_HEADER);
        await plantBytes(filesystem, `${seedFolder}/data/two.db-wal`, naming);
      },
    });
    expect(unflushed.error).toBeUndefined();
    expect(unflushed.logger.warnings).toEqual([
      `could not flush ${seedFolder}/data/one.db: unable to open database file ${seedFolder}/data/one.db`,
      `WAL ${seedFolder}/data/two.db-wal still holds frames after the flush; left unpatched`,
    ]);
    expect(
      recorded(unflushed.database),
      "a WAL is never recorded, and a database whose frames stayed names nothing",
    ).toEqual([]);

    const unreadable = await provisionNewSeed({
      plant: async (filesystem) => {
        await plantBytes(filesystem, `${seedFolder}/data/secret.db`, naming);
        await plantBytes(filesystem, `${seedFolder}/data/other.txt`, Buffer.from("nothing"));
      },
      unreadablePaths: [`${seedFolder}/data/secret.db`],
    });
    expect(unreadable.error).toBeUndefined();
    expect(recorded(unreadable.database)).toEqual([
      { kind: "unreadable", relative_path: "data/secret.db" },
    ]);
    expect(unreadable.logger.warnings).toEqual([
      `could not read ${seedFolder}/data/secret.db in source ${seedUdid}: EACCES: permission denied, open '${seedFolder}/data/secret.db'; recorded as unreadable`,
    ]);

    const namingNothing = await provisionNewSeed({
      plant: (filesystem) =>
        plantBytes(filesystem, `${seedFolder}/data/none.txt`, Buffer.from("nothing")),
    });
    expect(namingNothing.error).toBeUndefined();
    expect(recorded(namingNothing.database)).toEqual([]);
    expect(storedLineage(namingNothing.database)).toEqual({
      lineage: JSON.stringify([lineageUdid]),
      saved_without_lineage: 0,
    });

    const walkFails = await provisionNewSeed({
      failingPaths: [`${seedFolder}/data/sealed`],
      plant: async (filesystem) => {
        await plantBytes(filesystem, `${seedFolder}/data/sealed/a.plist`, naming);
        await plantBytes(filesystem, `${seedFolder}/data/b.plist`, naming);
      },
    });
    expect(walkFails.error).toMatchObject({ code: "EACCES" });
    expect(
      walkFails.runner.calls.some(
        (call) => call.args.join(" ") === `simctl --set ${sourcesSetPath} delete ${seedUdid}`,
      ),
      "the seed's clone is deleted",
    ).toBe(true);
    expect(walkFails.database.prepare("SELECT source_id FROM ios_source_data").all()).toEqual([]);
    expect(recorded(walkFails.database)).toEqual([]);

    const baselineFolder = `${sourcesSetPath}/${baselineUdid}`;
    const lease = driverData.udid.toUpperCase();
    const fromUsedLease = await saveBaseline({
      lineage: [lineageUdid],
      plant: async (filesystem) => {
        await plantBytes(filesystem, `${baselineFolder}/data/lease.plist`, Buffer.from(lease));
        await plantBytes(filesystem, `${baselineFolder}/data/seed.plist`, naming);
        await plantBytes(filesystem, `${baselineFolder}/data/none.txt`, Buffer.from("nothing"));
        await plantBytes(filesystem, `${baselineFolder}/data/one.db`, SQLITE_HEADER);
        await plantBytes(filesystem, `${baselineFolder}/data/one.db-wal`, naming);
      },
    });
    expect(fromUsedLease.error).toBeUndefined();
    expect(fromUsedLease.opener.checkpoints).toEqual([`${baselineFolder}/data/one.db`]);
    expect(storedLineage(fromUsedLease.database)).toEqual({
      lineage: JSON.stringify([lease, lineageUdid]),
      saved_without_lineage: 0,
    });
    expect(recorded(fromUsedLease.database)).toEqual([
      { kind: "file", relative_path: "data/lease.plist" },
      { kind: "file", relative_path: "data/one.db" },
      { kind: "file", relative_path: "data/seed.plist" },
    ]);

    const fromOldDevice = await saveBaseline({
      plant: (filesystem) =>
        plantBytes(filesystem, `${baselineFolder}/data/lease.plist`, Buffer.from(lease)),
    });
    expect(fromOldDevice.error).toBeUndefined();
    expect(storedLineage(fromOldDevice.database)).toEqual({
      lineage: null,
      saved_without_lineage: 1,
    });
    expect(recorded(fromOldDevice.database)).toEqual([]);
  });

  it("a baseline is saved when files listed in its clone are gone before the walk reaches them, and only the files still there are recorded", async () => {
    const baselineFolder = `${sourcesSet}/${baselineUdid}`;
    const lease = driverData.udid.toUpperCase();
    const topTemp = `${baselineFolder}/device.plist.sb-55c05b11-ISuHtw`;
    const nestedTemp = `${baselineFolder}/data/Library/Preferences/app.plist.sb-0a1b2c3d-QwErTy`;

    const saved = await saveBaseline({
      lineage: [lineageUdid],
      plant: async (filesystem) => {
        await plantBytes(filesystem, `${baselineFolder}/device.plist`, Buffer.from(lease));
        await plantBytes(filesystem, topTemp, Buffer.from(lease));
        await plantBytes(
          filesystem,
          `${baselineFolder}/data/Library/Preferences/app.plist`,
          Buffer.from(lease),
        );
        await plantBytes(filesystem, nestedTemp, Buffer.from(lease));
      },
      vanishingPaths: [topTemp, nestedTemp],
    });

    expect(saved.error).toBeUndefined();
    expect(saved.database.prepare("SELECT state FROM ios_source_data").all()).toEqual([
      { state: "ready" },
    ]);
    expect(recorded(saved.database)).toEqual([
      { kind: "file", relative_path: "data/Library/Preferences/app.plist" },
      { kind: "file", relative_path: "device.plist" },
    ]);
    expect(saved.logger.warnings).toEqual([]);
  });

  it("a baseline is saved when a file in its clone is renamed away after the walk reaches it but before it is read, and the file is not recorded", async () => {
    const baselineFolder = `${sourcesSet}/${baselineUdid}`;
    const lease = driverData.udid.toUpperCase();
    const temp = `${baselineFolder}/device.plist.sb-55c05b11-ISuHtw`;

    const saved = await saveBaseline({
      lineage: [lineageUdid],
      plant: async (filesystem) => {
        await plantBytes(filesystem, `${baselineFolder}/device.plist`, Buffer.from(lease));
        await plantBytes(filesystem, temp, Buffer.from(lease));
      },
      vanishingAfterLstatPaths: [temp],
    });

    expect(saved.error).toBeUndefined();
    expect(recorded(saved.database)).toEqual([{ kind: "file", relative_path: "device.plist" }]);
    expect(saved.logger.warnings).toEqual([]);
  });
});
