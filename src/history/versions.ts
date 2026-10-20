import type { SqliteDatabase } from "../ports/index.js";
import { inTransaction } from "./database.js";
import type { HistoryProjectionDefinition } from "./index.js";

const SET_VERSION_SQL = `INSERT INTO projection_versions (name, version) VALUES (?, ?)
  ON CONFLICT (name) DO UPDATE SET version = excluded.version`;

function storedVersion(database: SqliteDatabase, name: string): number {
  const row = database.prepare("SELECT version FROM projection_versions WHERE name = ?").get(name);
  return row === undefined ? 0 : Number(row.version);
}

export function isMarkedRebuilding(database: SqliteDatabase, name: string): boolean {
  const row = database
    .prepare("SELECT rebuilding FROM projection_versions WHERE name = ?")
    .get(name);
  return row !== undefined && Number(row.rebuilding) !== 0;
}

export function migrateProjection(
  database: SqliteDatabase,
  projection: HistoryProjectionDefinition,
): void {
  const stored = storedVersion(database, projection.name);
  if (stored > projection.version) {
    throw new Error(
      `History projection ${projection.name} is at version ${stored}; this simlock knows up to ${projection.version}. Upgrade simlock, or move history.db away.`,
    );
  }
  for (let from = stored; from < projection.version; from += 1) {
    try {
      inTransaction(database, () => {
        database.exec(projection.migrations[from] ?? "");
        database.prepare(SET_VERSION_SQL).run(projection.name, from + 1);
      });
    } catch (error: unknown) {
      throw new Error(
        `History projection ${projection.name} could not move from version ${from} to ${from + 1}: ${error instanceof Error ? error.message : String(error)}. Upgrade simlock, or move history.db away.`,
        { cause: error },
      );
    }
  }
}

export function markRebuilding(database: SqliteDatabase, name: string): void {
  database
    .prepare(
      `INSERT INTO projection_versions (name, version, rebuilding) VALUES (?, 0, 1)
       ON CONFLICT (name) DO UPDATE SET rebuilding = 1`,
    )
    .run(name);
}

export function markRebuilt(
  database: SqliteDatabase,
  projection: HistoryProjectionDefinition,
): void {
  database
    .prepare(
      `INSERT INTO projection_versions (name, version, rebuilding) VALUES (?, ?, 0)
       ON CONFLICT (name) DO UPDATE SET version = excluded.version, rebuilding = 0`,
    )
    .run(projection.name, projection.version);
}
