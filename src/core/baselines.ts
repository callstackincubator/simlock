import type { BaselineEntry } from "../contract/index.js";
import type { Clock } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import { assertVirtual, type Platform } from "./domain.js";
import type { Driver, DriverSource } from "./driver.js";
import type { ReclaimCoordinator, SavedSource } from "./reclaim-coordinator.js";
import type { ReleasedLease } from "./registry.js";

export interface BaselineSaveRequest {
  readonly leaseId: string;
  readonly name: string;
  readonly note?: string | undefined;
  readonly requesterId: string;
}

export interface BaselineSaveResult {
  readonly baseline: BaselineEntry;
  readonly leaseId: string;
}

/** why: the lease has ended and no baseline was kept, which the caller must be told apart from a refusal. */
export class BaselineSaveFailedError extends Error {
  constructor(
    readonly baselineName: string,
    readonly leaseId: string,
    readonly reason: string,
  ) {
    super(`baseline ${baselineName} was not saved: ${reason}. Lease ${leaseId} has ended.`);
    this.name = "BaselineSaveFailedError";
  }
}

/** why: a remove names a baseline the worker does not hold. */
export class UnknownBaselineError extends Error {
  constructor(readonly baselineName: string) {
    super(`no baseline named "${baselineName}" on this worker`);
    this.name = "UnknownBaselineError";
  }
}

export interface BaselineRemoveResult {
  readonly name: string;
  readonly versions: readonly number[];
  readonly deletedDevices: readonly string[];
}

export interface BaselineServiceOptions {
  readonly clock: Clock;
  readonly drivers: { get(platform: Platform): Pick<Driver, "destroySource" | "listSources"> };
  readonly leaseSave: () => {
    releaseToSave<Result>(
      leaseId: string,
      save: (released: ReleasedLease) => Promise<Result>,
    ): Promise<Result>;
  };
  readonly reclaim: Pick<ReclaimCoordinator, "retireSaved">;
  readonly state: StateDatabase;
}

/**
 * why: a baseline is a named source an operator saved from a held lease (ADR 0061 §4); the
 * `baselines` table holds the name, version and spec, and the driver holds the source itself.
 */
export class BaselineService {
  constructor(private readonly options: BaselineServiceOptions) {}

  async save(request: BaselineSaveRequest): Promise<BaselineSaveResult> {
    const baseline = await this.options
      .leaseSave()
      .releaseToSave(request.leaseId, async (released) => {
        const device = assertVirtual(released.device);
        const recorded: { entry?: BaselineEntry } = {};
        try {
          await this.options.reclaim.retireSaved(
            { device, lease: released.lease },
            async (saved) => {
              recorded.entry = this.#insert(request, device, saved);
            },
          );
        } catch (error: unknown) {
          if (recorded.entry !== undefined) throw error;
          throw new BaselineSaveFailedError(
            request.name,
            request.leaseId,
            error instanceof Error ? error.message : String(error),
          );
        }
        if (recorded.entry === undefined) throw new Error("A saved baseline was not recorded");
        return recorded.entry;
      });
    await this.#dropOlderVersions(baseline.name, baseline.version);
    return { baseline, leaseId: request.leaseId };
  }

  /** why: the newest version of each name, by name; the size is the source's, read from its driver. */
  async list(): Promise<readonly BaselineEntry[]> {
    await this.checkStale();
    const rows = this.options.state.database
      .prepare(
        `SELECT * FROM baselines AS b
         WHERE version = (SELECT MAX(version) FROM baselines WHERE name = b.name)
         ORDER BY name`,
      )
      .all();
    const sources = await this.#readSources(rows);
    return rows.map((row): BaselineEntry => {
      const sizeBytes = sources.get(String(row.source_id))?.sizeBytes;
      return {
        mode: String(row.mode) as BaselineEntry["mode"],
        model: String(row.model),
        name: String(row.name),
        osVersion: String(row.os_version),
        platform: String(row.platform) as Platform,
        savedAt: String(row.saved_at),
        version: Number(row.version),
        ...(row.image_tag === null ? {} : { imageTag: String(row.image_tag) }),
        ...(row.note === null ? {} : { note: String(row.note) }),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        ...(row.stale_reason === null ? {} : { staleReason: String(row.stale_reason) }),
      };
    });
  }

  /** why: a baseline is stale when its source's runtime or image changed since the save, and fresh again when it is back; the driver words the reason. */
  async checkStale(): Promise<void> {
    const { database } = this.options.state;
    const rows = database.prepare("SELECT name, version, platform, source_id FROM baselines").all();
    const sources = await this.#readSources(rows);
    for (const row of rows) {
      const source = sources.get(String(row.source_id));
      if (source === undefined) continue;
      database
        .prepare("UPDATE baselines SET stale_reason = ? WHERE name = ? AND version = ?")
        .run(source.staleReason ?? null, String(row.name), Number(row.version));
    }
  }

  async #readSources(
    rows: readonly Record<string, unknown>[],
  ): Promise<ReadonlyMap<string, DriverSource>> {
    const sources = new Map<string, DriverSource>();
    for (const platform of new Set(rows.map((row) => String(row.platform) as Platform))) {
      for (const source of await this.options.drivers.get(platform).listSources()) {
        sources.set(source.id, source);
      }
    }
    return sources;
  }

  /** why: removes every version of a name, oldest first; the row goes only after its source is destroyed, so a failed destroy leaves the row for the next try. */
  async remove(request: { readonly name: string }): Promise<BaselineRemoveResult> {
    const { database } = this.options.state;
    const rows = database
      .prepare("SELECT version, platform, source_id FROM baselines WHERE name = ? ORDER BY version")
      .all(request.name);
    if (rows.length === 0) throw new UnknownBaselineError(request.name);
    for (const row of rows) {
      await this.options.drivers
        .get(String(row.platform) as Platform)
        .destroySource(String(row.source_id));
      database
        .prepare("DELETE FROM baselines WHERE name = ? AND version = ?")
        .run(request.name, Number(row.version));
    }
    return {
      deletedDevices: [],
      name: request.name,
      versions: rows.map((row) => Number(row.version)),
    };
  }

  /** why: a replace drops the old version at once, since no device carries one (#1207 keeps a version while devices of it remain). */
  async #dropOlderVersions(name: string, version: number): Promise<void> {
    const { database } = this.options.state;
    const older = database
      .prepare("SELECT version, platform, source_id FROM baselines WHERE name = ? AND version < ?")
      .all(name, version);
    for (const row of older) {
      await this.options.drivers
        .get(String(row.platform) as Platform)
        .destroySource(String(row.source_id));
      database
        .prepare("DELETE FROM baselines WHERE name = ? AND version = ?")
        .run(name, Number(row.version));
    }
  }

  #insert(
    request: BaselineSaveRequest,
    device: ReturnType<typeof assertVirtual>,
    saved: SavedSource,
  ): BaselineEntry {
    const { database } = this.options.state;
    const next = database
      .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM baselines WHERE name = ?")
      .get(request.name);
    const version = Number(next?.version);
    const savedAt = new Date(this.options.clock.now()).toISOString();
    const { imageTag } = device.spec;
    database
      .prepare(
        `INSERT INTO baselines
           (name, version, platform, model, os_version, mode, image_tag, note, saved_at, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.name,
        version,
        device.spec.platform,
        device.spec.model,
        device.spec.osVersion,
        device.mode,
        imageTag ?? null,
        request.note ?? null,
        savedAt,
        saved.sourceId,
      );
    return {
      mode: device.mode,
      model: device.spec.model,
      name: request.name,
      osVersion: device.spec.osVersion,
      platform: device.spec.platform,
      savedAt,
      version,
      ...(imageTag === undefined ? {} : { imageTag }),
      ...(request.note === undefined ? {} : { note: request.note }),
      ...(saved.sizeBytes === undefined ? {} : { sizeBytes: saved.sizeBytes }),
    };
  }
}
