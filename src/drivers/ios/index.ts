import { dirname, join } from "node:path";

import {
  BootTimeoutError,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type ComponentRemoval,
  COMPONENT_REMOVAL_TIMEOUT_MS,
  type ExactDeviceRequest,
  type Driver,
  type DriverAdvisory,
  type DriverToolVersion,
  type DriverCatalogEntry,
  type DriverComponent,
  type DriverDevice,
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
  ProcessResult,
  ProcessRunner,
} from "../../ports/index.js";
import { runBoundedProcess, runInstallerProcess } from "../installer-process.js";
import { devicectlExecCommand } from "./devicectl-exec.js";
import { IosPhysicalHandler } from "./physical.js";
import { createIosScreenCapture } from "./screen-capture.js";
import { labelsFor, resolveSlimCategories, slimSignature } from "./slim-labels.js";

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
const REFUSED_SIMCTL_VERBS = new Set(["create", "erase", "delete"]);

const CALLER_SUPPLIED_SCOPE_FLAGS = new Set(["set", "profiles"]);

const SHUTDOWN_ALL_TARGET = "all";

const RECLAIM_INSTEAD =
  "Use `simlock release` (which reclaims the device for you) or `simlock cleanup` instead.";

// why: Slim mode reboots the device a second time and runs a launchctl-disable pass on top of the
// usual cold boot -- without a dedicated estimate, `doctor`'s provisioning-stall threshold would
// be sized for a single boot and flag every slim device as stuck. Budget: one `COLD_BOOT_ESTIMATE_MS`
// boot, a second one for the post-slim reboot, plus headroom for the chunked `simctl spawn` calls
// (a handful of ~60s-capped chunks that in practice finish in a few seconds each).
const SLIM_BOOT_ESTIMATE_MS = 150_000;
// why: simslim batches ~170 individual `launchctl disable` calls into shell loops rather than one
// `simctl spawn` per label -- at ~150ms/spawn that is well over half a minute of pure process
// overhead per full slim, which would swamp the boot budget above. 50 labels/chunk keeps each
// chunk's own script small (and its timeout comfortably generous) while still cutting spawn count
// by ~50x versus one-label-per-call.
const SLIM_CHUNK_SIZE = 50;
// why: A chunk of 50 `launchctl disable` calls inside a simulator is not instant -- COMMAND_TIMEOUT_MS
// (30s) has been observed to be tight for this under load, so slim chunks get their own, more
// generous budget instead of reusing it.
const SLIM_CHUNK_TIMEOUT_MS = 60_000;
const SLIM_FAILED_MARKER = "simlock-slim-failed";
const SLIM_SCRIPT_PRELUDE = '[ -n "$SIMULATOR_ROOT" ] && export DYLD_ROOT_PATH="$SIMULATOR_ROOT";';
// why: Built from `SLIM_FAILED_MARKER` (rather than a second hardcoded literal) so a change to the
// constant can never silently desync the script that emits the marker from the parser that reads
// it back -- see `#applySlimLabels`.
const SLIM_FAILED_MARKER_PATTERN = new RegExp(`^${SLIM_FAILED_MARKER} (\\S+)$`);
// why: Slim labels are compile-time constants from our own data file (`slim-labels.ts`), so this can
// never actually reject anything in production -- it exists purely as a second line of defense:
// if that data file ever grew a label containing shell metacharacters, this stops it from
// escaping the generated `sh -c` script instead of silently trusting the data.
const SLIM_LABEL_SAFE_PATTERN = /^[A-Za-z0-9._-]+$/;

interface IosDriverData {
  readonly deviceTypeId: string;
  readonly name: string;
  readonly runtimeId: string;
  readonly udid: string;
  readonly slimSignature?: string;
  readonly slimMarkToken?: string;
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
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly processRunner: ProcessRunner;
  readonly simlockHome: string;
  readonly uid?: number;
  readonly coreSimulatorRoot?: string;
  readonly onSlimmed?: (fact: SlimmedFact) => void;
  readonly onSlimSkipped?: (fact: SlimSkippedFact) => void;
  readonly slim?: {
    readonly categories?: readonly string[];
    readonly bootTimeoutMs: number;
  };
  readonly slimByDefault?: boolean;
  // why: absent when this host has no way to run the capture program; the driver then offers no
  // screen at all rather than one that fails on every open.
  readonly screenCapture?: {
    readonly command: string;
    readonly launcher: BytePipeLauncher;
    readonly baseEnvironment: NodeJS.ProcessEnv;
    readonly onLog?: (line: string) => void;
  };
}

type SlimOptions = NonNullable<IosSimctlDriverOptions["slim"]>;

type SlimApplyOutcome =
  | {
      readonly kind: "applied";
      readonly rejectedLabels: readonly string[];
      readonly unattemptedLabels: readonly string[];
    }
  | { readonly kind: "failed"; readonly detail: string };

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
  readonly #rootOptions: EnsureOwnedRootOptions;
  readonly #slim: SlimOptions | undefined;
  readonly #slimByDefault: boolean;

  private constructor(
    options: IosSimctlDriverOptions,
    deviceRoot: string,
    rootOptions: EnsureOwnedRootOptions,
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
    this.#rootOptions = rootOptions;
    this.#slim = options.slim;
    this.#slimByDefault = options.slimByDefault === true;
    this.screenCapture =
      options.screenCapture === undefined
        ? undefined
        : createIosScreenCapture({
            baseEnvironment: options.screenCapture.baseEnvironment,
            clock: options.clock,
            command: configuredScreenCaptureCommand(options) ?? options.screenCapture.command,
            deviceSet: deviceRoot,
            filesystem: options.filesystem,
            launcher: options.screenCapture.launcher,
            ...(options.screenCapture.onLog === undefined
              ? {}
              : { onLog: options.screenCapture.onLog }),
          });
  }

  readonly screenCapture: ScreenCapture | undefined;

  /**
   * why: Establishes the device set this driver owns before it can be asked to do anything,
   * which is why construction is asynchronous: a driver that had not yet proven its root
   * would be a driver that can address devices it cannot prove are Simlock's, and every
   * later `--set` would be pointing at an unvalidated path. An `OwnedRootError` here is
   * the fail-closed path -- the caller skips iOS entirely rather than falling back to the
   * machine's default device set (safety rule 9).
   */
  static async create(options: IosSimctlDriverOptions): Promise<IosSimctlDriver> {
    const rootOptions: EnsureOwnedRootOptions = {
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      path: configuredDeviceRoot(options),
      platform: "ios",
      ...(options.uid === undefined ? {} : { uid: options.uid }),
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
      foreign = devicesPerRuntime(JSON.parse(defaultSet.stdout) as unknown);
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

  async provision(spec: VirtualSpec): Promise<DriverDevice> {
    this.#requireIosPlatform(spec.platform);
    const resolved = await this.#resolvedSpec(spec);
    // why: Cosmetic, and deliberately so: what proves this device is Simlock's is that it
    // lives in the device set every call below is scoped to, never what it is called
    // (safety rule 8). The name exists because it is what a human reads in `simctl list`
    // and in the simulator's window title.
    const name = `simlock-${this.#idGenerator.generate()}`;
    const result = await this.#simctl(
      ["create", name, resolved.deviceType.identifier, resolved.runtime.identifier],
      COMMAND_TIMEOUT_MS,
    );
    const udid = result.stdout.trim();

    if (udid === "") {
      throw new DriverCrashError("simctl create returned no device UDID");
    }

    await this.#writeMark(udid);

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

  async makeReady(
    device: DriverDevice,
    options: { readonly purpose: "prepare" | "recover"; readonly mode: DeviceMode },
  ): Promise<DriverDevice> {
    const data = iosDriverData(device);
    const { plan, bootstatusTimeoutMs } = planSlimBoot(data, this.#slim, options);

    await this.#bootAndWait(data.udid, device.deviceId, bootstatusTimeoutMs);

    if (plan.kind === "skip") {
      this.#onSlimSkipped?.({
        deviceId: device.deviceId,
        detail: plan.detail,
        reason: plan.reason,
      });
    }

    if (plan.kind !== "apply") {
      return this.#asIs(device, data, "full");
    }

    return this.#applySlimAndReboot(device, data, plan.slim, bootstatusTimeoutMs);
  }

  #asIs(device: DriverDevice, data: IosDriverData, mode: DeviceMode): DriverDevice {
    return {
      address: data.udid,
      deviceId: device.deviceId,
      driverData: device.driverData,
      mode,
    };
  }

  async #bootAndWait(udid: string, deviceId: string, bootstatusTimeoutMs: number): Promise<void> {
    const boot = await this.#invokeSimctl(["boot", udid], COMMAND_TIMEOUT_MS);
    if (boot.kind === "timed-out") {
      throw new BootTimeoutError(deviceId);
    }
    if (boot.result.code !== 0 && !alreadyBooted(boot.result.stderr)) {
      this.#assertSuccessful(["boot", udid], boot.result);
    }
    const deadline = this.#clock.now() + bootstatusTimeoutMs;
    const outcome = await this.#invokeSimctl(["bootstatus", udid, "-b"], bootstatusTimeoutMs);

    if (outcome.kind === "finished") {
      this.#assertSuccessful(["bootstatus", udid, "-b"], outcome.result);
      if (await this.#waitForInstaller(udid, deadline)) return;
    }

    await this.#bestEffortShutdown(udid);
    throw new BootTimeoutError(deviceId);
  }

  async #waitForInstaller(udid: string, deadline: number): Promise<boolean> {
    // why: bootstatus can finish before the installer accepts requests after an erase (#547).
    while (this.#clock.now() < deadline) {
      const outcome = await this.#invokeSimctl(
        ["listapps", udid],
        Math.min(COMMAND_TIMEOUT_MS, deadline - this.#clock.now()),
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

  async #applySlimAndReboot(
    device: DriverDevice,
    data: IosDriverData,
    slim: SlimOptions,
    bootstatusTimeoutMs: number,
  ): Promise<DriverDevice> {
    const resolved = resolveSlimCategories(slim.categories);
    if (resolved.categories.length === 0) {
      return this.#skipApply(
        device,
        data,
        `none of the configured slim categories (${(slim.categories ?? []).join(", ")}) are known`,
        "full",
      );
    }

    const signature = slimSignature(resolved.categories);
    const idempotence = await this.#checkAlreadySlimmed(data, signature);
    if (idempotence.alreadySlimmed) {
      return this.#asIs(device, data, "slim");
    }

    const labels = labelsFor(resolved.categories);
    const startedAt = this.#clock.now();
    const applyOutcome = await this.#applySlimLabels(data.udid, labels);
    if (applyOutcome.kind === "failed") {
      return this.#skipApply(device, data, applyOutcome.detail, "full");
    }

    // why: The reboot below is what makes the disable entries take effect; never write the
    // idempotence marker or report `device.slimmed` on a device that hasn't actually rebooted
    // with them applied. `makeReady`'s own contract ("a failed or skipped slim never fails the
    // lease") holds here too: a hiccup here must downgrade to the skip path rather than fail a
    // lease that would otherwise have worked -- but the shutdown call's own outcome is never a
    // reliable signal of what the device is actually doing (see below), so it is captured, not
    // acted on directly.
    let shutdownError: unknown;
    try {
      await this.#shutdown(data.udid);
    } catch (error: unknown) {
      shutdownError = error;
    }
    // why: Always re-establish a known-good running device, whether or not the shutdown above actually
    // completed. `#shutdown` throws on a *timeout* of `simctl shutdown`, which is exactly the
    // moment the shutdown is most likely to still be in progress or to have already finished --
    // there is no reliable way to tell which from the exception alone, so this stops guessing:
    // `boot` already tolerates an already-booted device, so the boot below reaches a known-good
    // running device either way. A genuine inability to get it running again propagates as
    // `BootTimeoutError` / `DriverCrashError`, as it should -- that case really does mean the
    // device is left shut down, not "ready" as returning it would falsely claim.
    await this.#bootAndWait(data.udid, device.deviceId, bootstatusTimeoutMs);

    if (shutdownError !== undefined) {
      // why: The shutdown call itself failed, so whether the labels' reboot actually took effect is
      // unknown -- this is an uncertain apply, not a confirmed one. Never write the idempotence
      // marker on it (same reasoning as the partial-apply case below), and report "slim" (not
      // "full") under that uncertainty: telling a caller a device is slim when it is not is
      // benign -- it just avoids features it could have used -- while telling it a device is full
      // when it is not makes push / Spotlight / StoreKit fail with no explanation, exactly the
      // confusion the `slim` flag exists to prevent.
      return this.#skipApply(
        device,
        data,
        `slim shutdown failed: ${errorMessage(shutdownError)}`,
        "slim",
      );
    }

    if (applyOutcome.unattemptedLabels.length > 0) {
      // why: Partial apply: at least one chunk failed to run outright, so those labels were never even
      // attempted. The reboot above already happened -- the labels that did apply are worth
      // keeping -- but the idempotence marker must NOT be written: writing it here would
      // permanently mark this device "slim" (see `#checkAlreadySlimmed`) even though part of the
      // disable list never took effect, and every later boot would then trust the marker and
      // never retry the labels that were never attempted, with no way back short of
      // `reclaim`/`erase`. So a partial apply deliberately costs a re-attempt of the *whole*
      // label set on the next `makeReady` instead -- applying an already-disabled label again is
      // harmless (same comment on `#checkAlreadySlimmed`). "slim" because the labels that did
      // apply really are gone.
      return this.#skipApply(
        device,
        data,
        `${String(applyOutcome.unattemptedLabels.length)} of ${String(labels.length)} labels were never attempted (a chunk failed to run)`,
        "slim",
      );
    }

    // why: Every chunk ran (individual labels may still have been rejected by the script itself, or
    // filtered by `sanitizeSlimLabels` -- `rejectedLabels`, which is permanent, ADR point 8's
    // "log and continue" case). That is not grounds to withhold the marker: doing so would make a
    // runtime with one permanently-unknown daemon re-apply the whole label set on every boot,
    // forever, and never converge. The rejected labels travel in `SlimmedFact.unknownLabels`
    // instead.
    return this.#commitSlim(
      device,
      data,
      resolved,
      labels,
      signature,
      idempotence.currentToken,
      startedAt,
      applyOutcome,
    );
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

  async #checkAlreadySlimmed(
    data: IosDriverData,
    signature: string,
  ): Promise<{ readonly alreadySlimmed: boolean; readonly currentToken: string | undefined }> {
    // why: Derived from the owned device set rather than looked up, so unlike the pre-ADR-0001
    // `simctl list` path it can never come back undefined -- only the token read can.
    const currentToken = await this.#readToken(join(this.#dataPathFor(data.udid), MARK_FILE_NAME));

    const alreadySlimmed =
      data.slimSignature !== undefined &&
      currentToken !== undefined &&
      data.slimMarkToken !== undefined &&
      data.slimSignature === signature &&
      data.slimMarkToken === currentToken;

    return { alreadySlimmed, currentToken };
  }

  #commitSlim(
    device: DriverDevice,
    data: IosDriverData,
    resolved: ReturnType<typeof resolveSlimCategories>,
    labels: readonly string[],
    signature: string,
    currentToken: string | undefined,
    startedAt: number,
    applyOutcome: Extract<SlimApplyOutcome, { readonly kind: "applied" }>,
  ): DriverDevice {
    const newDriverData: Record<string, unknown> = {
      ...(isRecord(device.driverData) ? device.driverData : {}),
      slimSignature: signature,
      // why: `currentToken` was read from the erasable mark *before* this reboot -- a reboot alone
      // never touches the mark (only `provision`/`reclaim` rewrite it), so re-reading afterward
      // would just repeat the same value at the cost of another filesystem round trip.
      ...(currentToken === undefined ? {} : { slimMarkToken: currentToken }),
    };

    this.#onSlimmed?.({
      address: data.udid,
      categories: resolved.categories.map((category) => category.name),
      deviceId: device.deviceId,
      durationMs: this.#clock.now() - startedAt,
      labelCount: labels.length,
      signature,
      unknownLabels: [...resolved.unknown, ...applyOutcome.rejectedLabels],
    });

    return {
      address: data.udid,
      deviceId: device.deviceId,
      driverData: newDriverData,
      mode: "slim",
    };
  }

  async #applySlimLabels(udid: string, labels: readonly string[]): Promise<SlimApplyOutcome> {
    const { safe, rejected } = sanitizeSlimLabels(labels);
    if (safe.length === 0) {
      return { detail: "no labels passed the shell-safety filter", kind: "failed" };
    }

    const chunks = chunk(safe, SLIM_CHUNK_SIZE);
    // why: `sanitizeSlimLabels`-filtered labels never reached any chunk, so they were rejected the
    // same way an individual `simlock-slim-failed` line is -- not merely "unattempted" (that's
    // reserved for a whole chunk that failed to run).
    const rejectedLabels: string[] = [...rejected];
    const unattemptedLabels: string[] = [];
    let anyChunkSucceeded = false;
    // why: Why the most recent failed chunk failed, so a skip that drops the whole slim pass says
    // what simctl actually reported rather than only that something went wrong.
    let lastChunkFailure = "";

    for (const chunkLabels of chunks) {
      // why: `DYLD_ROOT_PATH` is what makes a bare `launchctl` inside the simulator load the
      // *simulator's* dyld shared cache; `simctl spawn` sets it for the process it starts, but
      // dyld strips `DYLD_*` from the environment of a platform binary such as `/bin/sh`, so
      // every child `launchctl` the script runs would otherwise die with an abort trap
      // (verified on iOS 26.4 and 27.0 simulators). Re-exporting it from `SIMULATOR_ROOT`
      // (which survives) is exactly what simslim's own batch script does first.
      const script =
        `${SLIM_SCRIPT_PRELUDE} for l in ${chunkLabels.join(" ")}; do launchctl disable "system/$l" ` +
        `>/dev/null 2>&1 || echo "${SLIM_FAILED_MARKER} $l"; done`;
      const outcome = await this.#invokeSimctl(
        ["spawn", udid, "/bin/sh", "-c", script],
        SLIM_CHUNK_TIMEOUT_MS,
      );

      if (outcome.kind === "timed-out" || outcome.result.code !== 0) {
        unattemptedLabels.push(...chunkLabels);
        lastChunkFailure = describeFailedChunk(outcome);
        continue;
      }

      anyChunkSucceeded = true;
      for (const line of outcome.result.stdout.split("\n")) {
        const match = SLIM_FAILED_MARKER_PATTERN.exec(line.trim());
        if (match?.[1] !== undefined) {
          rejectedLabels.push(match[1]);
        }
      }
    }

    if (!anyChunkSucceeded) {
      return {
        detail: `all ${String(chunks.length)} chunk(s) failed to run; last: ${lastChunkFailure}`,
        kind: "failed",
      };
    }

    return { kind: "applied", rejectedLabels, unattemptedLabels };
  }

  async reclaim(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult> {
    if (isPhysicalDriverDevice(device)) return this.#physical.reclaim(device);
    const data = iosDriverData(device);
    await this.#shutdown(data.udid);
    await this.#simctl(["erase", data.udid], COMMAND_TIMEOUT_MS);
    await this.#writeMark(data.udid);

    return { state: "shutdown", strategy: "erase" };
  }

  reclaimStrategy(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): "erase" | "uninstall" {
    return isPhysicalDriverDevice(device) ? "uninstall" : "erase";
  }

  async shutdown(device: DriverDevice): Promise<void> {
    await this.#shutdown(iosDriverData(device).udid);
  }

  async destroy(device: DriverDevice): Promise<void> {
    const data = iosDriverData(device);
    await this.#shutdown(data.udid);
    await this.#simctl(["delete", data.udid], COMMAND_TIMEOUT_MS);
  }

  async findLegacy(driverDeviceId: string): Promise<LegacyDevice | undefined> {
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
  }

  // fallow-ignore-next-line unused-class-member -- called through the Driver interface by the leasing watcher.
  async listPresentPhysical(enrolledIds: readonly string[]): Promise<readonly PresentPhysical[]> {
    return this.#physical.listPresent(enrolledIds);
  }

  async inspectPhysical(id: string): Promise<PhysicalInspection> {
    return this.#physical.inspect(id);
  }

  async listManaged(): Promise<DriverReality> {
    const result = await this.#simctl(["list", "-j", "devices"], COMMAND_TIMEOUT_MS);
    const parsed = parseManagedDevices(JSON.parse(result.stdout) as unknown);
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
        // why: A slim device pays for a second boot plus a launchctl-disable pass on top of the usual
        // one -- quoting the plain cold-boot number here would make `doctor` flag every slim
        // device as stalled. A full spec never slims, so quoting the slim number to it would
        // make `doctor` flag a perfectly on-time full boot as stalled instead.
        return this.#slim !== undefined && spec.mode === "slim"
          ? SLIM_BOOT_ESTIMATE_MS
          : COLD_BOOT_ESTIMATE_MS;
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
    return { SIMLOCK_IOS_DEVICE_SET: this.#deviceRoot };
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
    if (device !== undefined && isPhysicalDriverDevice(device)) {
      throw new PassthroughRefusedError(
        tool,
        "Refusing `simctl`: it serves simulators, and this lease holds a physical device. Use `devicectl`.",
      );
    }
    this.#assertProxyable(args);
    // why: No environment: simctl ignores every variable that could carry the device set.
    return await Promise.resolve({
      args: ["simctl", "--set", this.#deviceRoot, ...args],
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
    if (verb === "runtime" && operands.find((operand) => !operand.startsWith("-")) === "delete") {
      this.#refuse(
        "runtime delete",
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
    try {
      const contents = await this.#filesystem.readFile(path);
      const parsed = JSON.parse(contents) as unknown;
      return isRecord(parsed) && typeof parsed.token === "string" && parsed.token !== ""
        ? parsed.token
        : undefined;
    } catch {
      return undefined;
    }
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

  async #shutdown(udid: string): Promise<void> {
    const outcome = await this.#invokeSimctl(["shutdown", udid], COMMAND_TIMEOUT_MS);

    if (outcome.kind === "timed-out") {
      throw new DriverCrashError(`simctl shutdown ${udid} timed out after ${COMMAND_TIMEOUT_MS}ms`);
    }
    if (outcome.result.code !== 0 && !alreadyShutdown(outcome.result.stderr)) {
      this.#assertSuccessful(["shutdown", udid], outcome.result);
    }
  }

  async #bestEffortShutdown(udid: string): Promise<void> {
    try {
      await this.#shutdown(udid);
    } catch {
      // why: Boot failure cleanup must not obscure the timeout that triggered it.
    }
  }

  async #simctl(args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return this.#checked(args, timeoutMs, await this.#invokeSimctl(args, timeoutMs));
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

  #scopedSimctlArgv(args: readonly string[]): string[] {
    return ["simctl", "--set", this.#deviceRoot, ...args];
  }

  async #invokeSimctl(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    return this.#invokeXcrun(this.#scopedSimctlArgv(args), timeoutMs);
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

function configuredScreenCaptureCommand(options: IosSimctlDriverOptions): string | undefined {
  const configured = options.driverConfig["screenCaptureCommand"];
  return typeof configured === "string" && configured !== "" ? configured : undefined;
}

function configuredDeviceRoot(options: IosSimctlDriverOptions): string {
  const configured = options.driverConfig["deviceRoot"];

  if (configured !== undefined && typeof configured !== "string") {
    // why: A `deviceRoot` that is not a usable path refuses this platform's *configuration*,
    // which costs iOS and nothing else -- the same as every other refusal here. It is not
    // a daemon-fatal error: `"deviceRoot": true` and `"deviceRoot": "devices/ios"` are one
    // keystroke apart, and killing the process over the first would take Android down with
    // it and leave the reason unreachable, since `doctor` -- where `docs/CLI.md` promises
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

function devicesPerRuntime(value: unknown): ReadonlyMap<string, DefaultSetDevices> {
  if (!isRecord(value) || !isRecord(value.devices)) {
    throw new DriverCrashError("Invalid simctl device list JSON");
  }
  return new Map(
    Object.entries(value.devices).map(([runtime, devices]): [string, DefaultSetDevices] => {
      const entries: readonly unknown[] = Array.isArray(devices) ? devices : [];
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
    // why: Both are optional and post-date `state.json` registries written before slim mode
    // shipped -- absent or wrong-typed is tolerated (ignored) rather than rejected, so an old
    // registry keeps loading (compatibility requirement). A `full` key an older daemon stamped
    // here is not read: the spec's mode is the only record of it (ADR 0007 §7).
    ...(typeof value.slimSignature === "string" ? { slimSignature: value.slimSignature } : {}),
    ...(typeof value.slimMarkToken === "string" ? { slimMarkToken: value.slimMarkToken } : {}),
  };
}

export function iosRuntimeVersionFromId(runtimeId: string): readonly [number, number] | undefined {
  const match = /iOS-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(runtimeId);
  if (match === null) {
    return undefined;
  }
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return undefined;
  }
  return [major, minor];
}

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

export function sanitizeSlimLabels(labels: readonly string[]): {
  readonly safe: readonly string[];
  readonly rejected: readonly string[];
} {
  const safe: string[] = [];
  const rejected: string[] = [];
  for (const label of labels) {
    (SLIM_LABEL_SAFE_PATTERN.test(label) ? safe : rejected).push(label);
  }
  return { rejected, safe };
}

function describeFailedChunk(outcome: ProcessOutcome): string {
  if (outcome.kind === "timed-out") {
    return `timed out after ${String(SLIM_CHUNK_TIMEOUT_MS)}ms`;
  }
  return `exit ${String(outcome.result.code)}: ${outcome.result.stderr.trim()}`;
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function alreadyShutdown(stderr: string): boolean {
  return /Unable to shutdown.*current state:\s*Shutdown/i.test(stderr);
}

function alreadyBooted(stderr: string): boolean {
  return /current state:\s*Booted|already booted/i.test(stderr);
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
export { iosPrerequisites } from "./prerequisites.js";
export { labelsFor, SLIM_CATEGORIES } from "./slim-labels.js";
