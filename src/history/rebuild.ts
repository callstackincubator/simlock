import type { SqliteDatabase } from "../ports/index.js";
import { inTransaction, parseEnvelope } from "./database.js";
import type { HistoryProjectionDefinition, ProjectionHandle } from "./index.js";
import { markRebuilding, markRebuilt } from "./versions.js";

const REBUILD_BATCH = 1_000;

interface RebuildTarget {
  readonly definition: HistoryProjectionDefinition;
  readonly projector: ProjectionHandle;
}

const SELECT_BATCH_SQL =
  "SELECT rowid AS id, envelope FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?";

export async function rebuildProjections(settings: {
  readonly database: SqliteDatabase;
  readonly targets: readonly RebuildTarget[];
  readonly isStopped: () => boolean;
  readonly resume: () => void;
}): Promise<"done" | "stopped"> {
  const { database, targets } = settings;
  // why: the mark stays until the last batch, so a stop or a crash mid-way makes the next start rebuild again.
  inTransaction(database, () => {
    for (const { definition } of targets) markRebuilding(database, definition.name);
  });
  const clear = () =>
    inTransaction(database, () => {
      const oldest = database.prepare("SELECT MIN(timestamp) AS oldest FROM events").get()?.oldest;
      for (const { projector } of targets) {
        projector.rebuild(typeof oldest === "number" ? oldest : undefined);
      }
    });
  clear();
  try {
    return await replayBatches(settings);
  } catch (error: unknown) {
    // why: earlier batches committed, so a throw leaves their rows; the events' window is emptied again.
    clear();
    throw error;
  }
}

async function replayBatches(settings: {
  readonly database: SqliteDatabase;
  readonly targets: readonly RebuildTarget[];
  readonly isStopped: () => boolean;
  readonly resume: () => void;
}): Promise<"done" | "stopped"> {
  const { database, isStopped, resume, targets } = settings;
  let cursor = 0;
  for (;;) {
    await new Promise<void>((next) => setImmediate(next));
    if (isStopped()) return "stopped";
    const finished = inTransaction(database, () => {
      const rows = database.prepare(SELECT_BATCH_SQL).all(cursor, REBUILD_BATCH);
      for (const row of rows) {
        const envelope = parseEnvelope(row.envelope);
        if (envelope === undefined) continue;
        for (const { projector } of targets) projector.apply(envelope);
      }
      const last = rows.at(-1);
      if (last !== undefined) cursor = Number(last.id);
      return rows.length < REBUILD_BATCH;
    });
    if (finished) {
      inTransaction(database, () => {
        for (const { definition } of targets) markRebuilt(database, definition);
      });
      // why: in the same tick as the last batch, so no event lands between the cursor reaching the end and live steps starting again.
      resume();
      return "done";
    }
  }
}
