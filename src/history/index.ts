import { join } from "node:path";

import type { EventBus, EventEnvelope } from "../bus/index.js";
import {
  type Clock,
  type Filesystem,
  isMissingPathError,
  isLockError,
  type Logger,
  passesQuickCheck,
  type SqliteDatabase,
  type SqliteOpener,
  SqliteUnavailableError,
} from "../ports/index.js";
import {
  BUSY_TIMEOUT_MS,
  configureDatabase,
  envelopeSize,
  INSERT_EVENT_SQL,
  selectEventsBefore,
  selectEventsSince,
  selectNewestEvents,
  selectOldestTimestamp,
} from "./database.js";
import { HISTORY_DB_NAME } from "./names.js";
import { pruneHistory, totalEventBytes } from "./prune.js";
import { rebuildProjections } from "./rebuild.js";
import { setAsideDamagedHistory } from "./set-aside.js";
import { isMarkedRebuilding, migrateProjection } from "./versions.js";

export { HISTORY_DB_NAME } from "./names.js";
export { HISTORY_PROJECTIONS, openUsageReads } from "./projections/index.js";
export type { DeviceFactRow, MinuteBucket, RequestRow } from "./projections/index.js";

const PRUNE_INTERVAL_MS = 3_600_000;

export interface HistoryProjectionDefinition {
  readonly name: string;
  readonly version: number;
  readonly migrations: readonly string[];
  check(database: SqliteDatabase): boolean;
  create(database: SqliteDatabase, options: HistoryProjectionOptions): ProjectionHandle;
}

export interface ProjectionHandle {
  apply(envelope: EventEnvelope): void;
  prune(now: number): void;
  rebuild(oldestEventAt: number | undefined): void;
}

export interface HistoryProjectionOptions {
  readonly fleet: boolean;
  readonly metricsRetentionMs: number;
}

export interface EventHistoryStatus {
  readonly opened: boolean;
  readonly writing: boolean;
  readonly setAsideAt?: number;
  readonly rebuiltAt?: number;
  readonly rebuildFailed?: true;
}

export type EventsPageRead =
  | { readonly kind: "events"; readonly events: EventEnvelope[] }
  | { readonly kind: "not-kept"; readonly oldestTs: number }
  | { readonly kind: "unavailable" };

export interface EventHistoryHandle {
  replay(input?: { readonly sinceTs?: number }): Promise<EventEnvelope[]>;
  replayPage(input: {
    readonly beforeId?: string;
    readonly limit: number;
  }): Promise<EventsPageRead>;
  status(): EventHistoryStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface EventHistoryOptions {
  readonly bus: EventBus;
  readonly sqlite: SqliteOpener;
  readonly filesystem: Filesystem;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dataDirectory: string;
  readonly config: { readonly retention: number; readonly maxBytes: number };
  readonly projections: readonly HistoryProjectionDefinition[];
  readonly projectionOptions: HistoryProjectionOptions;
}

interface RunningProjection {
  readonly definition: HistoryProjectionDefinition;
  readonly projector: ProjectionHandle;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class EventHistory implements EventHistoryHandle {
  readonly #options: EventHistoryOptions;
  readonly #path: string;
  #database: SqliteDatabase | undefined;
  #projectors: RunningProjection[] = [];
  readonly #suspended = new Set<ProjectionHandle>();
  #rebuiltAt: number | undefined;
  #rebuildFailed = false;
  #stored = 0;
  #opened = false;
  #writing = false;
  #readable = false;
  #setAsideAt: number | undefined;
  #started = false;
  #settled = false;
  readonly #seenBeforeStart = new Set<string>();
  #stopped = false;
  #timer: ReturnType<Clock["setTimer"]> | undefined;

  constructor(options: EventHistoryOptions) {
    this.#options = options;
    this.#path = join(options.dataDirectory, HISTORY_DB_NAME);
    options.bus.subscribeAll((envelope) => {
      if (!this.#settled && !this.#stopped) this.#seenBeforeStart.add(envelope.id);
      this.#write(envelope);
    });
  }

  status(): EventHistoryStatus {
    return {
      opened: this.#opened,
      writing: this.#writing,
      ...(this.#setAsideAt === undefined ? {} : { setAsideAt: this.#setAsideAt }),
      ...(this.#rebuiltAt === undefined ? {} : { rebuiltAt: this.#rebuiltAt }),
      ...(this.#rebuildFailed ? { rebuildFailed: true as const } : {}),
    };
  }

  async replay(input: { readonly sinceTs?: number } = {}): Promise<EventEnvelope[]> {
    const { bus, logger } = this.#options;
    if (input.sinceTs === undefined) return bus.replay();
    const database = this.#database;
    if (database === undefined || !this.#readable) return bus.replay({ sinceTs: input.sinceTs });
    try {
      return selectEventsSince(database, input.sinceTs);
    } catch (error: unknown) {
      logger.warn("History read failed; replaying from memory", {
        error: describe(error),
        path: this.#path,
      });
      return bus.replay({ sinceTs: input.sinceTs });
    }
  }

  async replayPage(input: {
    readonly beforeId?: string;
    readonly limit: number;
  }): Promise<EventsPageRead> {
    const database = this.#database;
    if (input.beforeId === undefined) return { events: this.#newest(input.limit), kind: "events" };
    if (database === undefined || !this.#readable || !this.#writing) return { kind: "unavailable" };
    try {
      const events = selectEventsBefore(database, input.beforeId, input.limit);
      if (events !== undefined) return { events, kind: "events" };
      const oldestTs = selectOldestTimestamp(database);
      return oldestTs === undefined
        ? { events: [], kind: "events" }
        : { kind: "not-kept", oldestTs };
    } catch (error: unknown) {
      this.#options.logger.warn("History page read failed", {
        error: describe(error),
        path: this.#path,
      });
      return { kind: "unavailable" };
    }
  }

  #newest(limit: number): EventEnvelope[] {
    const database = this.#database;
    if (database !== undefined && this.#readable && this.#writing) {
      try {
        return selectNewestEvents(database, limit);
      } catch (error: unknown) {
        this.#options.logger.warn("History read failed; paging from memory", {
          error: describe(error),
          path: this.#path,
        });
      }
    }
    return this.#options.bus.replay().slice(-limit);
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    try {
      await this.#start();
    } finally {
      this.#settled = true;
      this.#seenBeforeStart.clear();
    }
  }

  async #start(): Promise<void> {
    const database = await this.#openChecked();
    if (database === undefined) return;
    if (this.#stopped) {
      closeQuietly(database);
      return;
    }
    // why: nothing up to the rebuild awaits, so no event can land between the ring's copy and the live writer
    this.#database = database;
    this.#migrate(database);
    const rebuilding = this.#prepare(database);
    if (rebuilding === undefined) return;
    this.#opened = true;
    this.#writing = true;
    this.#readable = true;
    // why: `replay()` orders by time, but a run's `seq` is its order, and a relayed event or a stepped-back clock breaks the two apart
    const ring = this.#options.bus.replay().sort((a, b) => a.seq - b.seq);
    for (const envelope of ring) {
      if (this.#setAsideAt === undefined || this.#seenBeforeStart.has(envelope.id)) {
        this.#write(envelope);
      }
    }
    this.#prune();
    if (rebuilding.length > 0) await this.#rebuild(database, rebuilding);
    this.#arm();
  }

  #migrate(database: SqliteDatabase): void {
    try {
      for (const projection of this.#options.projections) migrateProjection(database, projection);
    } catch (error: unknown) {
      this.#database = undefined;
      closeQuietly(database);
      throw error;
    }
  }

  #prepare(database: SqliteDatabase): RunningProjection[] | undefined {
    try {
      this.#projectors = this.#options.projections.map((definition) => ({
        definition,
        projector: definition.create(database, this.#options.projectionOptions),
      }));
      const rebuilding = this.#projectors.filter(({ definition }) =>
        needsRebuild(database, definition),
      );
      for (const { projector } of rebuilding) this.#suspended.add(projector);
      this.#stored = totalEventBytes(database);
      return rebuilding;
    } catch (error: unknown) {
      this.#options.logger.error("History could not be prepared; events are not written", {
        error: describe(error),
        path: this.#path,
      });
      this.#database = undefined;
      closeQuietly(database);
      return undefined;
    }
  }

  async #rebuild(database: SqliteDatabase, targets: RunningProjection[]): Promise<void> {
    try {
      const outcome = await rebuildProjections({
        database,
        isStopped: () => this.#stopped,
        resume: () => {
          for (const { projector } of targets) this.#suspended.delete(projector);
          this.#rebuiltAt = this.#options.clock.now();
        },
        targets,
      });
      if (outcome === "done") {
        this.#options.logger.info("History figures were rebuilt from the event history", {
          projections: targets.map(({ definition }) => definition.name),
        });
      }
    } catch (error: unknown) {
      this.#rebuildFailed = true;
      this.#options.logger.error("History figures could not be rebuilt; they are not written", {
        error: describe(error),
        path: this.#path,
      });
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#seenBeforeStart.clear();
    if (this.#timer !== undefined) this.#options.clock.cancel(this.#timer);
    this.#timer = undefined;
    const database = this.#database;
    this.#database = undefined;
    this.#opened = false;
    this.#writing = false;
    if (database !== undefined) closeQuietly(database);
  }

  async #openChecked(): Promise<SqliteDatabase | undefined> {
    const { logger } = this.#options;
    const first = await this.#tryOpen();
    if (first.database !== undefined || first.damage === undefined) return first.database;
    if (this.#stopped) return undefined;
    const now = this.#options.clock.now();
    let damaged: string;
    try {
      damaged = await setAsideDamagedHistory(
        this.#options.filesystem,
        this.#options.dataDirectory,
        now,
      );
    } catch (error: unknown) {
      logger.error("A damaged history could not be set aside; events are not written", {
        error: describe(error),
        path: this.#path,
      });
      return undefined;
    }
    this.#setAsideAt = now;
    logger.error("The history was damaged; it was set aside and a fresh one started", {
      damagedPath: damaged,
      error: first.damage,
      path: this.#path,
    });
    if (this.#stopped) return undefined;
    return (await this.#tryOpen()).database;
  }

  async #tryOpen(): Promise<{ database?: SqliteDatabase; damage?: string }> {
    const { logger, sqlite } = this.#options;
    let database: SqliteDatabase | undefined;
    try {
      database = await sqlite.open(this.#path, { readOnly: false });
      if (this.#stopped) return { database };
      configureDatabase(database);
      if (!passesQuickCheck(database)) {
        closeQuietly(database);
        return { damage: "quick_check did not answer ok" };
      }
      return { database };
    } catch (error: unknown) {
      if (database !== undefined) closeQuietly(database);
      if (error instanceof SqliteUnavailableError) {
        logger.error("node:sqlite is not available; the event history needs Node 22.13 or later", {
          error: describe(error),
        });
        return {};
      }
      if (isLockError(error)) {
        logger.error("The history is locked by another process; events are not written", {
          error: describe(error),
          path: this.#path,
          waitedMs: BUSY_TIMEOUT_MS,
        });
        return {};
      }
      if (this.#setAsideAt !== undefined) {
        logger.error("The fresh history could not be opened; events are not written", {
          error: describe(error),
          path: this.#path,
        });
        return {};
      }
      return { damage: describe(error) };
    }
  }

  #write(envelope: EventEnvelope): void {
    const database = this.#database;
    if (!this.#writing || database === undefined) return;
    try {
      const json = JSON.stringify(envelope);
      const size = envelopeSize(json);
      this.#stored += this.#store(database, envelope, size, json);
    } catch (error: unknown) {
      this.#writing = false;
      this.#options.logger.error("History write failed; events are no longer written", {
        error: describe(error),
        path: this.#path,
      });
    }
  }

  #store(database: SqliteDatabase, envelope: EventEnvelope, size: number, json: string): number {
    database.exec("BEGIN");
    let inProjection = false;
    try {
      const result = database
        .prepare(INSERT_EVENT_SQL)
        .run(envelope.id, envelope.timestamp, envelope.seq, size, json);
      const added = Number(result.changes) === 1;
      if (added) {
        inProjection = true;
        for (const { projector } of this.#projectors) {
          if (!this.#suspended.has(projector)) projector.apply(envelope);
        }
        inProjection = false;
      }
      database.exec("COMMIT");
      return added ? size : 0;
    } catch (error: unknown) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // why: the first error is the one to report
      }
      // why: a projection failure rolls back cleanly and leaves the file readable; a failed insert makes replay use the ring
      if (!inProjection) this.#readable = false;
      throw error;
    }
  }

  #prune(): void {
    const database = this.#database;
    if (database === undefined) return;
    try {
      this.#stored = pruneHistory(
        database,
        {
          maxBytes: this.#options.config.maxBytes,
          now: this.#options.clock.now(),
          projections: this.#projectors
            .filter(({ projector }) => !this.#suspended.has(projector))
            .map(({ projector }) => projector),
          retention: this.#options.config.retention,
        },
        this.#stored,
      );
    } catch (error: unknown) {
      this.#options.logger.warn("History prune failed; the next try is in an hour", {
        error: describe(error),
        path: this.#path,
      });
      // why: a delete that committed before the failure already changed what is stored
      try {
        this.#stored = totalEventBytes(database);
      } catch {
        // why: the next prune runs on the old count; a write recounts nothing
      }
    }
  }

  #arm(): void {
    if (this.#stopped) return;
    this.#timer = this.#options.clock.setTimer(PRUNE_INTERVAL_MS, () => {
      this.#timer = undefined;
      if (this.#stopped) return;
      this.#prune();
      this.#arm();
    });
  }
}

function needsRebuild(database: SqliteDatabase, definition: HistoryProjectionDefinition): boolean {
  try {
    return isMarkedRebuilding(database, definition.name) || !definition.check(database);
  } catch {
    // why: a table too damaged to inspect is one the rebuild recreates
    return true;
  }
}

function closeQuietly(database: SqliteDatabase): void {
  try {
    database.close();
  } catch {
    // why: a close that fails leaves the file as SQLite's recovery expects it
  }
}

export function createEventHistory(options: EventHistoryOptions): EventHistoryHandle {
  return new EventHistory(options);
}

export function openHistoryReader(options: {
  readonly sqlite: SqliteOpener;
  readonly filesystem: Filesystem;
  readonly dataDirectory: string;
}): { read(input: { readonly sinceTs: number }): Promise<EventEnvelope[]> } {
  const path = join(options.dataDirectory, HISTORY_DB_NAME);
  return {
    async read({ sinceTs }) {
      try {
        await options.filesystem.stat(path);
      } catch (error: unknown) {
        if (isMissingPathError(error)) return [];
        throw error;
      }
      const database = await options.sqlite.open(path, { readOnly: true });
      try {
        database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
        return selectEventsSince(database, sinceTs);
      } finally {
        closeQuietly(database);
      }
    },
  };
}
