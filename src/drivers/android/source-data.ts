import type { SqliteDatabase, SqliteSchemaOwner } from "../../ports/index.js";

export const androidSourceDataOwner: SqliteSchemaOwner = {
  migrations: [
    `CREATE TABLE android_source_data (
       source_id TEXT PRIMARY KEY,
       kind TEXT NOT NULL CHECK (kind IN ('seed', 'baseline')),
       state TEXT NOT NULL CHECK (state IN ('making', 'ready')),
       spec_key TEXT NOT NULL,
       model TEXT NOT NULL,
       os_version TEXT NOT NULL,
       image_tag TEXT NOT NULL,
       folder TEXT NOT NULL,
       avd_name TEXT NOT NULL,
       image_identity TEXT NOT NULL,
       emulator_version TEXT NOT NULL,
       config_hash TEXT,
       size_bytes INTEGER,
       stale_reason TEXT,
       created_at INTEGER NOT NULL
     ) STRICT`,
    `CREATE UNIQUE INDEX android_source_data_ready_seed ON android_source_data (spec_key)
       WHERE kind = 'seed' AND state = 'ready'`,
  ],
  name: "android-source-data",
  version: 1,
};

export interface NewSourceRow {
  readonly sourceId: string;
  readonly kind: "seed" | "baseline";
  readonly specKey: string;
  readonly model: string;
  readonly osVersion: string;
  readonly imageTag: string;
  readonly folder: string;
  readonly avdName: string;
  readonly imageIdentity: string;
  readonly emulatorVersion: string;
  readonly createdAt: number;
}

export interface SourceRow {
  readonly sourceId: string;
  readonly kind: "seed" | "baseline";
  readonly specKey: string;
  readonly model: string;
  readonly osVersion: string;
  readonly imageTag: string;
  readonly folder: string;
  readonly avdName: string;
  readonly configHash: string;
  readonly sizeBytes: number | undefined;
}

/** why: the one place that reads or writes `android_source_data`; nothing outside the Android driver does (ADR 0036 §2). */
export class AndroidSourceTable {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  insertMaking(row: NewSourceRow): void {
    this.#database
      .prepare(
        `INSERT INTO android_source_data (source_id, kind, state, spec_key, model, os_version, image_tag,
           folder, avd_name, image_identity, emulator_version, created_at)
         VALUES (?, ?, 'making', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.sourceId,
        row.kind,
        row.specKey,
        row.model,
        row.osVersion,
        row.imageTag,
        row.folder,
        row.avdName,
        row.imageIdentity,
        row.emulatorVersion,
        row.createdAt,
      );
  }

  markReady(sourceId: string, configHash: string, sizeBytes: number | undefined): void {
    this.#database
      .prepare(
        "UPDATE android_source_data SET state = 'ready', config_hash = ?, size_bytes = ? WHERE source_id = ?",
      )
      .run(configHash, sizeBytes ?? null, sourceId);
  }

  findReadySeed(specKey: string): SourceRow | undefined {
    return this.#rows("WHERE kind = 'seed' AND state = 'ready' AND spec_key = ?", [specKey])[0];
  }

  readyRows(): readonly SourceRow[] {
    return this.#rows("WHERE state = 'ready' ORDER BY created_at, source_id", []);
  }

  #rows(where: string, parameters: readonly (string | number)[]): readonly SourceRow[] {
    return this.#database
      .prepare(
        `SELECT source_id, kind, spec_key, model, os_version, image_tag, folder, avd_name, config_hash, size_bytes
         FROM android_source_data ${where}`,
      )
      .all(...parameters)
      .map((row) => ({
        sourceId: row["source_id"] as string,
        kind: row["kind"] as "seed" | "baseline",
        specKey: row["spec_key"] as string,
        model: row["model"] as string,
        osVersion: row["os_version"] as string,
        imageTag: row["image_tag"] as string,
        folder: row["folder"] as string,
        avdName: row["avd_name"] as string,
        configHash: (row["config_hash"] as string | null) ?? "",
        sizeBytes: (row["size_bytes"] as number | null) ?? undefined,
      }));
  }
}
