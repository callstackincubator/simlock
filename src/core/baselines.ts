import type { EventBus } from "../bus/index.js";
import type { BaselineEntry } from "../contract/index.js";
import type { Clock } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import { assertVirtual, type Platform, type VirtualDevice } from "./domain.js";
import { BadDeviceRequestError, type Driver, type DriverSource } from "./driver.js";
import { NoDriverError } from "./driver-catalog.js";
import type { ReclaimCoordinator, SavedSource } from "./reclaim-coordinator.js";
import type { Registry, ReleasedLease } from "./registry.js";
import type { DeviceOperationClaim, DeviceOperationClaims } from "./device-operation-claims.js";
import type { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import type { SerializedDecision } from "./serialized-decision.js";

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

function savedPayload(entry: BaselineEntry) {
  return {
    mode: entry.mode,
    model: entry.model,
    name: entry.name,
    osVersion: entry.osVersion,
    platform: entry.platform,
    version: entry.version,
    ...(entry.imageTag === undefined ? {} : { imageTag: entry.imageTag }),
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
  };
}

/** why: a remove would delete a device a lease holds, which no operation may do. */
export class BaselineInUseError extends Error {
  constructor(
    readonly baselineName: string,
    readonly leaseId: string,
  ) {
    super(`baseline ${baselineName} is in use by lease ${leaseId}`);
    this.name = "BaselineInUseError";
  }
}

/** why: one baseline version as a lease request reads it: the spec a copy has and the source it is copied from. */
export interface CurrentBaseline {
  readonly imageTag?: string;
  readonly mode: "slim" | "full";
  readonly model: string;
  readonly name: string;
  readonly osVersion: string;
  readonly platform: Platform;
  readonly sourceId: string;
  readonly staleReason?: string;
  readonly version: number;
}

export interface NamedSource extends DriverSource {
  readonly baselineName?: string;
  readonly baselineVersion?: number;
}

export interface BaselineRemoveResult {
  readonly name: string;
  readonly versions: readonly number[];
  readonly deletedDevices: readonly string[];
}

export interface BaselineServiceOptions {
  readonly clock: Clock;
  readonly drivers: {
    get(platform: Platform): Pick<Driver, "destroySource" | "listSources" | "supportsBaselines">;
  };
  readonly leaseSave: () => {
    releaseToSave<Result>(
      leaseId: string,
      save: (released: ReleasedLease) => Promise<Result>,
    ): Promise<Result>;
  };
  readonly claims: Pick<DeviceOperationClaims, "tryClaim">;
  readonly decisions: SerializedDecision;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly lifecycle: Pick<ManagedDeviceLifecycle, "dispose">;
  readonly reclaim: Pick<ReclaimCoordinator, "retireSaved">;
  readonly registry: { readonly snapshot: Pick<Registry["snapshot"], "leases" | "virtualDevices"> };
  readonly state: StateDatabase;
}

/**
 * why: a baseline is a named source an operator saved from a held lease (ADR 0061 §4); the
 * `baselines` table holds the name, version and spec, and the driver holds the source itself.
 */
export class BaselineService {
  #queue: Promise<unknown> = Promise.resolve();
  /** why: two overlapping stale checks must not both see the old reason, or one transition emits twice; it is apart from `#queue` so a list does not wait behind a save. */
  #staleQueue: Promise<unknown> = Promise.resolve();
  /** why: a provision reads a version's source in one gate section and registers its copy in a later one; the count keeps a replace from deleting the source in between. */
  readonly #holds = new Map<string, number>();

  constructor(private readonly options: BaselineServiceOptions) {}

  /** why: one save or remove runs at a time per worker, in arrival order, so a second save of a name becomes the next version and a remove sees the rows a save left. */
  #serial<Result>(run: () => Promise<Result>): Promise<Result> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  // fallow-ignore-next-line unused-class-member -- reached through a `Pick` of the class, or a port type, that the dispatcher, doctor and core wiring hold.
  save(request: BaselineSaveRequest): Promise<BaselineSaveResult> {
    return this.#serial(() => this.#save(request));
  }

  async #save(request: BaselineSaveRequest): Promise<BaselineSaveResult> {
    const lease = this.options.registry.snapshot.leases.find(
      (current) => current.id === request.leaseId,
    );
    const device = this.options.registry.snapshot.virtualDevices.find(
      (current) => current.id === lease?.deviceId,
    );
    if (device !== undefined) {
      const driver = this.options.drivers.get(device.spec.platform);
      if (driver.supportsBaselines === false) {
        throw new BadDeviceRequestError("This device provider does not support saved baselines");
      }
    }
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
              this.options.eventBus.emit(
                "baseline.saved",
                {
                  ...savedPayload(recorded.entry),
                  leaseId: request.leaseId,
                  requesterId: request.requesterId,
                },
                "baselines",
              );
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
    await this.#destroyIdleOlderDevices(baseline.name, baseline.version);
    await this.#dropReplaced(request.requesterId);
    return { baseline, leaseId: request.leaseId };
  }

  /** why: the version a provision copies stays until its copy has a record, then a replace may drop it. */
  // fallow-ignore-next-line unused-class-member -- reached through a `Pick` of the class, or a port type, that the provisioner holds.
  hold(name: string, version: number): () => void {
    const key = `${name}\u0000${version}`;
    this.#holds.set(key, (this.#holds.get(key) ?? 0) + 1);
    return () => {
      const left = (this.#holds.get(key) ?? 1) - 1;
      if (left === 0) this.#holds.delete(key);
      else this.#holds.set(key, left);
    };
  }

  /** why: a version that is no longer the newest is dropped once no device record and no provision hold it; every `device.deleted` and the daemon start run it, so the last device of a version leaving by any path drops it. */
  dropReplaced(): Promise<void> {
    return this.#serial(() => this.#dropReplaced());
  }

  /** why: a replace deletes the devices of an older version nobody holds, in the gate and under a claim like a remove, and leaves a leased or busy one to its lease. */
  async #destroyIdleOlderDevices(name: string, version: number): Promise<void> {
    const claimed = await this.options.decisions.run(() => {
      const { leases, virtualDevices } = this.options.registry.snapshot;
      const taken: { claim: DeviceOperationClaim; device: VirtualDevice }[] = [];
      for (const device of virtualDevices) {
        const made = device.spec.baseline;
        if (made?.name !== name || made.version >= version || device.state === "deleted") continue;
        if (leases.some((lease) => lease.deviceId === device.id)) continue;
        const claim = this.options.claims.tryClaim(device.id, "cleanup");
        if (claim !== undefined) taken.push({ claim, device });
      }
      return taken;
    });
    for (const { claim, device } of claimed) {
      try {
        await this.options.lifecycle.dispose(device, "baseline-replaced", "cleanup", claim);
      } catch {
        // why: a device that will not delete stays shut down with its record, so its version stays too, and the save itself has succeeded.
      } finally {
        claim.release();
      }
    }
  }

  /** why: the newest version of a name, with the source a copy is made from; the coordinator and the provisioner read it, each in their own step, so a save between them is seen. */
  // fallow-ignore-next-line unused-class-member -- reached through a `Pick` of the class, or a port type, that the coordinator, provisioner and warm pool hold.
  current(name: string): CurrentBaseline | undefined {
    const row = this.options.state.database
      .prepare("SELECT * FROM baselines WHERE name = ? ORDER BY version DESC LIMIT 1")
      .get(name);
    if (row === undefined) return undefined;
    return {
      mode: String(row.mode) as CurrentBaseline["mode"],
      model: String(row.model),
      name,
      osVersion: String(row.os_version),
      platform: String(row.platform) as Platform,
      sourceId: String(row.source_id),
      version: Number(row.version),
      ...(row.image_tag === null ? {} : { imageTag: String(row.image_tag) }),
      ...(row.stale_reason === null ? {} : { staleReason: String(row.stale_reason) }),
    };
  }

  /** why: the newest version of each name, by name; the size is the source's, read from its driver. */
  // fallow-ignore-next-line unused-class-member -- reached through a `Pick` of the class, or a port type, that the dispatcher, doctor and core wiring hold.
  async list(): Promise<readonly BaselineEntry[]> {
    await this.checkStale();
    const rows = this.options.state.database
      .prepare(
        `SELECT * FROM baselines AS b
         WHERE version = (SELECT MAX(version) FROM baselines WHERE name = b.name)
         ORDER BY name`,
      )
      .all();
    const { sources, unavailable } = await this.#readSources(rows);
    return rows.map((row): BaselineEntry => {
      const sizeBytes = sources.get(String(row.source_id))?.sizeBytes;
      const platform = String(row.platform) as Platform;
      const staleReason = unavailable.has(platform)
        ? `the ${platform} driver is not available on this worker`
        : row.stale_reason === null
          ? undefined
          : String(row.stale_reason);
      return {
        mode: String(row.mode) as BaselineEntry["mode"],
        model: String(row.model),
        name: String(row.name),
        osVersion: String(row.os_version),
        platform,
        savedAt: String(row.saved_at),
        version: Number(row.version),
        ...(row.image_tag === null ? {} : { imageTag: String(row.image_tag) }),
        ...(row.note === null ? {} : { note: String(row.note) }),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        ...(staleReason === undefined ? {} : { staleReason }),
      };
    });
  }

  /**
   * why: the driver cannot tell a baseline source from an orphan, since only the `baselines` table
   * names one: a source a row names carries its name and version, a ready one no row names is an
   * orphan for `doctor --purge-orphans` to delete.
   */
  // fallow-ignore-next-line unused-class-member -- reached through a `Pick` of the class, or a port type, that the dispatcher, doctor and core wiring hold.
  nameSources(sources: readonly DriverSource[]): readonly NamedSource[] {
    const names = new Map(
      this.options.state.database
        .prepare("SELECT name, version, source_id FROM baselines")
        .all()
        .map((row) => [String(row.source_id), row] as const),
    );
    return sources.map((source): NamedSource => {
      if (source.kind !== "baseline") return source;
      const row = names.get(source.id);
      if (row === undefined) return { ...source, orphan: true };
      return { ...source, baselineName: String(row.name), baselineVersion: Number(row.version) };
    });
  }

  /** why: a baseline is stale when its source's runtime or image changed since the save, and fresh again when it is back; the driver words the reason. */
  checkStale(): Promise<void> {
    const result = this.#staleQueue.then(() => this.#checkStale());
    this.#staleQueue = result.catch(() => undefined);
    return result;
  }

  async #checkStale(): Promise<void> {
    const { database } = this.options.state;
    const rows = database
      .prepare("SELECT name, version, platform, source_id, stale_reason FROM baselines")
      .all();
    const { sources } = await this.#readSources(rows);
    for (const row of rows) {
      const source = sources.get(String(row.source_id));
      if (source === undefined) continue;
      database
        .prepare("UPDATE baselines SET stale_reason = ? WHERE name = ? AND version = ?")
        .run(source.staleReason ?? null, String(row.name), Number(row.version));
      if (source.staleReason !== undefined && row.stale_reason === null) {
        this.options.eventBus.emit(
          "baseline.stale",
          { name: String(row.name), reason: source.staleReason, version: Number(row.version) },
          "baselines",
        );
      }
    }
  }

  /** why: a platform with no driver on this worker cannot be read, which is not the same as its sources being gone. */
  async #readSources(rows: readonly Record<string, unknown>[]): Promise<{
    readonly sources: ReadonlyMap<string, DriverSource>;
    readonly unavailable: ReadonlySet<Platform>;
  }> {
    const sources = new Map<string, DriverSource>();
    const unavailable = new Set<Platform>();
    for (const platform of new Set(rows.map((row) => String(row.platform) as Platform))) {
      try {
        for (const source of await this.options.drivers.get(platform).listSources()) {
          sources.set(source.id, source);
        }
      } catch (error: unknown) {
        if (!(error instanceof NoDriverError)) throw error;
        unavailable.add(platform);
      }
    }
    return { sources, unavailable };
  }

  /** why: removes every version of a name, oldest first; the row goes only after its source is destroyed, so a failed destroy leaves the row for the next try. */
  // fallow-ignore-next-line unused-class-member -- reached through a `Pick` of the class, or a port type, that the dispatcher, doctor and core wiring hold.
  remove(request: {
    readonly name: string;
    readonly requesterId: string;
  }): Promise<BaselineRemoveResult> {
    return this.#serial(() => this.#remove(request));
  }

  async #remove(request: {
    readonly name: string;
    readonly requesterId: string;
  }): Promise<BaselineRemoveResult> {
    const { database } = this.options.state;
    const rows = database
      .prepare(
        "SELECT name, version, platform, source_id FROM baselines WHERE name = ? ORDER BY version",
      )
      .all(request.name);
    if (rows.length === 0) throw new UnknownBaselineError(request.name);
    const claimed = await this.options.decisions.run(() => this.#claimIdleDevices(request.name));
    const deletedDevices: string[] = [];
    let failure: unknown;
    for (const { claim, device } of claimed) {
      try {
        const deleted = await this.options.lifecycle.dispose(
          device,
          "baseline-remove",
          "cleanup",
          claim,
        );
        if (deleted !== undefined) deletedDevices.push(device.id);
      } catch (error: unknown) {
        failure ??= error;
      } finally {
        // why: dispose leaves the claim held when it refuses a quarantined or busy device, and the retry and the reaper never act on a claimed one.
        claim.release();
      }
    }
    if (failure !== undefined) throw failure;
    for (const row of rows) await this.#deleteVersion(row, "operator", request.requesterId);
    return {
      deletedDevices,
      name: request.name,
      versions: rows.map((row) => Number(row.version)),
    };
  }

  /**
   * why: nuke's removal of every baseline: the rows go first, then the sources, so a source that
   * will not delete is an orphan `doctor` lists and not a baseline that points at nothing. Every
   * source is tried; the names whose rows went are answered with the first failure, if any.
   */
  async removeAll(): Promise<{ readonly failure?: unknown; readonly names: readonly string[] }> {
    const rows = this.options.state.database
      .prepare("SELECT name, version, platform, source_id FROM baselines ORDER BY name, version")
      .all();
    this.options.state.database.prepare("DELETE FROM baselines").run();
    let failure: unknown;
    for (const row of rows) {
      this.options.eventBus.emit(
        "baseline.removed",
        { name: String(row.name), reason: "nuke", version: Number(row.version) },
        "baselines",
      );
      try {
        await this.options.drivers
          .get(String(row.platform) as Platform)
          .destroySource(String(row.source_id));
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    const names = [...new Set(rows.map((row) => String(row.name)))];
    return failure === undefined ? { names } : { failure, names };
  }

  /** why: the in-use check and the claim on each idle device run in one decision-gate section, so a lease cannot be granted on a device in between. */
  #claimIdleDevices(name: string): { claim: DeviceOperationClaim; device: VirtualDevice }[] {
    const { leases, virtualDevices } = this.options.registry.snapshot;
    const made = virtualDevices.filter(
      (device) => device.spec.baseline?.name === name && device.state !== "deleted",
    );
    for (const device of made) {
      const lease = leases.find((candidate) => candidate.deviceId === device.id);
      if (lease !== undefined) throw new BaselineInUseError(name, lease.id);
    }
    const claimed: { claim: DeviceOperationClaim; device: VirtualDevice }[] = [];
    for (const device of made) {
      const claim = this.options.claims.tryClaim(device.id, "cleanup");
      if (claim === undefined) {
        for (const held of claimed) held.claim.release();
        throw new Error(`Device ${device.id} made from baseline ${name} is busy`);
      }
      claimed.push({ claim, device });
    }
    return claimed;
  }

  async #dropReplaced(requesterId?: string): Promise<void> {
    const rows = this.options.state.database
      .prepare(
        `SELECT name, version, platform, source_id FROM baselines AS b
         WHERE version < (SELECT MAX(version) FROM baselines WHERE name = b.name)`,
      )
      .all();
    const { virtualDevices } = this.options.registry.snapshot;
    for (const row of rows) {
      const name = String(row.name);
      const version = Number(row.version);
      const inUse =
        this.#holds.has(`${name}\u0000${version}`) ||
        virtualDevices.some(
          (device) =>
            device.state !== "deleted" &&
            device.spec.baseline?.name === name &&
            device.spec.baseline.version === version,
        );
      if (!inUse) await this.#deleteVersion(row, "replaced", requesterId);
    }
  }

  /** why: the source goes first and the row after, so a failed destroy leaves the row for the next try; the event follows the deleted row (events rule 3). */
  async #deleteVersion(
    row: Record<string, unknown>,
    reason: "operator" | "nuke" | "replaced",
    requesterId?: string,
  ): Promise<void> {
    const name = String(row.name);
    const version = Number(row.version);
    await this.options.drivers
      .get(String(row.platform) as Platform)
      .destroySource(String(row.source_id));
    this.options.state.database
      .prepare("DELETE FROM baselines WHERE name = ? AND version = ?")
      .run(name, version);
    this.options.eventBus.emit(
      "baseline.removed",
      { name, reason, version, ...(requesterId === undefined ? {} : { requesterId }) },
      "baselines",
    );
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
    const imageTag = saved.imageTag ?? device.spec.imageTag;
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
