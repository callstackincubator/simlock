import { inTransaction, type SqliteDatabase, type SqliteSchemaOwner } from "../../ports/index.js";

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
    // why: a step per version; version 1 once listed the index as a second entry that never ran, so a v1 database may hold several ready seeds of one kind. Keep the newest (a tie: the larger source id) and demote the rest so the index can be built.
    `UPDATE android_source_data SET state = 'making'
       WHERE kind = 'seed' AND state = 'ready' AND EXISTS (
         SELECT 1 FROM android_source_data AS newer
         WHERE newer.kind = 'seed' AND newer.state = 'ready' AND newer.spec_key = android_source_data.spec_key
           AND (newer.created_at > android_source_data.created_at
             OR (newer.created_at = android_source_data.created_at AND newer.source_id > android_source_data.source_id)));
     CREATE UNIQUE INDEX android_source_data_ready_seed ON android_source_data (spec_key)
       WHERE kind = 'seed' AND state = 'ready';`,
    // why: ADR 0090: the plain leases copied from a seed, whether it is a settled copy, and, on the row of a settle and of the quick seed it retires, the seed the settle replaces or was replaced by.
    `ALTER TABLE android_source_data ADD COLUMN lease_count INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE android_source_data ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE android_source_data ADD COLUMN settle_of TEXT;`,
  ],
  name: "android-source-data",
  version: 3,
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
  /** why: the quick seed a settle replaces; set on the row of a settle only. */
  readonly settleOf?: string;
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
  readonly createdAt: number;
  readonly emulatorVersion: string;
  readonly imageIdentity: string;
  readonly sizeBytes: number | undefined;
  readonly staleReason: string | undefined;
  readonly state: "making" | "ready";
  readonly settled: boolean;
  readonly leaseCount: number;
  readonly settleOf: string | undefined;
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
           folder, avd_name, image_identity, emulator_version, created_at, settle_of)
         VALUES (?, ?, 'making', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.settleOf ?? null,
      );
  }

  /** why: one statement, so two leases at once both count. */
  addLease(sourceId: string): void {
    this.#database
      .prepare("UPDATE android_source_data SET lease_count = lease_count + 1 WHERE source_id = ?")
      .run(sourceId);
  }

  /** why: ADR 0090 §3: one transaction, so a reader sees the quick seed or the settled one as the kind's ready seed, never both and never neither; the retired row stays, `making`, until its folder is gone. */
  promoteSettled(
    settleId: string,
    retiredId: string,
    configHash: string,
    sizeBytes: number | undefined,
  ): void {
    inTransaction(this.#database, () => {
      this.#database
        .prepare(
          "UPDATE android_source_data SET state = 'making', settle_of = ? WHERE source_id = ?",
        )
        .run(settleId, retiredId);
      this.#database
        .prepare(
          "UPDATE android_source_data SET state = 'ready', settled = 1, settle_of = NULL, config_hash = ?, size_bytes = ? WHERE source_id = ?",
        )
        .run(configHash, sizeBytes ?? null, settleId);
    });
  }

  markReady(sourceId: string, configHash: string, sizeBytes: number | undefined): void {
    this.#database
      .prepare(
        "UPDATE android_source_data SET state = 'ready', config_hash = ?, size_bytes = ? WHERE source_id = ?",
      )
      .run(configHash, sizeBytes ?? null, sourceId);
  }

  /** why: the reason is recomputed on every provision and listing, so what is stored is the last answer; `undefined` clears it. */
  setStaleReason(sourceId: string, reason: string | undefined): void {
    this.#database
      .prepare("UPDATE android_source_data SET stale_reason = ? WHERE source_id = ?")
      .run(reason ?? null, sourceId);
  }

  remove(sourceId: string): void {
    this.#database.prepare("DELETE FROM android_source_data WHERE source_id = ?").run(sourceId);
  }

  findReadySeed(specKey: string): SourceRow | undefined {
    return this.#rows("WHERE kind = 'seed' AND state = 'ready' AND spec_key = ?", [specKey])[0];
  }

  findRow(sourceId: string): SourceRow | undefined {
    return this.#rows("WHERE source_id = ?", [sourceId])[0];
  }

  /** why: every row in any state, so a folder under the sources set is an orphan only when none names it. */
  allIds(): readonly string[] {
    return this.#rows("", []).map((row) => row.sourceId);
  }

  makingRows(): readonly SourceRow[] {
    return this.#rows("WHERE state = 'making' ORDER BY created_at, source_id", []);
  }

  readyRows(): readonly SourceRow[] {
    return this.#rows("WHERE state = 'ready' ORDER BY created_at, source_id", []);
  }

  #rows(where: string, parameters: readonly (string | number)[]): readonly SourceRow[] {
    return this.#database
      .prepare(
        `SELECT source_id, kind, spec_key, model, os_version, image_tag, folder, avd_name, config_hash, size_bytes,
           emulator_version, image_identity, stale_reason, created_at, state, settled, lease_count, settle_of
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
        createdAt: row["created_at"] as number,
        emulatorVersion: row["emulator_version"] as string,
        imageIdentity: row["image_identity"] as string,
        sizeBytes: (row["size_bytes"] as number | null) ?? undefined,
        staleReason: (row["stale_reason"] as string | null) ?? undefined,
        state: row["state"] as "making" | "ready",
        settled: row["settled"] === 1,
        leaseCount: row["lease_count"] as number,
        settleOf: (row["settle_of"] as string | null) ?? undefined,
      }));
  }
}
