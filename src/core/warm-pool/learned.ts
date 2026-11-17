import { WARM_POOL_LEARNED_KINDS_MAX } from "../../contract/index.js";
import type { SqliteDatabase, SqliteSchemaOwner } from "../../ports/index.js";
import type { StateDatabase } from "../../state/index.js";
import type { Platform, VirtualSpec } from "../domain.js";

const WARM_POOL_V1 = `
CREATE TABLE warm_kinds (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  model TEXT NOT NULL,
  os_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  image_tag TEXT NOT NULL,
  last_leased_at INTEGER NOT NULL,
  UNIQUE (platform, model, os_version, mode, image_tag)
) STRICT;

CREATE TABLE warm_kind_leases (
  lease_id TEXT PRIMARY KEY,
  kind_id INTEGER NOT NULL REFERENCES warm_kinds (id),
  granted_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;
`;

// why: the unique key gains the baseline name, which SQLite can only do by rebuilding the table; `id` is kept, and the lease rows are set aside while the old table is dropped, since dropping a parent with children breaks the foreign key.
const WARM_POOL_V2 = `
CREATE TABLE warm_kinds_next (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  model TEXT NOT NULL,
  os_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  image_tag TEXT NOT NULL,
  baseline TEXT NOT NULL DEFAULT '',
  last_leased_at INTEGER NOT NULL,
  UNIQUE (platform, model, os_version, mode, image_tag, baseline)
) STRICT;

INSERT INTO warm_kinds_next (id, platform, model, os_version, mode, image_tag, last_leased_at)
  SELECT id, platform, model, os_version, mode, image_tag, last_leased_at FROM warm_kinds;

CREATE TEMP TABLE warm_kind_leases_kept AS SELECT * FROM warm_kind_leases;
DELETE FROM warm_kind_leases;

DROP TABLE warm_kinds;

ALTER TABLE warm_kinds_next RENAME TO warm_kinds;

INSERT INTO warm_kind_leases SELECT * FROM warm_kind_leases_kept;
DROP TABLE warm_kind_leases_kept;
`;

// why: a baseline kind is keyed on its name alone and is learned only once it has been leased enough, so rows written under the old key are dropped and `learned` marks a row the pool plans.
const WARM_POOL_V3 = `
DELETE FROM warm_kind_leases WHERE kind_id IN (SELECT id FROM warm_kinds WHERE baseline <> '');
DELETE FROM warm_kinds WHERE baseline <> '';
ALTER TABLE warm_kinds ADD COLUMN learned INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX warm_kinds_baseline_name ON warm_kinds (baseline) WHERE baseline <> '';
`;

export const warmPoolOwner: SqliteSchemaOwner = {
  migrations: [WARM_POOL_V1, WARM_POOL_V2, WARM_POOL_V3],
  name: "warm-pool",
  version: 3,
};

const UPSERT_PLAIN_KIND = `INSERT INTO warm_kinds (platform, model, os_version, mode, image_tag, baseline, last_leased_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (platform, model, os_version, mode, image_tag, baseline)
  DO UPDATE SET last_leased_at = excluded.last_leased_at
  RETURNING id`;

// why: a baseline row is keyed on the name alone, so a lease of another model or platform rewrites the row's spec instead of adding a second row.
const UPSERT_BASELINE_KIND = `INSERT INTO warm_kinds (platform, model, os_version, mode, image_tag, baseline, last_leased_at, learned)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT (baseline) WHERE baseline <> ''
  DO UPDATE SET platform = excluded.platform, model = excluded.model,
    os_version = excluded.os_version, mode = excluded.mode,
    image_tag = excluded.image_tag, last_leased_at = excluded.last_leased_at
  RETURNING id`;

const LEARNED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LearnedKind {
  readonly spec: VirtualSpec;
  readonly count: number;
  readonly lastLeasedAt: number;
}

/**
 * why: the record of the kinds this worker granted a lease of and the leases that make up each
 * one's peak. It stores no device id, so the registry and this record never need to agree. Every
 * method lets a database error through: the converger decides what a failed read or write costs.
 */
export class LearnedKinds {
  readonly #state: StateDatabase;

  constructor(state: StateDatabase) {
    this.#state = state;
  }

  /** why: a plain kind is learned by its first lease; a baseline kind, whose one row is keyed on the name, once `learnAfter` of its grants fall in the last 24 hours. */
  learn(spec: VirtualSpec, leaseId: string, at: number, learnAfter = 1): void {
    this.#state.transaction(() => {
      const database = this.#state.database;
      const key = [
        spec.platform,
        spec.model,
        spec.osVersion,
        spec.mode ?? "full",
        spec.imageTag ?? "",
        spec.baseline?.name ?? "",
        at,
      ];
      const row = database
        .prepare(spec.baseline === undefined ? UPSERT_PLAIN_KIND : UPSERT_BASELINE_KIND)
        .get(...key);
      const kindId = Number(row?.id);
      database
        .prepare(
          "INSERT OR REPLACE INTO warm_kind_leases (lease_id, kind_id, granted_at, ended_at) VALUES (?, ?, ?, NULL)",
        )
        .run(leaseId, kindId, at);
      if (spec.baseline !== undefined) this.#learnWhenLeasedEnough(kindId, at, learnAfter);
      database
        .prepare("DELETE FROM warm_kind_leases WHERE ended_at < ?")
        .run(at - LEARNED_WINDOW_MS);
      this.#dropSurplus(spec.platform);
    });
  }

  #learnWhenLeasedEnough(kindId: number, at: number, learnAfter: number): void {
    const database = this.#state.database;
    const grants = database
      .prepare(
        "SELECT COUNT(*) AS grants FROM warm_kind_leases WHERE kind_id = ? AND granted_at > ?",
      )
      .get(kindId, at - LEARNED_WINDOW_MS);
    if (Number(grants?.grants) >= learnAfter) {
      database.prepare("UPDATE warm_kinds SET learned = 1 WHERE id = ?").run(kindId);
    }
  }

  #dropSurplus(platform: Platform): void {
    const database = this.#state.database;
    const surplus = database
      .prepare(
        "SELECT id FROM warm_kinds WHERE platform = ? ORDER BY last_leased_at DESC, id DESC LIMIT -1 OFFSET ?",
      )
      .all(platform, WARM_POOL_LEARNED_KINDS_MAX);
    for (const { id } of surplus) {
      database.prepare("DELETE FROM warm_kind_leases WHERE kind_id = ?").run(Number(id));
      database.prepare("DELETE FROM warm_kinds WHERE id = ?").run(Number(id));
    }
  }

  ended(leaseId: string, at: number): void {
    this.#state.database
      .prepare("UPDATE warm_kind_leases SET ended_at = ? WHERE lease_id = ? AND ended_at IS NULL")
      .run(at, leaseId);
  }

  /** why: a lease that ended while no daemon ran has no end event, so startup closes the rows the registry no longer holds. */
  closeOpen(heldLeaseIds: ReadonlySet<string>, at: number): void {
    this.#state.transaction(() => {
      const database = this.#state.database;
      for (const { lease_id: leaseId } of database
        .prepare("SELECT lease_id FROM warm_kind_leases WHERE ended_at IS NULL")
        .all()) {
        if (!heldLeaseIds.has(String(leaseId))) this.ended(String(leaseId), at);
      }
    });
  }

  forget(spec: VirtualSpec): void {
    this.#state.transaction(() => this.#delete(spec));
  }

  /** why: the operator's undo of a mistaken lease: forgets every kind of the model, narrowed by what the caller names; answers what it forgot. */
  forgetMatching(
    match: LearnedKindMatch,
    view: (spec: VirtualSpec) => VirtualSpec = (spec) => spec,
  ): VirtualSpec[] {
    return this.#state.transaction(() => {
      const forgotten = this.#state.database
        .prepare(
          "SELECT platform, model, os_version, mode, image_tag, baseline FROM warm_kinds WHERE learned = 1 ORDER BY last_leased_at DESC, id DESC",
        )
        .all()
        .map((row) => view(specOf(row)))
        .filter((spec) => matches(spec, match));
      for (const spec of forgotten) this.#delete(spec);
      return forgotten;
    });
  }

  /** why: a baseline kind is one row per name, whatever model its latest lease or newest version has. */
  #delete(spec: VirtualSpec): void {
    const database = this.#state.database;
    const where =
      spec.baseline === undefined
        ? "platform = ? AND model = ? AND os_version = ? AND mode = ? AND image_tag = ? AND baseline = ''"
        : "baseline = ?";
    const key =
      spec.baseline === undefined
        ? [spec.platform, spec.model, spec.osVersion, spec.mode ?? "full", spec.imageTag ?? ""]
        : [spec.baseline.name];
    database
      .prepare(
        `DELETE FROM warm_kind_leases WHERE kind_id IN (SELECT id FROM warm_kinds WHERE ${where})`,
      )
      .run(...key);
    database.prepare(`DELETE FROM warm_kinds WHERE ${where}`).run(...key);
  }

  clear(): void {
    this.#state.transaction(() => {
      this.#state.database.exec("DELETE FROM warm_kind_leases");
      this.#state.database.exec("DELETE FROM warm_kinds");
    });
  }

  kinds(now: number): LearnedKind[] {
    const database: SqliteDatabase = this.#state.database;
    const windowStart = now - LEARNED_WINDOW_MS;
    return database
      .prepare(
        "SELECT id, platform, model, os_version, mode, image_tag, baseline, last_leased_at FROM warm_kinds WHERE learned = 1 ORDER BY last_leased_at DESC, id DESC",
      )
      .all()
      .map((row) => {
        const leases = database
          .prepare("SELECT granted_at, ended_at FROM warm_kind_leases WHERE kind_id = ?")
          .all(Number(row.id))
          .map((lease) => ({
            end: lease.ended_at === null ? undefined : Number(lease.ended_at),
            start: Math.max(Number(lease.granted_at), windowStart),
          }));
        return {
          count: Math.max(1, peakOverlap(leases, windowStart)),
          lastLeasedAt: Number(row.last_leased_at),
          spec: specOf(row),
        };
      });
  }
}

export interface LearnedKindMatch {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string | undefined;
  readonly mode?: "slim" | "full" | undefined;
  readonly imageTag?: string | undefined;
}

// why: a field the caller left out matches every kind; mode and image tag compare as stored, full and "" when unset.
// A given image tag is never empty (the contract refuses one), so it never matches an untagged kind.
function matches(spec: VirtualSpec, match: LearnedKindMatch): boolean {
  const stored: Readonly<Record<keyof LearnedKindMatch, string>> = {
    imageTag: spec.imageTag ?? "",
    mode: spec.mode ?? "full",
    model: spec.model,
    osVersion: spec.osVersion,
    platform: spec.platform,
  };
  return Object.entries(match).every(
    ([key, value]) => value === undefined || stored[key as keyof LearnedKindMatch] === value,
  );
}

// why: a lease still held has no end, so one granted this instant counts beside the others instead of closing as it opens.
function peakOverlap(
  intervals: readonly { readonly start: number; readonly end: number | undefined }[],
  floor: number,
): number {
  const edges = intervals
    .filter((interval) => interval.end === undefined || interval.end > floor)
    .flatMap((interval) => [
      { at: interval.start, delta: 1 },
      ...(interval.end === undefined ? [] : [{ at: interval.end, delta: -1 }]),
    ])
    .sort((left, right) => left.at - right.at || left.delta - right.delta);
  let open = 0;
  let peak = 0;
  for (const edge of edges) {
    open += edge.delta;
    peak = Math.max(peak, open);
  }
  return peak;
}

function specOf(row: Record<string, unknown>): VirtualSpec {
  return {
    model: String(row.model),
    osVersion: String(row.os_version),
    physical: false,
    platform: String(row.platform) as Platform,
    ...(row.mode === "slim" ? { mode: "slim" as const } : {}),
    ...(row.image_tag === "" ? {} : { imageTag: String(row.image_tag) }),
    // why: the version is the baseline's current one, which the converger reads at each pass; a learned kind stores only the name.
    ...(row.baseline === "" ? {} : { baseline: { name: String(row.baseline), version: 0 } }),
  };
}
