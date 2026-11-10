import { join } from "node:path";

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
  type SnapshotColdBootDiagnostic,
} from "./emulator.js";
import {
  type AndroidDriverConfig,
  type AndroidEmulatorLaunchOptions,
  DEFAULT_ADB_SERVER_PORT,
  defaultAndroidDeviceRoot,
} from "./definition.js";
import { ADB_DEVICES_TIMEOUT_MS, AdbTools } from "./adb-tools.js";
import { ANDROID_DEFAULT_MODELS, Catalog } from "./catalog.js";
import { AdbServerSupervisor, AdbServerUnavailableError } from "./adb-server.js";
import { ConsolePorts, portAllocatorFor, portsFromAdbDevices } from "./console-ports.js";
import { AvdConfig } from "./avd-config.js";
import { DeviceTable } from "./device-table.js";
import { Ownership } from "./ownership.js";
import { ANDROID_PASSTHROUGH_TOOLS, PassthroughRules } from "./passthrough-rules.js";
import { AndroidPhysicalHandler, PHYSICAL_RECLAIM_ESTIMATE_MS } from "./physical-handler.js";
import {
  type DeviceProfileSource,
  type DeviceProfileSourceDiagnostic,
} from "./device-profile-source.js";
import {
  ANDROID_SYSTEM_IMAGE_MIN_FREE_BYTES,
  SystemImages,
  systemImagePackage,
} from "./system-images.js";
import { createAndroidDeviceInput } from "./input/index.js";
import { BOOT_SNAPSHOT, PROVISION_ESTIMATE_MS, SEED_MAKE_ESTIMATE_MS, Seeds } from "./seeds.js";
import { createAndroidScreenCapture, type ScreenTarget } from "./screen/index.js";
import { type AndroidSdkPaths, locateSdk } from "./sdk-paths.js";

export { AdbServerUnavailableError } from "./adb-server.js";
export { AndroidLicenseNotAcceptedError } from "./system-images.js";
export {
  type AndroidDriverConfig,
  androidDriverConfig,
  type AndroidEmulatorLaunchOptions,
} from "./definition.js";
export {
  ANDROID_PASSTHROUGH_TOOLS,
  REFUSED_ADB_SEQUENCES,
  REFUSED_ADB_VERB,
} from "./passthrough-rules.js";

const DEFAULT_BOOT_TIMEOUT_MS = 300_000;
// why: the reclaim estimates below price the two strategies `virtualReclaimStrategy` still names; the Android driver
// reclaims no virtual device (a released one is deleted), so they were measured on an M3 Pro against Pixel 8 / API 35
// when it did: 2.4-5.1s for the snapshot strategy.
const SNAPSHOT_RECLAIM_ESTIMATE_MS = 6_000;
// why: measured on the same hardware at 22.8-42.8s (median 31.7s) for the wipe strategy; the slow
// branch is the one quoted, so `Doctor` never reads a slow reclaim as stalled.
const WIPE_RECLAIM_ESTIMATE_MS = 32_000;

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
  /** why: the driver's own keys of the `android` config section; without it emulators launch with the section's defaults. */
  readonly config?: Partial<AndroidDriverConfig> | undefined;
}

export type AndroidDriverDiagnostic = SnapshotColdBootDiagnostic | DeviceProfileSourceDiagnostic;

export class SdkMissingError extends Error {
  constructor(readonly searchedPaths: readonly string[]) {
    super(`Android SDK missing or incomplete; searched: ${searchedPaths.join(", ")}`);
    this.name = "SdkMissingError";
  }
}

type AndroidTargetFor = (
  device: VirtualDriverDevice | PhysicalDriverDevice,
) => Promise<ScreenTarget>;

export class AndroidDriver implements Driver {
  readonly platform = "android" as const;
  readonly defaultModels = ANDROID_DEFAULT_MODELS;
  readonly #adbServer: AdbServerSupervisor;
  readonly #adbServerPort: number;
  readonly #adbTools: AdbTools;
  readonly #avdConfigPart: AvdConfig;
  readonly #catalog: Catalog;
  readonly #ownership: Ownership;
  readonly #bootTimeoutMs: number;
  readonly #passthroughRules: PassthroughRules;
  readonly #clock: Clock;
  readonly #deviceTable: DeviceTable;
  readonly #deviceRoot: string;
  readonly #filesystem: Filesystem;
  readonly #legacyAvdHome: string;
  readonly #onDiagnostic: ((diagnostic: AndroidDriverDiagnostic) => void) | undefined;
  readonly #consolePorts: ConsolePorts;
  readonly #processRunner: ProcessRunner;
  readonly #physical: AndroidPhysicalHandler;
  readonly #emulator: Emulator;
  readonly #rootOptions: EnsureOwnedRootOptions;
  readonly #sdk: AndroidSdkPaths;
  readonly #systemImages: SystemImages;
  readonly #seeds: Seeds;
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
      seedLaunchInputs: seedLaunchInputs(options.config?.emulator),
    });
    this.#bootTimeoutMs = options.config?.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    this.#ownership = new Ownership({
      adb: sdk.adb,
      adbTools: this.#adbTools,
      filesystem: options.filesystem,
    });
    this.#clock = options.clock;
    this.#deviceRoot = deviceRoot;
    this.#filesystem = options.filesystem;
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
    this.deviceTcp = this.#deviceTcpFor(options, deviceTarget);
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
    this.#seeds = new Seeds({
      adb: sdk.adb,
      adbTools: this.#adbTools,
      avdConfig: this.#avdConfigPart,
      avdmanager: sdk.avdmanager,
      catalog: this.#catalog,
      clock: options.clock,
      bootTimeoutMs: this.#bootTimeoutMs,
      consolePorts: this.#consolePorts,
      database: options.database,
      deviceRoot,
      deviceTable: this.#deviceTable,
      emulator: this.#emulator,
      filesystem: options.filesystem,
      idGenerator: options.idGenerator ?? new SequentialIdGenerator(),
      ownership: this.#ownership,
      processRunner: options.processRunner,
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
      emulatorLaunch: options.config?.emulator,
      filesystem: options.filesystem,
      onDiagnostic: options.onDiagnostic,
      ownership: this.#ownership,
      processRunner: options.processRunner,
      bootTimeoutMs: this.#bootTimeoutMs,
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

  #deviceTcpFor(
    options: AndroidDriverOptions,
    target: AndroidTargetFor | undefined,
  ): AndroidDeviceTcp | undefined {
    if (options.tcpListener === undefined) return undefined;
    return createAndroidDeviceTcp({
      clock: options.clock,
      connector: options.tcpStreamConnector,
      listeners: options.tcpListener,
      target,
      isOwn: (device) => this.#ownership.deviceIsOwn(device),
      runAdb: (device, args, timeoutMs) => this.#passthroughRules.runAdbOn(device, args, timeoutMs),
      warn: (message, detail) => options.logger?.warn(message, detail),
    });
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
    return this.#seeds.listSources();
  }

  async saveSource(
    device: VirtualDriverDevice,
  ): Promise<{ sourceId: string; sizeBytes?: number; imageTag?: string }> {
    return this.#seeds.saveSource(device);
  }

  async destroySource(sourceId: string): Promise<void> {
    return this.#seeds.destroySource(sourceId);
  }

  async provision(
    spec: VirtualSpec,
    options: { readonly source?: string } = {},
  ): Promise<DriverDevice> {
    return this.#seeds.provision(spec, options);
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
        return spec.physical || this.#seeds.hasFreshSeed(spec)
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
        await this.#seeds.destroySeedsOf(packageName);
        return {};
      },
    });
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

  return configured ?? defaultAndroidDeviceRoot(options.simlockHome);
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
