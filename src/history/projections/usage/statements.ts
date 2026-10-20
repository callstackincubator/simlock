import type { SqliteDatabase, SqliteStatement } from "../../../ports/index.js";

/**
 * why: prepared on first use and not at create, because a table that fails the check must not
 * stop the history from opening; the rebuild then clears the cache after it recreates tables.
 */
export class Statements {
  readonly #database: SqliteDatabase;
  readonly #cache = new Map<string, SqliteStatement>();

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  get(sql: string): SqliteStatement {
    let statement = this.#cache.get(sql);
    if (statement === undefined) {
      statement = this.#database.prepare(sql);
      this.#cache.set(sql, statement);
    }
    return statement;
  }

  clear(): void {
    this.#cache.clear();
  }
}
