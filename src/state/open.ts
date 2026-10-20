import type {
  Filesystem,
  Logger,
  SqliteDatabase,
  SqliteOpener,
  SqliteSchemaOwner,
} from "../ports/index.js";

export const STATE_DB_NAME = "state.db";

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

export function openStateDatabase(_options: OpenStateDatabaseOptions): Promise<StateDatabase> {
  return Promise.resolve({
    close: () => undefined,
    database: {} as SqliteDatabase,
    transaction: (work) => work(),
  });
}
