import { join } from "node:path";

import type {
  Filesystem,
  Logger,
  SqliteDatabase,
  SqliteOpener,
  SqliteSchemaOwner,
} from "../ports/index.js";

export const STATE_DB_NAME = "state.db";

const BUSY_TIMEOUT_MS = 5_000;

export interface OpenStateDatabaseOptions {
  readonly dataDirectory: string;
  readonly sqlite: SqliteOpener;
  readonly filesystem: Filesystem;
  readonly owners: readonly SqliteSchemaOwner[];
  readonly oldFiles: readonly string[];
  readonly upgradeStep: string;
  readonly logger: Logger;
}

export interface StateDatabase {
  readonly database: SqliteDatabase;
  transaction<T>(work: () => T): T;
  close(): void;
}

export async function openStateDatabase(options: OpenStateDatabaseOptions): Promise<StateDatabase> {
  await options.filesystem.mkdirp(options.dataDirectory);
  const database = await options.sqlite.open(join(options.dataDirectory, STATE_DB_NAME), {
    readOnly: false,
  });
  configure(database);
  migrate(database, options.owners, options.logger);
  return stateDatabase(database);
}

export function configure(database: SqliteDatabase): void {
  database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=NORMAL");
}

export function stateDatabase(database: SqliteDatabase): StateDatabase {
  return {
    close: () => database.close(),
    database,
    transaction: (work) => inTransaction(database, work),
  };
}

function inTransaction<T>(database: SqliteDatabase, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
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

export function migrate(
  database: SqliteDatabase,
  owners: readonly SqliteSchemaOwner[],
  logger: Logger,
): void {
  inTransaction(database, () => {
    database.exec(
      "CREATE TABLE IF NOT EXISTS schema_versions (owner TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT",
    );
    for (const owner of owners) {
      const row = database
        .prepare("SELECT version FROM schema_versions WHERE owner = ?")
        .get(owner.name);
      const stored = row === undefined ? 0 : Number(row.version);
      for (let from = stored; from < owner.version; from += 1) {
        database.exec(owner.migrations[from] ?? "");
        logger.debug("Moved a state.db schema owner up one version", {
          from,
          owner: owner.name,
          to: from + 1,
        });
      }
      if (stored < owner.version) {
        database
          .prepare(
            `INSERT INTO schema_versions (owner, version) VALUES (?, ?)
             ON CONFLICT (owner) DO UPDATE SET version = excluded.version`,
          )
          .run(owner.name, owner.version);
      }
    }
  });
}
