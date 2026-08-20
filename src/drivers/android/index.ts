import type { DeviceSpec } from "../../core/domain.js";
import {
  BootTimeoutError,
  type DeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverDevice,
  DriverCrashError,
  type ReclaimResult,
  RuntimeMissingError,
  UnknownModelError,
} from "../../core/driver.js";
import type {
  Clock,
  Filesystem,
  IdGenerator,
  ProcessHandle,
  ProcessRunner,
} from "../../ports/index.js";
import { isAndroidDriverData, type AndroidDriverData } from "./data.js";

const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const COLD_BOOT_ESTIMATE_MS = 31_000;
const PORT_MAX = 5682;
const PORT_MIN = 5554;
const PORT_POLL_INTERVAL_MS = 2_000;
const SDK_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const SNAPSHOT_BOOT_ESTIMATE_MS = 4_000;
const CLEAN_BASELINE = "pitlane_clean_baseline";

export interface AndroidDriverOptions {
  readonly clock: Clock;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
  readonly hostAbi?: string;
  readonly idGenerator?: IdGenerator;
  readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
  readonly processRunner: ProcessRunner;
  readonly readinessTimeoutMs?: number;
}

export interface AndroidDriverDiagnostic {
  readonly avdName: string;
  readonly kind: "snapshot-cold-boot";
  readonly readyAfterMs: number;
}

export class SdkMissingError extends Error {
  constructor(readonly searchedPaths: readonly string[]) {
    super(`Android SDK missing or incomplete; searched: ${searchedPaths.join(", ")}`);
    this.name = "SdkMissingError";
  }
}

interface AndroidSdkPaths {
  readonly adb: string;
  readonly avdmanager: string;
  readonly emulator: string;
  readonly root: string;
  readonly sdkmanager: string;
}

interface DeviceState {
  baselineCaptured: boolean;
  handle: ProcessHandle | undefined;
  imageIdentity: string;
  needsWipe: boolean;
  snapshotExpected: boolean;
}

interface SystemImage {
  readonly abi: string;
  readonly apiLevel: string;
  readonly path: string;
  readonly tag: string;
  readonly version: string;
}

interface DeviceProfile {
  readonly id: string;
  readonly name: string;
}

const allocationsByRunner = new WeakMap<ProcessRunner, PortAllocator>();

export class AndroidDriver implements Driver {
  readonly platform = "android" as const;
  readonly #clock: Clock;
  readonly #devices = new Map<string, DeviceState>();
  readonly #filesystem: Filesystem;
  readonly #hostAbi: string;
  readonly #idGenerator: IdGenerator;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #onDiagnostic: ((diagnostic: AndroidDriverDiagnostic) => void) | undefined;
  readonly #portAllocator: PortAllocator;
  readonly #processRunner: ProcessRunner;
  readonly #profiles = new Map<string, DeviceProfile>();
  readonly #readinessTimeoutMs: number;
  readonly #sdk: AndroidSdkPaths;
  readonly #avdDirectory: string;

  private constructor(options: AndroidDriverOptions, sdk: AndroidSdkPaths) {
    this.#clock = options.clock;
    this.#filesystem = options.filesystem;
    this.#hostAbi = options.hostAbi ?? hostAbiFor(process.arch);
    this.#idGenerator = options.idGenerator ?? new SequentialIdGenerator();
    this.#onDiagnostic = options.onDiagnostic;
    this.#processRunner = options.processRunner;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.#sdk = sdk;
    this.#avdDirectory = options.env.ANDROID_AVD_HOME ?? `${options.homeDirectory}/.android/avd`;
    this.#portAllocator = portAllocatorFor(options.processRunner, sdk.adb);
  }

  static async create(options: AndroidDriverOptions): Promise<AndroidDriver> {
    const sdk = await discoverSdk(options);
    return new AndroidDriver(options, sdk);
  }

  get sdkPath(): string {
    return this.#sdk.root;
  }

  async resolveSpec(
    request: DeviceRequest,
    options: { readonly allowDownload: boolean },
  ): Promise<DeviceSpec> {
    if (request.platform !== this.platform) {
      throw new Error(`Android driver cannot resolve ${request.platform} requests`);
    }

    const profile = await this.#resolveProfile(request.model);
    const images = await this.#installedImages();
    const apiLevel = request.osVersion ?? newestApiLevel(images);
    if (apiLevel === undefined) {
      throw new RuntimeMissingError(this.platform, request.osVersion ?? "default");
    }

    if (this.#matchingImage(images, apiLevel) === undefined) {
      if (!options.allowDownload) {
        throw new RuntimeMissingError(this.platform, apiLevel);
      }

      const packageName = systemImagePackage(apiLevel, "google_apis", this.#hostAbi);
      await this.#runOrThrow(this.#sdk.sdkmanager, ["--install", packageName], {
        timeoutMs: SDK_DOWNLOAD_TIMEOUT_MS,
      });
    }

    this.#profiles.set(profile.name.toLocaleLowerCase(), profile);
    return { model: profile.name, osVersion: apiLevel, platform: this.platform };
  }

  async provision(spec: DeviceSpec): Promise<DriverDevice> {
    this.#assertAndroidSpec(spec);
    const profile = await this.#profileFor(spec.model);
    const image = await this.#requireImage(spec.osVersion);
    const avdName = `pitlane_${this.#idGenerator.generate()}`;
    const packageName = systemImagePackage(image.apiLevel, image.tag, image.abi);

    await this.#runOrThrow(this.#sdk.avdmanager, [
      "create",
      "avd",
      "-n",
      avdName,
      "-k",
      packageName,
      "-d",
      profile.id,
    ]);

    const configHash = await this.#configHash(avdName, image);
    const port = await this.#portAllocator.allocate();
    const driverData: AndroidDriverData = {
      avdName,
      configHash,
      imageIdentity: `${image.path}@${image.version}`,
      port,
      serial: serialFor(port),
    };
    this.#devices.set(avdName, {
      baselineCaptured: false,
      handle: undefined,
      imageIdentity: `${image.path}@${image.version}`,
      needsWipe: false,
      snapshotExpected: false,
    });

    return { deviceId: avdName, driverData };
  }

  async makeReady(device: DriverDevice): Promise<void> {
    const data = this.#dataFor(device);
    await this.#withDeviceLock(data.avdName, async () => {
      const state = this.#stateFor(data);
      if (state.handle !== undefined) {
        await this.#waitForReadiness(data, this.#clock.now());
        return;
      }

      const baselineHash = await this.#baselineHash(data.avdName);
      if (!state.needsWipe && baselineHash !== undefined) {
        const currentHash = await this.#currentConfigHash(data.avdName, state.imageIdentity);
        if (baselineHash === currentHash) {
          state.baselineCaptured = true;
          state.snapshotExpected = true;
        } else {
          await this.#filesystem.rm(`${this.#avdDirectory}/${data.avdName}.avd/snapshots`);
          state.baselineCaptured = false;
          state.needsWipe = true;
          state.snapshotExpected = false;
        }
      }

      await this.#startEmulator(
        data,
        state,
        state.needsWipe
          ? ["-wipe-data", "-no-snapshot-load"]
          : state.snapshotExpected
            ? ["-snapshot", CLEAN_BASELINE]
            : ["-no-snapshot-load"],
        state.snapshotExpected,
      );
      state.needsWipe = false;
      state.snapshotExpected = false;
      if (!state.baselineCaptured) {
        await this.#captureBaseline(data, state);
        await this.#shutdown(data, state);
        await this.#startEmulator(data, state, ["-snapshot", CLEAN_BASELINE], true);
      }
    });
  }

  async reclaim(
    device: DriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult> {
    const data = this.#dataFor(device);
    return this.#withDeviceLock(data.avdName, async () => {
      const state = this.#stateFor(data);

      if (options.clean === "full") {
        await this.#shutdown(data, state);
        state.needsWipe = true;
        state.snapshotExpected = false;
        state.baselineCaptured = false;
        return { state: "shutdown", strategy: "wipe" };
      }

      const currentHash = await this.#currentConfigHash(data.avdName, state.imageIdentity);
      const baselineHash = await this.#baselineHash(data.avdName);
      if (baselineHash !== currentHash) {
        await this.#shutdown(data, state);
        await this.#filesystem.rm(`${this.#avdDirectory}/${data.avdName}.avd/snapshots`);
        state.needsWipe = true;
        state.snapshotExpected = false;
        state.baselineCaptured = false;
        return { state: "shutdown", strategy: "wipe" };
      }

      const restored = await this.#runOrThrow(this.#sdk.adb, [
        "-s",
        data.serial,
        "emu",
        "avd",
        "snapshot",
        "load",
        CLEAN_BASELINE,
      ]);
      if (!/OK|loaded|success/i.test(`${restored.stdout}\n${restored.stderr}`)) {
        await this.#shutdown(data, state);
        state.needsWipe = true;
        state.baselineCaptured = false;
        return { state: "shutdown", strategy: "wipe" };
      }
      await this.#waitForReadiness(data, this.#clock.now());
      return { state: "ready", strategy: "snapshot" };
    });
  }

  reclaimStrategy(options: { readonly clean: "standard" | "full" }): "snapshot" | "wipe" {
    return options.clean === "full" ? "wipe" : "snapshot";
  }

  async shutdown(device: DriverDevice): Promise<void> {
    const data = this.#dataFor(device);
    await this.#withDeviceLock(data.avdName, async () => {
      await this.#shutdown(data, this.#stateFor(data));
    });
  }

  async destroy(device: DriverDevice): Promise<void> {
    const data = this.#dataFor(device);
    await this.#withDeviceLock(data.avdName, async () => {
      if (data.port > 0) {
        await this.#shutdown(data, this.#stateFor(data));
      }
      await this.#runOrThrow(this.#sdk.avdmanager, ["delete", "avd", "-n", data.avdName]);
      this.#devices.delete(data.avdName);
      this.#portAllocator.release(data.port);
    });
  }

  async listManaged(): Promise<{
    readonly devices: readonly DriverDevice[];
    readonly processes: readonly DriverDevice[];
  }> {
    const devices: DriverDevice[] = [];
    if (await this.#filesystem.exists(this.#avdDirectory)) {
      for (const entry of await this.#filesystem.readdir(this.#avdDirectory)) {
        const match = /^(pitlane_.+)\.avd$/.exec(entry);
        if (match?.[1] === undefined) continue;
        const avdName = match[1];
        devices.push({
          deviceId: avdName,
          driverData: {
            avdName,
            configHash: "recovered",
            imageIdentity: "",
            port: 0,
            serial: "",
          } satisfies AndroidDriverData,
        });
      }
    }

    const processes: DriverDevice[] = [];
    const attached = await this.#runOrThrow(this.#sdk.adb, ["devices"]);
    for (const serial of attached.stdout.matchAll(/^((?:emulator)-\d+)\s+device$/gm)) {
      const candidate = serial[1];
      if (candidate === undefined) continue;
      const name = await this.#runOrThrow(this.#sdk.adb, [
        "-s",
        candidate,
        "shell",
        "getprop",
        "ro.boot.qemu.avd_name",
      ]);
      const avdName = name.stdout.trim();
      if (!avdName.startsWith("pitlane_")) continue;
      const port = Number(candidate.slice("emulator-".length));
      processes.push({
        deviceId: avdName,
        driverData: {
          avdName,
          configHash: "recovered",
          imageIdentity: "",
          port,
          serial: candidate,
        } satisfies AndroidDriverData,
      });
    }
    return { devices, processes };
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    const [profiles, images] = await Promise.all([
      this.#listDeviceProfiles(),
      this.#installedImages(),
    ]);
    return {
      defaultRuntime: newestApiLevel(images),
      models: profiles.map((profile) => profile.name),
      runtimes: [...new Set(images.map((image) => image.apiLevel))].sort(compareApiLevels),
    };
  }

  estimate(operation: "provision" | "boot" | "reclaim", _spec: DeviceSpec): number {
    switch (operation) {
      case "provision":
        return 1_000;
      case "boot":
        return COLD_BOOT_ESTIMATE_MS;
      case "reclaim":
        return 2_000;
    }
  }

  async #profileFor(model: string): Promise<DeviceProfile> {
    return this.#profiles.get(model.toLocaleLowerCase()) ?? this.#resolveProfile(model);
  }

  async #listDeviceProfiles(): Promise<readonly DeviceProfile[]> {
    const result = await this.#runOrThrow(this.#sdk.avdmanager, ["list", "device"]);
    return parseDeviceProfiles(result.stdout);
  }

  async #resolveProfile(model: string): Promise<DeviceProfile> {
    const profiles = await this.#listDeviceProfiles();
    const normalized = model.toLocaleLowerCase();
    const profile = profiles.find(
      (candidate) =>
        candidate.name.toLocaleLowerCase() === normalized ||
        candidate.id.toLocaleLowerCase() === normalized,
    );
    if (profile === undefined) {
      throw new UnknownModelError(this.platform, model);
    }
    return profile;
  }

  async #installedImages(): Promise<SystemImage[]> {
    const root = `${this.#sdk.root}/system-images`;
    if (!(await this.#filesystem.exists(root))) {
      return [];
    }

    const images: SystemImage[] = [];
    for (const apiDirectory of await this.#filesystem.readdir(root)) {
      const apiMatch = /^android-(.+)$/.exec(apiDirectory);
      if (apiMatch?.[1] === undefined) {
        continue;
      }
      const apiPath = `${root}/${apiDirectory}`;
      for (const tag of await this.#filesystem.readdir(apiPath)) {
        const tagPath = `${apiPath}/${tag}`;
        for (const abi of await this.#filesystem.readdir(tagPath)) {
          const path = `${tagPath}/${abi}`;
          images.push({
            abi,
            apiLevel: apiMatch[1],
            path,
            tag,
            version: await systemImageVersion(this.#filesystem, path),
          });
        }
      }
    }
    return images;
  }

  #matchingImage(images: readonly SystemImage[], apiLevel: string): SystemImage | undefined {
    const matching = images.filter((image) => image.apiLevel === apiLevel);
    return (
      matching.find((image) => image.tag === "google_apis" && image.abi === this.#hostAbi) ??
      matching.find((image) => image.abi === this.#hostAbi) ??
      matching.find((image) => image.tag === "google_apis") ??
      matching[0]
    );
  }

  async #requireImage(apiLevel: string): Promise<SystemImage> {
    const image = this.#matchingImage(await this.#installedImages(), apiLevel);
    if (image === undefined) {
      throw new RuntimeMissingError(this.platform, apiLevel);
    }
    return image;
  }

  async #configHash(avdName: string, image: SystemImage): Promise<string> {
    const [emulatorVersion, config] = await Promise.all([
      this.#emulatorVersion(),
      this.#avdConfig(avdName),
    ]);
    return stableHash([`${image.path}@${image.version}`, emulatorVersion, config]);
  }

  async #currentConfigHash(avdName: string, imageIdentity: string): Promise<string> {
    const [emulatorVersion, config] = await Promise.all([
      this.#emulatorVersion(),
      this.#avdConfig(avdName),
    ]);
    return stableHash([imageIdentity, emulatorVersion, config]);
  }

  async #emulatorVersion(): Promise<string> {
    const result = await this.#runOrThrow(this.#sdk.emulator, ["-version"]);
    return result.stdout.trim();
  }

  async #avdConfig(avdName: string): Promise<string> {
    try {
      const contents = await this.#filesystem.readFile(
        `${this.#avdDirectory}/${avdName}.avd/config.ini`,
      );
      return contents
        .split(/\r?\n/)
        .filter((line) => /^(image\.sysdir\.1|hw\.|disk\.dataPartition\.)/.test(line))
        .sort()
        .join("\n");
    } catch {
      return "";
    }
  }

  async #waitForReadiness(data: AndroidDriverData, startedAt: number): Promise<void> {
    while (true) {
      if (this.#clock.now() - startedAt >= this.#readinessTimeoutMs) {
        throw new BootTimeoutError(data.avdName);
      }

      const completed = await this.#processRunner.run(this.#sdk.adb, [
        "-s",
        data.serial,
        "shell",
        "getprop",
        "sys.boot_completed",
      ]);
      if (completed.code !== 0) {
        await this.#delay(
          Math.min(
            PORT_POLL_INTERVAL_MS,
            this.#readinessTimeoutMs - (this.#clock.now() - startedAt),
          ),
        );
        continue;
      }
      if (completed.stdout.trim() === "1") {
        const bootAnimation = await this.#runOrThrow(this.#sdk.adb, [
          "-s",
          data.serial,
          "shell",
          "getprop",
          "init.svc.bootanim",
        ]);
        if (bootAnimation.stdout.trim() === "" || bootAnimation.stdout.trim() === "stopped") {
          return;
        }
      }

      await this.#delay(
        Math.min(PORT_POLL_INTERVAL_MS, this.#readinessTimeoutMs - (this.#clock.now() - startedAt)),
      );
    }
  }

  async #startEmulator(
    data: AndroidDriverData,
    state: DeviceState,
    launchArgs: readonly string[],
    fromSnapshot: boolean,
  ): Promise<void> {
    const startedAt = this.#clock.now();
    const handle = this.#processRunner.spawn(this.#sdk.emulator, [
      "-avd",
      data.avdName,
      "-port",
      String(data.port),
      "-no-snapshot-save",
      ...launchArgs,
    ]);
    state.handle = handle;

    try {
      await this.#waitForReadiness(data, startedAt);
    } catch (error: unknown) {
      handle.kill("SIGKILL");
      await handle.wait();
      state.handle = undefined;
      throw error;
    }

    const readyAfterMs = this.#clock.now() - startedAt;
    if (fromSnapshot && readyAfterMs > SNAPSHOT_BOOT_ESTIMATE_MS * 3) {
      this.#onDiagnostic?.({ avdName: data.avdName, kind: "snapshot-cold-boot", readyAfterMs });
    }
  }

  async #captureBaseline(data: AndroidDriverData, state: DeviceState): Promise<void> {
    await this.#runOrThrow(this.#sdk.adb, [
      "-s",
      data.serial,
      "emu",
      "avd",
      "snapshot",
      "save",
      CLEAN_BASELINE,
    ]);
    const snapshots = await this.#runOrThrow(this.#sdk.adb, [
      "-s",
      data.serial,
      "emu",
      "avd",
      "snapshot",
      "list",
    ]);
    if (!snapshots.stdout.includes(CLEAN_BASELINE)) {
      throw new DriverCrashError(`Android clean baseline ${CLEAN_BASELINE} was not validated`);
    }
    const configHash = await this.#currentConfigHash(data.avdName, state.imageIdentity);
    await this.#filesystem.writeFileAtomic(
      this.#baselineMetadataPath(data.avdName),
      JSON.stringify({ configHash, snapshot: CLEAN_BASELINE }),
    );
    state.baselineCaptured = true;
  }

  async #baselineHash(avdName: string): Promise<string | undefined> {
    try {
      const value = JSON.parse(
        await this.#filesystem.readFile(this.#baselineMetadataPath(avdName)),
      ) as {
        readonly configHash?: unknown;
        readonly snapshot?: unknown;
      };
      return value.snapshot === CLEAN_BASELINE && typeof value.configHash === "string"
        ? value.configHash
        : undefined;
    } catch {
      return undefined;
    }
  }

  #baselineMetadataPath(avdName: string): string {
    return `${this.#avdDirectory}/${avdName}.avd/pitlane-clean-baseline.json`;
  }

  async #shutdown(data: AndroidDriverData, state: DeviceState): Promise<void> {
    await this.#processRunner.run(this.#sdk.adb, ["-s", data.serial, "emu", "kill"]);
    const handle = state.handle;
    if (handle === undefined) {
      return;
    }

    const exited = await this.#waitForExit(handle, this.#readinessTimeoutMs);
    if (!exited) {
      handle.kill("SIGKILL");
      await handle.wait();
    }
    state.handle = undefined;
  }

  async #waitForExit(handle: ProcessHandle, timeoutMs: number): Promise<boolean> {
    let timerFired = false;
    const timer = this.#clock.setTimer(timeoutMs, () => {
      timerFired = true;
    });
    const result = await Promise.race([
      handle.wait().then(() => true),
      new Promise<boolean>((resolve) => {
        this.#clock.setTimer(timeoutMs, () => resolve(false));
      }),
    ]);
    this.#clock.cancel(timer);
    return timerFired ? false : result;
  }

  async #runOrThrow(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs?: number } = {},
  ) {
    const result = await this.#processRunner.run(command, args, options);
    if (result.code !== 0) {
      throw new DriverCrashError(
        `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }

  #dataFor(device: DriverDevice): AndroidDriverData {
    if (!isAndroidDriverData(device.driverData)) {
      throw new Error(`Android device ${device.deviceId} has invalid driver data`);
    }
    if (device.deviceId !== device.driverData.avdName) {
      throw new Error(
        `Android device id ${device.deviceId} does not match AVD ${device.driverData.avdName}`,
      );
    }
    return device.driverData;
  }

  #stateFor(data: AndroidDriverData): DeviceState {
    const existing = this.#devices.get(data.avdName);
    if (existing !== undefined) {
      return existing;
    }
    const restored: DeviceState = {
      baselineCaptured: false,
      handle: undefined,
      imageIdentity: data.imageIdentity ?? "",
      needsWipe: false,
      snapshotExpected: false,
    };
    this.#devices.set(data.avdName, restored);
    return restored;
  }

  #assertAndroidSpec(spec: DeviceSpec): void {
    if (spec.platform !== this.platform) {
      throw new Error(`Android driver cannot provision ${spec.platform} devices`);
    }
  }

  async #withDeviceLock<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(deviceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(deviceId, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(deviceId) === queued) {
        this.#locks.delete(deviceId);
      }
    }
  }

  #delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.#clock.setTimer(milliseconds, resolve);
    });
  }
}

class PortAllocator {
  readonly #reserved = new Set<number>();
  #lock = Promise.resolve();

  constructor(
    private readonly adb: string,
    private readonly processRunner: ProcessRunner,
  ) {}

  async allocate(): Promise<number> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const result = await this.processRunner.run(this.adb, ["devices"]);
      if (result.code !== 0) {
        throw new DriverCrashError(`adb devices failed: ${result.stderr || result.stdout}`);
      }
      const unavailable = new Set([...this.#reserved, ...portsFromAdbDevices(result.stdout)]);
      for (let port = PORT_MIN; port <= PORT_MAX; port += 2) {
        if (!unavailable.has(port)) {
          this.#reserved.add(port);
          return port;
        }
      }
      throw new DriverCrashError("No Android emulator console ports are available");
    } finally {
      release();
    }
  }

  release(port: number): void {
    this.#reserved.delete(port);
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

async function discoverSdk(options: AndroidDriverOptions): Promise<AndroidSdkPaths> {
  const roots = [
    options.env.ANDROID_HOME,
    options.env.ANDROID_SDK_ROOT,
    `${options.homeDirectory}/Library/Android/sdk`,
  ].filter((root): root is string => root !== undefined && root !== "");
  const searchedPaths: string[] = [];

  for (const root of roots) {
    const paths = await sdkPathsAt(root, options.filesystem);
    searchedPaths.push(root);
    if (paths !== undefined) {
      return paths;
    }
  }
  throw new SdkMissingError(searchedPaths);
}

async function sdkPathsAt(
  root: string,
  filesystem: Filesystem,
): Promise<AndroidSdkPaths | undefined> {
  const commandLineTools = await commandLineToolBins(root, filesystem);
  const legacyTools = `${root}/tools/bin`;
  const toolBins = [...commandLineTools, legacyTools];
  const tools = await firstCompleteToolBin(filesystem, toolBins);
  const emulator = `${root}/emulator/emulator`;
  const adb = `${root}/platform-tools/adb`;
  if (
    tools === undefined ||
    !(await filesystem.exists(emulator)) ||
    !(await filesystem.exists(adb))
  ) {
    return undefined;
  }
  return { adb, emulator, root, ...tools };
}

async function commandLineToolBins(root: string, filesystem: Filesystem): Promise<string[]> {
  const toolsRoot = `${root}/cmdline-tools`;
  if (!(await filesystem.exists(toolsRoot))) {
    return [];
  }

  const directories = await filesystem.readdir(toolsRoot);
  return directories
    .sort(compareCommandLineToolVersions)
    .reverse()
    .map((directory) => `${toolsRoot}/${directory}/bin`);
}

async function firstCompleteToolBin(
  filesystem: Filesystem,
  bins: readonly string[],
): Promise<Pick<AndroidSdkPaths, "avdmanager" | "sdkmanager"> | undefined> {
  for (const bin of bins) {
    const avdmanager = `${bin}/avdmanager`;
    const sdkmanager = `${bin}/sdkmanager`;
    if ((await filesystem.exists(avdmanager)) && (await filesystem.exists(sdkmanager))) {
      return { avdmanager, sdkmanager };
    }
  }
  return undefined;
}

function compareCommandLineToolVersions(left: string, right: string): number {
  if (left === "latest") {
    return 1;
  }
  if (right === "latest") {
    return -1;
  }

  const leftSegments = left.split(".").map(Number);
  const rightSegments = right.split(".").map(Number);
  if (leftSegments.every(Number.isFinite) && rightSegments.every(Number.isFinite)) {
    const length = Math.max(leftSegments.length, rightSegments.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (leftSegments[index] ?? 0) - (rightSegments[index] ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
  }

  return left.localeCompare(right);
}

function parseDeviceProfiles(output: string): DeviceProfile[] {
  const profiles: DeviceProfile[] = [];
  let id: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const idMatch = /^id:\s*\d+\s+or\s+"([^"]+)"/.exec(line.trim());
    if (idMatch?.[1] !== undefined) {
      id = idMatch[1];
      continue;
    }
    const nameMatch = /^Name:\s*(.+)$/.exec(line.trim());
    if (id !== undefined && nameMatch?.[1] !== undefined) {
      profiles.push({ id, name: nameMatch[1] });
      id = undefined;
    }
  }
  return profiles;
}

function newestApiLevel(images: readonly SystemImage[]): string | undefined {
  return [...new Set(images.map((image) => image.apiLevel))].sort(compareApiLevels).at(-1);
}

function compareApiLevels(left: string, right: string): number {
  const numericDifference = Number(left) - Number(right);
  return Number.isNaN(numericDifference) || numericDifference === 0
    ? left.localeCompare(right)
    : numericDifference;
}

function systemImagePackage(apiLevel: string, tag: string, abi: string): string {
  return `system-images;android-${apiLevel};${tag};${abi}`;
}

async function systemImageVersion(filesystem: Filesystem, imagePath: string): Promise<string> {
  try {
    const properties = await filesystem.readFile(`${imagePath}/source.properties`);
    return (
      properties
        .split(/\r?\n/)
        .find((line) => line.startsWith("Pkg.Revision="))
        ?.slice("Pkg.Revision=".length)
        .trim() ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

function serialFor(port: number): string {
  return `emulator-${port}`;
}

function portsFromAdbDevices(output: string): number[] {
  return [...output.matchAll(/^emulator-(\d+)\s+/gm)]
    .map((match) => Number(match[1]))
    .filter((port) => Number.isInteger(port));
}

function stableHash(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const character of parts.join("\u0000")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hostAbiFor(architecture: string): string {
  return architecture === "arm64" ? "arm64-v8a" : "x86_64";
}

function portAllocatorFor(processRunner: ProcessRunner, adb: string): PortAllocator {
  const existing = allocationsByRunner.get(processRunner);
  if (existing !== undefined) {
    return existing;
  }
  const allocator = new PortAllocator(adb, processRunner);
  allocationsByRunner.set(processRunner, allocator);
  return allocator;
}
