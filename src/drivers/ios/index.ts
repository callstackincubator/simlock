import { dirname, join } from "node:path";

import {
  BootTimeoutError,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type ComponentRemoval,
  type DeviceInputFactory,
  COMPONENT_REMOVAL_TIMEOUT_MS,
  type ExactDeviceRequest,
  type Driver,
  type DriverAdvisory,
  type DriverToolVersion,
  type DriverCatalogEntry,
  type DriverComponent,
  type DriverDevice,
  type DriverSource,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  type PhysicalDriverDevice,
  type PhysicalInspection,
  type ReclaimResult,
  type VirtualDriverDevice,
  isPhysicalDriverDevice,
  type PresentPhysical,
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  type InstalledComponent,
  type LegacyDevice,
  type ObservedDevice,
  OwnedRootError,
  type PassthroughCommand,
  type PassthroughContext,
  PassthroughRefusedError,
  type ObservedRunState,
  removeListedComponent,
  RuntimeMissingError,
  sameReceipt,
  UnknownModelError,
  UnsupportedRequestOptionError,
  type ObservedMark,
  type DeviceClass,
  type DeviceMode,
  type DeviceSpec,
  type VirtualSpec,
  type ScreenCapture,
} from "../../core/index.js";
import type {
  BytePipeLauncher,
  Clock,
  Filesystem,
  IdGenerator,
  Logger,
  ProcessResult,
  ProcessRunner,
  SqliteDatabase,
} from "../../ports/index.js";
import { runBoundedProcess, runInstallerProcess } from "../installer-process.js";
import { refuseOwnSetLeftovers, refuseXcodeSetLeftovers } from "./device-set-leftovers.js";
import { devicectlExecCommand } from "./devicectl-exec.js";
import { fillSimctlDevice } from "./simctl-device.js";
import { IosPhysicalHandler } from "./physical.js";
import { createIosDeviceInput } from "./input/index.js";
import { iosRuntimeVersionFromId } from "./runtime-version.js";
import { IosSourceTable, type ReadySeed, type SourceRow } from "./source-data.js";
import { createIosScreenCapture } from "./screen-capture.js";
import { overridesFor, resolveSlimCategories, slimSignature } from "./slim-labels.js";
import { parseOverridesPlist, parsePrintDisabled, renderOverridesPlist } from "./slim-overrides.js";

const COMMAND_TIMEOUT_MS = 30_000;
// why: `xcodebuild -version` answers in about a second; a first run after an Xcode update can take
// longer while it checks its components, and a hang must not hold host facts forever.
const XCODE_VERSION_TIMEOUT_MS = 15_000;
const BOOTSTATUS_TIMEOUT_MS = 120_000;
const INSTALLER_POLL_MS = 1_000;
const PROVISION_ESTIMATE_MS = 500;
// why: How often a removal lists again while `simctl runtime list` shows the deleted image as still
// being deleted, which it does for a few seconds after `simctl runtime delete` answers (#259).
const DELETING_POLL_MS = 1_000;
const LATEST_COMPONENT = "latest";
// why: `simctl`'s `minRuntimeVersion` / `maxRuntimeVersion` encode "no bound" as 0xFFFFFF
// (255.255.255) rather than omitting the field.
const UNBOUNDED_VERSION = 0xff_ff_ff;
// why: `xcodebuild -downloadPlatform iOS -buildVersion` only reaches back to iOS 16.0 (Xcode
// 16.1+); older runtimes must be installed through Xcode itself.
const IOS_DOWNLOAD_FLOOR: readonly [number, number, number] = [16, 0, 0];
// why: Conservative estimate for a simulator runtime download+install (~7 GB observed, rounded up
// with headroom) -- reserved by `ComponentInstaller` before `xcodebuild -downloadPlatform` ever
// starts, so a full disk fails fast instead of filling up mid-download.
const IOS_RUNTIME_MIN_FREE_BYTES = 8 * 1024 ** 3;
// why: Where macOS's own asset daemon keeps every simulator runtime it has ever downloaded, one
// `<uuid>.asset` bundle per build. `simctl runtime delete` only unregisters a runtime from
// CoreSimulator; the bundle it was mounted from stays here, marked never-collected, spending
// the same free space `IOS_RUNTIME_MIN_FREE_BYTES` measures. Nothing Simlock may do can
// reclaim it (issue #79), so the driver only ever reads this path.
const IOS_RUNTIME_ASSET_ROOT = "/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime";
// why: A cold `simctl boot` to `bootstatus` measures roughly 30s on a fast, idle machine and up to
// a minute on a loaded or slower one. The upper end is the estimate, deliberately: this number
// is what a waiting requester is quoted, and quoting 30s to someone who then waits 60s is the
// failure mode #56 is about. The cost is that `Doctor`'s `provisioning` stall threshold widens
// with it -- see the note there on why that is the cheaper of the two errors.
const COLD_BOOT_ESTIMATE_MS = 60_000;
// why: measured, not guessed: a single `simctl erase` took ~34s in #43's investigation. Unlike
// Android, iOS has no deferred-wipe path -- `erase` is synchronous and every simulator reclaim
// pays it, at either clean level, so this is the only simulator reclaim number the driver has.
// A physical device reclaim uninstalls apps instead and has its own estimate below.
const ERASE_ESTIMATE_MS = 34_000;
const PHYSICAL_RECLAIM_ESTIMATE_MS = 90_000;
const MARK_FILE_NAME = "simlock-mark.json";
/**
 * why: a driver that refused to start has no instance to ask, so the `simlock <tool>` names
 * it answers to are a constant, and `DriverRejection` carries them so `simlock simctl` can
 * say why it is unavailable rather than reading as a missing SDK.
 */
export const IOS_PASSTHROUGH_TOOLS: readonly string[] = ["simctl", "devicectl"];

const IOS_DEFAULT_MODELS: Readonly<Partial<Record<DeviceClass, readonly string[]>>> = {
  phone: ["iPhone 17", "iPhone 16", "iPhone 15", "iPhone 14", "iPhone 13"],
  tablet: [
    "iPad Pro 11-inch (M5)",
    "iPad Pro 11-inch (M4)",
    "iPad Air 11-inch (M3)",
    "iPad (A16)",
    "iPad (10th generation)",
  ],
  tv: ["Apple TV 4K (3rd generation)", "Apple TV"],
  vision: ["Apple Vision Pro"],
  watch: [
    "Apple Watch Series 11 (46mm)",
    "Apple Watch Series 10 (46mm)",
    "Apple Watch Series 9 (45mm)",
  ],
};

/**
 * why: Verbs `simlock simctl` will not proxy. Every one of them changes a device's lifecycle,
 * which the registry -- not `simctl` -- is the record of: a device created here has no
 * registry entry and reads as an orphan, and one erased or deleted under a live lease
 * reads as tampering on the next reconcile. Injecting `--set` for them would hand back
 * exactly the capability the device set exists to take away (ADR 0001, decision 7).
 */
export const REFUSED_SIMCTL_VERBS = new Set(["create", "erase", "delete"]);

export const CALLER_SUPPLIED_SCOPE_FLAGS = new Set(["set", "profiles"]);

export const SHUTDOWN_ALL_TARGET = "all";

export const REFUSED_RUNTIME_OPERATION = "delete";

const RECLAIM_INSTEAD =
  "Use `simlock release` (which reclaims the device for you) or `simlock cleanup` instead.";

// why: ADR 0060 §2: simslim's limit for a simulator just after its first boot.
const READBACK_TIMEOUT_MS = 120_000;
const OVERRIDES_FILE_NAME = "disabled.plist";
const DEFAULT_OVERRIDES_ROOT = "/private/var/tmp";
const OVERRIDES_FOLDER_PREFIX = "com.apple.CoreSimulator.SimDevice.";

interface IosDriverData {
  readonly deviceTypeId: string;
  readonly name: string;
  readonly runtimeId: string;
  readonly udid: string;
}

export interface SlimmedFact {
  readonly deviceId: string;
  readonly address: string;
  readonly categories: readonly string[];
  readonly labelCount: number;
  readonly durationMs: number;
  readonly signature: string;
  readonly unknownLabels: readonly string[];
}

export interface SlimSkippedFact {
  readonly deviceId: string;
  readonly reason: "runtime-too-old" | "unknown-runtime" | "apply-failed";
  readonly detail: string;
}

export interface IosSimctlDriverOptions {
  readonly clock: Clock;
  readonly database: SqliteDatabase;
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly processRunner: ProcessRunner;
  readonly simlockHome: string;
  readonly uid?: number;
  /** why: the daemon's pid is named in the staging directory of a new root. */
  readonly pid?: number;
  readonly coreSimulatorRoot?: string;
  // why: where launchd_sim keeps each simulator's overrides folder; a test points it elsewhere.
  readonly launchdOverridesRoot?: string;
  readonly onSlimmed?: (fact: SlimmedFact) => void;
  readonly onSlimSkipped?: (fact: SlimSkippedFact) => void;
  readonly slim?: {
    readonly categories?: readonly string[];
    readonly bootTimeoutMs: number;
  };
  readonly slimByDefault?: boolean;
  // why: the device input logs a Home press that did nothing; nothing else in the driver logs through it.
  readonly logger?: Logger;
  // why: absent when this host has no way to run the capture program; the driver then offers no
  // screen at all rather than one that fails on every open.
  readonly screenCapture?: {
    readonly command: string;
    readonly deviceCommand?: string;
    readonly launcher: BytePipeLauncher;
    readonly baseEnvironment: NodeJS.ProcessEnv;
    readonly onLog?: (line: string) => void;
  };
}

type SlimOptions = NonNullable<IosSimctlDriverOptions["slim"]>;

type SlimWrite =
  | { readonly kind: "no-categories"; readonly detail: string }
  | {
      readonly kind: "written";
      readonly resolved: ReturnType<typeof resolveSlimCategories>;
      readonly wanted: ReadonlyMap<string, boolean>;
      readonly startedAt: number;
      readonly writeError: string | undefined;
    };

const PRODUCT_FAMILY_CLASSES: ReadonlyMap<string | undefined, DeviceClass> = new Map([
  ["iPhone", "phone"],
  ["iPad", "tablet"],
  ["Apple Watch", "watch"],
  ["Apple TV", "tv"],
  ["Apple Vision", "vision"],
]);

interface DeviceType {
  readonly identifier: string;
  readonly name: string;
  readonly minRuntimeVersion: number;
  readonly maxRuntimeVersion: number;
  readonly productFamily: string | undefined;
}

interface Runtime {
  readonly identifier: string;
  readonly name: string;
  readonly version: string;
  readonly build?: string;
  readonly isAvailable: boolean;
  readonly supportedDeviceTypeIds: ReadonlySet<string>;
}

interface RuntimeAsset {
  readonly path: string;
  readonly version: string;
  readonly build: string;
}

interface SimctlCatalog {
  readonly deviceTypes: readonly DeviceType[];
  readonly runtimes: readonly Runtime[];
}

interface ResolvedIosSpec {
  readonly deviceType: DeviceType;
  readonly runtime: Runtime;
  readonly spec: VirtualSpec;
}

type ProcessOutcome =
  | { readonly kind: "finished"; readonly result: ProcessResult }
  | { readonly kind: "timed-out" };

export class IosSimctlDriver implements Driver {
  readonly platform = "ios" as const;
  readonly defaultModels = IOS_DEFAULT_MODELS;
  readonly #clock: Clock;
  readonly componentFootprint: { readonly path: string; readonly bytes: number };
  readonly #filesystem: Filesystem;
  readonly #idGenerator: IdGenerator;
  readonly #onSlimmed: ((fact: SlimmedFact) => void) | undefined;
  readonly #onSlimSkipped: ((fact: SlimSkippedFact) => void) | undefined;
  readonly #processRunner: ProcessRunner;
  readonly #physical: IosPhysicalHandler;
  readonly #resolvedSpecs = new Map<string, ResolvedIosSpec>();
  readonly #deviceRoot: string;
  readonly #instanceId: string;
  readonly #rootOptions: EnsureOwnedRootOptions | undefined;
  readonly #logger: Logger | undefined;
  readonly #overridesRoot: string;
  readonly #slim: SlimOptions | undefined;
  readonly #slimByDefault: boolean;
  readonly #sources: IosSourceTable;
  readonly #sourcesSet: string;
  #sourceMaker: string | undefined;
  #swept = false;

  private constructor(
    options: IosSimctlDriverOptions,
    deviceRoot: string,
    rootOptions: EnsureOwnedRootOptions | undefined,
  ) {
    this.#clock = options.clock;
    this.componentFootprint = {
      bytes: IOS_RUNTIME_MIN_FREE_BYTES,
      path: options.coreSimulatorRoot ?? ".",
    };
    this.#filesystem = options.filesystem;
    this.#idGenerator = options.idGenerator;
    this.#onSlimmed = options.onSlimmed;
    this.#onSlimSkipped = options.onSlimSkipped;
    this.#processRunner = options.processRunner;
    this.#physical = new IosPhysicalHandler({
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      invoke: (argv, timeoutMs) => this.#invokeXcrun(argv, timeoutMs),
      simlockHome: options.simlockHome,
    });
    this.#deviceRoot = deviceRoot;
    this.#instanceId = options.instanceId;
    this.#rootOptions = rootOptions;
    this.#logger = options.logger;
    this.#overridesRoot = options.launchdOverridesRoot ?? DEFAULT_OVERRIDES_ROOT;
    this.#slim = options.slim;
    this.#slimByDefault = options.slimByDefault === true;
    this.#sources = new IosSourceTable(options.database);
    this.#sourcesSet =
      rootOptions === undefined
        ? join(options.simlockHome, "devices", "ios-sources")
        : join(deviceRoot, "sources");
    this.screenCapture = createScreenCaptureFor(
      options,
      deviceRoot,
      rootOptions !== undefined,
      (udid) => this.#physical.osVersion(udid),
    );
    this.input = createInputFor(options, deviceRoot, rootOptions !== undefined);
  }

  readonly screenCapture: ScreenCapture | undefined;
  readonly input: DeviceInputFactory | undefined;

  /**
   * why: Establishes the device set this driver owns before it can be asked to do anything,
   * which is why construction is asynchronous: a driver that had not yet proven its root
   * would be a driver that can address devices it cannot prove are Simlock's, and every
   * later `--set` would be pointing at an unvalidated path. An `OwnedRootError` here is
   * the fail-closed path -- the caller skips iOS entirely rather than falling back to the
   * machine's default device set (safety rule 9).
   */
  static async create(options: IosSimctlDriverOptions): Promise<IosSimctlDriver> {
    const deviceSet = configuredDeviceSet(options);
    if (deviceSet === "default") {
      await refuseOwnSetLeftovers(options.filesystem, join(options.simlockHome, "devices", "ios"));
      return new IosSimctlDriver(options, xcodeDeviceSetPath(options), undefined);
    }
    if (options.coreSimulatorRoot !== undefined) {
      await refuseXcodeSetLeftovers(
        options.filesystem,
        xcodeDeviceSetPath(options),
        options.instanceId,
      );
    }
    const rootOptions: EnsureOwnedRootOptions = {
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      path: configuredDeviceRoot(options),
      platform: "ios",
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.pid === undefined ? {} : { pid: options.pid }),
    };
    const deviceRoot = await ensureOwnedRoot(rootOptions);

    return new IosSimctlDriver(options, deviceRoot, rootOptions);
  }

  get deviceRoot(): string {
    return this.#deviceRoot;
  }

  /**
   * why: The same call `create` made, with the same arguments, because the proof *is* that call:
   * a cheaper second check here would be a second validator, free to drift from the one
   * every start is judged by. It is asked for immediately before Simlock destroys anything
   * inside this set, since between then and startup the path can have become a symlink, or
   * a `mv` can have left the user's own device set standing where this one was.
   */
  async revalidateRoot(): Promise<void> {
    if (this.#rootOptions === undefined) return;
    await ensureOwnedRoot(this.#rootOptions);
  }

  async resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    this.#requireIosPlatform(request.platform);
    if (request.imageTag !== undefined) {
      throw new UnsupportedRequestOptionError("ios", "imageTag");
    }
    const catalog = await this.#loadCatalog();
    const deviceType = findDeviceType(catalog, request.model);

    if (deviceType === undefined) {
      throw new IosUnknownModelError(request.model);
    }

    const spec =
      request.osVersion === undefined
        ? this.#resolveDefaultRuntime(deviceType, catalog)
        : this.#resolveExactRuntime(deviceType, request.osVersion, catalog);
    // why: The resolution cache (`specKey`) ignores the mode, so the mode is applied here, outside it.
    return request.mode === "slim" && this.#canSlim(spec) ? { ...spec, mode: "slim" } : spec;
  }

  #canSlim(spec: VirtualSpec): boolean {
    const runtime = this.#resolvedSpecs.get(specKey(spec))?.runtime;
    return (
      this.#slim !== undefined &&
      runtime !== undefined &&
      supportsPersistentSlim(iosRuntimeVersionFromId(runtime.identifier))
    );
  }

  /**
   * why: Version requested explicitly: validated against the model's `[min, max]` pairing range
   * *before* anything else -- an out-of-range request can never be fixed by downloading, so it
   * is never reported as downloadable.
   */
  #resolveExactRuntime(
    deviceType: DeviceType,
    osVersion: string,
    catalog: SimctlCatalog,
  ): VirtualSpec {
    if (!isVersionInRange(osVersion, deviceType)) {
      throw new IosVersionOutOfRangeError(deviceType.name, osVersion, deviceType);
    }

    // why: Looked up among the runtimes the catalog lists for this model, so a listed pair always
    // resolves and an unlisted one never does (ADR 0008 §3). Any installed build of the version
    // that pairs will do: two builds can share a marketing version and pair differently.
    const paired = findPairedRuntime(catalog, deviceType, osVersion);
    if (paired !== undefined) {
      return this.#commitResolution(deviceType, paired);
    }
    // why: Installed but not paired: in the model's declared `[min, max]` range is necessary but not
    // sufficient, since `supportedDeviceTypeIds` is the authoritative source once a runtime is
    // on disk. Refused before committing, so a mismatch never reaches `simctl create`.
    if (findInstalledRuntime(catalog, osVersion) !== undefined) {
      throw new IosRuntimeUnpairedError(deviceType.name, osVersion);
    }

    throw missingRuntime(
      osVersion,
      `iOS ${osVersion} is not installed; pass --allow-download (or set downloads.policy) ` +
        `to download it`,
      osVersion,
    );
  }

  #resolveDefaultRuntime(deviceType: DeviceType, catalog: SimctlCatalog): VirtualSpec {
    const paired = newestRuntime(pairedInstalledRuntimes(catalog, deviceType));
    if (paired !== undefined) {
      return this.#commitResolution(deviceType, paired);
    }

    throw missingRuntime(
      "default",
      `No installed iOS runtime pairs with ${deviceType.name}; pass --allow-download (or ` +
        `set downloads.policy) to download a compatible runtime`,
      isUnboundedMax(deviceType.maxRuntimeVersion)
        ? LATEST_COMPONENT
        : majorVersionString(deviceType.maxRuntimeVersion),
    );
  }

  #commitResolution(deviceType: DeviceType, runtime: Runtime): VirtualSpec {
    const spec: VirtualSpec = {
      model: deviceType.name,
      osVersion: runtime.version,
      physical: false,
      platform: this.platform,
    };
    this.#resolvedSpecs.set(specKey(spec), { deviceType, runtime, spec });
    return spec;
  }

  async findComponent(component: string): Promise<InstalledComponent | undefined> {
    const [catalog, images] = await Promise.all([this.#loadCatalog(), this.#loadRuntimeImages()]);
    const runtime = findInstalledRuntime(catalog, component);
    return runtime === undefined ? undefined : installedComponent(runtime, images);
  }

  async installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult> {
    if (belowDownloadFloor(component)) {
      throw new IosDownloadFloorError(component);
    }
    const before = await this.#installedReceipts();
    const args =
      component === LATEST_COMPONENT
        ? ["-downloadPlatform", "iOS"]
        : ["-downloadPlatform", "iOS", "-buildVersion", component];
    try {
      await this.#xcodebuildOrThrow(args, options);
    } catch (error: unknown) {
      throw withBareMajorHint(component, error);
    }

    const [catalog, images] = await Promise.all([this.#loadCatalog(), this.#loadRuntimeImages()]);
    const runtime = runtimeForComponent(catalog, component);
    if (runtime === undefined) {
      throw new DriverCrashError(
        `xcodebuild reported success but iOS ${component} is still not installed`,
      );
    }
    const installed = installedComponent(runtime, images);
    const wasThere = before.some((receipt) => sameReceipt(receipt, installed.receipt));
    return { ...installed, outcome: wasThere ? "already-installed" : "installed" };
  }

  async listComponents(): Promise<readonly DriverComponent[]> {
    return (await this.#listedImages()).map(
      ({ image: _image, unusedDevices: _unused, ...component }) => component,
    );
  }

  async removeComponent(
    receipt: ComponentReceipt,
    options: { readonly signal: AbortSignal },
  ): Promise<ComponentRemoval> {
    return removeListedComponent({
      list: () => this.#listedImages(),
      platform: this.platform,
      receipt,
      remove: async ({ image, unusedDevices, version }) => {
        const deadline = this.#clock.now() + COMPONENT_REMOVAL_TIMEOUT_MS;
        await this.#deleteRuntimeImage(image.identifier, options.signal);
        await this.#waitWhileDeleting(image.identifier, version, deadline, options.signal);
        const sentences = [
          unavailableDevicesResidue(unusedDevices),
          (await this.#downloadResidue(image, version)).residue,
        ].filter((sentence) => sentence !== undefined);
        return sentences.length === 0 ? {} : { residue: sentences.join(". ") };
      },
    });
  }

  async #deleteRuntimeImage(identifier: string, signal: AbortSignal): Promise<void> {
    const args = ["runtime", "delete", identifier];
    const command = `simctl ${args.join(" ")}`;
    let outcome;
    try {
      outcome = await runBoundedProcess(
        this.#processRunner,
        this.#clock,
        "xcrun",
        this.#scopedSimctlArgv(args),
        { signal, timeoutMs: COMPONENT_REMOVAL_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      throw new DriverCrashError(`${command} failed: ${errorMessage(error)}`);
    }
    if (outcome.timedOut) {
      throw new DriverCrashError(
        `${command} timed out after ${String(COMPONENT_REMOVAL_TIMEOUT_MS)}ms`,
      );
    }
    if (outcome.stopped) throw new DriverCrashError(`${command} was ended before it finished`);
    this.#assertSuccessful(args, outcome.result);
  }

  async #waitWhileDeleting(
    identifier: string,
    version: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      const listed = (await this.#loadRuntimeImages()).find(
        (image) => image.identifier === identifier,
      );
      if (listed === undefined || !isBeingDeleted(listed)) return;
      const remainingMs = deadline - this.#clock.now();
      if (remainingMs <= 0) {
        throw new DriverCrashError(
          `${this.platform} ${version} was still being deleted ` +
            `${String(COMPONENT_REMOVAL_TIMEOUT_MS)}ms after its removal started`,
        );
      }
      if (!(await this.#pause(Math.min(DELETING_POLL_MS, remainingMs), signal))) {
        throw new DriverCrashError(
          `The removal of ${this.platform} ${version} was ended while it was still being deleted`,
        );
      }
    }
  }

  #pause(delayMs: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.#clock.cancel(timer);
        resolve(false);
      };
      const timer = this.#clock.setTimer(delayMs, () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #downloadResidue(image: RuntimeImage, version: string): Promise<{ residue?: string }> {
    const left = (await this.#downloadedRuntimeAssets()).filter((asset) =>
      image.build === undefined ? asset.version === version : asset.build === image.build,
    );
    if (left.length === 0) return {};
    const label = image.build === undefined ? version : `${version} (${image.build})`;
    return {
      residue: leftoverDownloadsSentence([label], left.length, await this.#assetsSize(left)),
    };
  }

  async #assetsSize(assets: readonly RuntimeAsset[]): Promise<number | undefined> {
    let total = 0;
    for (const asset of assets) {
      try {
        total += await this.#filesystem.directorySize(asset.path);
      } catch {
        return undefined;
      }
    }
    return total;
  }

  async #listedImages(): Promise<ListedImage[]> {
    const [images, defaultSet] = await Promise.all([
      this.#loadRuntimeImages(),
      this.#legacySimctl(["list", "-j", "devices"], COMMAND_TIMEOUT_MS),
    ]);
    let foreign: ReadonlyMap<string, DefaultSetDevices>;
    try {
      const parsed = JSON.parse(defaultSet.stdout) as unknown;
      foreign = devicesPerRuntime(parsed, await this.#ownedUdids(parsed));
    } catch (error: unknown) {
      if (error instanceof DriverCrashError) throw error;
      throw new DriverCrashError(`Could not parse simctl device list: ${errorMessage(error)}`);
    }
    return images.filter(isIosImage).flatMap((image): ListedImage[] =>
      image.version === undefined
        ? []
        : [
            {
              foreignDevices: foreign.get(image.runtimeIdentifier)?.used ?? 0,
              image,
              unusedDevices: images.some(
                (other) =>
                  other !== image &&
                  isIosImage(other) &&
                  other.runtimeIdentifier === image.runtimeIdentifier,
              )
                ? 0
                : (foreign.get(image.runtimeIdentifier)?.unused ?? 0),
              receipt: imageReceipt(image),
              version: image.version,
              ...(image.build === undefined ? {} : { variant: image.build }),
              ...(image.sizeBytes === undefined ? {} : { sizeBytes: image.sizeBytes }),
            },
          ],
    );
  }

  async #installedReceipts(): Promise<readonly ComponentReceipt[]> {
    const [catalog, images] = await Promise.all([this.#loadCatalog(), this.#loadRuntimeImages()]);
    return catalog.runtimes
      .filter((runtime) => runtime.isAvailable)
      .map((runtime) => runtimeReceipt(runtime, images));
  }

  async #xcodebuildOrThrow(
    args: readonly string[],
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<void> {
    let outcome;
    try {
      outcome = await runInstallerProcess(
        this.#processRunner,
        this.#clock,
        "xcodebuild",
        args,
        options,
      );
    } catch (error: unknown) {
      throw new DriverCrashError(`xcodebuild ${args.join(" ")} failed: ${errorMessage(error)}`);
    }
    if (outcome.stopped) {
      throw new DriverCrashError(`xcodebuild ${args.join(" ")} was ended before it finished`);
    }
    const { result } = outcome;
    if (result.code === 0) {
      return;
    }
    const message = result.stderr || result.stdout;
    // why: Apple's downloader accepts `-buildVersion <marketing version>` only for whatever it
    // currently offers -- a pin naming a release Apple has since retired from its live catalog
    // (superseded by a newer point release), or one still ambiguous across several concurrent
    // beta/seed builds sharing the same marketing version, is rejected outright with "is not
    // available for download", distinct from every other `xcodebuild` failure this method
    // otherwise reports as a `DriverCrashError`. Falling back to an unpinned `-downloadPlatform
    // iOS` here would silently substitute whatever Apple currently offers instead -- a different,
    // unrequested, and possibly multi-gigabyte runtime -- for a request that named an exact
    // version, so this fails the request instead of guessing; see
    // `IosRuntimeUnavailableForDownloadError`.
    const buildVersionIndex = args.indexOf("-buildVersion");
    if (buildVersionIndex !== -1 && /is not available for download/.test(message)) {
      throw new IosRuntimeUnavailableForDownloadError(
        args[buildVersionIndex + 1] ?? "requested version",
      );
    }
    throw new DriverCrashError(`xcodebuild ${args.join(" ")} failed: ${message}`);
  }

  async listSources(): Promise<readonly DriverSource[]> {
    await this.#sweepLeftovers();
    const rows = this.#sources.readyRows();
    if (rows.length === 0) return [];
    const catalog = await this.#loadCatalog();
    return rows.map((row) => {
      const staleReason = sourceStaleReason(row, catalog);
      return {
        id: row.sourceId,
        kind: row.kind,
        model: row.model,
        osVersion: row.osVersion,
        ...(row.sizeBytes === undefined ? {} : { sizeBytes: row.sizeBytes }),
        ...(staleReason === undefined ? {} : { staleReason }),
      };
    });
  }

  async destroySource(sourceId: string): Promise<void> {
    const row = this.#sources.findRow(sourceId);
    if (row === undefined) throw new DriverCrashError(`iOS keeps no source ${sourceId}`);
    if (row.udid !== undefined) await this.#deleteSeedSimulator(row.udid);
    this.#sources.deleteRow(sourceId);
  }

  async provision(spec: VirtualSpec): Promise<DriverDevice> {
    this.#requireIosPlatform(spec.platform);
    const resolved = await this.#resolvedSpec(spec);
    const seed = await this.#seedFor(resolved);
    // why: Cosmetic, and deliberately so: what proves this device is Simlock's is that it
    // lives in the device set every call below is scoped to, never what it is called
    // (safety rule 8). The name exists because it is what a human reads in `simctl list`
    // and in the simulator's window title.
    const name = `simlock-${this.#idGenerator.generate()}`;
    const result = await this.#simctl(
      ["clone", seed.udid, name, this.#deviceRoot],
      COMMAND_TIMEOUT_MS,
      this.#sourcesSet,
    );
    const udid = result.stdout.trim();

    if (udid === "") {
      throw new DriverCrashError("simctl clone returned no device UDID");
    }

    try {
      await this.#writeMark(udid);
    } catch (error: unknown) {
      // why: In Xcode's set an unmarked simulator is nobody's, so one left here would never
      // be listed, reclaimed or deleted by Simlock again.
      if (this.#rootOptions === undefined) {
        await this.#invokeSimctl(["delete", udid], COMMAND_TIMEOUT_MS).catch(() => undefined);
      }
      throw error;
    }

    return {
      address: udid,
      deviceId: udid,
      driverData: {
        deviceTypeId: resolved.deviceType.identifier,
        name,
        runtimeId: resolved.runtime.identifier,
        udid,
      } satisfies IosDriverData,
    };
  }

  async #seedFor(resolved: ResolvedIosSpec): Promise<ReadySeed> {
    const specKey = seedSpecKey(resolved);
    const seed = this.#sources.findReadySeed(specKey);
    if (seed !== undefined && !seedIsStale(seed, resolved)) return seed;
    if (seed !== undefined) await this.#destroySeed(seed);
    return this.#makeSeed(resolved, specKey);
  }

  async #makeSeed(resolved: ResolvedIosSpec, specKey: string): Promise<ReadySeed> {
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
    try {
      await this.#ensureSourcesSet();
      const created = await this.#simctl(
        [
          "create",
          `simlock-seed-${sourceId}`,
          resolved.deviceType.identifier,
          resolved.runtime.identifier,
        ],
        COMMAND_TIMEOUT_MS,
        this.#sourcesSet,
      );
      const udid = created.stdout.trim();
      this.#sources.setUdid(sourceId, udid);
      try {
        await this.#bootAndWait(udid, sourceId, BOOTSTATUS_TIMEOUT_MS, this.#sourcesSet);
      } catch (error: unknown) {
        await this.#deleteSeedSimulator(udid);
        throw new DriverCrashError(`seed ${udid} did not boot: ${errorMessage(error)}`);
      }
      try {
        await this.#shutdown(udid, this.#sourcesSet);
      } catch (error: unknown) {
        await this.#deleteSeedSimulator(udid);
        throw error;
      }
      this.#sources.markReady(sourceId, await this.#sizeOf(udid));
      return { sourceId, udid, runtimeBuild: resolved.runtime.build };
    } catch (error: unknown) {
      this.#sources.deleteRow(sourceId);
      throw error;
    }
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
      try {
        if (row.udid !== undefined) await this.#deleteSeedSimulator(row.udid);
        this.#sources.deleteRow(row.sourceId);
      } catch (error: unknown) {
        this.#logger?.warn(
          `could not remove leftover source ${row.udid ?? row.sourceId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  #maker(): string {
    this.#sourceMaker ??= this.#idGenerator.generate();
    return this.#sourceMaker;
  }

  async #destroySeed(seed: ReadySeed): Promise<void> {
    await this.#deleteSeedSimulator(seed.udid);
    this.#sources.deleteRow(seed.sourceId);
  }

  async #deleteSeedSimulator(udid: string): Promise<void> {
    await this.#bestEffortShutdown(udid, this.#sourcesSet);
    await this.#simctl(["delete", udid], COMMAND_TIMEOUT_MS, this.#sourcesSet);
  }

  async #ensureSourcesSet(): Promise<void> {
    if (this.#rootOptions !== undefined) {
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

  async #sizeOf(udid: string): Promise<number | undefined> {
    try {
      return await this.#filesystem.directorySize(join(this.#sourcesSet, udid));
    } catch {
      // why: a size that cannot be counted leaves the seed `ready` with no size; `doctor` then leaves it out.
      return undefined;
    }
  }

  async makeReady(
    device: DriverDevice,
    options: { readonly purpose: "prepare" | "recover"; readonly mode: DeviceMode },
  ): Promise<DriverDevice> {
    const data = iosDriverData(device);
    const { plan, bootstatusTimeoutMs } = planSlimBoot(data, this.#slim, options);
    const write =
      plan.kind === "apply" ? await this.#writeOverrides(data.udid, plan.slim) : undefined;

    await this.#bootAndWait(data.udid, device.deviceId, bootstatusTimeoutMs);

    if (plan.kind === "skip") {
      this.#onSlimSkipped?.({
        deviceId: device.deviceId,
        detail: plan.detail,
        reason: plan.reason,
      });
    }

    if (write === undefined) {
      return this.#asIs(device, data, "full");
    }
    if (write.kind === "no-categories") {
      return this.#skipApply(device, data, write.detail, "full");
    }

    return this.#readBack(device, data, write);
  }

  #asIs(device: DriverDevice, data: IosDriverData, mode: DeviceMode): DriverDevice {
    return {
      address: data.udid,
      deviceId: device.deviceId,
      driverData: device.driverData,
      mode,
    };
  }

  async #bootAndWait(
    udid: string,
    deviceId: string,
    bootstatusTimeoutMs: number,
    set?: string,
  ): Promise<void> {
    const boot = await this.#invokeSimctl(["boot", udid], COMMAND_TIMEOUT_MS, set);
    if (boot.kind === "timed-out") {
      throw new BootTimeoutError(deviceId);
    }
    if (boot.result.code !== 0 && !alreadyBooted(boot.result.stderr)) {
      this.#assertSuccessful(["boot", udid], boot.result);
    }
    const deadline = this.#clock.now() + bootstatusTimeoutMs;
    const outcome = await this.#invokeSimctl(["bootstatus", udid, "-b"], bootstatusTimeoutMs, set);

    if (outcome.kind === "finished") {
      this.#assertSuccessful(["bootstatus", udid, "-b"], outcome.result);
      if (await this.#waitForInstaller(udid, deadline, set)) return;
    }

    await this.#bestEffortShutdown(udid, set);
    throw new BootTimeoutError(deviceId);
  }

  async #waitForInstaller(udid: string, deadline: number, set?: string): Promise<boolean> {
    // why: bootstatus can finish before the installer accepts requests after an erase (#547).
    while (this.#clock.now() < deadline) {
      const outcome = await this.#invokeSimctl(
        ["listapps", udid],
        Math.min(COMMAND_TIMEOUT_MS, deadline - this.#clock.now()),
        set,
      );
      if (outcome.kind === "finished" && outcome.result.code === 0) {
        return this.#clock.now() < deadline;
      }
      const remainingMs = deadline - this.#clock.now();
      if (remainingMs <= 0) break;
      await new Promise<void>((resolve) => {
        this.#clock.setTimer(Math.min(INSTALLER_POLL_MS, remainingMs), resolve);
      });
    }
    return false;
  }

  async #writeOverrides(udid: string, slim: SlimOptions): Promise<SlimWrite> {
    const resolved = resolveSlimCategories(slim.categories);
    if (resolved.categories.length === 0) {
      return {
        detail: `none of the configured slim categories (${(slim.categories ?? []).join(", ")}) are known`,
        kind: "no-categories",
      };
    }

    const startedAt = this.#clock.now();
    const wanted = overridesFor(resolved.categories);
    let writeError: string | undefined;
    try {
      const folder = this.#overridesFolder(udid);
      const file = join(folder, OVERRIDES_FILE_NAME);
      const existing = await this.#readOverrides(file);
      const merged = new Map([...existing, ...wanted]);
      if (!sameEntries(existing, merged)) {
        await this.#filesystem.mkdirp(folder, { mode: 0o700 });
        await this.#filesystem.writeFileAtomic(file, renderOverridesPlist(merged), { mode: 0o644 });
      }
    } catch (error: unknown) {
      writeError = `could not write the launchd overrides file: ${errorMessage(error)}`;
    }

    return { kind: "written", resolved, startedAt, wanted, writeError };
  }

  async #readOverrides(file: string): Promise<ReadonlyMap<string, boolean>> {
    if (!(await this.#filesystem.exists(file))) return new Map();
    const parsed = parseOverridesPlist(await this.#filesystem.readFile(file));
    if (parsed === undefined)
      throw new Error("the existing file is not a property list dictionary");
    return parsed;
  }

  #overridesFolder(udid: string): string {
    return join(this.#overridesRoot, `${OVERRIDES_FOLDER_PREFIX}${udid}`);
  }

  async #readBack(
    device: DriverDevice,
    data: IosDriverData,
    write: Extract<SlimWrite, { readonly kind: "written" }>,
  ): Promise<DriverDevice> {
    const outcome = await this.#invokeSimctl(
      ["spawn", data.udid, "launchctl", "print-disabled", "system"],
      READBACK_TIMEOUT_MS,
    );
    const details = write.writeError === undefined ? [] : [write.writeError];

    if (outcome.kind === "timed-out" || outcome.result.code !== 0) {
      const reason =
        outcome.kind === "timed-out"
          ? `timed out after ${String(READBACK_TIMEOUT_MS)}ms`
          : `exit ${String(outcome.result.code)}: ${outcome.result.stderr.trim()}`;
      details.push(`could not read back the launchd overrides: ${reason}`);
      return this.#skipApply(device, data, details.join("; "), "slim");
    }

    const read = parsePrintDisabled(outcome.result.stdout);
    const mismatched = [...write.wanted.keys()]
      .sort()
      .filter((label) => (read.get(label) ?? false) !== write.wanted.get(label));
    if (mismatched.length > 0) {
      details.push(
        `${String(mismatched.length)} of ${String(write.wanted.size)} managed labels did not read back as written at boot; first: ${mismatched[0] ?? ""}`,
      );
      return this.#skipApply(device, data, details.join("; "), "full");
    }
    if (details.length > 0) {
      return this.#skipApply(device, data, details.join("; "), "slim");
    }

    const labelCount = [...write.wanted.values()].filter(Boolean).length;
    this.#onSlimmed?.({
      address: data.udid,
      categories: write.resolved.categories.map((category) => category.name),
      deviceId: device.deviceId,
      durationMs: this.#clock.now() - write.startedAt,
      labelCount,
      signature: slimSignature(write.resolved.categories),
      unknownLabels: [...write.resolved.unknown],
    });

    return this.#asIs(device, data, "slim");
  }

  #skipApply(
    device: DriverDevice,
    data: IosDriverData,
    detail: string,
    mode: DeviceMode,
  ): DriverDevice {
    this.#onSlimSkipped?.({ deviceId: device.deviceId, detail, reason: "apply-failed" });
    return this.#asIs(device, data, mode);
  }

  async reclaim(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult> {
    if (isPhysicalDriverDevice(device)) return this.#physical.reclaim(device);
    throw new DriverCrashError("virtual devices are not reclaimed");
  }

  reclaimStrategy(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): "uninstall" {
    if (isPhysicalDriverDevice(device)) return "uninstall";
    throw new DriverCrashError("virtual devices are not reclaimed");
  }

  async shutdown(device: DriverDevice): Promise<void> {
    await this.#shutdown(iosDriverData(device).udid);
  }

  async destroy(device: DriverDevice): Promise<void> {
    const data = iosDriverData(device);
    await this.#shutdown(data.udid);
    await this.#simctl(["delete", data.udid], COMMAND_TIMEOUT_MS);
    await this.#removeOverrides(data.udid);
  }

  // why: simctl delete leaves the folder behind; a failed removal must not fail a destroy that
  // already deleted the simulator.
  async #removeOverrides(udid: string): Promise<void> {
    try {
      await this.#filesystem.rm(this.#overridesFolder(udid));
    } catch (error: unknown) {
      this.#logger?.warn(
        `could not remove the launchd overrides folder of ${udid}: ${errorMessage(error)}`,
      );
    }
  }

  async findLegacy(driverDeviceId: string): Promise<LegacyDevice | undefined> {
    // why: Under Xcode's set the default set is the driver's own, so no device is "pre-root"
    // there, and a lost mark stays a report-only finding instead of a deletable legacy device.
    if (this.#rootOptions === undefined) return undefined;
    const result = await this.#legacySimctl(["list", "-j", "devices"], COMMAND_TIMEOUT_MS);
    const found = parseManagedDevices(JSON.parse(result.stdout) as unknown).find(
      (device) => device.udid === driverDeviceId,
    );
    if (found === undefined) {
      return undefined;
    }

    return {
      device: {
        address: found.udid,
        deviceId: found.udid,
        driverData: {
          deviceTypeId: "",
          name: found.name,
          runtimeId: "",
          udid: found.udid,
        } satisfies IosDriverData,
      },
      ...(found.dataPath === undefined ? {} : { path: dirname(found.dataPath) }),
    };
  }

  async destroyLegacy(device: DriverDevice): Promise<void> {
    const { udid } = iosDriverData(device);
    // why: Best effort: a device that is already shut down reports a failure unrelated to the delete.
    await this.#invokeLegacySimctl(["shutdown", udid], COMMAND_TIMEOUT_MS);
    await this.#legacySimctl(["delete", udid], COMMAND_TIMEOUT_MS);
    await this.#removeOverrides(udid);
  }

  async listPresentPhysical(enrolledIds: readonly string[]): Promise<readonly PresentPhysical[]> {
    return this.#physical.listPresent(enrolledIds);
  }

  async inspectPhysical(id: string): Promise<PhysicalInspection> {
    return this.#physical.inspect(id);
  }

  async listManaged(): Promise<DriverReality> {
    const result = await this.#simctl(["list", "-j", "devices"], COMMAND_TIMEOUT_MS);
    const listed = parseManagedDevices(JSON.parse(result.stdout) as unknown);
    // why: Xcode's set also holds the user's own simulators and other Simlocks'; only a
    // durable mark naming this instance proves a simulator here is ours.
    const parsed =
      this.#rootOptions !== undefined
        ? listed
        : (
            await Promise.all(
              listed.map(async (device) =>
                (await this.#isMarkedByThisInstance(device.udid)) ? [device] : [],
              ),
            )
          ).flat();
    const devices: ObservedDevice[] = await Promise.all(
      parsed.map(async (device) => {
        const mark = await this.#readMark(device.udid);
        return {
          address: device.udid,
          deviceId: device.udid,
          driverData: {
            deviceTypeId: "",
            name: device.name,
            runtimeId: "",
            udid: device.udid,
          } satisfies IosDriverData,
          runState: device.runState,
          ...(mark !== undefined ? { mark } : {}),
        };
      }),
    );
    const processes = devices.filter((device) => device.runState === "running");
    return { devices, processes };
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    const catalog = await this.#loadCatalog();
    const installedRuntimes = catalog.runtimes.filter((runtime) => runtime.isAvailable);
    const models = catalog.deviceTypes.map((deviceType) => deviceType.name);
    return {
      defaultRuntime: newestRuntime(installedRuntimes)?.version,
      // why: Keyed by name and paired through the device type `resolveSpec` would pick for that name,
      // so two device types that differ only in letter case both list the first one's runtimes.
      // A device type answers to its name only, in any letter case (`findDeviceType`).
      modelAliases: {},
      modelClasses: Object.fromEntries(
        catalog.deviceTypes.flatMap((deviceType) => {
          const deviceClass = PRODUCT_FAMILY_CLASSES.get(deviceType.productFamily);
          return deviceClass === undefined ? [] : [[deviceType.name, deviceClass]];
        }),
      ),
      modelRuntimes: Object.fromEntries(
        models.map((model) => [model, pairedVersions(catalog, findDeviceType(catalog, model))]),
      ),
      models,
      runtimes: installedRuntimes.map((runtime) => runtime.version),
    };
  }

  estimate(estimate: DriverEstimate, spec: DeviceSpec): number {
    switch (estimate.operation) {
      case "provision":
        return PROVISION_ESTIMATE_MS;
      case "boot":
        return COLD_BOOT_ESTIMATE_MS;
      case "reclaim":
        if (spec.physical) return PHYSICAL_RECLAIM_ESTIMATE_MS;
        return ERASE_ESTIMATE_MS;
    }
  }

  async advisories(): Promise<readonly DriverAdvisory[]> {
    return [...(await this.#unreclaimableCacheAdvisories()), ...(await this.#slimAdvisories())];
  }

  async toolVersions(): Promise<readonly DriverToolVersion[]> {
    const result = await this.#processRunner.run("xcodebuild", ["-version"], {
      timeoutMs: XCODE_VERSION_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      if (/requires Xcode/.test(result.stderr)) return [];
      throw new Error(`xcodebuild -version exited with ${String(result.code)}`);
    }
    const version = /^Xcode (\S+)$/m.exec(result.stdout)?.[1];
    const build = /^Build version (\S+)$/m.exec(result.stdout)?.[1];
    if (version === undefined) throw new Error("xcodebuild -version printed no Xcode version");
    return [{ name: "xcode", version, ...(build === undefined ? {} : { build }) }];
  }

  async #unreclaimableCacheAdvisories(): Promise<readonly DriverAdvisory[]> {
    const assets = await this.#downloadedRuntimeAssets();

    if (assets.length === 0) {
      return [];
    }

    const installed = (await this.#loadCatalog()).runtimes.filter((runtime) => runtime.isAvailable);
    const orphans = assets.filter(
      (asset) => !installed.some((runtime) => runtimeMountsAsset(runtime, asset)),
    );

    if (orphans.length === 0) {
      return [];
    }

    // why: Oldest first, by version and then by build, so a store that has been collecting for
    // months reads in the order the downloads happened rather than as a lexicographic jumble.
    const described = [
      ...new Map(
        orphans.map((asset) => [`${asset.version} (${asset.build})`, asset] as const),
      ).entries(),
    ]
      .sort(
        ([, left], [, right]) =>
          compareVersions(left.version, right.version) || left.build.localeCompare(right.build),
      )
      .map(([label]) => label);
    return [
      {
        code: "runtime-cache-unreclaimable",
        message: leftoverDownloadsSentence(
          described,
          orphans.length,
          await this.#assetsSize(orphans),
        ),
      },
    ];
  }

  async #downloadedRuntimeAssets(): Promise<readonly RuntimeAsset[]> {
    let bundles: readonly string[];
    try {
      bundles = await this.#filesystem.readdir(IOS_RUNTIME_ASSET_ROOT);
    } catch {
      return [];
    }

    const assets: RuntimeAsset[] = [];
    for (const bundle of bundles.filter((name) => name.endsWith(".asset"))) {
      let contents: string;
      try {
        contents = await this.#filesystem.readFile(
          join(IOS_RUNTIME_ASSET_ROOT, bundle, "Info.plist"),
        );
      } catch {
        continue;
      }

      const asset = parseRuntimeAsset(join(IOS_RUNTIME_ASSET_ROOT, bundle), contents);
      if (asset !== undefined) {
        assets.push(asset);
      }
    }

    return assets;
  }

  async #slimAdvisories(): Promise<readonly DriverAdvisory[]> {
    if (this.#slim === undefined || !this.#slimByDefault) {
      return [];
    }

    const catalog = await this.#loadCatalog();
    const unsupportedVersions = [
      ...new Set(
        catalog.runtimes
          .filter((runtime) => runtime.isAvailable)
          .filter((runtime) => !supportsPersistentSlim(iosRuntimeVersionFromId(runtime.identifier)))
          .map((runtime) => runtime.version),
      ),
    ].sort(compareVersions);

    if (unsupportedVersions.length === 0) {
      return [];
    }

    const plural = unsupportedVersions.length > 1;
    return [
      {
        code: "slim-runtime-unsupported",
        message:
          `The default device mode is slim, but iOS ${unsupportedVersions.join(", ")} ${plural ? "are" : "is"} ` +
          `below the 18.5 persistent-override floor; devices on ${plural ? "those runtimes" : "that runtime"} ` +
          `get full devices -- \`launchctl disable\` overrides do not survive a reboot below iOS 18.5`,
      },
    ];
  }

  virtualLeaseEnvironment(): Readonly<Record<string, string>> {
    return this.#rootOptions === undefined ? {} : { SIMLOCK_IOS_DEVICE_SET: this.#deviceRoot };
  }

  leaseEnvironment(device: DriverDevice): Readonly<Record<string, string>> {
    if (isPhysicalDriverDevice(device)) return { SIMLOCK_DEVICE_UDID: device.deviceId };
    return this.virtualLeaseEnvironment();
  }

  readonly passthroughTools = IOS_PASSTHROUGH_TOOLS;

  async passthrough(
    tool: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand> {
    if (tool === "devicectl") return this.#devicectlPassthrough(device, args, context);
    if (tool !== "simctl") {
      throw new PassthroughRefusedError(
        tool,
        `Refusing \`${tool}\`: the iOS driver does not wrap it.`,
      );
    }
    if (context?.platform !== undefined && context.platform !== this.platform) {
      throw new PassthroughRefusedError(
        tool,
        `Refusing \`simctl\`: it only serves an iOS simulator, and this lease is on the ${context.platform} platform.`,
      );
    }
    if (device !== undefined && isPhysicalDriverDevice(device)) {
      throw new PassthroughRefusedError(
        tool,
        "Refusing `simctl`: it serves simulators, and this lease holds a physical device. Use `devicectl`.",
      );
    }
    this.#assertProxyable(args);
    const scopedArgs = device === undefined ? args : fillSimctlDevice(args, device.deviceId);
    // why: No environment: simctl ignores every variable that could carry the device set.
    return await Promise.resolve({
      args: this.#scopedSimctlArgv(scopedArgs),
      command: "xcrun",
      env: {},
    });
  }

  #devicectlPassthrough(
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context: PassthroughContext | undefined,
  ): PassthroughCommand {
    const tool = "devicectl";
    if (device === undefined) {
      throw new PassthroughRefusedError(
        tool,
        "Refusing `simlock devicectl`: Simlock has no local devicectl wrapper. Run `xcrun devicectl` directly, or use `device.exec` on a lease.",
      );
    }
    if (context?.platform !== undefined && context.platform !== this.platform) {
      throw new PassthroughRefusedError(
        tool,
        `Refusing \`devicectl\`: it only serves a physical iOS device, and this lease is on the ${context.platform} platform.`,
      );
    }
    if (!isPhysicalDriverDevice(device)) {
      throw new PassthroughRefusedError(
        tool,
        "Refusing `devicectl`: it only serves a physical device, and this lease holds a simulator. Use `simctl`.",
      );
    }
    return devicectlExecCommand(device.deviceId, args);
  }

  #assertProxyable(args: readonly string[]): void {
    const [verb, ...operands] = this.#subcommand(args);
    if (verb === undefined) return;
    if (REFUSED_SIMCTL_VERBS.has(verb)) {
      this.#refuse(
        verb,
        `it changes a device's lifecycle behind Simlock's registry, which would report the device as drifted on the next reconcile. ${RECLAIM_INSTEAD}`,
      );
    }
    if (verb === "shutdown" && operands.includes(SHUTDOWN_ALL_TARGET)) {
      this.#refuse(
        `shutdown ${SHUTDOWN_ALL_TARGET}`,
        `it stops every device in Simlock's set at once -- every agent's, not just yours -- and each interrupted lease spends its recovery budget rebooting, so one that runs out ends as \`lease_lost\`. Shutting a single device down by udid is still allowed. ${RECLAIM_INSTEAD}`,
      );
    }
    // why: A bare `simctl` reaches this too, so refusing it takes no capability away. The
    // wrapper is advertised as the safe path, and being the convenient route to a
    // multi-gigabyte deletion of a runtime Xcode shares is not that.
    if (
      verb === "runtime" &&
      operands.find((operand) => !operand.startsWith("-")) === REFUSED_RUNTIME_OPERATION
    ) {
      this.#refuse(
        `runtime ${REFUSED_RUNTIME_OPERATION}`,
        "it deletes a runtime shared with Xcode and other tools. To remove a runtime Simlock added, use `simlock component remove ios <version>`; delete any other through Xcode.",
      );
    }
  }

  #refuse(command: string, guidance: string): never {
    throw new PassthroughRefusedError(
      "simctl",
      `Refusing \`simlock simctl ${command}\`: ${guidance}`,
    );
  }

  #subcommand(args: readonly string[]): readonly string[] {
    for (const [index, argument] of args.entries()) {
      if (!argument.startsWith("-")) return args.slice(index);
      const flag = /^-+([^=]*)/.exec(argument)?.[1];
      if (flag !== undefined && CALLER_SUPPLIED_SCOPE_FLAGS.has(flag)) {
        throw new PassthroughRefusedError(
          "simctl",
          `Refusing \`simlock simctl ${argument}\`: \`simlock simctl\` supplies the device set itself, and a caller-supplied \`--${flag}\` would point simctl somewhere Simlock does not manage. Drop the flag -- the command is already scoped -- or run \`xcrun simctl\` directly if you mean to leave Simlock's set.`,
        );
      }
      // why: Not `--set`/`--profiles` by name, but simctl has no other legitimate global here --
      // refused on sight rather than skipped over as presumed harmless, the same way an
      // unrecognized adb global is (`allowedGlobalArity`). Skipping it is exactly what let a
      // caller-supplied `--set`/`--profiles` hide behind an unrecognized flag's *value*.
      throw new PassthroughRefusedError(
        "simctl",
        `Refusing \`simlock simctl ${argument}\`: \`simlock simctl\` supplies the device set itself, and does not recognize any caller-supplied argument ahead of the subcommand. Drop the flag -- the command is already scoped -- or run \`xcrun simctl\` directly if you mean to leave Simlock's set.`,
      );
    }
    return [];
  }

  #deviceDirectory(udid: string): string {
    return join(this.#deviceRoot, udid);
  }

  #dataPathFor(udid: string): string {
    return join(this.#deviceDirectory(udid), "data");
  }

  /**
   * why: Writes the same provenance token into both regions of a device: the
   * device root (durable -- survives `simctl erase`) and the data container
   * (erasable -- destroyed by it).
   *
   * The erasable half goes first, and the two are not written concurrently, because a
   * half-written pair is read by `Doctor` as tampering: durable-without-erasable is
   * exactly the signature of a foreign erase. Writing the fragile half first means a
   * failure (`<root>/<udid>/data` is not there, so `writeFileAtomic` -- which creates no
   * parents -- cannot land) leaves *neither* mark, which reads as "never marked" and
   * produces no finding at all. The write still throws, so the caller learns something
   * was wrong with the device; what it must never do is accuse the user of erasing a
   * device Simlock itself just erased.
   */
  async #writeMark(udid: string): Promise<void> {
    const token = this.#idGenerator.generate();
    const contents = JSON.stringify({
      instanceId: this.#instanceId,
      token,
      udid,
      writtenAt: new Date(this.#clock.now()).toISOString(),
    });

    await this.#filesystem.writeFileAtomic(join(this.#dataPathFor(udid), MARK_FILE_NAME), contents);
    await this.#filesystem.writeFileAtomic(
      join(this.#deviceDirectory(udid), MARK_FILE_NAME),
      contents,
    );
  }

  async #readMark(udid: string): Promise<ObservedMark | undefined> {
    const durable = await this.#readToken(join(this.#deviceDirectory(udid), MARK_FILE_NAME));
    const erasable = await this.#readToken(join(this.#dataPathFor(udid), MARK_FILE_NAME));

    if (durable === undefined && erasable === undefined) {
      return undefined;
    }

    return { durable, erasable, erasableReadable: true };
  }

  async #readToken(path: string): Promise<string | undefined> {
    return (await this.#readMarkFile(path))?.token;
  }

  async #readMarkFile(
    path: string,
  ): Promise<{ readonly token: string; readonly instanceId: string | undefined } | undefined> {
    try {
      const contents = await this.#filesystem.readFile(path);
      const parsed = JSON.parse(contents) as unknown;
      if (!isRecord(parsed) || typeof parsed.token !== "string" || parsed.token === "") {
        return undefined;
      }
      return {
        instanceId:
          typeof parsed.instanceId === "string" && parsed.instanceId !== ""
            ? parsed.instanceId
            : undefined,
        token: parsed.token,
      };
    } catch {
      return undefined;
    }
  }

  /** why: Under Xcode's set the default set holds this instance's simulators too, and they are not foreign. */
  async #ownedUdids(listed: unknown): Promise<ReadonlySet<string>> {
    if (this.#rootOptions !== undefined || !isRecord(listed) || !isRecord(listed.devices)) {
      return new Set();
    }
    const udids = parseManagedDevices(listed).map((device) => device.udid);
    const owned = await Promise.all(udids.map((udid) => this.#isMarkedByThisInstance(udid)));
    return new Set(udids.filter((_udid, index) => owned[index]));
  }

  async #isMarkedByThisInstance(udid: string): Promise<boolean> {
    const durable = await this.#readMarkFile(join(this.#deviceDirectory(udid), MARK_FILE_NAME));
    return durable?.instanceId === this.#instanceId;
  }

  async #resolvedSpec(spec: VirtualSpec): Promise<ResolvedIosSpec> {
    const existing = this.#resolvedSpecs.get(specKey(spec));
    if (existing !== undefined) {
      return existing;
    }

    await this.resolveSpec(spec);
    const resolved = this.#resolvedSpecs.get(specKey(spec));
    if (resolved === undefined) {
      throw new DriverCrashError("simctl did not resolve the requested device specification");
    }

    return resolved;
  }

  async #loadCatalog(): Promise<SimctlCatalog> {
    const result = await this.#simctl(
      ["list", "-j", "devicetypes", "runtimes"],
      COMMAND_TIMEOUT_MS,
    );

    try {
      return parseCatalog(JSON.parse(result.stdout) as unknown);
    } catch (error: unknown) {
      if (error instanceof DriverCrashError) {
        throw error;
      }

      throw new DriverCrashError(`Could not parse simctl device catalog: ${errorMessage(error)}`);
    }
  }

  async #loadRuntimeImages(): Promise<readonly RuntimeImage[]> {
    const result = await this.#simctl(["runtime", "list", "-j"], COMMAND_TIMEOUT_MS);
    try {
      return parseRuntimeImages(JSON.parse(result.stdout) as unknown);
    } catch (error: unknown) {
      if (error instanceof DriverCrashError) throw error;
      throw new DriverCrashError(`Could not parse simctl runtime list: ${errorMessage(error)}`);
    }
  }

  async #shutdown(udid: string, set?: string): Promise<void> {
    const outcome = await this.#invokeSimctl(["shutdown", udid], COMMAND_TIMEOUT_MS, set);

    if (outcome.kind === "timed-out") {
      throw new DriverCrashError(`simctl shutdown ${udid} timed out after ${COMMAND_TIMEOUT_MS}ms`);
    }
    if (outcome.result.code !== 0 && !alreadyShutdown(outcome.result.stderr)) {
      this.#assertSuccessful(["shutdown", udid], outcome.result);
    }
  }

  async #bestEffortShutdown(udid: string, set?: string): Promise<void> {
    try {
      await this.#shutdown(udid, set);
    } catch {
      // why: Boot failure cleanup must not obscure the timeout that triggered it.
    }
  }

  async #simctl(args: readonly string[], timeoutMs: number, set?: string): Promise<ProcessResult> {
    return this.#checked(args, timeoutMs, await this.#invokeSimctl(args, timeoutMs, set));
  }

  async #legacySimctl(args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return this.#checked(args, timeoutMs, await this.#invokeLegacySimctl(args, timeoutMs));
  }

  #checked(args: readonly string[], timeoutMs: number, outcome: ProcessOutcome): ProcessResult {
    if (outcome.kind === "timed-out") {
      throw new DriverCrashError(`simctl ${args.join(" ")} timed out after ${timeoutMs}ms`);
    }

    this.#assertSuccessful(args, outcome.result);
    return outcome.result;
  }

  #scopedSimctlArgv(args: readonly string[], set?: string): string[] {
    if (set !== undefined) return ["simctl", "--set", set, ...args];
    // why: Xcode's own set is simctl's default, so a call there carries no `--set`.
    if (this.#rootOptions === undefined) return ["simctl", ...args];
    return ["simctl", "--set", this.#deviceRoot, ...args];
  }

  async #invokeSimctl(
    args: readonly string[],
    timeoutMs: number,
    set?: string,
  ): Promise<ProcessOutcome> {
    return this.#invokeXcrun(this.#scopedSimctlArgv(args, set), timeoutMs);
  }

  /**
   * why: Deliberately unscoped, and the only thing in Simlock that is: the pre-root devices
   * `findLegacy` / `destroyLegacy` deal with are in the machine's default set, which is
   * where a `--set` would stop reaching them. Only those two may call it, and only for a
   * UDID a registry record names -- registry-only destruction (safety rule 1) is satisfied
   * by that record, not by the root. The one other caller is `listComponents`, and only for
   * `simctl list`, which reads the default set and mutates nothing (ADR 0010 §8).
   */
  async #invokeLegacySimctl(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    return this.#invokeXcrun(["simctl", ...args], timeoutMs);
  }

  async #invokeXcrun(argv: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    let process;
    try {
      process = this.#processRunner.spawn("xcrun", [...argv], { timeoutMs });
    } catch (error: unknown) {
      throw new DriverCrashError(`Could not start ${argv.join(" ")}: ${errorMessage(error)}`);
    }

    let resolveTimeout: (() => void) | undefined;
    const timedOut = new Promise<void>((resolve) => {
      resolveTimeout = resolve;
    });
    const timer = this.#clock.setTimer(timeoutMs, () => {
      resolveTimeout?.();
      try {
        process.kill("SIGTERM");
      } catch {
        // why: A process that has already exited needs no timeout cleanup.
      }
    });

    try {
      return await Promise.race([
        process.wait().then((result) => ({ kind: "finished" as const, result })),
        timedOut.then(() => ({ kind: "timed-out" as const })),
      ]);
    } catch (error: unknown) {
      throw new DriverCrashError(`${argv.join(" ")} failed: ${errorMessage(error)}`);
    } finally {
      this.#clock.cancel(timer);
    }
  }

  #assertSuccessful(args: readonly string[], result: ProcessResult): void {
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      const suffix = stderr === "" ? "" : `: ${stderr}`;
      throw new DriverCrashError(
        `simctl ${args.join(" ")} exited with code ${String(result.code)}${suffix}`,
      );
    }
  }

  #requireIosPlatform(platform: string): void {
    if (platform !== this.platform) {
      throw new DriverCrashError(`iOS simctl driver cannot handle ${platform} device requests`);
    }
  }
}

function missingRuntime(
  osVersion: string,
  message: string,
  component: string,
): RuntimeMissingError {
  return belowDownloadFloor(component)
    ? new IosDownloadFloorError(component)
    : new IosRuntimeMissingError(osVersion, message, component);
}

function belowDownloadFloor(component: string): boolean {
  return component !== LATEST_COMPONENT && isTooOldToDownload(component);
}

class IosRuntimeMissingError extends RuntimeMissingError {
  constructor(osVersion: string, message: string, component: string) {
    super("ios", osVersion, { component });
    this.message = message;
  }
}

class IosUnknownModelError extends UnknownModelError {
  constructor(model: string) {
    super("ios", model);
    this.message = `Unknown ios model: ${model}; a newer Xcode version may add this device`;
  }
}

class IosVersionOutOfRangeError extends RuntimeMissingError {
  constructor(model: string, requested: string, deviceType: DeviceType) {
    super("ios", requested, { downloadable: false });
    const range = formatVersionRange(deviceType.minRuntimeVersion, deviceType.maxRuntimeVersion);
    this.message = `${model} supports iOS ${range}; iOS ${requested} is out of range`;
  }
}

class IosRuntimeUnpairedError extends RuntimeMissingError {
  constructor(model: string, requested: string) {
    super("ios", requested, { downloadable: false });
    this.message = `iOS ${requested} is installed but does not support ${model}`;
  }
}

class IosDownloadFloorError extends RuntimeMissingError {
  constructor(requested: string) {
    super("ios", requested, { downloadable: false });
    this.message =
      `iOS ${requested} predates Xcode's automatic download support (introduced for iOS ` +
      `16.0 and newer); install it manually via Xcode`;
  }
}

class IosRuntimeUnavailableForDownloadError extends RuntimeMissingError {
  constructor(requested: string) {
    super("ios", requested, { downloadable: false });
    this.message =
      `iOS ${requested} is not currently offered for download by Apple (likely superseded by a ` +
      `newer point release); request a different --os, or omit --os for the newest available runtime`;
  }
}

// why: the input is offered exactly when the screen capture is, because both are the one program.
function createInputFor(
  options: IosSimctlDriverOptions,
  deviceRoot: string,
  ownedRoot: boolean,
): DeviceInputFactory | undefined {
  if (options.screenCapture === undefined) return undefined;
  return createIosDeviceInput({
    baseEnvironment: options.screenCapture.baseEnvironment,
    clock: options.clock,
    command: configuredScreenCaptureCommand(options) ?? options.screenCapture.command,
    ...(ownedRoot ? { deviceSet: deviceRoot } : {}),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    launcher: options.screenCapture.launcher,
    processRunner: options.processRunner,
  });
}

function configuredScreenCaptureCommand(options: IosSimctlDriverOptions): string | undefined {
  const configured = options.driverConfig["screenCaptureCommand"];
  return typeof configured === "string" && configured !== "" ? configured : undefined;
}

function configuredDeviceCaptureCommand(options: IosSimctlDriverOptions): string | undefined {
  const configured = options.driverConfig["deviceCaptureCommand"];
  return typeof configured === "string" && configured !== "" ? configured : undefined;
}

function configuredDeviceSet(options: IosSimctlDriverOptions): "simlock" | "default" {
  const configured = options.driverConfig["deviceSet"];
  if (configured === undefined || configured === "simlock") return "simlock";
  if (configured !== "default") {
    throw new OwnedRootError(
      `Refusing the ios device set: drivers.ios.deviceSet must be "simlock" or "default", but it is ${JSON.stringify(configured)}`,
      "invalid-device-set",
      typeof configured === "string" ? configured : JSON.stringify(configured),
      "ios",
    );
  }
  if (options.driverConfig["deviceRoot"] !== undefined) {
    throw new OwnedRootError(
      `Refusing the ios device set: drivers.ios.deviceRoot names Simlock's own set, but drivers.ios.deviceSet is "default". Remove one of them.`,
      "invalid-device-set",
      configured,
      "ios",
    );
  }
  return "default";
}

function xcodeDeviceSetPath(options: IosSimctlDriverOptions): string {
  return join(options.coreSimulatorRoot ?? ".", "Devices");
}

function configuredDeviceRoot(options: IosSimctlDriverOptions): string {
  const configured = options.driverConfig["deviceRoot"];

  if (configured !== undefined && typeof configured !== "string") {
    // why: A `deviceRoot` that is not a usable path refuses this platform's *configuration*,
    // which costs iOS and nothing else -- the same as every other refusal here. It is not
    // a daemon-fatal error: `"deviceRoot": true` and `"deviceRoot": "devices/ios"` are one
    // keystroke apart, and killing the process over the first would take Android down with
    // it and leave the reason unreachable, since `doctor` -- where the CLI reference promises
    // it appears -- needs a daemon to answer. `not-absolute` is the vocabulary term the
    // docs already publish for "this names no usable directory"; nothing new is invented.
    throw new OwnedRootError(
      `Refusing the ios device root: drivers.ios.deviceRoot must be an absolute path, but it is the ${typeof configured} ${JSON.stringify(configured)}`,
      "not-absolute",
      String(configured),
      "ios",
    );
  }

  return configured ?? join(options.simlockHome, "devices", "ios");
}

interface ParsedManagedDevice {
  readonly dataPath?: string;
  readonly name: string;
  readonly runState: ObservedRunState;
  readonly udid: string;
}

function parseManagedDevices(value: unknown): ParsedManagedDevice[] {
  if (!isRecord(value) || !isRecord(value.devices)) {
    throw new DriverCrashError("Invalid simctl device list JSON");
  }
  return Object.values(value.devices).flatMap((runtimeDevices) =>
    Array.isArray(runtimeDevices) ? runtimeDevices.flatMap(parseManagedDevice) : [],
  );
}

function parseManagedDevice(value: unknown): readonly ParsedManagedDevice[] {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.udid !== "string") {
    return [];
  }

  return [
    {
      name: value.name,
      runState: simctlRunState(value.state),
      udid: value.udid,
      ...(typeof value.dataPath === "string" ? { dataPath: value.dataPath } : {}),
    },
  ];
}

function simctlRunState(state: unknown): ObservedRunState {
  if (state === "Booted") return "running";
  if (state === "Shutdown") return "stopped";
  return "transitioning";
}

function parseCatalog(value: unknown): SimctlCatalog {
  if (!isRecord(value) || !Array.isArray(value.devicetypes) || !Array.isArray(value.runtimes)) {
    throw new DriverCrashError(
      "Invalid simctl list JSON: expected devicetypes and runtimes arrays",
    );
  }

  const deviceTypes = value.devicetypes.flatMap(parseDeviceType);
  const runtimes = value.runtimes.flatMap(parseRuntime);

  // why: Device types come from the Xcode install itself and are never empty on a working
  // toolchain, so an empty list here means the JSON was malformed. Runtimes are different: a
  // fresh Xcode with zero simulator runtimes installed is a normal, if unusual, starting state
  // -- and it must be able to reach the download-latest path in `#resolveDefaultRuntime` rather
  // than being rejected here before any resolution is attempted.
  if (deviceTypes.length === 0) {
    throw new DriverCrashError("Invalid simctl list JSON: no usable device types");
  }

  return { deviceTypes, runtimes };
}

function parseDeviceType(value: unknown): readonly DeviceType[] {
  if (!isRecord(value) || typeof value.identifier !== "string" || typeof value.name !== "string") {
    return [];
  }

  return [
    {
      identifier: value.identifier,
      maxRuntimeVersion: versionIntOr(value.maxRuntimeVersion, UNBOUNDED_VERSION),
      minRuntimeVersion: versionIntOr(value.minRuntimeVersion, 0),
      name: value.name,
      productFamily: typeof value.productFamily === "string" ? value.productFamily : undefined,
    },
  ];
}

function parseRuntime(value: unknown): readonly Runtime[] {
  if (
    !isRecord(value) ||
    typeof value.identifier !== "string" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.isAvailable !== "boolean" ||
    !value.name.toLocaleLowerCase().startsWith("ios ")
  ) {
    return [];
  }

  return [
    {
      ...(typeof value.buildversion === "string" ? { build: value.buildversion } : {}),
      identifier: value.identifier,
      isAvailable: value.isAvailable,
      name: value.name,
      supportedDeviceTypeIds: parseSupportedDeviceTypeIds(value.supportedDeviceTypes),
      version: value.version,
    },
  ];
}

function runtimeMountsAsset(runtime: Runtime, asset: RuntimeAsset): boolean {
  return runtime.build === undefined
    ? runtime.version === asset.version
    : runtime.build === asset.build;
}

/**
 * why: The build and marketing version out of an asset bundle's `Info.plist`. Read as text rather
 * than through a plist parser: these are two flat string values in a file this driver must
 * never write, and shelling out to `plutil` once per bundle would make a `doctor` run pay for
 * every runtime ever downloaded. Both keys are read from `MobileAssetProperties` onwards, so a
 * same-named key in the surrounding envelope cannot be mistaken for the asset's own.
 */
function parseRuntimeAsset(path: string, plist: string): RuntimeAsset | undefined {
  const propertiesAt = plist.indexOf("<key>MobileAssetProperties</key>");
  const properties = propertiesAt === -1 ? plist : plist.slice(propertiesAt);
  const build = /<key>Build<\/key>\s*<string>([^<]+)<\/string>/.exec(properties)?.[1];
  const version = /<key>SimulatorVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(properties)?.[1];

  return build === undefined || version === undefined ? undefined : { build, path, version };
}

function versionIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseSupportedDeviceTypeIds(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  const ids = value
    .filter(isRecord)
    .map((entry) => entry.identifier)
    .filter((identifier): identifier is string => typeof identifier === "string");
  return new Set(ids);
}

interface RuntimeImage {
  readonly identifier: string;
  readonly runtimeIdentifier: string;
  readonly build?: string;
  readonly platformIdentifier?: string;
  readonly version?: string;
  readonly sizeBytes?: number;
  readonly state?: string;
}

function isBeingDeleted(image: RuntimeImage): boolean {
  return image.state?.toLowerCase() === "deleting";
}

const IOS_SIMULATOR_PLATFORM = "com.apple.platform.iphonesimulator";

function parseRuntimeImages(value: unknown): readonly RuntimeImage[] {
  if (!isRecord(value)) {
    throw new DriverCrashError("Invalid simctl runtime list JSON: expected an object");
  }
  return Object.values(value).flatMap((entry): RuntimeImage[] =>
    isRecord(entry) &&
    typeof entry.identifier === "string" &&
    typeof entry.runtimeIdentifier === "string"
      ? [
          {
            identifier: entry.identifier,
            runtimeIdentifier: entry.runtimeIdentifier,
            ...optionalString("build", entry.build),
            ...optionalString("platformIdentifier", entry.platformIdentifier),
            ...optionalString("version", entry.version),
            ...optionalString("state", entry.state),
            ...(isByteCount(entry.sizeBytes) ? { sizeBytes: entry.sizeBytes } : {}),
          },
        ]
      : [],
  );
}

function optionalString<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  return typeof value === "string" ? ({ [key]: value } as Record<Key, string>) : {};
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function runtimeReceipt(runtime: Runtime, images: readonly RuntimeImage[]): ComponentReceipt {
  const image = images.find(
    (candidate) =>
      candidate.runtimeIdentifier === runtime.identifier &&
      (runtime.build === undefined || candidate.build === runtime.build),
  );
  return image === undefined
    ? { build: runtime.build ?? "", runtime: runtime.identifier }
    : imageReceipt(image);
}

function imageReceipt(image: RuntimeImage): ComponentReceipt {
  return { build: image.build ?? "", image: image.identifier };
}

function isIosImage(image: RuntimeImage): boolean {
  return image.platformIdentifier === IOS_SIMULATOR_PLATFORM;
}

type ListedImage = DriverComponent & {
  readonly image: RuntimeImage;
  readonly unusedDevices: number;
};

function leftoverDownloadsSentence(
  labels: readonly string[],
  bundles: number,
  sizeBytes: number | undefined,
): string {
  const runtimes = labels.length > 1;
  const downloads = bundles > 1;
  const size =
    sizeBytes === undefined
      ? ""
      : ` (${(sizeBytes / 1024 ** 3).toFixed(1)} GiB${downloads ? " in all" : ""})`;
  return (
    `iOS ${labels.join(", ")} ${runtimes ? "are" : "is"} no longer installed, but ` +
    `${runtimes ? "their" : "its"} ${downloads ? "downloads" : "download"}${size} ` +
    `${downloads ? "are" : "is"} still in ${IOS_RUNTIME_ASSET_ROOT}; ` +
    `\`simctl runtime delete\` does not reclaim ${downloads ? "them" : "it"} and Simlock does ` +
    "not delete files there -- remove the platform in Xcode's Settings -> Platforms to get " +
    "the space back"
  );
}

function unavailableDevicesResidue(unused: number): string | undefined {
  if (unused === 0) return undefined;
  const subject =
    unused === 1
      ? "1 never-used simulator in the default device set is"
      : `${String(unused)} never-used simulators in the default device set are`;
  return (
    `${subject} now unavailable; Simlock does not delete simulators there -- ` +
    "`xcrun simctl delete unavailable` clears them"
  );
}

interface DefaultSetDevices {
  readonly used: number;
  readonly unused: number;
}

function devicesPerRuntime(
  value: unknown,
  owned: ReadonlySet<string>,
): ReadonlyMap<string, DefaultSetDevices> {
  if (!isRecord(value) || !isRecord(value.devices)) {
    throw new DriverCrashError("Invalid simctl device list JSON");
  }
  return new Map(
    Object.entries(value.devices).map(([runtime, devices]): [string, DefaultSetDevices] => {
      const entries: readonly unknown[] = (Array.isArray(devices) ? devices : []).filter(
        (device: unknown) => !(isRecord(device) && owned.has(String(device.udid))),
      );
      const used = entries.filter(
        (device) => !isRecord(device) || device.lastUsedAt !== undefined,
      ).length;
      return [runtime, { unused: entries.length - used, used }];
    }),
  );
}

function installedComponent(runtime: Runtime, images: readonly RuntimeImage[]): InstalledComponent {
  return { receipt: runtimeReceipt(runtime, images), version: runtime.version };
}

function withBareMajorHint(component: string, error: unknown): unknown {
  if (component === LATEST_COMPONENT || component.includes(".")) return error;
  if (!(error instanceof DriverCrashError)) return error;
  return new DriverCrashError(
    `Could not download a default iOS runtime (tried ${component}): ${error.message}; ` +
      `pass --os <version> to request an exact release`,
  );
}

function runtimeForComponent(catalog: SimctlCatalog, component: string): Runtime | undefined {
  const available = catalog.runtimes.filter((runtime) => runtime.isAvailable);
  if (component === LATEST_COMPONENT) return newestRuntime(available);
  if (!component.includes(".")) {
    return newestRuntime(
      available.filter((runtime) => runtime.version.split(".")[0] === component),
    );
  }
  return findInstalledRuntime(catalog, component);
}

function findInstalledRuntime(catalog: SimctlCatalog, version: string): Runtime | undefined {
  return catalog.runtimes.find((runtime) => runtime.isAvailable && runtime.version === version);
}

function findDeviceType(catalog: SimctlCatalog, model: string): DeviceType | undefined {
  const wanted = model.toLocaleLowerCase();
  return catalog.deviceTypes.find((candidate) => candidate.name.toLocaleLowerCase() === wanted);
}

function pairedInstalledRuntimes(
  catalog: SimctlCatalog,
  deviceType: DeviceType,
): readonly Runtime[] {
  return catalog.runtimes.filter(
    (runtime) =>
      runtime.isAvailable &&
      runtime.supportedDeviceTypeIds.has(deviceType.identifier) &&
      isVersionInRange(runtime.version, deviceType),
  );
}

function findPairedRuntime(
  catalog: SimctlCatalog,
  deviceType: DeviceType,
  version: string,
): Runtime | undefined {
  return pairedInstalledRuntimes(catalog, deviceType).find(
    (runtime) => runtime.version === version,
  );
}

function pairedVersions(catalog: SimctlCatalog, deviceType: DeviceType | undefined): string[] {
  if (deviceType === undefined) return [];
  return [
    ...new Set(pairedInstalledRuntimes(catalog, deviceType).map((runtime) => runtime.version)),
  ];
}

function decodeVersionTriple(encoded: number): readonly [number, number, number] {
  return [(encoded >> 16) & 0xff, (encoded >> 8) & 0xff, encoded & 0xff];
}

function formatDecodedVersion(encoded: number): string {
  const [major, minor, patch] = decodeVersionTriple(encoded);
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

function isUnboundedMax(encoded: number): boolean {
  return encoded >= UNBOUNDED_VERSION;
}

function formatVersionRange(min: number, max: number): string {
  const minLabel = formatDecodedVersion(min);
  return isUnboundedMax(max) ? `${minLabel}+` : `${minLabel}-${formatDecodedVersion(max)}`;
}

function versionTriple(version: string): readonly [number, number, number] {
  const parts = version.split(".").map(versionPart);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function versionOrdinal(triple: readonly [number, number, number]): number {
  return triple[0] * 1_000_000 + triple[1] * 1_000 + triple[2];
}

function isVersionInRange(version: string, deviceType: DeviceType): boolean {
  const ordinal = versionOrdinal(versionTriple(version));
  return (
    ordinal >= versionOrdinal(decodeVersionTriple(deviceType.minRuntimeVersion)) &&
    ordinal <= versionOrdinal(decodeVersionTriple(deviceType.maxRuntimeVersion))
  );
}

function isTooOldToDownload(version: string): boolean {
  return versionOrdinal(versionTriple(version)) < versionOrdinal(IOS_DOWNLOAD_FLOOR);
}

function majorVersionString(encoded: number): string {
  return String(decodeVersionTriple(encoded)[0]);
}

function newestRuntime(runtimes: readonly Runtime[]): Runtime | undefined {
  return [...runtimes].sort((left, right) => compareVersions(left.version, right.version)).at(-1);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(versionPart);
  const rightParts = right.split(".").map(versionPart);
  const partCount = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < partCount; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return left.localeCompare(right);
}

function versionPart(part: string): number {
  const parsed = Number.parseInt(part, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function iosDriverData(device: DriverDevice): IosDriverData {
  const value = device.driverData;
  if (
    !isRecord(value) ||
    typeof value.udid !== "string" ||
    typeof value.deviceTypeId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.name !== "string"
  ) {
    throw new DriverCrashError(`Invalid iOS driver data for device ${device.deviceId}`);
  }

  return {
    deviceTypeId: value.deviceTypeId,
    name: value.name,
    runtimeId: value.runtimeId,
    udid: value.udid,
    // why: Both are optional: absent or wrong-typed is ignored rather than rejected. A `full` key
    // an older daemon stamped here is not read: the spec's mode is the only record of it (ADR 0007 §7).
    ...(typeof value.slimSignature === "string" ? { slimSignature: value.slimSignature } : {}),
    ...(typeof value.slimMarkToken === "string" ? { slimMarkToken: value.slimMarkToken } : {}),
  };
}

export { iosRuntimeVersionFromId };

export function supportsPersistentSlim(version: readonly [number, number] | undefined): boolean {
  if (version === undefined) {
    return false;
  }
  const [major, minor] = version;
  return major > 18 || (major === 18 && minor >= 5);
}

type SlimPlan =
  | { readonly kind: "off" }
  | { readonly kind: "skip"; readonly reason: SlimSkippedFact["reason"]; readonly detail: string }
  | { readonly kind: "apply"; readonly slim: SlimOptions };

function planSlimBoot(
  data: IosDriverData,
  slim: SlimOptions | undefined,
  options: { readonly purpose: "prepare" | "recover"; readonly mode: DeviceMode },
): { readonly plan: SlimPlan; readonly bootstatusTimeoutMs: number } {
  if (options.purpose === "recover" || slim === undefined || options.mode !== "slim") {
    return { bootstatusTimeoutMs: BOOTSTATUS_TIMEOUT_MS, plan: { kind: "off" } };
  }

  const version = iosRuntimeVersionFromId(data.runtimeId);
  if (!supportsPersistentSlim(version)) {
    return {
      bootstatusTimeoutMs: BOOTSTATUS_TIMEOUT_MS,
      plan: {
        detail:
          version === undefined
            ? `runtimeId "${data.runtimeId}" does not parse to an iOS version`
            : `iOS ${String(version[0])}.${String(version[1])} is below the 18.5 persistent-override floor`,
        kind: "skip",
        reason: version === undefined ? "unknown-runtime" : "runtime-too-old",
      },
    };
  }

  return { bootstatusTimeoutMs: slim.bootTimeoutMs, plan: { kind: "apply", slim } };
}

function createScreenCaptureFor(
  options: IosSimctlDriverOptions,
  deviceRoot: string,
  ownsDeviceSet: boolean,
  deviceOsVersion: (udid: string) => Promise<string | undefined>,
): ScreenCapture | undefined {
  const capture = options.screenCapture;
  if (capture === undefined) return undefined;
  const deviceCommand = configuredDeviceCaptureCommand(options) ?? capture.deviceCommand;
  return createIosScreenCapture({
    baseEnvironment: capture.baseEnvironment,
    clock: options.clock,
    command: configuredScreenCaptureCommand(options) ?? capture.command,
    ...(deviceCommand === undefined ? {} : { deviceCommand }),
    deviceOsVersion,
    ...(ownsDeviceSet ? { deviceSet: deviceRoot } : {}),
    filesystem: options.filesystem,
    launcher: capture.launcher,
    ...(capture.onLog === undefined ? {} : { onLog: capture.onLog }),
  });
}

function sameEntries(a: ReadonlyMap<string, boolean>, b: ReadonlyMap<string, boolean>): boolean {
  return a.size === b.size && [...a].every(([label, disabled]) => b.get(label) === disabled);
}

function alreadyShutdown(stderr: string): boolean {
  return /Unable to shutdown.*current state:\s*Shutdown/i.test(stderr);
}

function alreadyBooted(stderr: string): boolean {
  return /current state:\s*Booted|already booted/i.test(stderr);
}

/** why: a seed built on a runtime whose build changed no longer matches it; with no build on either side only the runtime's presence is checked, and a provision always has the runtime. */
function seedIsStale(seed: ReadySeed, resolved: ResolvedIosSpec): boolean {
  const current = resolved.runtime.build;
  return seed.runtimeBuild !== undefined && current !== undefined && seed.runtimeBuild !== current;
}

/** why: the phrase reads after "is stale:" in `doctor`, and is what a person acts on, so it names the runtime or device type by id. */
function sourceStaleReason(row: SourceRow, catalog: SimctlCatalog): string | undefined {
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

function specKey(spec: VirtualSpec): string {
  return `${spec.model.toLocaleLowerCase()}\u0000${spec.osVersion}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export { iosDeviceDataTable } from "./device-data.js";
export { iosSourceDataOwner } from "./source-data.js";
export { iosPrerequisites } from "./prerequisites.js";
export { labelsFor, SLIM_CATEGORIES } from "./slim-labels.js";
