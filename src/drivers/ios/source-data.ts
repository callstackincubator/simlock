import type { SqliteDatabase, SqliteSchemaOwner } from "../../ports/index.js";

export const iosSourceDataOwner: SqliteSchemaOwner = {
  migrations: [
    `CREATE TABLE ios_source_data (
       source_id TEXT PRIMARY KEY,
       kind TEXT NOT NULL CHECK (kind IN ('seed', 'baseline')),
       spec_key TEXT NOT NULL,
       udid TEXT,
       set_path TEXT NOT NULL,
       device_type_id TEXT NOT NULL,
       runtime_id TEXT NOT NULL,
       runtime_build TEXT,
       model TEXT NOT NULL,
       os_version TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('making', 'ready')),
       maker TEXT NOT NULL,
       size_bytes INTEGER,
       stale_reason TEXT,
       created_at INTEGER NOT NULL
     ) STRICT`,
    `CREATE UNIQUE INDEX ios_source_data_ready_seed ON ios_source_data (spec_key)
       WHERE kind = 'seed' AND state = 'ready'`,
  ],
  name: "ios-source-data",
  version: 1,
};

export interface NewSourceRow {
  readonly sourceId: string;
  readonly kind: "seed" | "baseline";
  readonly specKey: string;
  readonly setPath: string;
  readonly deviceTypeId: string;
  readonly runtimeId: string;
  readonly runtimeBuild: string | undefined;
  readonly model: string;
  readonly osVersion: string;
  readonly maker: string;
  readonly createdAt: number;
}

export interface SourceRow {
  readonly sourceId: string;
  readonly kind: "seed" | "baseline";
  readonly udid: string | undefined;
  readonly deviceTypeId: string;
  readonly runtimeId: string;
  readonly runtimeBuild: string | undefined;
  readonly model: string;
  readonly osVersion: string;
  readonly state: "making" | "ready";
  readonly maker: string;
  readonly sizeBytes: number | undefined;
}

export interface ReadySeed {
  readonly sourceId: string;
  readonly udid: string;
  readonly runtimeBuild: string | undefined;
}

/** why: the one place that reads or writes `ios_source_data`; nothing outside the iOS driver does (ADR 0036 §2). */
export class IosSourceTable {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  insertMaking(row: NewSourceRow): void {
    this.#database
      .prepare(
        `INSERT INTO ios_source_data (source_id, kind, spec_key, set_path, device_type_id, runtime_id,
           runtime_build, model, os_version, state, maker, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'making', ?, ?)`,
      )
      .run(
        row.sourceId,
        row.kind,
        row.specKey,
        row.setPath,
        row.deviceTypeId,
        row.runtimeId,
        row.runtimeBuild ?? null,
        row.model,
        row.osVersion,
        row.maker,
        row.createdAt,
      );
  }

  setUdid(sourceId: string, udid: string): void {
    this.#database
      .prepare("UPDATE ios_source_data SET udid = ? WHERE source_id = ?")
      .run(udid, sourceId);
  }

  markReady(sourceId: string, sizeBytes: number | undefined): void {
    this.#database
      .prepare("UPDATE ios_source_data SET state = 'ready', size_bytes = ? WHERE source_id = ?")
      .run(sizeBytes ?? null, sourceId);
  }

  deleteRow(sourceId: string): void {
    this.#database.prepare("DELETE FROM ios_source_data WHERE source_id = ?").run(sourceId);
  }

  findReadySeed(specKey: string): ReadySeed | undefined {
    const row = this.#database
      .prepare(
        "SELECT source_id, udid, runtime_build FROM ios_source_data WHERE kind = 'seed' AND state = 'ready' AND spec_key = ?",
      )
      .get(specKey);
    if (row === undefined) return undefined;
    return {
      sourceId: row["source_id"] as string,
      udid: row["udid"] as string,
      runtimeBuild: (row["runtime_build"] as string | null) ?? undefined,
    };
  }

  makingRowsNotMadeBy(maker: string): readonly SourceRow[] {
    return this.#rows("WHERE state = 'making' AND maker != ?", [maker]);
  }

  readyRows(): readonly SourceRow[] {
    return this.#rows("WHERE state = 'ready' ORDER BY created_at, source_id", []);
  }

  #rows(where: string, parameters: readonly string[]): readonly SourceRow[] {
    return this.#database
      .prepare(
        `SELECT source_id, kind, udid, device_type_id, runtime_id, runtime_build, model, os_version,
           state, maker, size_bytes FROM ios_source_data ${where}`,
      )
      .all(...parameters)
      .map((row) => ({
        sourceId: row["source_id"] as string,
        kind: row["kind"] as "seed" | "baseline",
        udid: (row["udid"] as string | null) ?? undefined,
        deviceTypeId: row["device_type_id"] as string,
        runtimeId: row["runtime_id"] as string,
        runtimeBuild: (row["runtime_build"] as string | null) ?? undefined,
        model: row["model"] as string,
        osVersion: row["os_version"] as string,
        state: row["state"] as "making" | "ready",
        maker: row["maker"] as string,
        sizeBytes: (row["size_bytes"] as number | null) ?? undefined,
      }));
  }
}
