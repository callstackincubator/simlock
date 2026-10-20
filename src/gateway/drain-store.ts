/**
 * The one thing a gateway persists (ADR 0005, Decision 3: the worker registry is gateway
 * state): which workers an operator has drained.
 *
 * Everything else on a view is rebuilt from the workers themselves on reconnect, which is why
 * this file holds ids and nothing else. Drain cannot be rebuilt that way -- it is an operator's
 * decision about a machine, not a fact the machine reports -- and losing it is the one failure
 * mode that matters: a gateway restart, or a worker reconnecting after a reboot, would silently
 * put a machine that was taken out of service back into rotation.
 */
import type { Logger, SqliteDatabase, SqliteSchemaOwner } from "../ports/index.js";

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

export class StateDrainStore implements DrainStore {
  constructor(private readonly options: StateDrainStoreOptions) {}

  async load(): Promise<readonly string[]> {
    return [];
  }

  async save(_drainedWorkerIds: readonly string[]): Promise<void> {}
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
