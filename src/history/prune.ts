import type { SqliteDatabase } from "../ports/index.js";
import { inTransaction } from "./database.js";

const SIZE_STEP_ROWS = 1_000;

export interface PruneSettings {
  readonly now: number;
  readonly retention: number;
  readonly maxBytes: number;
  readonly projections: ReadonlyArray<{ prune(now: number): void }>;
}

export function totalEventBytes(database: SqliteDatabase): number {
  return Number(
    database.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM events").get()?.total,
  );
}

export function pruneHistory(
  database: SqliteDatabase,
  settings: PruneSettings,
  storedBytes: number,
): number {
  let total = storedBytes;
  const cutoff = settings.now - settings.retention;
  total -= inTransaction(database, () => {
    const removed = Number(
      database
        .prepare("SELECT COALESCE(SUM(size), 0) AS removed FROM events WHERE timestamp < ?")
        .get(cutoff)?.removed,
    );
    database.prepare("DELETE FROM events WHERE timestamp < ?").run(cutoff);
    return removed;
  });
  while (total > settings.maxBytes) {
    const step = inTransaction(database, () => {
      const oldest = "SELECT rowid FROM events ORDER BY timestamp, rowid LIMIT ?";
      const removed = Number(
        database
          .prepare(
            `SELECT COALESCE(SUM(size), 0) AS removed FROM events WHERE rowid IN (${oldest})`,
          )
          .get(SIZE_STEP_ROWS)?.removed,
      );
      const result = database
        .prepare(`DELETE FROM events WHERE rowid IN (${oldest})`)
        .run(SIZE_STEP_ROWS);
      return { deleted: Number(result.changes), removed };
    });
    if (step.deleted === 0) break;
    total -= step.removed;
  }
  inTransaction(database, () => {
    for (const projection of settings.projections) projection.prune(settings.now);
  });
  database.exec("PRAGMA incremental_vacuum");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return total;
}
