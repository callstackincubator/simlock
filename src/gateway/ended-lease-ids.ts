/**
 * why: ADR 0074 §4: a gateway remembers the chosen lease ids its workers reported ended, so a late retry
 * of the same request is refused with `LEASE_ENDED` instead of being granted a new device.
 *
 * Like the drain store, a failing statement never stops the gateway: a failed write means the end is
 * not recorded, and a failed read means the id is treated as absent, so the request goes on to a worker,
 * which answers for its own leases.
 */
import type { Clock, Logger, SqliteDatabase, SqliteSchemaOwner } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";

export interface EndedLeaseIds {
  /** why: remembers that the chosen `leaseId` ended at `endedAt` (milliseconds since the epoch); a newer end replaces an older one. */
  record(leaseId: string, endedAt: number): void;
  /** why: when `leaseId` ended, while that is inside the retention window. */
  endedAt(leaseId: string): number | undefined;
}

export const endedLeaseIdsOwner: SqliteSchemaOwner = {
  migrations: [
    "CREATE TABLE ended_lease_ids (lease_id TEXT PRIMARY KEY, ended_at INTEGER NOT NULL) STRICT;",
  ],
  name: "ended-lease-ids",
  version: 1,
};

export interface StateEndedLeaseIdsOptions {
  readonly clock: Pick<Clock, "now">;
  readonly database: SqliteDatabase;
  /** why: `lease.endedIdRetentionMs`, counted from the recorded end. */
  readonly retentionMs: number;
  readonly logger?: Logger;
}

export class StateEndedLeaseIds implements EndedLeaseIds {
  readonly #logger: Logger;

  constructor(private readonly options: StateEndedLeaseIdsOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#attempt("prune", () => this.#prune());
  }

  record(leaseId: string, endedAt: number): void {
    this.#attempt("record", () => {
      this.options.database
        .prepare("INSERT OR REPLACE INTO ended_lease_ids (lease_id, ended_at) VALUES (?, ?)")
        .run(leaseId, endedAt);
      this.#prune();
    });
  }

  endedAt(leaseId: string): number | undefined {
    return this.#attempt("read", () => {
      const row = this.options.database
        .prepare("SELECT ended_at FROM ended_lease_ids WHERE lease_id = ?")
        .get(leaseId);
      if (row === undefined) return undefined;
      const endedAt = Number(row["ended_at"]);
      return this.options.clock.now() - endedAt > this.options.retentionMs ? undefined : endedAt;
    });
  }

  #prune(): void {
    this.options.database
      .prepare("DELETE FROM ended_lease_ids WHERE ended_at < ?")
      .run(this.options.clock.now() - this.options.retentionMs);
  }

  #attempt<T>(what: string, run: () => T): T | undefined {
    try {
      return run();
    } catch (error: unknown) {
      this.#logger.error(`Could not ${what} the gateway's ended lease ids`, {
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

/** why: for tests and for a gateway with nowhere to write: remembers nothing across a restart. */
export class MemoryEndedLeaseIds implements EndedLeaseIds {
  readonly #ended = new Map<string, number>();

  constructor(
    private readonly options: { readonly clock: Pick<Clock, "now">; readonly retentionMs: number },
  ) {}

  record(leaseId: string, endedAt: number): void {
    this.#ended.set(leaseId, endedAt);
  }

  endedAt(leaseId: string): number | undefined {
    const endedAt = this.#ended.get(leaseId);
    if (endedAt === undefined) return undefined;
    return this.options.clock.now() - endedAt > this.options.retentionMs ? undefined : endedAt;
  }
}
