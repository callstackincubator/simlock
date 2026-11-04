import { basename, join } from "node:path";

import {
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  type LegacyDevice,
  OwnedRootError,
  type DeviceSpec,
  type DriverAdvisory,
  type VirtualSpec,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type ComponentRemoval,
  type ExactDeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverComponent,
  type DriverDevice,
  type DriverSource,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  type PhysicalInspection,
  isPhysicalDriverDevice,
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
  type PresentPhysical,
  type DriverToolVersion,
  type InstalledComponent,
  type PassthroughCommand,
  type PassthroughContext,
  type ReclaimResult,
  removeListedComponent,
  type DeviceInputFactory,
  type ScreenCapture,
  ScreenUnavailableError,
} from "../../core/index.js";
import { AndroidSourceTable, type SourceRow } from "./source-data.js";
import {
  type Clock,
  type Filesystem,
  type IdGenerator,
  type Logger,
  type ProcessRunner,
  type ProcessSupervisor,
  type SqliteDatabase,
  type TcpListenerFactory,
  type TcpProbe,
  type TcpStreamConnector,
} from "../../ports/index.js";
import { createAndroidDeviceTcp, type AndroidDeviceTcp } from "./device-tcp.js";
import {
  COLD_BOOT_ESTIMATE_MS,
  DEFAULT_EMULATOR_LAUNCH,
  Emulator,
  SIGKILL_REAP_TIMEOUT_MS,
  type AndroidEmulatorLaunchOptions,
  type SnapshotColdBootDiagnostic,
} from "./emulator.js";
import { ADB_DEVICES_TIMEOUT_MS, AdbTools, SEED_AVD_NAME } from "./adb-tools.js";
import { ANDROID_DEFAULT_MODELS, Catalog } from "./catalog.js";
import { AdbServerSupervisor, AdbServerUnavailableError } from "./adb-server.js";
import { ConsolePorts, portAllocatorFor, portsFromAdbDevices } from "./console-ports.js";
import type { AndroidDriverData, DeviceState, SystemImage } from "./data.js";
import { AvdConfig, assertLibraryProfileWritable } from "./avd-config.js";
import { DeviceTable } from "./device-table.js";
import { OWNERSHIP_PROBE_TIMEOUT_MS, Ownership } from "./ownership.js";
import { ANDROID_PASSTHROUGH_TOOLS, PassthroughRules } from "./passthrough-rules.js";
import { AndroidPhysicalHandler, PHYSICAL_RECLAIM_ESTIMATE_MS } from "./physical-handler.js";
import {
  type DeviceProfileSource,
  type DeviceProfileSourceDiagnostic,
  type DeviceProfile,
} from "./device-profile-source.js";
import {
  ANDROID_SYSTEM_IMAGE_MIN_FREE_BYTES,
  SystemImages,
  systemImagePackage,
} from "./system-images.js";
import { createAndroidDeviceInput } from "./input/index.js";
import { createAndroidScreenCapture, type ScreenTarget } from "./screen/index.js";
import { type AndroidSdkPaths, locateSdk } from "./sdk-paths.js";

export { AdbServerUnavailableError } from "./adb-server.js";
export { AndroidLicenseNotAcceptedError } from "./system-images.js";
export type { AndroidEmulatorLaunchOptions } from "./emulator.js";
export {
  ANDROID_PASSTHROUGH_TOOLS,
  REFUSED_ADB_SEQUENCES,
  REFUSED_ADB_VERB,
} from "./passthrough-rules.js";

const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const DEFAULT_ADB_SERVER_PORT = 5038;
// why: Saving the boot snapshot writes the whole guest RAM and disk to the host, far slower than
// the console's other commands; past this the emulator's console is taken as hung (#1138).
const SNAPSHOT_SAVE_TIMEOUT_MS = 60_000;
const PROVISION_ESTIMATE_MS = 1_000;
// why: making a seed is two cold boots, a power-off and a snapshot save.
const SEED_MAKE_ESTIMATE_MS = 150_000;
// why: the reclaim estimates below price the two strategies `virtualReclaimStrategy` still names; the Android driver
// reclaims no virtual device (a released one is deleted), so they were measured on an M3 Pro against Pixel 8 / API 35
// when it did: 2.4-5.1s for the snapshot strategy.
const SNAPSHOT_RECLAIM_ESTIMATE_MS = 6_000;
// why: measured on the same hardware at 22.8-42.8s (median 31.7s) for the wipe strategy; the slow
// branch is the one quoted, so `Doctor` never reads a slow reclaim as stalled.
const WIPE_RECLAIM_ESTIMATE_MS = 32_000;
const BOOT_SNAPSHOT = "simlock_boot";
const SOURCES_DIRECTORY = "sources";
const SEED_COPY_TIMEOUT_MS = 600_000;
const STALE_REASON_MAX_LENGTH = 300;
// why: avdmanager create has no limit of its own, so this is the ceiling of one seed make.
const SEED_MAKE_CEILING_MS = 900_000;
const SEED_POWER_OFF_TIMEOUT_MS = 60_000;
/** why: a device found after a restart has no process handle, so its exit is seen by listing adb's devices. */
const SAVE_EXIT_POLL_INTERVAL_MS = 1_000;
// why: adb shell sync and reboot -p have no limit of their own; a wedged adbd would hold the kind's lock.
const SEED_SHELL_TIMEOUT_MS = 60_000;

export interface AndroidDriverOptions {
  /**
   * why: Explicit legal consent for Android SDK licenses (`downloads.acceptAndroidLicenses`),
   * independent of the per-request download permission. Defaults to `false`: an install that
   * fails on an unaccepted license fails outright rather than accepting it silently.
   */
  readonly acceptAndroidLicenses?: boolean;
  readonly clock: Clock;
  readonly database: SqliteDatabase;
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  readonly deviceProfileSources?: readonly DeviceProfileSource[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
  /**
   * why: The ABI this host runs natively (`hostAbiFor` of the host port's architecture), passed in
   * by the composition root so the image this driver prefers and the architecture `status.get`
   * reports come from the same reading.
   */
  readonly hostAbi: string;
  readonly idGenerator?: IdGenerator;
  readonly instanceId: string;
  // why: the input logs a device whose screen size it cannot read; nothing else in the driver logs through it.
  readonly logger?: Logger | undefined;
  readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly readinessTimeoutMs?: number;
  readonly simlockHome: string;
  readonly tcpProbe: TcpProbe;
  // why: both are optional so a host that leaves either out gets a driver without screen streams
  // rather than one that fails each stream it is asked for.
  readonly scrcpyServerPath?: string | undefined;
  readonly tcpStreamConnector?: TcpStreamConnector | undefined;
  // why: optional so a host that leaves it out gets a driver that offers no tunnels.
  readonly tcpListener?: TcpListenerFactory | undefined;
  readonly uid?: number;
  /** why: the daemon's pid is named in the staging directory of a new root. */
  readonly pid?: number;
  readonly emulator?: AndroidEmulatorLaunchOptions | undefined;
}

export type AndroidDriverDiagnostic = SnapshotColdBootDiagnostic | DeviceProfileSourceDiagnostic;

export class SdkMissingError extends Error {
  constructor(readonly searchedPaths: readonly string[]) {
    super(`Android SDK missing or incomplete; searched: ${searchedPaths.join(", ")}`);
    this.name = "SdkMissingError";
  }
}

interface SeedRecord {
  readonly configHash: string;
  readonly folder: string;
  readonly sourceId: string;
}

type AndroidTargetFor = (
  device: VirtualDriverDevice | PhysicalDriverDevice,
) => Promise<ScreenTarget>;

/** why: a device carries no spec, so a saved source's model, API level, image tag and package come from its AVD's config: `hw.device.name` names the model and `image.sysdir.1` the image. */
function savedKindOf(config: string):
  | {
      readonly imageTag: string;
      readonly model: string;
      readonly osVersion: string;
      readonly packageName: string;
    }
  | undefined {
  const image = /^image\.sysdir\.1=system-images\/android-([^/]+)\/([^/]+)\/([^/\s]+)\/?\s*$/m.exec(
    config,
  );
  const [, osVersion, imageTag, abi] = image ?? [];
  if (osVersion === undefined || imageTag === undefined || abi === undefined) return undefined;
  return {
    imageTag,
    model: /^hw\.device\.name=(.+?)\s*$/m.exec(config)?.[1] ?? "unknown",
    osVersion,
    packageName: systemImagePackage(osVersion, imageTag, abi),
  };
}

export class AndroidDriver implements Driver {
  readonly platform = "android" as const;
  readonly defaultModels = ANDROID_DEFAULT_MODELS;
  readonly #adbServer: AdbServerSupervisor;
  readonly #adbServerPort: number;
  readonly #adbTools: AdbTools;
  readonly #avdConfigPart: AvdConfig;
  readonly #catalog: Catalog;
  readonly #ownership: Ownership;
  readonly #passthroughRules: PassthroughRules;
  readonly #clock: Clock;
  readonly #deviceTable: DeviceTable;
  readonly #deviceRoot: string;
  readonly #filesystem: Filesystem;
  readonly #idGenerator: IdGenerator;
  readonly #legacyAvdHome: string;
  readonly #onDiagnostic: ((diagnostic: AndroidDriverDiagnostic) => void) | undefined;
  readonly #consolePorts: ConsolePorts;
  readonly #processRunner: ProcessRunner;
  readonly #physical: AndroidPhysicalHandler;
  readonly #emulator: Emulator;
  readonly #rootOptions: EnsureOwnedRootOptions;
  readonly #sdk: AndroidSdkPaths;
  readonly #sources: AndroidSourceTable;
  readonly #systemImages: SystemImages;
  /** why: the seeds this process is making; a `making` row not named here is a leftover of an earlier process. */
  readonly #making = new Set<string>();
  readonly componentFootprint: { readonly path: string; readonly bytes: number };
  readonly screenCapture: ScreenCapture | undefined;
  readonly input: DeviceInputFactory | undefined;
  readonly deviceTcp: AndroidDeviceTcp | undefined;

  private constructor(
    options: AndroidDriverOptions,
    sdk: AndroidSdkPaths,
    deviceRoot: string,
    rootOptions: EnsureOwnedRootOptions,
    adbServer: AdbServerSupervisor,
    adbServerPort: number,
  ) {
    this.#adbServer = adbServer;
    this.#adbServerPort = adbServerPort;
    this.#adbTools = new AdbTools({
      adb: sdk.adb,
      adbServerPort,
      baseEnv: options.env,
      clock: options.clock,
      deviceRoot,
      emulator: sdk.emulator,
      processRunner: options.processRunner,
    });
    this.#avdConfigPart = new AvdConfig({
      adb: sdk.adb,
      adbTools: this.#adbTools,
      filesystem: options.filesystem,
      idGenerator: options.idGenerator ?? new SequentialIdGenerator(),
      seedLaunchInputs: seedLaunchInputs(options.emulator),
    });
    this.#ownership = new Ownership({
      adb: sdk.adb,
      adbTools: this.#adbTools,
      filesystem: options.filesystem,
    });
    this.#clock = options.clock;
    this.#deviceRoot = deviceRoot;
    this.#filesystem = options.filesystem;
    this.#idGenerator = options.idGenerator ?? new SequentialIdGenerator();
    this.#onDiagnostic = options.onDiagnostic;
    this.#processRunner = options.processRunner;
    this.#physical = new AndroidPhysicalHandler({
      adb: sdk.adb,
      baseEnv: options.env,
      filesystem: options.filesystem,
      isBareShell: (args) => this.#passthroughRules.isBareShell(args),
      processRunner: options.processRunner,
      tcpProbe: options.tcpProbe,
    });
    this.#passthroughRules = new PassthroughRules({
      adb: sdk.adb,
      adbServerPort,
      adbTools: this.#adbTools,
      physical: {
        passthrough: (device, args, context) => this.#physical.passthrough(device, args, context),
        runAdb: (device, args, timeoutMs) => this.#physical.runAdb(device, args, timeoutMs),
      },
      platform: this.platform,
      processRunner: options.processRunner,
    });
    this.#emulator = this.#emulatorFor(options, sdk, deviceRoot, adbServerPort);
    this.#rootOptions = rootOptions;
    this.#sdk = sdk;
    this.#sources = new AndroidSourceTable(options.database);
    // why: Where an AVD Simlock made before it owned a root still sits: the AVD home the user
    // had configured then, or the SDK's own default. Used only by `findLegacy` /
    // `destroyLegacy` -- the fallback CP3 deleted from the driver proper, kept exactly here
    // because a stranded device cannot be found anywhere else (ADR 0001, Migration) -- and
    // read by `SystemImages.listComponents`, which counts the user's own AVDs there (ADR 0010 §8).
    this.#legacyAvdHome =
      options.env.ANDROID_AVD_HOME ?? join(options.homeDirectory, ".android", "avd");
    this.#systemImages = new SystemImages({
      acceptAndroidLicenses: options.acceptAndroidLicenses ?? false,
      clock: options.clock,
      deviceRoot,
      filesystem: options.filesystem,
      hostAbi: options.hostAbi,
      legacyAvdHome: this.#legacyAvdHome,
      processRunner: options.processRunner,
      sdk,
    });
    this.#deviceTable = new DeviceTable({
      adbTools: this.#adbTools,
      avdConfig: this.#avdConfigPart,
      avdmanager: sdk.avdmanager,
      baseEnv: options.env,
      deviceRoot,
      filesystem: options.filesystem,
      legacyAvdHome: this.#legacyAvdHome,
      ownership: this.#ownership,
      register: (consolePort) => this.#emulator.register(consolePort),
    });
    this.componentFootprint = { bytes: ANDROID_SYSTEM_IMAGE_MIN_FREE_BYTES, path: sdk.root };
    const deviceTarget = this.#deviceTargetFor(options, sdk.adb, adbServerPort);
    const targetFor = this.#screenTargetFor(options, deviceTarget);
    this.screenCapture = this.#screenCaptureFor(options, targetFor);
    this.input = this.#inputFor(options, targetFor);
    this.deviceTcp =
      options.tcpListener === undefined
        ? undefined
        : createAndroidDeviceTcp({
            clock: options.clock,
            listeners: options.tcpListener,
            target: deviceTarget,
            isOwn: (device) => this.#ownership.deviceIsOwn(device),
            runAdb: (device, args, timeoutMs) =>
              this.#passthroughRules.runAdbOn(device, args, timeoutMs),
            warn: (message, detail) => options.logger?.warn(message, detail),
          });
    this.#consolePorts = new ConsolePorts({
      adbTools: this.#adbTools,
      allocator: portAllocatorFor(options.processRunner, sdk.adb),
      tcpProbe: options.tcpProbe,
    });
    this.#catalog = new Catalog({
      avdmanager: sdk.avdmanager,
      avdmanagerEnv: () => this.#adbTools.env(),
      deviceProfileSources: options.deviceProfileSources,
      env: options.env,
      filesystem: options.filesystem,
      homeDirectory: options.homeDirectory,
      onDiagnostic: this.#onDiagnostic,
      processRunner: options.processRunner,
      sdkRoot: sdk.root,
      systemImages: this.#systemImages,
    });
  }

  #emulatorFor(
    options: AndroidDriverOptions,
    sdk: AndroidSdkPaths,
    deviceRoot: string,
    adbServerPort: number,
  ): Emulator {
    return new Emulator({
      adb: sdk.adb,
      adbServerPort,
      adbTools: this.#adbTools,
      clock: options.clock,
      deviceRoot,
      emulator: sdk.emulator,
      emulatorLaunch: options.emulator,
      filesystem: options.filesystem,
      onDiagnostic: options.onDiagnostic,
      ownership: this.#ownership,
      processRunner: options.processRunner,
      readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      tcpProbe: options.tcpProbe,
    });
  }

  // why: the screen and the input helper ride on the scrcpy server, so without its path they have no target even when a device port can be opened.
  #screenTargetFor(
    options: AndroidDriverOptions,
    deviceTarget: AndroidTargetFor | undefined,
  ): AndroidTargetFor | undefined {
    return options.scrcpyServerPath === undefined ? undefined : deviceTarget;
  }

  #deviceTargetFor(
    options: AndroidDriverOptions,
    adb: string,
    adbServerPort: number,
  ): AndroidTargetFor | undefined {
    const tcp = options.tcpStreamConnector;
    if (tcp === undefined) return undefined;
    const runner = options.processRunner;
    return async (device) =>
      isPhysicalDriverDevice(device)
        ? this.#physical.screenTargetFor(device, tcp)
        : emulatorScreenTarget(
            runner,
            adb,
            tcp,
            adbServerPort,
            () => this.#adbTools.env(),
            this.#adbTools.dataFor(device).serial,
            device,
          );
  }

  #screenCaptureFor(
    options: AndroidDriverOptions,
    targetFor: AndroidTargetFor | undefined,
  ): ScreenCapture | undefined {
    if (options.scrcpyServerPath === undefined || targetFor === undefined) return undefined;
    return createAndroidScreenCapture({
      clock: options.clock,
      filesystem: options.filesystem,
      serverPath: options.scrcpyServerPath,
      targetFor,
    });
  }

  // why: the input uses the same jar and the same targets as the stream, so it is offered exactly
  // when the stream is.
  #inputFor(
    options: AndroidDriverOptions,
    targetFor: AndroidTargetFor | undefined,
  ): DeviceInputFactory | undefined {
    if (options.scrcpyServerPath === undefined || targetFor === undefined) return undefined;
    return createAndroidDeviceInput({
      clock: options.clock,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      serverPath: options.scrcpyServerPath,
      targetFor,
    });
  }

  /**
   * why: Establishes everything containment rests on before the driver can be asked to do
   * anything: the AVD home this instance owns, and the private adb server its emulators
   * are reachable through. Both fail closed -- an `OwnedRootError` or an
   * `AdbServerUnavailableError` here costs the Android platform and nothing else, because
   * the alternatives are the user's own AVD directory and the machine's shared adb server,
   * which Simlock can prove nothing about (safety rule 9).
   */
  static async create(options: AndroidDriverOptions): Promise<AndroidDriver> {
    const sdk = await discoverSdk(options);
    const adbServerPort = configuredAdbServerPort(options);
    // why: Resolved once and shared: the root's staging directory, the AVD names, and the
    // provenance tokens all come from the same generator, so a caller that injected one
    // controls all three rather than two of them.
    const idGenerator = options.idGenerator ?? new SequentialIdGenerator();
    const rootOptions: EnsureOwnedRootOptions = {
      filesystem: options.filesystem,
      idGenerator,
      instanceId: options.instanceId,
      path: configuredDeviceRoot(options),
      platform: "android",
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.pid === undefined ? {} : { pid: options.pid }),
    };
    const deviceRoot = await ensureOwnedRoot(rootOptions);
    const adbServer = new AdbServerSupervisor({
      adbPath: sdk.adb,
      clock: options.clock,
      env: options.env,
      filesystem: options.filesystem,
      logPath: join(options.simlockHome, "logs", "adb-server.log"),
      port: adbServerPort,
      processRunner: options.processRunner,
      processSupervisor: options.processSupervisor,
      recordPath: join(options.simlockHome, "adb-server.json"),
      tcpProbe: options.tcpProbe,
    });
    await adbServer.start();

    const driver = new AndroidDriver(
      { ...options, idGenerator },
      sdk,
      deviceRoot,
      rootOptions,
      adbServer,
      adbServerPort,
    );
    await driver.#adoptRunningEmulators();
    return driver;
  }

  async #adoptRunningEmulators(): Promise<void> {
    await this.#deviceTable.reattachRunningEmulators();
  }

  get sdkPath(): string {
    return this.#sdk.root;
  }

  get deviceRoot(): string {
    return this.#deviceRoot;
  }

  /**
   * why: The same call `create` made, with the same arguments, because the proof *is* that call:
   * a cheaper second check here would be a second validator, free to drift from the one
   * every start is judged by. It is asked for immediately before Simlock destroys anything
   * inside this root, since between then and startup the path can have become a symlink, or
   * a `mv` can have left the user's own AVD home standing where this root was.
   */
  async revalidateRoot(): Promise<void> {
    await ensureOwnedRoot(this.#rootOptions);
  }

  async findLegacy(driverDeviceId: string): Promise<LegacyDevice | undefined> {
    return this.#deviceTable.findLegacy(driverDeviceId);
  }

  async destroyLegacy(device: DriverDevice): Promise<void> {
    await this.#deviceTable.destroyLegacy(device);
  }

  virtualLeaseEnvironment(): Readonly<Record<string, string>> {
    // why: without this their `adb` talks to the shared server, which cannot see the emulator.
    return { ANDROID_ADB_SERVER_PORT: String(this.#adbServerPort) };
  }

  leaseEnvironment(device: DriverDevice): Readonly<Record<string, string>> {
    if (isPhysicalDriverDevice(device)) {
      return { ANDROID_ADB_SERVER_PORT: "5037", ANDROID_SERIAL: device.deviceId };
    }
    return this.virtualLeaseEnvironment();
  }

  readonly passthroughTools = ANDROID_PASSTHROUGH_TOOLS;

  async passthrough(
    _tool: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand> {
    return await this.#passthroughRules.passthrough(device, args, context);
  }

  /**
   * why: Stops the adb server this driver started. Nothing else can: `ADB_REJECT_KILL_SERVER=1`
   * makes `adb kill-server` refuse Simlock too, and the spawned child is not unref'd, so a
   * shutdown that skipped this would leave both a server and a daemon that cannot exit.
   */
  async dispose(): Promise<void> {
    if (await this.#emulatorAttached()) {
      this.#adbServer.leave();
      return;
    }
    await this.#adbServer.stop();
  }

  /**
   * why: an emulator that outlives the daemon starts its own adb `fork-server` on this port
   * once the server is gone, and the next daemon refuses that one as `occupied`; so the server
   * stays while an emulator is attached and the next daemon adopts it. An unreadable list
   * counts as none: the server is reaped as it always was.
   */
  async #emulatorAttached(): Promise<boolean> {
    try {
      const result = await this.#processRunner.run(this.#sdk.adb, ["devices"], {
        env: this.#adbTools.env(),
        timeoutMs: ADB_DEVICES_TIMEOUT_MS,
      });
      return result.code === 0 && portsFromAdbDevices(result.stdout).length > 0;
    } catch {
      return false;
    }
  }

  async resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    if (request.platform !== this.platform) {
      throw new Error(`Android driver cannot resolve ${request.platform} requests`);
    }

    return this.#catalog.resolveSpec(request);
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
      if (mine && this.#clock.now() - row.createdAt <= SEED_MAKE_CEILING_MS) continue;
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
      (await this.#avdConfigPart.currentConfigHash(
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
        const configHash = await this.#avdConfigPart.currentConfigHash(
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
        this.#sdk.adb,
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
      await this.#processRunner.run(this.#sdk.adb, ["-s", data.serial, "emu", "kill"], {
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
      const attached = await this.#adbTools.runOrThrow(this.#sdk.adb, ["devices"], {
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
        this.#sdk.avdmanager,
        ["create", "avd", "-n", SEED_AVD_NAME, "-k", packageName, "-d", seedDeviceId],
        { env: { ...this.#adbTools.env(), ANDROID_AVD_HOME: folder } },
      );
      if (profile.kind === "properties") {
        await this.#avdConfigPart.applyHardwareProperties(avdFolder, profile.hardwareProperties);
      }
      if (profile.kind === "library") {
        await this.#avdConfigPart.applyLibraryProfile(avdFolder, profile, image);
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
      const configHash = await this.#avdConfigPart.currentConfigHash(
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
      await this.#adbTools.runOrThrow(this.#sdk.adb, ["-s", booted.serial, "shell", "sync"], {
        timeoutMs: SEED_SHELL_TIMEOUT_MS,
      });
      await this.#adbTools.runOrThrow(
        this.#sdk.adb,
        ["-s", booted.serial, "shell", "reboot", "-p"],
        {
          timeoutMs: SEED_SHELL_TIMEOUT_MS,
        },
      );
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
      await this.#processRunner.run(this.#sdk.adb, ["-s", seed.serial, "emu", "kill"], {
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
        this.#sdk.adb,
        ["-s", seed.serial, "emu", "avd", "snapshot", "save", BOOT_SNAPSHOT],
        { timeoutMs: SNAPSHOT_SAVE_TIMEOUT_MS },
      );
      const snapshots = await this.#adbTools.runOrThrow(
        this.#sdk.adb,
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

  /**
   * why: Returns the device with its address re-read: see `Driver.makeReady` for why it is read here.
   *
   * `options.purpose === "recover"` boots and nothing else: a cold boot from disk, never a
   * snapshot load and never a wipe, since the device is still leased and its data is the
   * agent's.
   */
  async makeReady(
    device: DriverDevice,
    options?: { readonly purpose: "prepare" | "recover" },
  ): Promise<DriverDevice> {
    const data = this.#adbTools.dataFor(device);
    return this.#deviceTable.withLock(this.#adbTools.avdFolder(data), async () => {
      const state = this.#deviceTable.get(data);
      if (state.handle !== undefined) {
        const running = this.#consolePorts.onReservedPort(data, state);
        await this.#emulator.waitForReadiness(running, this.#clock.now());
        // why: The device was already running (or booting) under this driver instance, so its mark
        // can't have gone stale. Re-mark anyway: this is the
        // single readiness transition that lets a caller re-lease an already-ready device
        // without ever seeing a moment where "ready" and "marked" disagree.
        await this.#avdConfigPart.writeMark(running);
        return { address: running.serial, deviceId: device.deviceId, driverData: running };
      }

      if (options?.purpose === "recover") {
        state.handle = await this.#emulator.start(data, ["-no-snapshot-load"], false);
        await this.#avdConfigPart.writeMark(data);
        return { address: data.serial, deviceId: device.deviceId, driverData: data };
      }

      if (data.avdHome !== undefined) {
        const copy = await this.#consolePorts.withReservedPort(data, state);
        state.handle = await this.#emulator.start(copy, ["-snapshot", BOOT_SNAPSHOT], true);
        await this.#avdConfigPart.writeMark(copy);
        return { address: copy.serial, deviceId: device.deviceId, driverData: copy };
      }

      // why: a device made before copies has no boot snapshot: it boots once with a wipe and is destroyed at its release.
      const booted = await this.#consolePorts.withReservedPort(data, state);
      state.handle = await this.#emulator.start(booted, ["-wipe-data", "-no-snapshot-load"], false);
      await this.#avdConfigPart.writeMark(booted);
      return { address: booted.serial, deviceId: device.deviceId, driverData: booted };
    });
  }

  // why: the loopback ports held for a phone's tunnels are freed after its reclaim, which removes no rule: only the ports no rule points to are freed. An emulator's are freed at its destroy.
  async reclaim(
    device: DriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult> {
    const result = await this.#reclaimDevice(device, options);
    if (isPhysicalDriverDevice(device)) await this.deviceTcp?.release(device);
    return result;
  }

  async #reclaimDevice(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult> {
    if (isPhysicalDriverDevice(device)) {
      return this.#physical.reclaim(device);
    }
    throw new DriverCrashError("virtual devices are not reclaimed");
  }

  reclaimStrategy(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): "snapshot" | "wipe" | "uninstall" {
    if (isPhysicalDriverDevice(device)) return "uninstall";
    throw new DriverCrashError("virtual devices are not reclaimed");
  }

  async shutdown(device: DriverDevice): Promise<void> {
    const data = this.#adbTools.dataFor(device);
    await this.#deviceTable.withLock(this.#adbTools.avdFolder(data), async () => {
      const state = this.#deviceTable.get(data);
      await this.#emulator.shutdown(data, state.handle);
      state.handle = undefined;
    });
  }

  async destroy(device: DriverDevice): Promise<void> {
    const data = this.#adbTools.dataFor(device);
    await this.#deviceTable.withLock(this.#adbTools.avdFolder(data), async () => {
      const state = this.#deviceTable.get(data);
      // why: After a restart a stopped device's recorded port may be another device's (#52), so a
      // handle-less device is sent a kill only on a serial whose own answer names its AVD directory.
      if (state.handle !== undefined) {
        await this.#emulator.shutdown(this.#consolePorts.onReservedPort(data, state), state.handle);
        state.handle = undefined;
      } else if (state.restored === true) {
        await this.#emulator.stopUnowned(data);
      }
      if (data.avdHome === undefined) {
        await this.#adbTools.runOrThrow(this.#sdk.avdmanager, [
          "delete",
          "avd",
          "-n",
          data.avdName,
        ]);
      } else {
        await this.#filesystem.rm(data.avdHome);
      }
      this.#deviceTable.delete(data);
      if (state.port !== undefined) {
        this.#consolePorts.release(state.port);
      }
      await this.deviceTcp?.release({ ...device, physical: false as const });
    });
  }

  async listPresentPhysical(enrolledIds: readonly string[]): Promise<readonly PresentPhysical[]> {
    return this.#physical.listPresentPhysical(enrolledIds);
  }

  async inspectPhysical(id: string): Promise<PhysicalInspection> {
    return this.#physical.inspectPhysical(id);
  }

  async advisories(): Promise<readonly DriverAdvisory[]> {
    const physical = await this.#physical.advisories();
    const hidden = await this.#catalog.hiddenProfiles();
    return [
      ...physical,
      ...hidden.map(({ libraryName, userName }) => ({
        code: "device-profile-hidden",
        message: `"${userName}" in devices.xml is not used: Simlock's own ${libraryName} profile answers to that name`,
      })),
    ];
  }

  async listManaged(): Promise<DriverReality> {
    return this.#deviceTable.listManaged();
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    return this.#catalog.listCatalog();
  }

  estimate(
    estimate: DriverEstimate & { readonly operation: "boot"; readonly device: DriverDevice },
    spec: DeviceSpec,
  ): Promise<number>;
  estimate(estimate: DriverEstimate, spec: DeviceSpec): number;
  estimate(estimate: DriverEstimate, spec: DeviceSpec): number | Promise<number> {
    switch (estimate.operation) {
      case "provision":
        return spec.physical || this.#hasFreshSeed(spec)
          ? PROVISION_ESTIMATE_MS
          : SEED_MAKE_ESTIMATE_MS;
      case "boot":
        if (estimate.device === undefined) return COLD_BOOT_ESTIMATE_MS;
        return this.#emulator.bootEstimate(estimate.device, estimate.purpose, spec);
      case "reclaim":
        if (spec.physical) return PHYSICAL_RECLAIM_ESTIMATE_MS;
        // why: the two clean levels price differently (the wipe strategy about five times the snapshot one);
        // the estimate follows the level asked for, never an average of the two.
        return virtualReclaimStrategy(estimate.clean) === "wipe"
          ? WIPE_RECLAIM_ESTIMATE_MS
          : SNAPSHOT_RECLAIM_ESTIMATE_MS;
    }
  }

  /** why: read from the table with no process call: the estimate is asked often and the stale check is only worth a process at provision. */
  #hasFreshSeed(spec: VirtualSpec): boolean {
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

  async toolVersions(): Promise<readonly DriverToolVersion[]> {
    return this.#systemImages.toolVersions();
  }

  async findComponent(component: string): Promise<InstalledComponent | undefined> {
    return this.#systemImages.findComponent(component);
  }

  async installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult> {
    return this.#systemImages.installComponent(component, options);
  }

  async listComponents(): Promise<readonly DriverComponent[]> {
    return this.#systemImages.listComponents();
  }

  async removeComponent(
    receipt: ComponentReceipt,
    options: { readonly signal: AbortSignal },
  ): Promise<ComponentRemoval> {
    return removeListedComponent({
      list: () => this.#systemImages.listedImages(),
      platform: this.platform,
      receipt,
      remove: async ({ image }) => {
        const packageName = systemImagePackage(image.apiLevel, image.tag, image.abi);
        await this.#systemImages.uninstall(packageName, options);
        await this.#destroySeedsOf(packageName);
        return {};
      },
    });
  }

  /**
   * why: A seed made from a removed image would be remade at the next provision anyway; destroying it
   * now frees its disk. A seed that cannot be destroyed stays: its stale reason says the image is
   * gone, so `doctor` lists it and `nuke` deletes it, and the removal itself still succeeds.
   */
  async #destroySeedsOf(packageName: string): Promise<void> {
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
    if (spec.platform !== this.platform) {
      throw new Error(`Android driver cannot provision ${spec.platform} devices`);
    }
  }
}

class SequentialIdGenerator implements IdGenerator {
  #next = 1;

  generate(): string {
    const value = this.#next;
    this.#next += 1;
    return String(value);
  }
}

/**
 * why: A `deviceRoot` that is not a usable path refuses this platform's *configuration*, which
 * costs Android and nothing else -- not the daemon. `"deviceRoot": true` and
 * `"deviceRoot": "devices/android"` are one keystroke apart, and killing the process over
 * the first would take iOS down with it and leave the reason unreachable, since `doctor`
 * needs a daemon to answer. `not-absolute` is the published vocabulary term for "this
 * names no usable directory"; nothing new is invented here.
 */
function configuredDeviceRoot(options: AndroidDriverOptions): string {
  const configured = options.driverConfig["deviceRoot"];

  if (configured !== undefined && typeof configured !== "string") {
    throw new OwnedRootError(
      `Refusing the android device root: drivers.android.deviceRoot must be an absolute path, but it is the ${typeof configured} ${JSON.stringify(configured)}`,
      "not-absolute",
      String(configured),
      "android",
    );
  }

  return configured ?? join(options.simlockHome, "devices", "android");
}

/**
 * why: The port is only read here; whether it can actually carry a server is the supervisor's
 * decision, so range and reserved-port checks are not duplicated. A value that is not a
 * number at all cannot reach that check as itself, and the event payload has nowhere to
 * put it -- hence the `0` stand-in, with the configured value named in the message.
 */
function configuredAdbServerPort(options: AndroidDriverOptions): number {
  const configured = options.driverConfig["adbServerPort"];

  if (configured !== undefined && typeof configured !== "number") {
    throw new AdbServerUnavailableError(
      `Refusing to run the android driver: drivers.android.adbServerPort must be a TCP port number, but it is the ${typeof configured} ${JSON.stringify(configured)}`,
      "invalid-port",
      0,
    );
  }

  return configured ?? DEFAULT_ADB_SERVER_PORT;
}

async function discoverSdk(options: AndroidDriverOptions): Promise<AndroidSdkPaths> {
  const location = await locateSdk(options.env, options.homeDirectory, options.filesystem);
  if (location.kind === "complete") {
    return location.paths;
  }
  throw new SdkMissingError(location.searched);
}

/**
 * why: The launch settings a seed's boot snapshot depends on: the window and the GPU mode change the
 * emulator's graphics state, so a snapshot taken under one does not load cleanly under the
 * other. Audio and the boot animation do not, and stay out. Nothing is added while both are at
 * their defaults.
 */
function seedLaunchInputs(
  launch: AndroidEmulatorLaunchOptions = DEFAULT_EMULATOR_LAUNCH,
): string[] {
  if (
    launch.headless === DEFAULT_EMULATOR_LAUNCH.headless &&
    launch.gpu === DEFAULT_EMULATOR_LAUNCH.gpu
  ) {
    return [];
  }
  return [`headless=${String(launch.headless)}`, `gpu=${launch.gpu}`];
}

export function hostAbiFor(architecture: string): string {
  return architecture === "arm64" ? "arm64-v8a" : "x86_64";
}

// why: an emulator's capture target -- the same `adb -s <serial> …` with this driver's scoped env
// that every other emulator call carries, and raw connections to Simlock's own adb server. A phone
// gets its target from the physical handler, behind that server's version check; the capture itself
// names neither a port nor a check.
function emulatorScreenTarget(
  processRunner: ProcessRunner,
  adb: string,
  tcp: TcpStreamConnector,
  serverPort: number,
  env: () => NodeJS.ProcessEnv,
  serial: string,
  device: VirtualDriverDevice,
): ScreenTarget {
  if (serial === "") {
    throw new ScreenUnavailableError(
      `${device.deviceId} is not running, so it has no screen to stream`,
    );
  }
  return {
    connect: async (timeoutMs) => await tcp.connect(serverPort, timeoutMs),
    serial,
    spawn: async (args) => processRunner.spawn(adb, ["-s", serial, ...args], { env: env() }),
    run: async (args, timeoutMs) =>
      await processRunner.run(adb, ["-s", serial, ...args], { env: env(), timeoutMs }),
  };
}

export { androidDeviceDataTable } from "./device-data.js";
export { androidSourceDataOwner } from "./source-data.js";
export { androidPrerequisites } from "./prerequisites.js";

function virtualReclaimStrategy(clean: "standard" | "full"): "snapshot" | "wipe" {
  return clean === "full" ? "wipe" : "snapshot";
}
