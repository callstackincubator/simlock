import {
  NodeSqliteOpener,
  type Filesystem,
  type SqliteDatabase,
  type SqliteOpener,
} from "../../ports/index.js";
import { iosSourceDataOwner, IosSourceTable, type SourceFile } from "./source-data.js";

export async function memorySourceDatabase(): Promise<SqliteDatabase> {
  const database = await new NodeSqliteOpener().open(":memory:", { readOnly: false });
  for (const migration of iosSourceDataOwner.migrations) database.exec(migration);
  return database;
}

export interface PlantedSource {
  readonly deviceTypeId: string;
  readonly files?: readonly SourceFile[];
  /** why: a source made before ADR 0076's index, which only a row of an earlier release has; absent means indexed. */
  readonly indexed?: false;
  readonly kind?: "seed" | "baseline";
  readonly maker?: string;
  readonly model?: string;
  readonly osVersion?: string;
  readonly runtimeBuild?: string;
  readonly runtimeId: string;
  readonly setPath?: string;
  readonly sizeBytes?: number;
  readonly state?: "making" | "ready";
  readonly udid?: string;
}

/** why: a source row as an earlier process, or an earlier call of this one, left it, so a test starts from the row and not from the make. */
export function plantSource(database: SqliteDatabase, source: PlantedSource): SqliteDatabase {
  const table = new IosSourceTable(database);
  const sourceId = `planted-${source.udid ?? source.maker ?? "making"}-${source.runtimeId}`;
  table.insertMaking({
    createdAt: 0,
    deviceTypeId: source.deviceTypeId,
    kind: source.kind ?? "seed",
    maker: source.maker ?? "planted",
    model: source.model ?? "iPhone 16",
    osVersion: source.osVersion ?? "26.5",
    runtimeBuild: source.runtimeBuild,
    runtimeId: source.runtimeId,
    setPath: source.setPath ?? "/home/.simlock/devices/src____",
    sourceId,
    specKey: `${source.deviceTypeId}\u0000${source.runtimeId}`,
  });
  if (source.udid !== undefined) table.setUdid(sourceId, source.udid);
  if (source.state !== "making") table.markReady(sourceId, source.sizeBytes, source.files ?? []);
  if (source.indexed === false) {
    database.prepare("UPDATE ios_source_data SET indexed = 0 WHERE source_id = ?").run(sourceId);
  }
  return database;
}

export function plantReadySeed(
  database: SqliteDatabase,
  seed: Omit<PlantedSource, "state"> & { readonly udid: string },
): SqliteDatabase {
  return plantSource(database, seed);
}

/** why: stands in for the opener that flushes a source's databases: closing a checkpointed database deletes its `-wal` and `-shm` files, as SQLite does, and a path in `failing` cannot be opened. */
export class FakeSqliteOpener implements SqliteOpener {
  readonly flushed: string[] = [];
  readonly failing = new Set<string>();
  readonly #filesystem: Filesystem;

  constructor(filesystem: Filesystem) {
    this.#filesystem = filesystem;
  }

  async open(path: string, options: { readonly readOnly: boolean }): Promise<SqliteDatabase> {
    if (options.readOnly) throw new Error(`${path} is opened read-write to flush it`);
    if (this.failing.has(path)) throw new Error("database is locked");
    return {
      close: () => {
        if (this.flushed.at(-1) !== path) return;
        void this.#filesystem.rm(`${path}-wal`);
        void this.#filesystem.rm(`${path}-shm`);
      },
      exec: (sql) => {
        if (sql !== "PRAGMA wal_checkpoint(TRUNCATE)") throw new Error(`unexpected ${sql}`);
        this.flushed.push(path);
      },
      prepare: () => {
        throw new Error("a flush runs one pragma and nothing else");
      },
    };
  }
}
