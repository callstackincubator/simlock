/**
 * why: What a gateway persists of its worker registry (ADR 0005, Decision 3; ADR 0036 §1): which
 * workers an operator has drained.
 *
 * Everything else on a view is rebuilt from the workers themselves on reconnect, which is why
 * this table holds ids and nothing else. Drain cannot be rebuilt that way -- it is an operator's
 * decision about a machine, not a fact the machine reports -- and losing it is the one failure
 * mode that matters: a gateway restart, or a worker reconnecting after a reboot, would silently
 * put a machine that was taken out of service back into rotation.
 */
import type { Logger, SqliteDatabase, SqliteSchemaOwner } from "../ports/index.js";
import { inTransaction, NoopLogger } from "../ports/index.js";

export interface DrainStore {
  load(): Promise<readonly string[]>;
  save(drainedWorkerIds: readonly string[]): Promise<void>;
}

export const drainedWorkersOwner: SqliteSchemaOwner = {
  migrations: ["CREATE TABLE drained_workers (worker_id TEXT PRIMARY KEY) STRICT;"],
  name: "drained-workers",
  version: 1,
};

export interface StateDrainStoreOptions {
  readonly database: SqliteDatabase;
  readonly logger?: Logger;
}

/** why: The drained ids in the gateway's `state.db`. A failing statement never stops the gateway: a
 * read error forgets the drains and logs, a write error logs and is swallowed, because the drain
 * already holds in memory and refusing to start would take a fleet's routing offline to protect a flag.
 */
export class StateDrainStore implements DrainStore {
  readonly #logger: Logger;

  constructor(private readonly options: StateDrainStoreOptions) {
    this.#logger = options.logger ?? new NoopLogger();
  }

  async load(): Promise<readonly string[]> {
    try {
      const rows = this.options.database
        .prepare("SELECT worker_id FROM drained_workers ORDER BY rowid")
        .all();
      return rows.map((row) => String(row["worker_id"]));
    } catch (error: unknown) {
      this.#logger.error("Could not read the gateway's worker registry; drains are forgotten", {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async save(drainedWorkerIds: readonly string[]): Promise<void> {
    const { database } = this.options;
    try {
      inTransaction(database, () => {
        database.exec("DELETE FROM drained_workers");
        const insert = database.prepare("INSERT INTO drained_workers (worker_id) VALUES (?)");
        for (const id of drainedWorkerIds) insert.run(id);
      });
    } catch (error: unknown) {
      this.#logger.error("Could not persist the gateway's worker registry", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** For tests and for a gateway with nowhere to write: remembers nothing across a restart. */
export class MemoryDrainStore implements DrainStore {
  #drained: readonly string[] = [];

  async load(): Promise<readonly string[]> {
    return this.#drained;
  }

  async save(drainedWorkerIds: readonly string[]): Promise<void> {
    this.#drained = [...drainedWorkerIds];
  }
}
