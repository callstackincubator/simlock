import { join } from "node:path";
import { inTransaction, type SqliteDatabase, type SqliteSchemaOwner } from "../../ports/index.js";

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
    // why: a step per version; version 1 once listed the index as a second entry that never ran, so a v1 database may hold several ready seeds of one kind. Keep the newest (a tie: the larger source id) and demote the rest so the index can be built.
    `UPDATE ios_source_data SET state = 'making'
       WHERE kind = 'seed' AND state = 'ready' AND EXISTS (
         SELECT 1 FROM ios_source_data AS newer
         WHERE newer.kind = 'seed' AND newer.state = 'ready' AND newer.spec_key = ios_source_data.spec_key
           AND (newer.created_at > ios_source_data.created_at
             OR (newer.created_at = ios_source_data.created_at AND newer.source_id > ios_source_data.source_id)));
     CREATE UNIQUE INDEX ios_source_data_ready_seed ON ios_source_data (spec_key)
       WHERE kind = 'seed' AND state = 'ready';`,
    // why: ADR 0076: the throwaway a seed was copied from, kept so a restart mid-make can delete it through the row.
    "ALTER TABLE ios_source_data ADD COLUMN throwaway_udid TEXT",
    // why: ADR 0076: the UDIDs a source was copied from (null: made before lineages were kept), the files that name them, and whether a baseline was saved from a device that had no lineage.
    `ALTER TABLE ios_source_data ADD COLUMN lineage TEXT;
     ALTER TABLE ios_source_data ADD COLUMN saved_without_lineage INTEGER NOT NULL DEFAULT 0;
     CREATE TABLE ios_source_files (
       source_id TEXT NOT NULL,
       relative_path TEXT NOT NULL CHECK (length(CAST(relative_path AS BLOB)) <= 4096),
       kind TEXT NOT NULL CHECK (kind IN ('link', 'file', 'unreadable')),
       PRIMARY KEY (source_id, relative_path)
     ) STRICT;`,
    // why: ADR 0090: the plain leases copied from a seed, whether it is a settled copy, and, on the row of a settle or of the quick seed it retires, the seed the settle replaces or was replaced by.
    `ALTER TABLE ios_source_data ADD COLUMN lease_count INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE ios_source_data ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE ios_source_data ADD COLUMN settle_of TEXT;`,
  ],
  name: "ios-source-data",
  version: 5,
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
  readonly throwawayUdid: string | undefined;
  readonly deviceTypeId: string;
  readonly runtimeId: string;
  readonly runtimeBuild: string | undefined;
  readonly model: string;
  readonly osVersion: string;
  readonly state: "making" | "ready";
  readonly maker: string;
  readonly sizeBytes: number | undefined;
  readonly lineage: readonly string[] | undefined;
  readonly savedWithoutLineage: boolean;
}

export interface ReadySeed {
  readonly sourceId: string;
  readonly udid: string;
  readonly runtimeBuild: string | undefined;
  readonly lineage: readonly string[] | undefined;
}

export interface SourceFile {
  readonly relativePath: string;
  readonly kind: "link" | "file" | "unreadable";
}

/** why: what a source records when it is made: the UDIDs it came from and the files that name them. */
export interface SourceRecord {
  readonly lineage: readonly string[] | undefined;
  readonly files: readonly SourceFile[];
  readonly savedWithoutLineage?: boolean;
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

  setThrowaway(sourceId: string, udid: string): void {
    this.#database
      .prepare("UPDATE ios_source_data SET throwaway_udid = ? WHERE source_id = ?")
      .run(udid, sourceId);
  }

  markReady(sourceId: string, sizeBytes: number | undefined, record: SourceRecord): void {
    inTransaction(this.#database, () => {
      this.#database
        .prepare(
          `UPDATE ios_source_data SET state = 'ready', size_bytes = ?, lineage = ?, saved_without_lineage = ?
           WHERE source_id = ?`,
        )
        .run(
          sizeBytes ?? null,
          record.lineage === undefined ? null : JSON.stringify(record.lineage),
          record.savedWithoutLineage === true ? 1 : 0,
          sourceId,
        );
      const insert = this.#database.prepare(
        "INSERT INTO ios_source_files (source_id, relative_path, kind) VALUES (?, ?, ?)",
      );
      for (const file of record.files) insert.run(sourceId, file.relativePath, file.kind);
    });
  }

  filesOf(sourceId: string): readonly SourceFile[] {
    return this.#database
      .prepare("SELECT relative_path, kind FROM ios_source_files WHERE source_id = ?")
      .all(sourceId)
      .map((row) => ({
        relativePath: row["relative_path"] as string,
        kind: row["kind"] as SourceFile["kind"],
      }));
  }

  deleteRow(sourceId: string): void {
    inTransaction(this.#database, () => {
      this.#database.prepare("DELETE FROM ios_source_files WHERE source_id = ?").run(sourceId);
      this.#database.prepare("DELETE FROM ios_source_data WHERE source_id = ?").run(sourceId);
    });
  }

  findReadySeed(specKey: string): ReadySeed | undefined {
    const row = this.#database
      .prepare(
        "SELECT source_id, udid, runtime_build, lineage FROM ios_source_data WHERE kind = 'seed' AND state = 'ready' AND spec_key = ?",
      )
      .get(specKey);
    if (row === undefined) return undefined;
    return {
      sourceId: row["source_id"] as string,
      udid: row["udid"] as string,
      runtimeBuild: (row["runtime_build"] as string | null) ?? undefined,
      lineage: parseLineage(row["lineage"]),
    };
  }

  makingRowsNotMadeBy(maker: string): readonly SourceRow[] {
    return this.#rows("WHERE state = 'making' AND maker != ?", [maker]);
  }

  makingRowsOfKindBefore(
    maker: string,
    specKey: string,
    createdBefore: number,
  ): readonly SourceRow[] {
    return this.#rows("WHERE state = 'making' AND maker = ? AND spec_key = ? AND created_at < ?", [
      maker,
      specKey,
      createdBefore,
    ]);
  }

  makingThrowaways(): readonly string[] {
    return this.#database
      .prepare(
        "SELECT throwaway_udid FROM ios_source_data WHERE state = 'making' AND throwaway_udid IS NOT NULL",
      )
      .all()
      .map((row) => row["throwaway_udid"] as string);
  }

  allUdids(): readonly string[] {
    return this.#database
      .prepare("SELECT udid FROM ios_source_data WHERE udid IS NOT NULL")
      .all()
      .map((row) => row["udid"] as string);
  }

  findRow(sourceId: string): SourceRow | undefined {
    return this.#rows("WHERE source_id = ?", [sourceId])[0];
  }

  readyRows(): readonly SourceRow[] {
    return this.#rows("WHERE state = 'ready' ORDER BY created_at, source_id", []);
  }

  #rows(where: string, parameters: readonly (string | number)[]): readonly SourceRow[] {
    return this.#database
      .prepare(
        `SELECT source_id, kind, udid, throwaway_udid, device_type_id, runtime_id, runtime_build, model, os_version,
           state, maker, size_bytes, lineage, saved_without_lineage FROM ios_source_data ${where}`,
      )
      .all(...parameters)
      .map((row) => ({
        sourceId: row["source_id"] as string,
        kind: row["kind"] as "seed" | "baseline",
        udid: (row["udid"] as string | null) ?? undefined,
        throwawayUdid: (row["throwaway_udid"] as string | null) ?? undefined,
        deviceTypeId: row["device_type_id"] as string,
        runtimeId: row["runtime_id"] as string,
        runtimeBuild: (row["runtime_build"] as string | null) ?? undefined,
        model: row["model"] as string,
        osVersion: row["os_version"] as string,
        state: row["state"] as "making" | "ready",
        maker: row["maker"] as string,
        sizeBytes: (row["size_bytes"] as number | null) ?? undefined,
        lineage: parseLineage(row["lineage"]),
        savedWithoutLineage: row["saved_without_lineage"] === 1,
      }));
  }
}

function parseLineage(value: unknown): readonly string[] | undefined {
  return typeof value === "string" ? (JSON.parse(value) as string[]) : undefined;
}

export function sourcesSetFor(simlockHome: string, deviceRoot: string, owned: boolean): string {
  return owned ? join(deviceRoot, "sources") : join(simlockHome, "devices", "ios-sources");
}
