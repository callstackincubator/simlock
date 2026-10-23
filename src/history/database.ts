import type { EventEnvelope } from "../bus/index.js";
import { EVENT_ID_PATTERN } from "../contract/index.js";
import type { SqliteDatabase } from "../ports/index.js";

export const BUSY_TIMEOUT_MS = 5_000;

export const INSERT_EVENT_SQL =
  "INSERT OR IGNORE INTO events (id, timestamp, seq, size, envelope) VALUES (?, ?, ?, ?, ?)";

// why: a row of bad JSON must index as no worker; a bare json_extract on it throws "malformed JSON" and fails the index build
const ENVELOPE_FIELD = (path: string) =>
  `(CASE WHEN json_valid(envelope) THEN json_extract(envelope, '${path}') END)`;
const WORKER_ID_SQL = ENVELOPE_FIELD("$.payload.workerId");

// why: a refused dial's workerId is only what the connection claimed, so worker.rejected never belongs to a worker
const WORKER_FILTER_SQL = `${WORKER_ID_SQL} = ? AND ${ENVELOPE_FIELD("$.event")} <> 'worker.rejected'`;

const WORKER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS events_worker ON events (${WORKER_ID_SQL}, timestamp, seq)`;

function filtered(workerId: string | undefined): string {
  return workerId === undefined ? "" : ` AND ${WORKER_FILTER_SQL}`;
}

function selectSinceSql(workerId: string | undefined): string {
  return `SELECT envelope FROM events WHERE timestamp > ?${filtered(workerId)} ORDER BY timestamp, seq, rowid`;
}

const SELECT_CURSOR_SQL = "SELECT timestamp, seq, rowid AS position FROM events WHERE id = ?";

function selectBeforeSql(workerId: string | undefined): string {
  return `SELECT envelope FROM events WHERE (timestamp, seq, rowid) < (?, ?, ?)${filtered(workerId)} ORDER BY timestamp DESC, seq DESC, rowid DESC LIMIT ?`;
}

function selectNewestSql(workerId: string | undefined): string {
  return `SELECT envelope FROM events ${workerId === undefined ? "" : `WHERE ${WORKER_FILTER_SQL} `}ORDER BY timestamp DESC, seq DESC, rowid DESC LIMIT ?`;
}

function withWorker(
  workerId: string | undefined,
  before: readonly (string | number)[],
  after: readonly number[] = [],
): (string | number)[] {
  return [...before, ...(workerId === undefined ? [] : [workerId]), ...after];
}

const SELECT_OLDEST_SQL = "SELECT timestamp FROM events ORDER BY timestamp, seq, rowid LIMIT 1";

export function configureDatabase(database: SqliteDatabase): void {
  database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA auto_vacuum=INCREMENTAL");
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=NORMAL");
  database.exec(
    `CREATE TABLE IF NOT EXISTS events (
       id TEXT PRIMARY KEY,
       timestamp INTEGER NOT NULL,
       seq INTEGER NOT NULL,
       size INTEGER NOT NULL,
       envelope TEXT NOT NULL
     )`,
  );
  database.exec("CREATE INDEX IF NOT EXISTS events_timestamp ON events (timestamp, seq)");
  database.exec(
    `CREATE TABLE IF NOT EXISTS projection_versions (
       name TEXT PRIMARY KEY,
       version INTEGER NOT NULL,
       rebuilding INTEGER NOT NULL DEFAULT 0
     )`,
  );
}

// why: run after the file has opened, never inside `configureDatabase`, whose throws count as damage
export function createWorkerIndex(database: SqliteDatabase): void {
  database.exec(WORKER_INDEX_SQL);
}

export function inTransaction<T>(database: SqliteDatabase, work: () => T): T {
  database.exec("BEGIN");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // why: the connection may already have ended the transaction; the first error is the one to report
    }
    throw error;
  }
}

export function envelopeSize(json: string): number {
  return Buffer.byteLength(json, "utf8");
}

export function selectEventsSince(
  database: SqliteDatabase,
  sinceTs: number,
  workerId?: string,
): EventEnvelope[] {
  return parseEnvelopes(
    database.prepare(selectSinceSql(workerId)).all(...withWorker(workerId, [sinceTs])),
  );
}

function parseEnvelopes(rows: readonly Record<string, unknown>[]): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  for (const row of rows) {
    const envelope = parseEnvelope(row.envelope);
    if (envelope !== undefined) events.push(envelope);
  }
  return events;
}

export function selectEventsBefore(
  database: SqliteDatabase,
  beforeId: string,
  limit: number,
  workerId?: string,
): EventEnvelope[] | undefined {
  const cursor = database.prepare(SELECT_CURSOR_SQL).get(beforeId);
  if (cursor === undefined) return undefined;
  const rows = database
    .prepare(selectBeforeSql(workerId))
    .all(
      ...withWorker(
        workerId,
        [Number(cursor.timestamp), Number(cursor.seq), Number(cursor.position)],
        [limit],
      ),
    );
  return parseEnvelopes(rows).reverse();
}

export function selectNewestEvents(
  database: SqliteDatabase,
  limit: number,
  workerId?: string,
): EventEnvelope[] {
  return parseEnvelopes(
    database.prepare(selectNewestSql(workerId)).all(...withWorker(workerId, [], [limit])),
  ).reverse();
}

export function isWorkerEvent(envelope: EventEnvelope, workerId: string | undefined): boolean {
  if (workerId === undefined) return true;
  return (
    envelope.event !== "worker.rejected" &&
    (envelope.payload as { workerId?: unknown } | null)?.workerId === workerId
  );
}

export function selectOldestTimestamp(database: SqliteDatabase): number | undefined {
  const row = database.prepare(SELECT_OLDEST_SQL).get();
  return row === undefined ? undefined : Number(row.timestamp);
}

export function parseEnvelope(stored: unknown): EventEnvelope | undefined {
  if (typeof stored !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    !EVENT_ID_PATTERN.test((value as { id: string }).id)
  ) {
    return undefined;
  }
  return value as EventEnvelope;
}
