import type { DeviceSpec } from "../../core/domain.js";
import {
  BootTimeoutError,
  type DeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverDevice,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  type ObservedDevice,
  type ObservedMark,
  type ReclaimResult,
  RuntimeMissingError,
  UnknownModelError,
} from "../../core/driver.js";
import type {
  Clock,
  Filesystem,
  IdGenerator,
  ProcessHandle,
  ProcessResult,
  ProcessRunner,
} from "../../ports/index.js";
import { isAndroidDriverData, type AndroidDriverData } from "./data.js";

const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const COLD_BOOT_ESTIMATE_MS = 31_000;
const PORT_MAX = 5682;
const PORT_MIN = 5554;
const PORT_POLL_INTERVAL_MS = 2_000;
const SDK_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
// A defense-in-depth bound on the wait that follows a SIGKILL: NodeProcessHandle#wait
// already settles shortly after `exit`, but this keeps a pathologically slow reap
// from ever turning a "we already killed it" cleanup into an unbounded await.
const SIGKILL_REAP_TIMEOUT_MS = 5_000;
const SNAPSHOT_BOOT_ESTIMATE_MS = 4_000;
const PROVISION_ESTIMATE_MS = 1_000;
// Measured on an M3 Pro against Pixel 8 / API 35: 2.4-5.1s over nine steady-state reclaims
// (median 4.6s), and 3.7-5.7s with three running at once. A `snapshot` reclaim loads the clean
// baseline and commits the device straight back to `ready`, so the driver call is the whole
// window the device spends `reclaiming`. Held just above the observed maximum.
const SNAPSHOT_RECLAIM_ESTIMATE_MS = 6_000;
// Measured at 22.8-42.8s on the same hardware (median 31.7s) -- an order of magnitude above the
// 3s this first guessed, for a reason worth stating precisely. `reclaim` itself really does
// only shut the emulator down and defer the wipe to the next `makeReady`; what it does not do
// is end the device's time in `reclaiming`. `WarmPoolCoordinator#disposition` re-readies a
// device the pool wants to keep warm before committing the transition, so the wipe boot and the
// baseline re-capture land inside the same window -- and that window, not the driver call, is
// what both consumers of this number measure: a waiting requester's ETA, and the state age
// `Doctor` compares against. A device the pool does not keep warm settles in seconds instead.
// The slow branch is the one to quote: pricing the fast one would make every kept-warm reclaim
// look stalled, while over-quoting only delays a finding.
const WIPE_RECLAIM_ESTIMATE_MS = 32_000;
const CLEAN_BASELINE = "simlock_clean_baseline";
const DURABLE_MARK_KEY = "simlock.mark";
const ERASABLE_MARK_PATH = "/data/local/tmp/simlock-mark.json";

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
  /**
   * Placeholder until this driver owns a validated AVD home and a private adb server
   * (ADR 0001, decision 4). Deliberately not `#avdDirectory`: that is wherever the user's
   * own AVDs already live, and naming it here would claim an ownership Simlock has not
   * proven for it. Nothing reads either member yet.
   */
  // fallow-ignore-next-line unused-class-member -- Driver.deviceRoot contract; read by doctor --purge-orphans to say which root an orphan came from.
  readonly deviceRoot = "/simlock-android-device-root-pending";
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

  // fallow-ignore-next-line unused-class-member -- Driver.leaseEnvironment contract; read by the lease path when it builds a grant.
  leaseEnvironment(): Readonly<Record<string, string>> {
    return {};
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
    const avdName = `simlock_${this.#idGenerator.generate()}`;
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

    return { address: serialFor(port), deviceId: avdName, driverData };
  }

  /** Returns the device with its address re-read: see `Driver.makeReady` for why it is read here. */
  async makeReady(device: DriverDevice): Promise<DriverDevice> {
    const data = this.#dataFor(device);
    return this.#withDeviceLock(data.avdName, async () => {
      const state = this.#stateFor(data);
      if (state.handle !== undefined) {
        await this.#waitForReadiness(data, this.#clock.now());
        // The device was already running (or booting) under this driver instance -- reclaim
        // never touched it, so its mark can't have gone stale. Re-mark anyway: this is the
        // single readiness transition that lets a caller re-lease an already-ready device
        // without ever seeing a moment where "ready" and "marked" disagree.
        await this.#writeMark(data);
        return { address: data.serial, deviceId: device.deviceId, driverData: data };
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
      // Covers all three boot paths above (wipe, snapshot restore, cold boot -- including the
      // baseline-capture restart) with a single call: whichever path ran, the device is ready
      // now and must be re-marked unconditionally.
      await this.#writeMark(data);
      return { address: data.serial, deviceId: device.deviceId, driverData: data };
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
        // No mark write here: `-wipe-data` hasn't happened yet -- it's deferred to the next
        // `makeReady` (`state.needsWipe`) -- so there is no post-erase moment on this path to
        // mark. The next `makeReady` call covers it via its unconditional tail write.
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
      // Snapshot restore reverts the erasable half of the mark to whatever it was at capture
      // time, and this path returns "ready" directly without going through `makeReady` --
      // skipping this write would leave the mark frozen at a stale generation forever.
      await this.#writeMark(data);
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

  async listManaged(): Promise<DriverReality> {
    const avdNames = await this.#listAvdNames();
    const { settledSerials, unattributableTransitionalSerial } = await this.#scanAdbSerials();
    const { processes, runningByAvdName, erasableMarkByAvdName, unreadableSerial } =
      await this.#resolveRunningAvds(settledSerials);
    const unattributable = unattributableTransitionalSerial || unreadableSerial;

    const devices: ObservedDevice[] = await Promise.all(
      avdNames.map((avdName) =>
        this.#observedDevice(avdName, runningByAvdName, unattributable, erasableMarkByAvdName),
      ),
    );

    return { devices, processes };
  }

  async #observedDevice(
    avdName: string,
    runningByAvdName: ReadonlySet<string>,
    unattributableTransitionalSerial: boolean,
    erasableMarkByAvdName: ReadonlyMap<string, string | undefined>,
  ): Promise<ObservedDevice> {
    const base = observedAndroidDevice(avdName, runningByAvdName, unattributableTransitionalSerial);
    const running = runningByAvdName.has(avdName);
    const durable = await this.#readDurableMark(avdName);
    const mark = buildObservedMark(durable, running, erasableMarkByAvdName.get(avdName));
    return mark === undefined ? base : { ...base, mark };
  }

  async #listAvdNames(): Promise<string[]> {
    const avdNames: string[] = [];
    if (await this.#filesystem.exists(this.#avdDirectory)) {
      for (const entry of await this.#filesystem.readdir(this.#avdDirectory)) {
        const match = /^(simlock_.+)\.avd$/.exec(entry);
        if (match?.[1] === undefined) continue;
        avdNames.push(match[1]);
      }
    }
    return avdNames;
  }

  /**
   * Serials attached in a settled `device` state can answer `getprop`, so they can be
   * attributed to an AVD by name. A serial in any other adb state (offline, unauthorized,
   * booting, ...) cannot answer `getprop` yet, so it cannot be attributed to an AVD name --
   * `unattributableTransitionalSerial` records that this tick saw at least one such serial.
   */
  async #scanAdbSerials(): Promise<{
    readonly settledSerials: readonly string[];
    readonly unattributableTransitionalSerial: boolean;
  }> {
    const attached = await this.#runOrThrow(this.#sdk.adb, ["devices"]);
    const settledSerials: string[] = [];
    let unattributableTransitionalSerial = false;
    for (const match of attached.stdout.matchAll(/^((?:emulator)-\d+)\s+(\S+)$/gm)) {
      const candidate = match[1];
      const state = match[2];
      if (candidate === undefined || state === undefined) continue;
      if (state === "device") {
        settledSerials.push(candidate);
      } else {
        unattributableTransitionalSerial = true;
      }
    }
    return { settledSerials, unattributableTransitionalSerial };
  }

  /**
   * Reads the running AVD's name and its erasable mark in a single `adb shell` round trip
   * per serial -- the mark read is folded into the `getprop` call that this method already
   * makes, so it costs nothing extra.
   */
  async #resolveRunningAvds(settledSerials: readonly string[]): Promise<{
    readonly erasableMarkByAvdName: ReadonlyMap<string, string | undefined>;
    readonly processes: readonly DriverDevice[];
    readonly runningByAvdName: ReadonlySet<string>;
    readonly unreadableSerial: boolean;
  }> {
    const processes: DriverDevice[] = [];
    const runningByAvdName = new Set<string>();
    const erasableMarkByAvdName = new Map<string, string | undefined>();
    let unreadableSerial = false;
    for (const candidate of settledSerials) {
      // `adb shell` reports the exit status of the last command it ran, so a missing
      // mark file would fail the whole invocation -- and a missing mark file is exactly
      // the foreign-erase case this feature exists to detect. `|| true` keeps an absent
      // mark an observation rather than a crash.
      const output = await this.#adbShellOrUndefined([
        "-s",
        candidate,
        "shell",
        `getprop ro.boot.qemu.avd_name; cat ${ERASABLE_MARK_PATH} 2>/dev/null || true`,
      ]);
      // An emulator can die between `adb devices` and this call. Losing the whole
      // reality view over one dead serial would strand every other device, so treat it
      // like a transitional serial: unattributable this tick, nothing concluded.
      if (output === undefined) {
        unreadableSerial = true;
        continue;
      }
      const [nameLine = "", ...markLines] = output.stdout.split(/\r?\n/);
      const avdName = nameLine.trim();
      if (!avdName.startsWith("simlock_")) continue;
      runningByAvdName.add(avdName);
      erasableMarkByAvdName.set(avdName, parseErasableMark(markLines.join("\n")));
      const port = Number(candidate.slice("emulator-".length));
      processes.push({
        address: candidate,
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
    return { erasableMarkByAvdName, processes, runningByAvdName, unreadableSerial };
  }

  /** Undefined when the serial could not be reached at all, as opposed to answering. */
  async #adbShellOrUndefined(args: readonly string[]): Promise<ProcessResult | undefined> {
    try {
      return await this.#runOrThrow(this.#sdk.adb, args);
    } catch {
      return undefined;
    }
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

  estimate(estimate: DriverEstimate, _spec: DeviceSpec): number {
    switch (estimate.operation) {
      case "provision":
        return PROVISION_ESTIMATE_MS;
      case "boot":
        return COLD_BOOT_ESTIMATE_MS;
      case "reclaim":
        // `standard` is priced as the snapshot restore it selects. It can still fall back to
        // the wipe branch when the baseline no longer matches the AVD config, which runs some
        // five times longer; that is the exception rather than the case to quote, and `Doctor`
        // covers it by taking the slower clean level instead of this averaging the two.
        return this.reclaimStrategy({ clean: estimate.clean }) === "wipe"
          ? WIPE_RECLAIM_ESTIMATE_MS
          : SNAPSHOT_RECLAIM_ESTIMATE_MS;
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
      const contents = await this.#filesystem.readFile(this.#configIniPath(avdName));
      return contents
        .split(/\r?\n/)
        .filter((line) => /^(image\.sysdir\.1|hw\.|disk\.dataPartition\.)/.test(line))
        .sort()
        .join("\n");
    } catch {
      return "";
    }
  }

  #configIniPath(avdName: string): string {
    return `${this.#avdDirectory}/${avdName}.avd/config.ini`;
  }

  /**
   * Writes the same provenance token into both regions of the mark: the durable
   * `simlock.mark` key in `config.ini` (host-side, survives an erase) and the erasable
   * `/data/local/tmp/simlock-mark.json` file on the device (destroyed by an erase). Must be
   * called after every readiness transition -- see the call sites in `makeReady` and
   * `reclaim` for why "the tail of `makeReady`" alone is not sufficient.
   */
  async #writeMark(data: AndroidDriverData): Promise<void> {
    const token = this.#idGenerator.generate();
    await Promise.all([
      this.#writeDurableMark(data.avdName, token),
      this.#writeErasableMark(data.serial, token),
    ]);
  }

  async #writeDurableMark(avdName: string, token: string): Promise<void> {
    const path = this.#configIniPath(avdName);
    let contents: string;
    try {
      contents = await this.#filesystem.readFile(path);
    } catch {
      contents = "";
    }
    const lines = contents === "" ? [] : contents.replace(/\r?\n$/, "").split(/\r?\n/);
    const markLine = `${DURABLE_MARK_KEY}=${token}`;
    const existingIndex = lines.findIndex((line) => line.startsWith(`${DURABLE_MARK_KEY}=`));
    if (existingIndex >= 0) {
      lines[existingIndex] = markLine;
    } else {
      lines.push(markLine);
    }
    await this.#filesystem.writeFileAtomic(path, `${lines.join("\n")}\n`);
  }

  async #writeErasableMark(serial: string, token: string): Promise<void> {
    const payload = JSON.stringify({ token });
    await this.#runOrThrow(this.#sdk.adb, [
      "-s",
      serial,
      "shell",
      `echo '${payload}' > ${ERASABLE_MARK_PATH}`,
    ]);
  }

  async #readDurableMark(avdName: string): Promise<string | undefined> {
    try {
      const contents = await this.#filesystem.readFile(this.#configIniPath(avdName));
      const line = contents
        .split(/\r?\n/)
        .find((entry) => entry.startsWith(`${DURABLE_MARK_KEY}=`));
      const value = line?.slice(`${DURABLE_MARK_KEY}=`.length).trim();
      return value === undefined || value === "" ? undefined : value;
    } catch {
      return undefined;
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
      await this.#waitForExit(handle, SIGKILL_REAP_TIMEOUT_MS);
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
    return `${this.#avdDirectory}/${avdName}.avd/simlock-clean-baseline.json`;
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
      await this.#waitForExit(handle, SIGKILL_REAP_TIMEOUT_MS);
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

function observedAndroidDevice(
  avdName: string,
  runningByAvdName: ReadonlySet<string>,
  unattributableTransitionalSerial: boolean,
): ObservedDevice {
  return {
    // Reconnaissance only: an observed device is never granted, so it carries no usable address.
    address: "",
    deviceId: avdName,
    driverData: {
      avdName,
      configHash: "recovered",
      imageIdentity: "",
      port: 0,
      serial: "",
    } satisfies AndroidDriverData,
    // Conservative: an emulator serial we can't attribute (transitional adb state) might
    // belong to any AVD that otherwise looks stopped, so treat all of them as transitioning
    // for this tick rather than risk a false-positive foreign-state-change finding.
    runState: runningByAvdName.has(avdName)
      ? "running"
      : unattributableTransitionalSerial
        ? "transitioning"
        : "stopped",
  };
}

/**
 * `undefined` (no `mark` at all) only when the durable key is absent *and* the device isn't
 * running: that is the upgrade path for an AVD provisioned before marks existed, where the
 * erasable half is also unreadable and can't corroborate either way. Reporting a half-empty
 * mark there would read as tampering (`durable-mark-missing`) on every tick forever. Once the
 * device is running with neither half present, a mark object is the correct, honest reading.
 */
function buildObservedMark(
  durable: string | undefined,
  running: boolean,
  erasable: string | undefined,
): ObservedMark | undefined {
  if (durable === undefined && !running) {
    return undefined;
  }
  return { durable, erasable: running ? erasable : undefined, erasableReadable: running };
}

function parseErasableMark(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as { readonly token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
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
