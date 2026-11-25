import { closeSync, openSync } from "node:fs";

import type { MemoryFilesystem } from "./filesystem.js";
import { errorMessage } from "../shared/index.js";

export interface SqliteRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
  run(...parameters: SqliteValue[]): SqliteRunResult;
  get(...parameters: SqliteValue[]): Record<string, unknown> | undefined;
  all(...parameters: SqliteValue[]): Record<string, unknown>[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteSchemaOwner {
  readonly name: string;
  readonly version: number;
  readonly migrations: readonly string[];
}

export interface SqliteOpener {
  open(path: string, options: { readonly readOnly: boolean }): Promise<SqliteDatabase>;
}

export class SqliteUnavailableError extends Error {}

export class NodeSqliteOpener implements SqliteOpener {
  async open(path: string, options: { readonly readOnly: boolean }): Promise<SqliteDatabase> {
    let engine: typeof import("node:sqlite");
    try {
      engine = await import("node:sqlite");
    } catch (error: unknown) {
      throw new SqliteUnavailableError(errorMessage(error));
    }
    // why: SQLite creates a missing file 0644 (less the umask) and gives -wal and -shm the main
    // file's mode, so creating it 0600 first keeps all three owner-only, like the other local state.
    if (!options.readOnly && path !== ":memory:") closeSync(openSync(path, "a", 0o600));
    return new engine.DatabaseSync(path, { readOnly: options.readOnly });
  }
}

/**
 * why: a fake for a caller that opens a database only to flush its WAL: it records each database
 * a checkpoint ran on, can fail one, and a checkpoint moves the `-wal` file's bytes onto the end of
 * its database in a memory filesystem and empties the WAL, unless told to leave its frames.
 */
export class FakeSqliteOpener implements SqliteOpener {
  readonly checkpoints: string[] = [];
  readonly #filesystem: MemoryFilesystem;
  readonly #failing: ReadonlySet<string>;
  readonly #keepingFrames: ReadonlySet<string>;

  constructor(
    filesystem: MemoryFilesystem,
    options: {
      readonly failing?: readonly string[];
      readonly keepingFrames?: readonly string[];
    } = {},
  ) {
    this.#filesystem = filesystem;
    this.#failing = new Set(options.failing);
    this.#keepingFrames = new Set(options.keepingFrames);
  }

  async open(path: string): Promise<SqliteDatabase> {
    if (this.#failing.has(path)) throw new Error(`unable to open database file ${path}`);
    // why: `exec` is synchronous, so what a checkpoint moves is read here, and the filesystem calls
    // below run their bodies at once.
    const wal = `${path}-wal`;
    const frames = await this.#filesystem.readFile(wal).then(
      (text) => Buffer.from(text),
      () => undefined,
    );
    const size = frames === undefined ? 0 : (await this.#filesystem.stat(path)).size;
    let emptied = false;
    const checkpoint = (): void => {
      this.checkpoints.push(path);
      if (this.#keepingFrames.has(path)) return;
      if (frames !== undefined) void this.#filesystem.writeAt(path, size, frames);
      void this.#filesystem.rm(wal);
      emptied = true;
    };
    return {
      // why: like SQLite, the last connection to close after a full checkpoint removes the `-shm` beside the emptied WAL.
      close: () => {
        if (emptied) void this.#filesystem.rm(`${path}-shm`);
      },
      exec: (sql) => {
        if (sql === "PRAGMA wal_checkpoint(TRUNCATE)") checkpoint();
      },
      prepare: () => {
        throw new Error("FakeSqliteOpener runs no statements");
      },
    };
  }
}

const SQLITE_WARNING_PREFIX = "SQLite is an experimental feature";

export function filterSqliteExperimentalWarning(): void {
  const emit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const first = rest[0];
    const type = typeof first === "string" ? first : (first as { type?: string } | undefined)?.type;
    const name = typeof warning === "string" ? type : (type ?? warning.name);
    const message = typeof warning === "string" ? warning : warning.message;
    if (name === "ExperimentalWarning" && message.startsWith(SQLITE_WARNING_PREFIX)) return;
    (emit as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export function inTransaction<T>(database: SqliteDatabase, work: () => T): T {
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

export function passesQuickCheck(database: SqliteDatabase): boolean {
  const rows = database.prepare("PRAGMA quick_check").all();
  return rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok";
}

export function isLockError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { errcode, message } = error as { errcode?: unknown; message?: unknown };
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
  }
  return typeof message === "string" && /database (table )?is locked|busy/i.test(message);
}
