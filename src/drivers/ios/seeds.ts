import { join } from "node:path";
import {
  BootTimeoutError,
  type DriverDevice,
  type DriverSettleResult,
  type DriverSource,
  DriverCrashError,
  type VirtualDriverDevice,
  ensureOwnedRoot,
} from "../../core/index.js";
import type { Clock, Filesystem, IdGenerator, Logger } from "../../ports/index.js";

import { errorMessage } from "./command-run.js";
import { SeedTurns } from "./seed-turns.js";
import { COMMAND_TIMEOUT_MS, Simctl, unknownDevice } from "./simctl.js";
import type { DeviceHubPreferences } from "./devicehub.js";
import { DeviceMarks } from "./marks.js";
import type { SlimBoot } from "./slim-boot.js";
import type { SimulatorBoot } from "./simulator-boot.js";
import type { ResolvedIosSpec } from "./catalog.js";

import { UDID_PATTERN } from "./device-set-leftovers.js";

import {
  IosSourceTable,
  type ReadySeed,
  type SourceFile,
  type SourceRecord,
  type SourceRow,
} from "./source-data.js";

import { recordLineageFiles, swapCopyFiles } from "./lineage-files.js";

import { type SimctlCatalog } from "./simctl-parse.js";

import { type IosDriverData, iosDriverData } from "./simulator-data.js";

import type { SqliteDatabase, SqliteOpener } from "../../ports/index.js";

/** why: ADR 0061 §1: a `making` row of this process older than this is a make that never ended. */
const STALE_MAKING_MS = 300_000;

const LAUNCH_SERVICES_DATABASE = /^com\.apple\.LaunchServices-.*\.csstore$/;
const LAUNCH_SERVICES_PATH = /^data\/var\/db\/lsd\/com\.apple\.LaunchServices-[^/]*\.csstore$/;

interface SeedsOptions {
  readonly boot: SimulatorBoot;
  readonly clock: Clock;
  readonly slimBoot: SlimBoot;
  readonly database: SqliteDatabase;
  readonly deviceHub: DeviceHubPreferences;
  readonly deviceRoot: string;
  readonly filesystem: Filesystem;
  readonly fullBootTimeoutMs: number;
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly logger: Logger | undefined;
  readonly logsRoot: string | undefined;
  readonly marks: DeviceMarks;
  readonly ownsDeviceSet: boolean;
  readonly seedTurns: SeedTurns;
  readonly simctl: Simctl;
  readonly sourcesSet: string;
  readonly sqliteOpener: SqliteOpener | undefined;
}

/** why: the part of IosSimctlDriver (ADR 0063) that makes, keeps and deletes the seeds every provision copies (ADR 0061), and lists them as sources. */
export class Seeds {
  readonly #boot: SimulatorBoot;
  readonly #clock: Clock;
  readonly #slimBoot: SlimBoot;
  readonly #deviceHub: DeviceHubPreferences;
  readonly #deviceRoot: string;
  readonly #filesystem: Filesystem;
  readonly #fullBootTimeoutMs: number;
  readonly #idGenerator: IdGenerator;
  readonly #instanceId: string;
  readonly #logger: Logger | undefined;
  readonly #logsRoot: string | undefined;
  readonly #marks: DeviceMarks;
  readonly #ownsDeviceSet: boolean;
  readonly #seedMakes = new Map<string, Promise<ReadySeed>>();
  readonly #seedTurns: SeedTurns;
  readonly #simctl: Simctl;
  readonly #sources: IosSourceTable;
  readonly #sourcesSet: string;
  readonly #sqliteOpener: SqliteOpener | undefined;
  #sourceMaker: string | undefined;
  #swept = false;

  constructor(options: SeedsOptions) {
    this.#boot = options.boot;
    this.#clock = options.clock;
    this.#slimBoot = options.slimBoot;
    this.#deviceHub = options.deviceHub;
    this.#deviceRoot = options.deviceRoot;
    this.#filesystem = options.filesystem;
    this.#fullBootTimeoutMs = options.fullBootTimeoutMs;
    this.#idGenerator = options.idGenerator;
    this.#instanceId = options.instanceId;
    this.#logger = options.logger;
    this.#logsRoot = options.logsRoot;
    this.#marks = options.marks;
    this.#ownsDeviceSet = options.ownsDeviceSet;
    this.#seedTurns = options.seedTurns;
    this.#simctl = options.simctl;
    this.#sources = new IosSourceTable(options.database);
    this.#sourcesSet = options.sourcesSet;
    this.#sqliteOpener = options.sqliteOpener;
  }

  async listSources(): Promise<readonly DriverSource[]> {
    await this.#sweepLeftovers();
    const rows = this.#sources.readyRows();
    const orphans = await this.#orphanSources();
    if (rows.length === 0) return orphans;
    const catalog = await this.#simctl.loadCatalog();
    return [
      ...rows.map((row) => {
        const staleReason = sourceStaleReason(row, catalog);
        return {
          id: row.sourceId,
          kind: row.kind,
          model: row.model,
          osVersion: row.osVersion,
          ...(row.sizeBytes === undefined ? {} : { sizeBytes: row.sizeBytes }),
          ...(staleReason === undefined ? {} : { staleReason }),
        };
      }),
      ...orphans,
    ];
  }

  /** why: a throwaway a `making` row names is the driver's own leftover, deleted through that row (ADR 0001 §6), so it is no leased device and no orphan. */
  makingThrowaways(): ReadonlySet<string> {
    return new Set(this.#sources.makingThrowaways());
  }

  async saveSource(device: VirtualDriverDevice): Promise<{ sourceId: string; sizeBytes?: number }> {
    const data = iosDriverData(device);
    const catalog = await this.#simctl.loadCatalog();
    const runtime = catalog.runtimes.find((entry) => entry.identifier === data.runtimeId);
    const deviceType = catalog.deviceTypes.find((entry) => entry.identifier === data.deviceTypeId);
    if (runtime === undefined || deviceType === undefined) {
      throw new DriverCrashError(
        `device ${data.udid} was made with a runtime or device type that is gone`,
      );
    }
    const sourceId = this.#idGenerator.generate();
    this.#sources.insertMaking({
      createdAt: this.#clock.now(),
      deviceTypeId: data.deviceTypeId,
      kind: "baseline",
      maker: this.#maker(),
      model: deviceType.name,
      osVersion: runtime.version,
      runtimeBuild: runtime.build,
      runtimeId: data.runtimeId,
      setPath: this.#sourcesSet,
      sourceId,
      specKey: `baseline-${sourceId}`,
    });
    let cloneUdid: string | undefined;
    try {
      await this.#ensureSourcesSet();
      await this.#simctl.shutdown(data.udid);
      const cloned = await this.#simctl.createSimulator(
        ["clone", data.udid, `simlock-baseline-${sourceId}`, this.#sourcesSet],
        { destination: this.#sourcesSet },
      );
      cloneUdid = cloned.stdout.trim();
      if (cloneUdid === "") throw new DriverCrashError("simctl clone returned no device UDID");
      this.#sources.setUdid(sourceId, cloneUdid);
      await this.#slimBoot.copyOverrides(data.udid, cloneUdid);
      await this.#dropLaunchServicesDatabase(this.#sourcesSet, cloneUdid);
      const record = await this.#baselineRecord(data, cloneUdid);
      const sizeBytes = await this.#sizeOf(cloneUdid);
      this.#sources.markReady(sourceId, sizeBytes, record);
      // why: ADR 0076: the lease is destroyed next, and `simctl delete` leaves its log folder behind for the baseline's copies to inherit.
      await this.#deleteLogFolder(data.udid);
      return { sourceId, ...(sizeBytes === undefined ? {} : { sizeBytes }) };
    } catch (error: unknown) {
      if (cloneUdid !== undefined && cloneUdid !== "") {
        await this.#deleteSeedSimulator(cloneUdid).catch(() => undefined);
      }
      this.#sources.deleteRow(sourceId);
      throw error;
    }
  }

  /** why: ADR 0076 §2: the baseline's lineage is its lease's UDID and the lineage the lease was copied with; a lease made before lineages were kept has none, so the baseline is never copied. */
  async #baselineRecord(data: IosDriverData, cloneUdid: string): Promise<SourceRecord> {
    const lineage =
      data.lineage === undefined ? undefined : [data.udid.toUpperCase(), ...data.lineage];
    const files = lineage === undefined ? [] : await this.#recordFiles(cloneUdid, lineage);
    return { files, lineage, savedWithoutLineage: lineage === undefined };
  }

  settleSeed(
    _sourceId: string,
    _options: { readonly signal: AbortSignal },
  ): Promise<DriverSettleResult> {
    return Promise.resolve({ reason: "idle", settledAfterMs: 0, sourceId: "" });
  }

  async destroySource(sourceId: string): Promise<void> {
    const row = this.#sources.findRow(sourceId);
    if (row === undefined) {
      // why: safety rule 1 (ADR 0061 §1): a UDID no row names is deleted only when it is a simulator folder of the sources set.
      if (!(await this.#isOrphanSource(sourceId))) {
        throw new DriverCrashError(`iOS keeps no source ${sourceId}`);
      }
      await this.#deleteSeedInTurn(sourceId);
      return;
    }
    if (row.udid !== undefined) {
      const udid = row.udid;
      await this.#deleteSeedInTurn(udid);
    }
    this.#sources.deleteRow(sourceId);
  }

  async provision(
    resolved: ResolvedIosSpec,
    options?: { readonly source?: string },
  ): Promise<DriverDevice> {
    const seed =
      options?.source === undefined
        ? await this.#seedFor(resolved)
        : await this.#namedSource(options.source);
    // why: Cosmetic, and deliberately so: what proves this device is Simlock's is that it
    // lives in the device set every call below is scoped to, never what it is called
    // (safety rule 8). The name exists because it is what a human reads in `simctl list`
    // and in the simulator's window title.
    const name = `simlock-${this.#idGenerator.generate()}`;
    const cloned = await this.#seedTurns.take(seed.udid, async () => ({
      result: await this.#simctl.createSimulator(["clone", seed.udid, name, this.#deviceRoot], {
        seedUdid: seed.udid,
        source: this.#sourcesSet,
      }),
      // why: the seed's deletion drops its file rows once the turn ends, so a copy reads them before leaving it.
      files: seed.lineage === undefined ? [] : this.#sources.filesOf(seed.sourceId),
    }));
    const udid = cloned.result.stdout.trim();

    if (udid === "") {
      throw new DriverCrashError("simctl clone returned no device UDID");
    }

    try {
      await this.#marks.writeMark(udid);
      await this.#dropLaunchServicesDatabase(this.#deviceRoot, udid);
      if (seed.lineage !== undefined) await this.#swapLineage(cloned.files, seed.lineage, udid);
    } catch (error: unknown) {
      // why: a clone whose mark or database drop failed is not a device Simlock hands out, and
      // in Xcode's set an unmarked one would never be listed, reclaimed or deleted again.
      await this.#simctl.invoke(["delete", udid], COMMAND_TIMEOUT_MS).catch(() => undefined);
      throw error;
    }
    await this.#slimBoot.copyOverrides(seed.udid, udid);

    return {
      address: udid,
      deviceId: udid,
      driverData: {
        deviceTypeId: resolved.deviceType.identifier,
        name,
        runtimeId: resolved.runtime.identifier,
        udid,
        ...(seed.lineage === undefined ? {} : { lineage: seed.lineage }),
      } satisfies IosDriverData,
    };
  }

  /** why: a simulator in the sources set that no row names is a leftover of a crash; `doctor` reports it and only `--purge-orphans` deletes it. */
  async #orphanSources(): Promise<readonly DriverSource[]> {
    const named = new Set(this.#sources.allUdids());
    return (await this.#sourceFolders())
      .filter((udid) => !named.has(udid))
      .map((udid) => ({
        id: udid,
        kind: "seed",
        model: "unknown",
        orphan: true,
        osVersion: "unknown",
      }));
  }

  async #isOrphanSource(udid: string): Promise<boolean> {
    return (await this.#sourceFolders()).includes(udid) && !this.#sources.allUdids().includes(udid);
  }

  async #sourceFolders(): Promise<readonly string[]> {
    try {
      return (await this.#filesystem.readdir(this.#sourcesSet)).filter((entry) =>
        UDID_PATTERN.test(entry),
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #namedSource(sourceId: string): Promise<ReadySeed> {
    const row = this.#sources.findRow(sourceId);
    if (row?.state !== "ready" || row.udid === undefined) {
      throw new DriverCrashError(`iOS keeps no ready source ${sourceId}`);
    }
    const reason = sourceStaleReason(row, await this.#simctl.loadCatalog());
    if (reason !== undefined) throw new DriverCrashError(`source ${sourceId} is stale: ${reason}`);
    return {
      lineage: row.lineage,
      runtimeBuild: row.runtimeBuild,
      sourceId: row.sourceId,
      udid: row.udid,
    };
  }

  /** why: two provisions of one kind at once make one seed, the second waiting for the first's make. */
  #seedFor(resolved: ResolvedIosSpec): Promise<ReadySeed> {
    const specKey = seedSpecKey(resolved);
    const running = this.#seedMakes.get(specKey);
    if (running !== undefined) return running;
    const made = this.#findOrMakeSeed(resolved, specKey).finally(() => {
      this.#seedMakes.delete(specKey);
    });
    this.#seedMakes.set(specKey, made);
    return made;
  }

  async #deleteSeedInTurn(udid: string): Promise<void> {
    await this.#seedTurns.takeToDelete(udid, () => this.#deleteSeedSimulator(udid));
  }

  async #findOrMakeSeed(resolved: ResolvedIosSpec, specKey: string): Promise<ReadySeed> {
    const seed = this.#sources.findReadySeed(specKey);
    if (seed !== undefined && !seedIsStale(seed, resolved)) return seed;
    if (seed !== undefined) await this.#destroySeed(seed);
    return this.#makeSeed(resolved, specKey);
  }

  async #bootThrowaway(throwaway: string, sourceId: string): Promise<void> {
    try {
      await this.#boot.bootAndWait(throwaway, sourceId, this.#fullBootTimeoutMs);
    } catch (error: unknown) {
      // why: a seed that ran out of boot time is a boot timeout, as an Android seed's is.
      if (error instanceof BootTimeoutError) throw error;
      throw new DriverCrashError(`seed ${throwaway} did not boot: ${errorMessage(error)}`);
    }
  }

  async #makeSeed(resolved: ResolvedIosSpec, specKey: string): Promise<ReadySeed> {
    // why: a `making` row of this process older than the longest a make can take belongs to a make that never ended.
    for (const row of this.#sources.makingRowsOfKindBefore(
      this.#maker(),
      specKey,
      this.#clock.now() - STALE_MAKING_MS,
    )) {
      await this.#removeLeftover(row);
    }
    const sourceId = this.#idGenerator.generate();
    this.#sources.insertMaking({
      createdAt: this.#clock.now(),
      deviceTypeId: resolved.deviceType.identifier,
      kind: "seed",
      maker: this.#maker(),
      model: resolved.spec.model,
      osVersion: resolved.spec.osVersion,
      runtimeBuild: resolved.runtime.build,
      runtimeId: resolved.runtime.identifier,
      setPath: this.#sourcesSet,
      sourceId,
      specKey,
    });
    let throwaway: string | undefined;
    let keepRow = false;
    let seedClone: string | undefined;
    try {
      await this.#ensureSourcesSet();
      const created = await this.#simctl.createSimulator(
        [
          "create",
          `simlock-seed-${sourceId}`,
          resolved.deviceType.identifier,
          resolved.runtime.identifier,
        ],
        {},
      );
      const printed = created.stdout.trim();
      // why: safety: the throwaway's UDID is joined onto the logs root and deleted, so a value that is not a UDID (an empty one would name the root itself) is refused before anything is recorded.
      if (!UDID_PATTERN.test(printed)) {
        throw new DriverCrashError("simctl create returned no device UDID");
      }
      throwaway = printed;
      this.#sources.setThrowaway(sourceId, throwaway);
      if (!this.#ownsDeviceSet) {
        // why: ADR 0048: in Xcode's set a simulator is Simlock's only by its mark, and a booted one keeps the clipboard sync it booted with.
        await this.#marks.writeMark(throwaway);
        await this.#deviceHub.disablePasteboardSync(throwaway);
      }
      await this.#bootThrowaway(throwaway, sourceId);
      await this.#simctl.shutdown(throwaway);
      const cloned = await this.#simctl.createSimulator(
        ["clone", throwaway, `simlock-seed-${sourceId}`, this.#sourcesSet],
        { destination: this.#sourcesSet },
      );
      seedClone = cloned.stdout.trim();
      this.#sources.setUdid(sourceId, seedClone);
      const done = throwaway;
      const lineage = [done.toUpperCase()];
      throwaway = undefined;
      keepRow = true;
      await this.#deleteThrowaway(done, false);
      keepRow = false;
      const files = await this.#recordFiles(seedClone, lineage);
      this.#sources.markReady(sourceId, await this.#sizeOf(seedClone), { files, lineage });
      return { sourceId, udid: seedClone, runtimeBuild: resolved.runtime.build, lineage };
    } catch (error: unknown) {
      keepRow = await this.#undoFailedMake(seedClone, throwaway, keepRow);
      if (!keepRow) this.#sources.deleteRow(sourceId);
      throw error;
    }
  }

  /** why: a failed make deletes what it created; the row stays only while a throwaway it could not delete still needs it. */
  async #undoFailedMake(
    seedClone: string | undefined,
    throwaway: string | undefined,
    keepRow: boolean,
  ): Promise<boolean> {
    if (seedClone !== undefined) await this.#deleteSeedSimulator(seedClone).catch(() => undefined);
    if (throwaway === undefined) return keepRow;
    return !(await this.#deleteThrowaway(throwaway, true).then(
      () => true,
      () => false,
    ));
  }

  /**
   * why: ADR 0061 §1: a `making` row another process left is a seed that process never finished, so
   * its simulator (if `create` answered) and row go at the first source read of this process. A
   * simulator no row names is left in place: `doctor` reports it.
   */
  async #sweepLeftovers(): Promise<void> {
    if (this.#swept) return;
    this.#swept = true;
    for (const row of this.#sources.makingRowsNotMadeBy(this.#maker())) {
      await this.#removeLeftover(row);
    }
  }

  async #removeLeftover(row: SourceRow): Promise<void> {
    try {
      if (row.udid !== undefined) await this.#deleteSeedSimulator(row.udid);
      if (row.throwawayUdid !== undefined) await this.#deleteThrowaway(row.throwawayUdid, true);
      this.#sources.deleteRow(row.sourceId);
    } catch (error: unknown) {
      this.#logger?.warn(
        `could not remove leftover source ${row.udid ?? row.sourceId}: ${errorMessage(error)}`,
      );
    }
  }

  #maker(): string {
    this.#sourceMaker ??= this.#idGenerator.generate();
    return this.#sourceMaker;
  }

  async #destroySeed(seed: ReadySeed): Promise<void> {
    await this.#deleteSeedInTurn(seed.udid);
    this.#sources.deleteRow(seed.sourceId);
  }

  async #deleteSeedSimulator(udid: string): Promise<void> {
    await this.#simctl.bestEffortShutdown(udid, this.#sourcesSet);
    await this.#deleteIn(udid, this.#sourcesSet);
  }

  /** why: ADR 0076 §1: the throwaway lives in the device set and is deleted only through the `making` row that names it (ADR 0001 §6), with its log folder, which `simctl delete` leaves behind. */
  async #deleteThrowaway(udid: string, shutdownFirst: boolean): Promise<void> {
    if (shutdownFirst) await this.#simctl.bestEffortShutdown(udid);
    await this.#deleteIn(udid, undefined);
    if (!this.#ownsDeviceSet) await this.#deviceHub.removePasteboardPreference(udid);
    await this.#deleteLogFolder(udid);
  }

  async #deleteLogFolder(udid: string): Promise<void> {
    if (this.#logsRoot === undefined) return;
    const path = join(this.#logsRoot, udid);
    try {
      await this.#filesystem.rm(path);
    } catch (error: unknown) {
      this.#logger?.warn(`could not delete log folder ${path}: ${errorMessage(error)}`);
    }
  }

  async #deleteIn(udid: string, set: string | undefined): Promise<void> {
    const args = ["delete", udid];
    const outcome = await this.#simctl.invoke(args, COMMAND_TIMEOUT_MS, set);
    // why: a seed deleted by hand is already gone, and its row must still be dropped.
    if (outcome.kind === "finished" && unknownDevice(outcome.result)) return;
    this.#simctl.checked(args, COMMAND_TIMEOUT_MS, outcome);
  }

  async #ensureSourcesSet(): Promise<void> {
    if (this.#ownsDeviceSet) {
      await this.#filesystem.mkdirp(this.#sourcesSet, { mode: 0o700 });
      return;
    }
    await ensureOwnedRoot({
      filesystem: this.#filesystem,
      idGenerator: this.#idGenerator,
      instanceId: this.#instanceId,
      path: this.#sourcesSet,
      platform: "ios",
    });
  }

  async #swapLineage(
    recorded: readonly SourceFile[],
    lineage: readonly string[],
    udid: string,
  ): Promise<void> {
    const started = this.#clock.now();
    const counts = await swapCopyFiles(
      this.#filesystem,
      join(this.#deviceRoot, udid),
      // why: the copy's LaunchServices database was dropped just before, so a seed that recorded one has nothing of it left to swap.
      recorded.filter((file) => !LAUNCH_SERVICES_PATH.test(file.relativePath)),
      { lineage, own: udid },
    );
    this.#logger?.debug(
      `swapped ${String(counts.files)} files and ${String(counts.links)} links in ${String(this.#clock.now() - started)} ms for ${udid}; ${String(counts.unreadable)} unreadable`,
    );
  }

  #recordFiles(udid: string, lineage: readonly string[]): ReturnType<typeof recordLineageFiles> {
    return recordLineageFiles({
      filesystem: this.#filesystem,
      folder: join(this.#sourcesSet, udid),
      lineage,
      logger: this.#logger,
      sqlite: this.#sqliteOpener,
      udid,
    });
  }

  async #sizeOf(udid: string): Promise<number | undefined> {
    try {
      return await this.#filesystem.directorySize(join(this.#sourcesSet, udid));
    } catch {
      // why: a size that cannot be counted leaves the seed `ready` with no size; `doctor` then leaves it out.
      return undefined;
    }
  }

  /**
   * why: `simctl clone` keeps the LaunchServices database, which records each app (system apps
   * included) by its absolute path under the original device's folder; a copy then uses the
   * original's data, or fails once that folder is gone. Dropped from every clone before its first
   * boot, LaunchServices rebuilds it from the clone's own container folders (ADR 0061 §3).
   */
  async #dropLaunchServicesDatabase(setPath: string, udid: string): Promise<void> {
    const folder = join(setPath, udid, "data", "var", "db", "lsd");
    if (!(await this.#filesystem.exists(folder))) return;
    for (const entry of await this.#filesystem.readdir(folder)) {
      if (LAUNCH_SERVICES_DATABASE.test(entry)) await this.#filesystem.rm(join(folder, entry));
    }
  }

  /** why: ADR 0061 §3: a seed of a removed runtime can never be copied again; a stuck one is logged and the removal goes on. */
  async destroySeedsOf(runtimeId: string): Promise<void> {
    for (const row of this.#sources.readyRows()) {
      if (row.kind !== "seed" || row.runtimeId !== runtimeId || row.udid === undefined) continue;
      const udid = row.udid;
      try {
        await this.#deleteSeedInTurn(udid);
        this.#sources.deleteRow(row.sourceId);
      } catch (error: unknown) {
        this.#logger?.warn(
          `could not remove seed ${udid} of removed runtime ${runtimeId}: ${errorMessage(error)}`,
        );
      }
    }
  }
}

/** why: a seed built on a runtime whose build changed no longer matches it; with no build on either side only the runtime's presence is checked, and a provision always has the runtime. */
function seedIsStale(seed: ReadySeed, resolved: ResolvedIosSpec): boolean {
  if (seed.lineage === undefined) return true;
  const current = resolved.runtime.build;
  return seed.runtimeBuild !== undefined && current !== undefined && seed.runtimeBuild !== current;
}

/** why: the phrase reads after "is stale:" in `doctor`, and is what a person acts on, so it names the runtime or device type by id. */
function sourceStaleReason(row: SourceRow, catalog: SimctlCatalog): string | undefined {
  if (row.kind === "baseline" && row.lineage === undefined) {
    return row.savedWithoutLineage
      ? "saved from a simulator made before simulators stopped sharing folders; save it again from a new lease"
      : "saved before simulators stopped sharing folders; save it again";
  }
  const runtime = catalog.runtimes.find((entry) => entry.identifier === row.runtimeId);
  if (runtime === undefined) return `runtime ${row.runtimeId} is not installed`;
  if (
    row.runtimeBuild !== undefined &&
    runtime.build !== undefined &&
    row.runtimeBuild !== runtime.build
  ) {
    return `runtime ${row.runtimeId} changed from build ${row.runtimeBuild} to ${runtime.build}`;
  }
  if (!catalog.deviceTypes.some((entry) => entry.identifier === row.deviceTypeId)) {
    return `device type ${row.deviceTypeId} is not available`;
  }
  return undefined;
}

function seedSpecKey(resolved: ResolvedIosSpec): string {
  return `${resolved.deviceType.identifier}\u0000${resolved.runtime.identifier}`;
}
