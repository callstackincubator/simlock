import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { OWNED_ROOT_MARKER_FILE } from "../../src/core/index.js";
import { emptyDeviceSet, iosDeviceSet, setDevices, simctlInSet } from "./ios-device-set.js";
import { removeHome } from "./remove-home.js";

type Row = Record<string, string | number | null>;

interface KeptSeed {
  readonly table: string;
  readonly row: Row;
}

interface SeedTable {
  readonly table: string;
  folderOf(row: Row): string;
}

// why: a seed is a row and a folder (ADR 0061), and each driver names the folder in its own columns.
const SEED_TABLES: readonly SeedTable[] = [
  {
    folderOf: (row) => join(String(row["set_path"]), String(row["udid"])),
    table: "ios_source_data",
  },
  { folderOf: (row) => String(row["folder"]), table: "android_source_data" },
];

const KEPT_SEEDS_FILE = "kept-seeds.json";
// why: the instance id has to stay, because each device root's marker names it and a root naming another instance is refused.
const KEPT_ENTRIES = new Set(["instance.json", "devices", KEPT_SEEDS_FILE]);

let claimed = false;

/** why: the name is outside `simlock-e2e-*`, which `sweepStaleDeviceSets` empties once a home's device set is an hour old; the variable gives the helper's own test a home no other run shares. */
function laneHomePath(): string {
  return process.env.SIMLOCK_E2E_LANE_HOME ?? join(tmpdir(), "simlock-lane-home");
}

/**
 * why: one machine runs one real-driver worker (ADR 0059), so one home can serve every flow in
 * turn. Whatever a failed teardown left in it is cleared first.
 */
export async function claimLaneHome(): Promise<string> {
  if (claimed) {
    throw new Error("the lane home is taken: two envs with keepSeeds cannot be open at once");
  }
  claimed = true;
  const home = laneHomePath();
  try {
    await mkdir(home, { mode: 0o700, recursive: true });
    await resetLaneHome(home);
  } catch (error: unknown) {
    claimed = false;
    throw error;
  }
  return home;
}

export async function releaseLaneHome(home: string): Promise<void> {
  try {
    await resetLaneHome(home);
  } finally {
    claimed = false;
  }
}

export function hasKeptSeeds(home: string): boolean {
  return existsSync(join(home, KEPT_SEEDS_FILE));
}

/** why: called once a daemon has made the home's `state.db` and stopped, so the seed tables exist and nothing else writes them. */
export async function restoreKeptSeeds(home: string): Promise<void> {
  const seeds = JSON.parse(await readFile(join(home, KEPT_SEEDS_FILE), "utf8")) as KeptSeed[];
  const database = new DatabaseSync(join(home, "state.db"));
  try {
    for (const { table, row } of seeds) {
      const columns = Object.keys(row);
      database
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...columns.map((column) => row[column] ?? null));
    }
  } finally {
    database.close();
  }
}

/** why: what the daemon made between a restore's start and stop (its event history, log and admin secret) is not the flow's, and `state.db` holds the tables the seeds go back into. */
export async function clearAllButState(home: string): Promise<void> {
  for (const entry of await readdir(home)) {
    if (KEPT_ENTRIES.has(entry) || entry.startsWith("state.db")) continue;
    await removeHome(join(home, entry));
  }
}

/**
 * why: the next flow must find a home no flow has used, but for the seeds: every other row,
 * file and device folder goes. A home whose seeds cannot be read is emptied whole, so no seed
 * folder is left without its row for `doctor` to report.
 */
async function resetLaneHome(home: string): Promise<void> {
  try {
    const seeds = await readySeeds(home);
    if (existsSync(iosDeviceSet(home))) await emptyDeviceSet(iosDeviceSet(home));
    await removeAllBut(home, KEPT_ENTRIES);
    await removeAllBut(
      join(home, "devices", "android"),
      new Set(["sources", OWNED_ROOT_MARKER_FILE]),
    );
    await pruneSources(home, seeds);
    // why: the file's presence is what sends the next env through a daemon start and stop to put the rows back.
    if (seeds.length === 0) await removeHome(join(home, KEPT_SEEDS_FILE));
    else await writeFile(join(home, KEPT_SEEDS_FILE), JSON.stringify(seeds), "utf8");
  } catch {
    await removeAllBut(home, new Set());
  }
}

async function removeAllBut(directory: string, kept: ReadonlySet<string>): Promise<void> {
  for (const entry of await readdir(directory).catch(() => [])) {
    if (!kept.has(entry)) await removeHome(join(directory, entry));
  }
}

/** why: with no `state.db` the last reset already removed it, so the seeds are the ones that reset kept. */
async function readySeeds(home: string): Promise<KeptSeed[]> {
  const path = join(home, "state.db");
  if (!existsSync(path)) {
    if (!hasKeptSeeds(home)) return [];
    const kept = JSON.parse(await readFile(join(home, KEPT_SEEDS_FILE), "utf8")) as KeptSeed[];
    return kept.filter((seed) => existsSync(folderOf(seed)));
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return SEED_TABLES.flatMap(({ table }) =>
      readyRows(database, table).map((row) => ({ row, table })),
    ).filter((seed) => existsSync(folderOf(seed)));
  } finally {
    database.close();
  }
}

/**
 * why: the iOS driver's seed key holds a NUL, and `node:sqlite` hands a text value back cut at
 * its first NUL, so a key read as text no longer matches the driver's lookup. Every text column
 * is read as bytes and decoded here.
 */
function readyRows(database: DatabaseSync, table: string): Row[] {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
  }[];
  if (columns.length === 0) return [];
  const selected = columns.map(({ name, type }) =>
    type === "TEXT" ? `CAST(${name} AS BLOB) AS ${name}` : name,
  );
  return database
    .prepare(`SELECT ${selected.join(", ")} FROM ${table} WHERE kind = 'seed' AND state = 'ready'`)
    .all()
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([name, value]) => [
          name,
          value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value,
        ]),
      ),
    ) as Row[];
}

function folderOf(seed: KeptSeed): string {
  const table = SEED_TABLES.find((entry) => entry.table === seed.table);
  if (table === undefined) throw new Error(`no seed table ${seed.table}`);
  return table.folderOf(seed.row);
}

/**
 * why: a baseline's source, or a seed whose making never ended, sits in the same folders with no
 * kept row; the next flow's `doctor` would report it as an orphan. Folders are matched by name:
 * a driver may record its root under another spelling of the home (`/private/tmp` for `/tmp`).
 */
async function pruneSources(home: string, seeds: readonly KeptSeed[]): Promise<void> {
  const kept = new Set(seeds.map((seed) => basename(folderOf(seed))));
  const iosSources = join(iosDeviceSet(home), "sources");
  if (existsSync(iosSources)) {
    for (const device of await setDevices(iosSources)) {
      if (kept.has(device.udid)) continue;
      await simctlInSet(iosSources, ["shutdown", device.udid]).catch(() => undefined);
      await simctlInSet(iosSources, ["delete", device.udid]);
    }
  }
  const androidSources = join(home, "devices", "android", "sources");
  for (const entry of await readdir(androidSources).catch(() => [])) {
    if (!kept.has(entry)) await removeHome(join(androidSources, entry));
  }
}
