import { basename, join } from "node:path";

import {
  DriverCrashError,
  type DriverDevice,
  type DriverSource,
  type VirtualDriverDevice,
  type VirtualSpec,
} from "../../core/index.js";
import type {
  Clock,
  Filesystem,
  IdGenerator,
  ProcessRunner,
  SqliteDatabase,
} from "../../ports/index.js";
import { ADB_DEVICES_TIMEOUT_MS, SEED_AVD_NAME, type AdbTools } from "./adb-tools.js";
import { assertLibraryProfileWritable, iniValues, type AvdConfig } from "./avd-config.js";
import type { Catalog } from "./catalog.js";
import type { ConsolePorts } from "./console-ports.js";
import type { AndroidDriverData, DeviceState, SystemImage } from "./data.js";
import type { DeviceProfile } from "./device-profile-source.js";
import type { DeviceTable } from "./device-table.js";
import { SIGKILL_REAP_TIMEOUT_MS, type Emulator } from "./emulator.js";
import { OWNERSHIP_PROBE_TIMEOUT_MS, type Ownership } from "./ownership.js";
import { AndroidSourceTable, type SourceRow } from "./source-data.js";
import { systemImagePackage, type SystemImages } from "./system-images.js";

// why: Saving the boot snapshot writes the whole guest RAM and disk to the host, far slower than
// the console's other commands; past this the emulator's console is taken as hung (#1138).
const SNAPSHOT_SAVE_TIMEOUT_MS = 60_000;
export const PROVISION_ESTIMATE_MS = 1_000;
// why: making a seed is two cold boots, a power-off and a snapshot save.
export const SEED_MAKE_ESTIMATE_MS = 150_000;
export const BOOT_SNAPSHOT = "simlock_boot";
const SOURCES_DIRECTORY = "sources";
const SEED_COPY_TIMEOUT_MS = 600_000;
const STALE_REASON_MAX_LENGTH = 300;
// why: avdmanager create has no limit of its own, so this is the ceiling of one seed make: two boots plus the steps between them, which are bounded at 600 s in all.
const SEED_MAKE_MIN_CEILING_MS = 900_000;
const SEED_MAKE_STEPS_MS = 600_000;
const SEED_POWER_OFF_TIMEOUT_MS = 60_000;
/** why: a device found after a restart has no process handle, so its exit is seen by listing adb's devices. */
const SAVE_EXIT_POLL_INTERVAL_MS = 1_000;
// why: adb shell sync and reboot -p have no limit of their own; a wedged adbd would hold the kind's lock.
const SEED_SHELL_TIMEOUT_MS = 60_000;

interface SeedRecord {
  readonly configHash: string;
  readonly folder: string;
  readonly sourceId: string;
}

/** why: a device carries no spec, so a saved source's model, API level, image tag and package come from its AVD's config: `hw.device.name` names the model and `image.sysdir.1` the image. */
function savedKindOf(config: string):
  | {
      readonly imageTag: string;
      readonly model: string;
      readonly osVersion: string;
      readonly packageName: string;
    }
  | undefined {
  const image = /^system-images\/android-([^/]+)\/([^/]+)\/([^/\s]+)\/?$/.exec(
    iniValues(config, /^image\.sysdir\.1$/)[0] ?? "",
  );
  const [, osVersion, imageTag, abi] = image ?? [];
  if (osVersion === undefined || imageTag === undefined || abi === undefined) return undefined;
  return {
    imageTag,
    model: iniValues(config, /^hw\.device\.name$/)[0] ?? "unknown",
    osVersion,
    packageName: systemImagePackage(osVersion, imageTag, abi),
  };
}

export interface SeedsOptions {
  readonly adb: string;
  readonly adbTools: AdbTools;
  readonly avdConfig: AvdConfig;
  readonly avdmanager: string;
  readonly bootTimeoutMs: number;
  readonly catalog: Catalog;
  readonly clock: Clock;
  readonly consolePorts: ConsolePorts;
  readonly database: SqliteDatabase;
  readonly deviceRoot: string;
  readonly deviceTable: DeviceTable;
  readonly emulator: Emulator;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly ownership: Ownership;
  readonly processRunner: ProcessRunner;
  readonly systemImages: SystemImages;
}

/** why: the part of AndroidDriver (ADR 0063) that owns the sources table and the seeds being made, and makes and copies the seeds every virtual device starts from. */
export class Seeds {
  readonly #adb: string;
  readonly #adbTools: AdbTools;
  readonly #avdConfig: AvdConfig;
  readonly #avdmanager: string;
  readonly #makeCeilingMs: number;
  readonly #catalog: Catalog;
  readonly #clock: Clock;
  readonly #consolePorts: ConsolePorts;
  readonly #deviceRoot: string;
  readonly #deviceTable: DeviceTable;
  readonly #emulator: Emulator;
  readonly #filesystem: Filesystem;
  readonly #idGenerator: IdGenerator;
  readonly #ownership: Ownership;
  readonly #processRunner: ProcessRunner;
  readonly #sources: AndroidSourceTable;
  readonly #systemImages: SystemImages;
  /** why: the seeds this process is making; a `making` row not named here is a leftover of an earlier process. */
  readonly #making = new Set<string>();

  constructor(options: SeedsOptions) {
    this.#adb = options.adb;
    this.#adbTools = options.adbTools;
    this.#avdConfig = options.avdConfig;
    this.#avdmanager = options.avdmanager;
    this.#makeCeilingMs = Math.max(
      SEED_MAKE_MIN_CEILING_MS,
      2 * options.bootTimeoutMs + SEED_MAKE_STEPS_MS,
    );
    this.#catalog = options.catalog;
    this.#clock = options.clock;
    this.#consolePorts = options.consolePorts;
    this.#deviceRoot = options.deviceRoot;
    this.#deviceTable = options.deviceTable;
    this.#emulator = options.emulator;
    this.#filesystem = options.filesystem;
    this.#idGenerator = options.idGenerator;
    this.#ownership = options.ownership;
    this.#processRunner = options.processRunner;
    this.#sources = new AndroidSourceTable(options.database);
    this.#systemImages = options.systemImages;
  }

  async listSources(): Promise<readonly DriverSource[]> {
    await this.#sweepLeftovers();
    const rows = this.#sources.readyRows();
    const orphans = await this.#orphanSources();
    if (rows.length === 0) return orphans;
    const [images, emulatorVersion] = await Promise.all([
      this.#systemImages.installedImages(),
      this.#adbTools.emulatorVersion(),
    ]);
    const listed: DriverSource[] = [];
    for (const row of rows) {
      const staleReason = await this.#staleReasonOf(row, images, emulatorVersion);
      this.#sources.setStaleReason(row.sourceId, staleReason);
      listed.push({
        id: row.sourceId,
        imageTag: row.imageTag,
        kind: row.kind,
        model: row.model,
        osVersion: row.osVersion,
        ...(row.sizeBytes === undefined ? {} : { sizeBytes: row.sizeBytes }),
        ...(staleReason === undefined ? {} : { staleReason }),
      });
    }
    return [...listed, ...orphans];
  }

  /**
   * why: A `making` row is a leftover when this process is not making it, or has been for longer
   * than any make takes; its emulator is stopped by its own path and its folder and row deleted.
   * A row this process is making is never touched. `onlyKind` limits the sweep to one kind.
   */
  async #sweepLeftovers(onlyKind?: string): Promise<void> {
    for (const row of this.#sources.makingRows()) {
      if (onlyKind !== undefined && row.specKey !== onlyKind) continue;
      const mine = this.#making.has(row.sourceId);
      if (mine && this.#clock.now() - row.createdAt <= this.#makeCeilingMs) continue;
      await this.#removeSource(row.sourceId, row.folder, row.avdName);
    }
  }

  /** why: a sources folder no row names is a leftover of a crash; `doctor` reports it and only `--purge-orphans` deletes it. */
  async #orphanSources(): Promise<readonly DriverSource[]> {
    const named = new Set(this.#sources.allIds());
    return (await this.#sourceFolders())
      .filter((entry) => !named.has(entry))
      .map((entry) => ({
        id: entry,
        kind: "seed",
        model: "unknown",
        orphan: true,
        osVersion: "unknown",
      }));
  }

  async #sourceFolders(): Promise<readonly string[]> {
    try {
      return await this.#filesystem.readdir(join(this.#deviceRoot, SOURCES_DIRECTORY));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** why: the emulator running a source's AVD is found by its path and stopped before the folder goes, so nothing is deleted under a live process. */
  async #removeSource(sourceId: string, folder: string, avdName: string): Promise<void> {
    await this.#emulator.stopUnowned({
      avdHome: folder,
      avdName,
      configHash: "",
      port: 0,
      serial: "",
    });
    await this.#filesystem.rm(folder);
    this.#sources.remove(sourceId);
  }

  /**
   * why: A seed is stale when what it was made from no longer matches the machine: its system image
   * is gone or changed, the emulator is another version, or the launch settings its snapshot
   * depends on changed. Recomputed on each call, so a reason clears once things match again.
   */
  async #staleReasonOf(
    row: SourceRow,
    images: readonly SystemImage[],
    emulatorVersion: string,
  ): Promise<string | undefined> {
    const packageName = row.specKey.slice(row.specKey.indexOf("|") + 1);
    const image = images.find(
      (candidate) =>
        systemImagePackage(candidate.apiLevel, candidate.tag, candidate.abi) === packageName,
    );
    const revisionOf = (identity: string) => identity.slice(identity.lastIndexOf("@") + 1);
    let reason: string | undefined;
    if (image === undefined) {
      reason = `system image ${packageName} is not installed`;
    } else if (`${image.path}@${image.version}` !== row.imageIdentity) {
      reason = `system image ${packageName} changed from revision ${revisionOf(row.imageIdentity)} to ${image.version}`;
    } else if (emulatorVersion !== row.emulatorVersion) {
      reason = `emulator changed from ${row.emulatorVersion} to ${emulatorVersion}`;
    } else if (
      (await this.#avdConfig.currentConfigHash(
        join(row.folder, `${row.avdName}.avd`),
        row.imageIdentity,
        row.emulatorVersion,
      )) !== row.configHash
    ) {
      reason = "android.emulator launch settings changed";
    }
    return reason?.slice(0, STALE_REASON_MAX_LENGTH);
  }

  async #removeSeed(row: SourceRow): Promise<void> {
    await this.#filesystem.rm(row.folder);
    this.#sources.remove(row.sourceId);
  }

  /**
   * why: ADR 0061 §4: a baseline source is the device's disk after a clean power-off, copied into the
   * sources area and booted once cold to save the boot snapshot every copy starts from. The row is
   * written `making` before any folder exists, so a crash leaves a row that names the folder to clean.
   */
  async saveSource(
    device: VirtualDriverDevice,
  ): Promise<{ sourceId: string; sizeBytes?: number; imageTag?: string }> {
    const data = this.#adbTools.dataFor(device);
    return this.#deviceTable.withLock(this.#adbTools.avdFolder(data), async () => {
      const state = this.#deviceTable.get(data);
      const kind = await this.#kindOfDevice(data, state, device.deviceId);
      const sourceId = `baseline_${this.#idGenerator.generate()}`;
      const folder = join(this.#deviceRoot, SOURCES_DIRECTORY, sourceId);
      const emulatorVersion = await this.#adbTools.emulatorVersion();
      this.#sources.insertMaking({
        avdName: SEED_AVD_NAME,
        createdAt: this.#clock.now(),
        emulatorVersion,
        folder,
        imageIdentity: kind.imageIdentity,
        imageTag: kind.imageTag,
        kind: "baseline",
        model: kind.model,
        osVersion: kind.osVersion,
        sourceId,
        specKey: `${kind.model}|${kind.packageName}`,
      });
      this.#making.add(sourceId);
      try {
        await this.#powerOffForSave(data, state, device.deviceId);
        await this.#copyAvd(
          kind.avdHome,
          folder,
          `copying Android device ${device.deviceId} to source ${sourceId} failed`,
        );
        const avdFolder = join(folder, `${SEED_AVD_NAME}.avd`);
        await this.#snapshotSource(sourceId, {
          avdHome: folder,
          avdName: SEED_AVD_NAME,
          configHash: "",
          imageIdentity: kind.imageIdentity,
          port: 0,
          serial: "",
        });
        const configHash = await this.#avdConfig.currentConfigHash(
          avdFolder,
          kind.imageIdentity,
          emulatorVersion,
        );
        const sizeBytes = await this.#filesystem.directorySize(avdFolder).catch(() => undefined);
        this.#sources.markReady(sourceId, configHash, sizeBytes);
        return {
          imageTag: kind.imageTag,
          sourceId,
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        };
      } catch (error: unknown) {
        await this.#filesystem.rm(folder);
        this.#sources.remove(sourceId);
        throw error;
      } finally {
        this.#making.delete(sourceId);
      }
    });
  }

  /**
   * why: the source row's model, API level and image tag are read from the device's own AVD, since
   * a device carries no spec: `hw.device.name` names the model and `image.sysdir.1` the image.
   */
  async #kindOfDevice(data: AndroidDriverData, state: DeviceState, deviceId: string) {
    const imageIdentity = data.imageIdentity ?? state.imageIdentity;
    if (data.avdHome === undefined || imageIdentity === "") {
      throw new DriverCrashError(
        `Android device ${deviceId} cannot be saved: it has no copy folder or image`,
      );
    }
    const config = await this.#filesystem.readFile(`${this.#adbTools.avdFolder(data)}/config.ini`);
    const kind = savedKindOf(config);
    if (kind === undefined) {
      throw new DriverCrashError(
        `Android device ${deviceId} cannot be saved: its AVD names no system image`,
      );
    }
    return { ...kind, avdHome: data.avdHome, imageIdentity };
  }

  /**
   * why: a clean power-off keeps what the operator prepared, where a kill loses it (spike, 2026-11-02).
   * Ownership is proved first, since a device found after a restart may name another emulator's port
   * (#52); an emulator that stays up past the limit is killed by its path and the save goes on.
   */
  async #powerOffForSave(
    data: AndroidDriverData,
    state: DeviceState,
    deviceId: string,
  ): Promise<void> {
    if (!(await this.#ownership.serialIsOwn(data))) {
      throw new DriverCrashError(
        `Android device ${deviceId} cannot be saved: ${data.serial} is not its emulator`,
      );
    }
    for (const command of ["sync", "reboot -p"]) {
      await this.#adbTools.runOrThrow(
        this.#adb,
        ["-s", data.serial, "shell", ...command.split(" ")],
        {
          timeoutMs: SEED_SHELL_TIMEOUT_MS,
        },
      );
    }
    if (!(await this.#exitedWithin(data, state, SEED_POWER_OFF_TIMEOUT_MS))) {
      if (!(await this.#ownership.serialIsOwn(data))) {
        throw new DriverCrashError(
          `Android device ${deviceId} did not power off and ${data.serial} is no longer its emulator`,
        );
      }
      await this.#processRunner.run(this.#adb, ["-s", data.serial, "emu", "kill"], {
        env: this.#adbTools.env(),
        timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS,
      });
      if (!(await this.#exitedWithin(data, state, SEED_POWER_OFF_TIMEOUT_MS))) {
        state.handle?.kill("SIGKILL");
        if (state.handle !== undefined)
          await this.#emulator.waitForExit(state.handle, SIGKILL_REAP_TIMEOUT_MS);
      }
    }
    state.handle = undefined;
    if (state.port !== undefined) this.#consolePorts.release(state.port);
    state.port = undefined;
  }

  /** why: with a process handle the exit is seen on it; a device found after a restart has none, so `adb devices` is polled every second until its serial is gone. */
  async #exitedWithin(
    data: AndroidDriverData,
    state: DeviceState,
    timeoutMs: number,
  ): Promise<boolean> {
    if (state.handle !== undefined) return this.#emulator.waitForExit(state.handle, timeoutMs);
    const startedAt = this.#clock.now();
    while (true) {
      const attached = await this.#adbTools.runOrThrow(this.#adb, ["devices"], {
        timeoutMs: ADB_DEVICES_TIMEOUT_MS,
      });
      if (!attached.stdout.split(/\r?\n/).some((line) => line.startsWith(`${data.serial}\t`))) {
        return true;
      }
      if (this.#clock.now() - startedAt >= timeoutMs) return false;
      await this.#adbTools.delay(SAVE_EXIT_POLL_INTERVAL_MS);
    }
  }

  async destroySource(sourceId: string): Promise<void> {
    const row = this.#sources.findRow(sourceId);
    if (row !== undefined) {
      await this.#removeSource(row.sourceId, row.folder, row.avdName);
      return;
    }
    // why: safety rule 1 (ADR 0061 §1): a name no row holds is deleted only when it is a folder of the sources set.
    if (!(await this.#sourceFolders()).includes(sourceId)) {
      throw new DriverCrashError(`Android keeps no source ${sourceId}`);
    }
    await this.#removeSource(
      sourceId,
      join(this.#deviceRoot, SOURCES_DIRECTORY, sourceId),
      SEED_AVD_NAME,
    );
  }

  async provision(
    spec: VirtualSpec,
    options: { readonly source?: string } = {},
  ): Promise<DriverDevice> {
    this.#assertAndroidSpec(spec);
    if (options.source !== undefined) return await this.#provisionFromSource(options.source);
    const profile = await this.#catalog.profileFor(spec.model);
    const image = await this.#systemImages.requireImage(profile, spec.osVersion, spec.imageTag);
    // why: Cosmetic only, and worth saying so: the prefix is a label that names the device's
    // folder. Nothing reads it back as evidence of anything -- ownership comes from the root.
    const deviceId = `simlock_${this.#idGenerator.generate()}`;
    const packageName = systemImagePackage(image.apiLevel, image.tag, image.abi);
    const specKey = `${spec.model}|${packageName}`;
    const seed = await this.#deviceTable.withLock(`seed:${specKey}`, async () => {
      await this.#sweepLeftovers(specKey);
      const ready = this.#sources.findReadySeed(specKey);
      if (ready !== undefined) {
        const reason = await this.#staleReasonOf(
          ready,
          await this.#systemImages.installedImages(),
          await this.#adbTools.emulatorVersion(),
        );
        if (reason === undefined) return ready;
        await this.#removeSeed(ready);
      }
      return this.#makeSeed({ image, packageName, profile, spec, specKey });
    });
    const avdHome = join(this.#deviceRoot, deviceId);
    await this.#copySeed(seed, avdHome);
    const driverData: AndroidDriverData = {
      avdHome,
      avdName: SEED_AVD_NAME,
      configHash: seed.configHash,
      imageIdentity: `${image.path}@${image.version}`,
      port: 0,
      serial: "",
    };
    this.#deviceTable.set(driverData, {
      handle: undefined,
      imageIdentity: `${image.path}@${image.version}`,
      port: undefined,
    });

    return { address: "", deviceId, driverData };
  }

  /**
   * why: ADR 0061 §4: a lease naming a baseline starts from a copy of that baseline's source, which
   * holds the saved disk and its boot snapshot; the kind's seed is not touched, the spec was
   * already checked against the baseline by the coordinator, and a stale source is refused, never copied.
   */
  async #provisionFromSource(sourceId: string): Promise<DriverDevice> {
    const row = this.#sources.readyRows().find((candidate) => candidate.sourceId === sourceId);
    if (row === undefined) {
      throw new DriverCrashError(`Android keeps no ready source ${sourceId}`);
    }
    const reason = await this.#staleReasonOf(
      row,
      await this.#systemImages.installedImages(),
      await this.#adbTools.emulatorVersion(),
    );
    if (reason !== undefined) throw new DriverCrashError(`source ${sourceId} is stale: ${reason}`);
    const deviceId = `simlock_${this.#idGenerator.generate()}`;
    const avdHome = join(this.#deviceRoot, deviceId);
    await this.#copyAvd(
      row.folder,
      avdHome,
      `copying Android source ${sourceId} to ${basename(avdHome)} failed`,
    );
    const driverData: AndroidDriverData = {
      avdHome,
      avdName: SEED_AVD_NAME,
      configHash: row.configHash,
      imageIdentity: row.imageIdentity,
      port: 0,
      serial: "",
    };
    this.#deviceTable.set(driverData, {
      handle: undefined,
      imageIdentity: row.imageIdentity,
      port: undefined,
    });
    return { address: "", deviceId, driverData };
  }

  /**
   * why: A seed is the source every Android device of one kind is copied from: made once, booted
   * twice (the second boot starts from a disk that was powered off cleanly), saved as one boot
   * snapshot, and never booted again (ADR 0061 §1). Its row is written `making` before any
   * folder exists, so a crash leaves a row that names the folder to clean.
   */
  async #makeSeed(request: {
    readonly image: SystemImage;
    readonly packageName: string;
    readonly profile: DeviceProfile;
    readonly spec: VirtualSpec;
    readonly specKey: string;
  }): Promise<SeedRecord> {
    const { image, packageName, profile, spec, specKey } = request;
    if (profile.kind === "library") {
      assertLibraryProfileWritable(profile);
    }
    const sourceId = `seed_${this.#idGenerator.generate()}`;
    const folder = join(this.#deviceRoot, SOURCES_DIRECTORY, sourceId);
    const avdFolder = join(folder, `${SEED_AVD_NAME}.avd`);
    const imageIdentity = `${image.path}@${image.version}`;
    const seedDeviceId =
      profile.kind === "builtin"
        ? profile.avdmanagerId
        : await this.#catalog.defaultAvdmanagerDeviceId();
    const emulatorVersion = await this.#adbTools.emulatorVersion();
    this.#sources.insertMaking({
      avdName: SEED_AVD_NAME,
      createdAt: this.#clock.now(),
      emulatorVersion,
      folder,
      imageIdentity,
      imageTag: image.tag,
      kind: "seed",
      model: spec.model,
      osVersion: image.apiLevel,
      sourceId,
      specKey,
    });
    this.#making.add(sourceId);
    try {
      await this.#filesystem.mkdirp(folder, { mode: 0o700 });
      await this.#adbTools.runOrThrow(
        this.#avdmanager,
        ["create", "avd", "-n", SEED_AVD_NAME, "-k", packageName, "-d", seedDeviceId],
        { env: { ...this.#adbTools.env(), ANDROID_AVD_HOME: folder } },
      );
      if (profile.kind === "properties") {
        await this.#avdConfig.applyHardwareProperties(avdFolder, profile.hardwareProperties);
      }
      if (profile.kind === "library") {
        await this.#avdConfig.applyLibraryProfile(avdFolder, profile, image);
      }
      await this.#bootSeedTwice(sourceId, {
        avdHome: folder,
        avdName: SEED_AVD_NAME,
        configHash: "",
        imageIdentity,
        port: 0,
        serial: "",
      });
      // why: taken after the boots, since the emulator normalizes the config.ini it boots from; a hash from before would read as a launch-settings change at once.
      const configHash = await this.#avdConfig.currentConfigHash(
        avdFolder,
        imageIdentity,
        emulatorVersion,
      );
      const sizeBytes = await this.#filesystem.directorySize(avdFolder).catch(() => undefined);
      this.#sources.markReady(sourceId, configHash, sizeBytes);
      return { configHash, folder, sourceId };
    } catch (error: unknown) {
      await this.#filesystem.rm(folder);
      this.#sources.remove(sourceId);
      throw error;
    } finally {
      this.#making.delete(sourceId);
    }
  }

  async #bootSeedTwice(sourceId: string, seed: AndroidDriverData): Promise<void> {
    const state = this.#coldState(seed);
    const booted = await this.#consolePorts.withReservedPort(seed, state);
    try {
      state.handle = await this.#emulator.start(booted, ["-no-snapshot-load"], false);
      await this.#adbTools.runOrThrow(this.#adb, ["-s", booted.serial, "shell", "sync"], {
        timeoutMs: SEED_SHELL_TIMEOUT_MS,
      });
      await this.#adbTools.runOrThrow(this.#adb, ["-s", booted.serial, "shell", "reboot", "-p"], {
        timeoutMs: SEED_SHELL_TIMEOUT_MS,
      });
      await this.#awaitSeedPowerOff(sourceId, booted, state);
      await this.#bootToSnapshot(sourceId, booted, state);
    } finally {
      state.handle?.kill("SIGKILL");
      if (state.port !== undefined) this.#consolePorts.release(state.port);
    }
  }

  /** why: a source that already powered off cleanly is booted once cold, its boot snapshot saved, and shut down; it is never booted again. */
  async #snapshotSource(sourceId: string, seed: AndroidDriverData): Promise<void> {
    const state = this.#coldState(seed);
    const booted = await this.#consolePorts.withReservedPort(seed, state);
    try {
      await this.#bootToSnapshot(sourceId, booted, state);
    } finally {
      state.handle?.kill("SIGKILL");
      if (state.port !== undefined) this.#consolePorts.release(state.port);
    }
  }

  #coldState(seed: AndroidDriverData): DeviceState {
    return { handle: undefined, imageIdentity: seed.imageIdentity ?? "", port: undefined };
  }

  async #bootToSnapshot(
    sourceId: string,
    booted: AndroidDriverData,
    state: DeviceState,
  ): Promise<void> {
    state.handle = await this.#emulator.start(booted, ["-no-snapshot-load"], false);
    await this.#saveBootSnapshot(sourceId, booted);
    await this.#emulator.shutdown(booted, state.handle);
    state.handle = undefined;
  }

  async #awaitSeedPowerOff(
    sourceId: string,
    seed: AndroidDriverData,
    state: DeviceState,
  ): Promise<void> {
    const running = state.handle;
    if (running === undefined) return;
    if (await this.#emulator.waitForExit(running, SEED_POWER_OFF_TIMEOUT_MS)) {
      state.handle = undefined;
      return;
    }
    if (await this.#ownership.serialIsOwn(seed)) {
      await this.#processRunner.run(this.#adb, ["-s", seed.serial, "emu", "kill"], {
        env: this.#adbTools.env(),
        timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS,
      });
    }
    running.kill("SIGKILL");
    await this.#emulator.waitForExit(running, SIGKILL_REAP_TIMEOUT_MS);
    state.handle = undefined;
    throw new DriverCrashError(
      `Android seed ${sourceId} did not power off within ${String(SEED_POWER_OFF_TIMEOUT_MS)}ms`,
    );
  }

  /** why: the boot snapshot is what every copy starts from, so a save that did not list is a failed make. */
  async #saveBootSnapshot(sourceId: string, seed: AndroidDriverData): Promise<void> {
    let saved = false;
    try {
      await this.#adbTools.runOrThrow(
        this.#adb,
        ["-s", seed.serial, "emu", "avd", "snapshot", "save", BOOT_SNAPSHOT],
        { timeoutMs: SNAPSHOT_SAVE_TIMEOUT_MS },
      );
      const snapshots = await this.#adbTools.runOrThrow(
        this.#adb,
        ["-s", seed.serial, "emu", "avd", "snapshot", "list"],
        { timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS },
      );
      saved = snapshots.stdout.includes(BOOT_SNAPSHOT);
    } catch {
      saved = false;
    }
    if (!saved) {
      throw new DriverCrashError(
        `Android seed ${sourceId}: boot snapshot ${BOOT_SNAPSHOT} was not saved`,
      );
    }
  }

  /** why: `to` of the filesystem port's copy must not exist, so the device's folder is made and the AVD copied into it. */
  async #copySeed(seed: SeedRecord, avdHome: string): Promise<void> {
    await this.#copyAvd(
      seed.folder,
      avdHome,
      `copying Android seed ${seed.sourceId} to ${basename(avdHome)} failed`,
    );
  }

  async #copyAvd(fromHome: string, toHome: string, failure: string): Promise<void> {
    try {
      await this.#filesystem.mkdirp(toHome, { mode: 0o700 });
      await this.#filesystem.copyTree(
        join(fromHome, `${SEED_AVD_NAME}.avd`),
        join(toHome, `${SEED_AVD_NAME}.avd`),
        { timeoutMs: SEED_COPY_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      await this.#filesystem.rm(toHome);
      throw new DriverCrashError(
        `${failure}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const ini = await this.#filesystem.readFile(join(fromHome, `${SEED_AVD_NAME}.ini`));
    await this.#filesystem.writeFileAtomic(
      join(toHome, `${SEED_AVD_NAME}.ini`),
      ini.replace(/^path=.*$/m, `path=${join(toHome, `${SEED_AVD_NAME}.avd`)}`),
    );
  }

  /** why: read from the table with no process call: the estimate is asked often and the stale check is only worth a process at provision. */
  hasFreshSeed(spec: VirtualSpec): boolean {
    return this.#sources
      .readyRows()
      .some(
        (row) =>
          row.kind === "seed" &&
          row.model === spec.model &&
          row.osVersion === spec.osVersion &&
          (spec.imageTag === undefined || row.imageTag === spec.imageTag) &&
          row.staleReason === undefined,
      );
  }

  /**
   * why: A seed made from a removed image would be remade at the next provision anyway; destroying it
   * now frees its disk. A seed that cannot be destroyed stays: its stale reason says the image is
   * gone, so `doctor` lists it and `nuke` deletes it, and the removal itself still succeeds.
   */
  async destroySeedsOf(packageName: string): Promise<void> {
    for (const row of this.#sources.readyRows()) {
      if (row.kind !== "seed" || !row.specKey.endsWith(`|${packageName}`)) continue;
      try {
        await this.#removeSource(row.sourceId, row.folder, row.avdName);
      } catch {
        // why: left for doctor and nuke, see above.
      }
    }
  }

  #assertAndroidSpec(spec: VirtualSpec): void {
    if (spec.platform !== "android") {
      throw new Error(`Android driver cannot provision ${spec.platform} devices`);
    }
  }
}
