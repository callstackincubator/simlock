import { join } from "node:path";

import {
  type Filesystem,
  inTransaction,
  isLockError,
  type Logger,
  passesQuickCheck,
  type SqliteDatabase,
  type SqliteOpener,
  type SqliteSchemaOwner,
  SqliteUnavailableError,
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

class StateRefusal extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateRefusal";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function damaged(path: string, detail: string, cause: unknown): StateRefusal {
  return new StateRefusal(
    `${path} is damaged (${detail}). Move it away to start with empty state; every device and lease it held is forgotten.`,
    { cause },
  );
}

function refusalFor(error: unknown, path: string): StateRefusal {
  if (error instanceof StateRefusal) return error;
  if (isLockError(error)) {
    return new StateRefusal(
      `${path} is locked by another process. Stop the other Simlock daemon using it, then start again.`,
      { cause: error },
    );
  }
  return damaged(path, `open: ${describe(error)}`, error);
}

export async function openStateDatabase(options: OpenStateDatabaseOptions): Promise<StateDatabase> {
  const { dataDirectory, filesystem, owners } = options;
  for (const name of options.oldFiles) {
    const oldFile = join(dataDirectory, name);
    if (await filesystem.exists(oldFile)) {
      throw new StateRefusal(
        `Found ${oldFile}, which this Simlock no longer reads. To upgrade: ${options.upgradeStep.replaceAll("<path>", oldFile)} See https://callstackincubator.github.io/simlock/docs/worker/running-the-daemon#upgrade-simlock.`,
      );
    }
  }
  await filesystem.mkdirp(dataDirectory);
  const path = join(dataDirectory, STATE_DB_NAME);
  let database: SqliteDatabase | undefined;
  try {
    database = await options.sqlite.open(path, { readOnly: false });
    configure(database);
    check(database, path);
    migrate(database, owners, path, options.logger);
  } catch (error: unknown) {
    try {
      database?.close();
    } catch {
      // why: the open already failed; the refusal is what the caller must see
    }
    if (error instanceof SqliteUnavailableError) {
      throw new StateRefusal("node:sqlite is not available; Simlock needs Node 22.13 or later.", {
        cause: error,
      });
    }
    throw refusalFor(error, path);
  }
  return stateDatabase(database);
}

function configure(database: SqliteDatabase): void {
  database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=NORMAL");
}

function check(database: SqliteDatabase, path: string): void {
  let first: unknown;
  try {
    if (passesQuickCheck(database)) return;
    first = Object.values(database.prepare("PRAGMA quick_check").all()[0] ?? {})[0];
  } catch (error: unknown) {
    if (isLockError(error)) throw error;
    throw damaged(path, `quick_check: ${describe(error)}`, error);
  }
  throw damaged(path, `quick_check: ${String(first)}`, undefined);
}

function stateDatabase(database: SqliteDatabase): StateDatabase {
  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
    },
    database,
    transaction: (work) => inTransaction(database, work),
  };
}

function migrate(
  database: SqliteDatabase,
  owners: readonly SqliteSchemaOwner[],
  path: string,
  logger: Logger,
): void {
  inTransaction(database, () => {
    database.exec(
      "CREATE TABLE IF NOT EXISTS schema_versions (owner TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT",
    );
    for (const owner of owners) migrateOwner(database, owner, path, logger);
  });
}

function migrateOwner(
  database: SqliteDatabase,
  owner: SqliteSchemaOwner,
  path: string,
  logger: Logger,
): void {
  const row = database
    .prepare("SELECT version FROM schema_versions WHERE owner = ?")
    .get(owner.name);
  const stored = row === undefined ? 0 : Number(row.version);
  if (stored > owner.version) {
    throw new StateRefusal(
      `${owner.name} in ${path} is at version ${String(stored)}; this Simlock knows up to ${String(owner.version)}. Upgrade Simlock, or move state.db away.`,
    );
  }
  if (stored === owner.version) return;
  for (let from = stored; from < owner.version; from += 1) {
    try {
      database.exec(owner.migrations[from] ?? "");
    } catch (error: unknown) {
      if (isLockError(error)) throw error;
      throw new StateRefusal(
        `${owner.name} in ${path} could not move from version ${String(from)} to ${String(from + 1)}: ${describe(error)}. Upgrade Simlock, or move state.db away.`,
        { cause: error },
      );
    }
    logger.debug("Moved a state.db schema owner up one version", {
      from,
      owner: owner.name,
      to: from + 1,
    });
  }
  database
    .prepare(
      `INSERT INTO schema_versions (owner, version) VALUES (?, ?)
       ON CONFLICT (owner) DO UPDATE SET version = excluded.version`,
    )
    .run(owner.name, owner.version);
}
