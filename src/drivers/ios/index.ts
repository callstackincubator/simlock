import { dirname, join } from "node:path";

import {
  BootTimeoutError,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type ComponentRemoval,
  COMPONENT_REMOVAL_TIMEOUT_MS,
  type DeviceRequest,
  type Driver,
  type DriverAdvisory,
  type DriverToolVersion,
  type DriverCatalogEntry,
  type DriverComponent,
  type DriverDevice,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  type InstalledComponent,
  type LegacyDevice,
  type ObservedDevice,
  OwnedRootError,
  type PassthroughCommand,
  PassthroughRefusedError,
  type ObservedRunState,
  removeListedComponent,
  RuntimeMissingError,
  sameReceipt,
  UnknownModelError,
  UnsupportedRequestOptionError,
} from "../../core/index.js";
import type { ObservedMark } from "../../core/driver.js";
import type { DeviceMode, DeviceSpec } from "../../core/index.js";
import type {
  Clock,
  Filesystem,
  IdGenerator,
  ProcessResult,
  ProcessRunner,
} from "../../ports/index.js";
import { runBoundedProcess, runInstallerProcess } from "../installer-process.js";
import { labelsFor, resolveSlimCategories, slimSignature } from "./slim-labels.js";

const COMMAND_TIMEOUT_MS = 30_000;
// `xcodebuild -version` answers in about a second; a first run after an Xcode update can take
// longer while it checks its components, and a hang must not hold host facts forever.
const XCODE_VERSION_TIMEOUT_MS = 15_000;
const BOOTSTATUS_TIMEOUT_MS = 120_000;
const PROVISION_ESTIMATE_MS = 500;
// How often a removal lists again while `simctl runtime list` shows the deleted image as still
// being deleted, which it does for a few seconds after `simctl runtime delete` answers (#259).
const DELETING_POLL_MS = 1_000;
// This driver's word for "the newest runtime Apple offers": a bare `xcodebuild -downloadPlatform
// iOS`. Not a version, so `findComponent` never finds it (ADR 0010 §2).
const LATEST_COMPONENT = "latest";
// `simctl`'s `minRuntimeVersion` / `maxRuntimeVersion` encode "no bound" as 0xFFFFFF
// (255.255.255) rather than omitting the field.
const UNBOUNDED_VERSION = 0xff_ff_ff;
// `xcodebuild -downloadPlatform iOS -buildVersion` only reaches back to iOS 16.0 (Xcode
// 16.1+); older runtimes must be installed through Xcode itself.
const IOS_DOWNLOAD_FLOOR: readonly [number, number, number] = [16, 0, 0];
// Conservative estimate for a simulator runtime download+install (~7 GB observed, rounded up
// with headroom) -- reserved by `ComponentInstaller` before `xcodebuild -downloadPlatform` ever
// starts, so a full disk fails fast instead of filling up mid-download.
const IOS_RUNTIME_MIN_FREE_BYTES = 8 * 1024 ** 3;
// Where macOS's own asset daemon keeps every simulator runtime it has ever downloaded, one
// `<uuid>.asset` bundle per build. `simctl runtime delete` only unregisters a runtime from
// CoreSimulator; the bundle it was mounted from stays here, marked never-collected, spending
// the same free space `IOS_RUNTIME_MIN_FREE_BYTES` measures. Nothing Simlock may do can
// reclaim it (issue #79), so the driver only ever reads this path.
const IOS_RUNTIME_ASSET_ROOT = "/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime";
// Observed size of one downloaded runtime bundle, for an advisory that must not stat the
// store: a `du` over three bundles is tens of gigabytes of directory walking per doctor run.
const IOS_RUNTIME_ASSET_APPROX_SIZE = "roughly 7-8 GiB";
// A cold `simctl boot` to `bootstatus` measures roughly 30s on a fast, idle machine and up to
// a minute on a loaded or slower one. The upper end is the estimate, deliberately: this number
// is what a waiting requester is quoted, and quoting 30s to someone who then waits 60s is the
// failure mode #56 is about. The cost is that `Doctor`'s `provisioning` stall threshold widens
// with it -- see the note there on why that is the cheaper of the two errors.
const COLD_BOOT_ESTIMATE_MS = 60_000;
// Measured, not guessed: a single `simctl erase` took ~34s in #43's investigation. Unlike
// Android, iOS has no deferred-wipe path -- `erase` is synchronous and every reclaim pays it,
// at either clean level, so this is the only reclaim number the driver has.
const ERASE_ESTIMATE_MS = 34_000;
const MARK_FILE_NAME = "simlock-mark.json";
/**
 * The `simlock <tool>` wrapper this driver answers to. Published as a constant because a
 * driver that refused to start has no instance to ask, and `DriverRejection` carries the
 * name so `simlock simctl` can say why it is unavailable rather than reading as a missing
 * SDK.
 */
export const IOS_PASSTHROUGH_TOOL = "simctl";

/**
 * Verbs `simlock simctl` will not proxy. Every one of them changes a device's lifecycle,
 * which the registry -- not `simctl` -- is the record of: a device created here has no
 * registry entry and reads as an orphan, and one erased or deleted under a live lease
 * reads as tampering on the next reconcile. Injecting `--set` for them would hand back
 * exactly the capability the device set exists to take away (ADR 0001, decision 7).
 */
const REFUSED_SIMCTL_VERBS = new Set(["create", "erase", "delete"]);

/**
 * simctl's usage is `simctl [--set <path>] [--profiles <path>] <subcommand>`, so these are
 * the only two globals whose value is a separate argv entry -- and a separated value is
 * indistinguishable from a subcommand once it is in the array, which is how
 * `--profiles /tmp erase all` used to read as the subcommand `/tmp` and slide past every
 * refusal below. Refusing them is what makes "the first non-flag argument is the
 * subcommand" true by construction rather than by pattern-matching. It is also right on
 * its own terms: this wrapper exists to supply the device set, and a caller-supplied one
 * would aim Simlock's own containment wherever it pointed.
 */
const CALLER_SUPPLIED_SCOPE_FLAGS = new Set(["set", "profiles"]);

/**
 * `shutdown all` is the iOS analogue of `adb kill-server`: it stops every device in the
 * set, for every agent, and each affected lease then spends its recovery budget rebooting
 * -- one that runs out ends as `lease_lost`. Shutting down a single device stays allowed.
 */
const SHUTDOWN_ALL_TARGET = "all";

/** Every lifecycle refusal ends the same way: the Simlock command that does it safely. */
const RECLAIM_INSTEAD =
  "Use `simlock release` (which reclaims the device for you) or `simlock cleanup` instead.";

// Slim mode reboots the device a second time and runs a launchctl-disable pass on top of the
// usual cold boot -- without a dedicated estimate, `doctor`'s provisioning-stall threshold would
// be sized for a single boot and flag every slim device as stuck. Budget: one `COLD_BOOT_ESTIMATE_MS`
// boot, a second one for the post-slim reboot, plus headroom for the chunked `simctl spawn` calls
// (a handful of ~60s-capped chunks that in practice finish in a few seconds each).
const SLIM_BOOT_ESTIMATE_MS = 150_000;
// simslim batches ~170 individual `launchctl disable` calls into shell loops rather than one
// `simctl spawn` per label -- at ~150ms/spawn that is well over half a minute of pure process
// overhead per full slim, which would swamp the boot budget above. 50 labels/chunk keeps each
// chunk's own script small (and its timeout comfortably generous) while still cutting spawn count
// by ~50x versus one-label-per-call.
const SLIM_CHUNK_SIZE = 50;
// A chunk of 50 `launchctl disable` calls inside a simulator is not instant -- COMMAND_TIMEOUT_MS
// (30s) has been observed to be tight for this under load, so slim chunks get their own, more
// generous budget instead of reusing it.
const SLIM_CHUNK_TIMEOUT_MS = 60_000;
const SLIM_FAILED_MARKER = "simlock-slim-failed";
/** See the comment in `#applySlimLabels`; must stay in sync with the test's `slimScript`. */
const SLIM_SCRIPT_PRELUDE = '[ -n "$SIMULATOR_ROOT" ] && export DYLD_ROOT_PATH="$SIMULATOR_ROOT";';
// Built from `SLIM_FAILED_MARKER` (rather than a second hardcoded literal) so a change to the
// constant can never silently desync the script that emits the marker from the parser that reads
// it back -- see `#applySlimLabels`.
const SLIM_FAILED_MARKER_PATTERN = new RegExp(`^${SLIM_FAILED_MARKER} (\\S+)$`);
// Slim labels are compile-time constants from our own data file (`slim-labels.ts`), so this can
// never actually reject anything in production -- it exists purely as a second line of defense:
// if that data file ever grew a label containing shell metacharacters, this stops it from
// escaping the generated `sh -c` script instead of silently trusting the data.
const SLIM_LABEL_SAFE_PATTERN = /^[A-Za-z0-9._-]+$/;

interface IosDriverData {
  readonly deviceTypeId: string;
  readonly name: string;
  readonly runtimeId: string;
  readonly udid: string;
  /** `slimSignature(...)` of the label set actually applied -- the idempotence marker. */
  readonly slimSignature?: string;
  /** The device's *erasable* provenance-mark token as read at the moment slimming was applied. */
  readonly slimMarkToken?: string;
}

/** Fact reported to the daemon layer once a slim reboot has committed (`onSlimmed`). */
export interface SlimmedFact {
  readonly deviceId: string;
  readonly address: string;
  readonly categories: readonly string[];
  readonly labelCount: number;
  readonly durationMs: number;
  readonly signature: string;
  /**
   * Category names `resolveSlimCategories` didn't recognize, plus individual launchd labels a
   * chunk reported via `simlock-slim-failed` -- neither is fatal (ADR point 8), both are worth
   * surfacing.
   */
  readonly unknownLabels: readonly string[];
}

/** Fact reported when a device that should have been slimmed wasn't. */
export interface SlimSkippedFact {
  readonly deviceId: string;
  readonly reason: "runtime-too-old" | "unknown-runtime" | "apply-failed";
  readonly detail: string;
}

export interface IosSimctlDriverOptions {
  readonly clock: Clock;
  /** This driver's own `drivers.ios` block, handed over unread by the core. */
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  /** Identity every device root's ownership marker is checked against. */
  readonly instanceId: string;
  readonly processRunner: ProcessRunner;
  /** `SIMLOCK_HOME`, from which the default device root is derived here rather than in the core. */
  readonly simlockHome: string;
  /** `process.getuid?.()`; `undefined` skips the root's ownership check. */
  readonly uid?: number;
  /**
   * Volume a runtime download actually lands on, stated in `componentFootprint` -- simulator
   * runtimes install under `~/Library/Developer/CoreSimulator`, which is not necessarily the
   * same volume as the daemon's working directory. Defaults to `"."` (the daemon process's own
   * volume) only when nothing better is available, mirroring the Android driver's use of
   * `sdk.root`.
   */
  readonly coreSimulatorRoot?: string;
  /**
   * Reports the `device.slimmed` fact for the daemon layer to bridge onto the event bus -- this
   * driver never depends on the bus directly (architecture rule 5).
   */
  readonly onSlimmed?: (fact: SlimmedFact) => void;
  /** Reports why a slim-spec device was not slimmed. Mirrors `onSlimmed`. */
  readonly onSlimSkipped?: (fact: SlimSkippedFact) => void;
  /**
   * How a slim device is made (`ios.slim`). Omitted means this driver slims nothing: every slim
   * request resolves to a full spec.
   */
  readonly slim?: {
    readonly categories?: readonly string[];
    readonly bootTimeoutMs: number;
  };
  /**
   * True when the worker's default mode for iOS is `slim`, so `advisories()` reports runtimes
   * that cannot be slimmed (ADR 0007 §14). The driver is told this, never the default itself.
   */
  readonly slimByDefault?: boolean;
}

type SlimOptions = NonNullable<IosSimctlDriverOptions["slim"]>;

/**
 * Result of `#applySlimLabels`: either every chunk was attempted (individual labels may still
 * have been rejected, tracked separately below), or the whole apply never ran.
 *
 * The "applied" variant deliberately splits two very different kinds of not-fully-applied into
 * separate fields rather than one bag:
 * - `rejectedLabels`: the in-simulator script itself rejected this label (a `simlock-slim-failed`
 *   line), or `sanitizeSlimLabels` filtered it before the script ever ran. This is ADR point 8's
 *   "log and continue" case, and it is PERMANENT -- the daemon that owns this label is gone or
 *   renamed on this runtime, and retrying on every boot would never change that outcome. It must
 *   NOT block writing the idempotence marker (see `#applySlimAndReboot`), or a runtime with one
 *   permanently-unknown daemon would re-apply the whole label set forever and never converge.
 * - `unattemptedLabels`: a whole chunk timed out or exited nonzero, so those labels were never
 *   attempted at all. This is transient (the daemon script itself never ran) and MUST be retried,
 *   which is why it blocks the idempotence marker.
 */
type SlimApplyOutcome =
  | {
      readonly kind: "applied";
      readonly rejectedLabels: readonly string[];
      readonly unattemptedLabels: readonly string[];
    }
  | { readonly kind: "failed"; readonly detail: string };

interface DeviceType {
  readonly identifier: string;
  readonly name: string;
  /** Decoded `0xAABBCC` -> `[AA, BB, CC]`; simctl's inclusive lower bound on pairable runtimes. */
  readonly minRuntimeVersion: number;
  /** Same encoding; `UNBOUNDED_VERSION` means "no upper bound". */
  readonly maxRuntimeVersion: number;
}

interface Runtime {
  readonly identifier: string;
  readonly name: string;
  readonly version: string;
  /**
   * The exact build simctl reports for this runtime (`buildversion`), when it reports one.
   * Two runtimes can share a marketing `version`, so this is what identifies which download
   * a runtime is mounted from -- and it is optional because an older simctl omits the key.
   */
  readonly build?: string;
  readonly isAvailable: boolean;
  /** Device type identifiers this runtime pairs with -- authoritative once the runtime is installed. */
  readonly supportedDeviceTypeIds: ReadonlySet<string>;
}

/** One downloaded runtime bundle in the OS asset store, identified by its own metadata. */
interface RuntimeAsset {
  /** `MobileAssetProperties.SimulatorVersion` -- the marketing version, for the operator. */
  readonly version: string;
  /** `MobileAssetProperties.Build` -- what says which runtime this bundle actually holds. */
  readonly build: string;
}

interface SimctlCatalog {
  readonly deviceTypes: readonly DeviceType[];
  readonly runtimes: readonly Runtime[];
}

interface ResolvedIosSpec {
  readonly deviceType: DeviceType;
  readonly runtime: Runtime;
  readonly spec: DeviceSpec;
}

type ProcessOutcome =
  | { readonly kind: "finished"; readonly result: ProcessResult }
  | { readonly kind: "timed-out" };

/** iOS simulator implementation. Its simctl details remain opaque to the core. */
export class IosSimctlDriver implements Driver {
  readonly platform = "ios" as const;
  readonly #clock: Clock;
  readonly componentFootprint: { readonly path: string; readonly bytes: number };
  readonly #filesystem: Filesystem;
  readonly #idGenerator: IdGenerator;
  readonly #onSlimmed: ((fact: SlimmedFact) => void) | undefined;
  readonly #onSlimSkipped: ((fact: SlimSkippedFact) => void) | undefined;
  readonly #processRunner: ProcessRunner;
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
    this.#deviceRoot = deviceRoot;
    this.#rootOptions = rootOptions;
    this.#slim = options.slim;
    this.#slimByDefault = options.slimByDefault === true;
  }

  /**
   * Establishes the device set this driver owns before it can be asked to do anything,
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
   * The same call `create` made, with the same arguments, because the proof *is* that call:
   * a cheaper second check here would be a second validator, free to drift from the one
   * every start is judged by. It is asked for immediately before Simlock destroys anything
   * inside this set, since between then and startup the path can have become a symlink, or
   * a `mv` can have left the user's own device set standing where this one was.
   */
  async revalidateRoot(): Promise<void> {
    await ensureOwnedRoot(this.#rootOptions);
  }

  /**
   * Never downloads: a runtime a download could supply throws, naming it as the component. An iOS
   * runtime comes in one type, so a request naming an image tag is refused.
   */
  async resolveSpec(request: DeviceRequest): Promise<DeviceSpec> {
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
    // The resolution cache (`specKey`) ignores the mode, so the mode is applied here, outside it.
    return request.mode === "slim" && this.#canSlim(spec) ? { ...spec, mode: "slim" } : spec;
  }

  /**
   * Whether this driver will slim a device of this spec: slim is configured and the runtime is
   * 18.5 or newer (ADR 0007 §4). Read from the runtime `resolveSpec` just committed, by the same
   * `supportsPersistentSlim(iosRuntimeVersionFromId(...))` call `planSlimBoot` makes.
   */
  #canSlim(spec: DeviceSpec): boolean {
    const runtime = this.#resolvedSpecs.get(specKey(spec))?.runtime;
    return (
      this.#slim !== undefined &&
      runtime !== undefined &&
      supportsPersistentSlim(iosRuntimeVersionFromId(runtime.identifier))
    );
  }

  /**
   * Version requested explicitly: validated against the model's `[min, max]` pairing range
   * *before* anything else -- an out-of-range request can never be fixed by downloading, so it
   * is never reported as downloadable.
   */
  #resolveExactRuntime(
    deviceType: DeviceType,
    osVersion: string,
    catalog: SimctlCatalog,
  ): DeviceSpec {
    if (!isVersionInRange(osVersion, deviceType)) {
      throw new IosVersionOutOfRangeError(deviceType.name, osVersion, deviceType);
    }

    // Looked up among the runtimes the catalog lists for this model, so a listed pair always
    // resolves and an unlisted one never does (ADR 0008 §3). Any installed build of the version
    // that pairs will do: two builds can share a marketing version and pair differently.
    const paired = findPairedRuntime(catalog, deviceType, osVersion);
    if (paired !== undefined) {
      return this.#commitResolution(deviceType, paired);
    }
    // Installed but not paired: in the model's declared `[min, max]` range is necessary but not
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

  /**
   * No version requested: defaults to the newest *installed* runtime that both falls in the
   * model's range and actually pairs with it (`supportedDeviceTypes`) -- not the newest
   * installed runtime overall, which may have dropped this model (iOS 26 dropping iPhone
   * XS/XR support is the motivating case). With none, the component to install is `latest`
   * when the model's range has no upper bound, and the bare major of its upper bound otherwise.
   */
  #resolveDefaultRuntime(deviceType: DeviceType, catalog: SimctlCatalog): DeviceSpec {
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

  #commitResolution(deviceType: DeviceType, runtime: Runtime): DeviceSpec {
    const spec: DeviceSpec = {
      model: deviceType.name,
      osVersion: runtime.version,
      platform: this.platform,
    };
    this.#resolvedSpecs.set(specKey(spec), { deviceType, runtime, spec });
    return spec;
  }

  /**
   * The installed runtime of exactly this version, with its receipt. `latest` and a bare major
   * are not versions the catalog lists, so they are never found here: only an install run can
   * say what they resolve to.
   */
  async findComponent(component: string): Promise<InstalledComponent | undefined> {
    const [catalog, images] = await Promise.all([this.#loadCatalog(), this.#loadRuntimeImages()]);
    const runtime = findInstalledRuntime(catalog, component);
    return runtime === undefined ? undefined : installedComponent(runtime, images);
  }

  /**
   * Runs `xcodebuild -downloadPlatform iOS [-buildVersion <component>]` and verifies the result
   * against a fresh catalog. `latest` asks for the newest runtime Apple offers; a bare major
   * (the bounded default) for the newest of that major; anything else for that exact version,
   * which must not predate `IOS_DOWNLOAD_FLOOR`. `xcodebuild` has no timeout of its own and
   * ends when `signal` fires.
   */
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

  /**
   * One entry per iOS runtime image `simctl runtime list -j` reports: its version, its size, its
   * build as the variant, and the receipt `findComponent` and `installComponent` build for the
   * runtime it provides. `foreignDevices` counts the devices in the machine's default device set
   * whose runtime is the image's and that have been used at least once (`devicesPerRuntime`);
   * that read is an unscoped `simctl list`, which mutates nothing.
   * An image that reports no version names no component and is left out.
   */
  async listComponents(): Promise<readonly DriverComponent[]> {
    return (await this.#listedImages()).map(
      ({ image: _image, unusedDevices: _unused, ...component }) => component,
    );
  }

  /**
   * Removes the runtime image whose receipt this is with `simctl runtime delete <image>` -- no
   * `--keep-asset`, so CoreSimulator is asked to let go of its download too -- through the steps
   * every driver takes (`removeListedComponent`): refused when a used device in the machine's
   * default set has its runtime, verified gone afterwards. Never-used default-set devices of the
   * runtime, counted in the listing taken before the delete, do not block it; they become
   * unavailable and stay where they are, and `residue` says how many and how to clear them. When
   * the download is still in the macOS asset store afterwards (#79), `residue` says that too.
   * Nothing is written to the default set: Simlock never deletes a simulator or a file there.
   *
   * `simctl runtime delete` can answer while the image is still listed as being deleted (#259),
   * so the removal waits for that state to end before it is verified (`#waitWhileDeleting`).
   * The delete and the wait share one budget, `COMPONENT_REMOVAL_TIMEOUT_MS` from the start of
   * the delete.
   */
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

  /**
   * `simctl runtime delete <image>`, scoped like every other call, through the same bounded
   * runner the Android removal uses: it ends at `COMPONENT_REMOVAL_TIMEOUT_MS` or when `signal`
   * fires, `SIGTERM` then `SIGKILL`, and answers only once the process has exited.
   */
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

  /**
   * Lists the runtime images every `DELETING_POLL_MS` while the image `identifier` is listed as
   * being deleted (`isBeingDeleted`), and answers once it is gone or listed in any other state;
   * `removeListedComponent`'s check then decides. Still being deleted at `deadline`, or when
   * `signal` fires, is `DriverCrashError`, so the removal fails and the record is kept.
   */
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

  /** Answers `true` after `delayMs` on the clock, or `false` as soon as `signal` fires. */
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

  /**
   * What `removeComponent` reports when the removed image's download is still in the asset
   * store: matched by build, or by version for an image that names no build.
   */
  async #downloadResidue(image: RuntimeImage, version: string): Promise<{ residue?: string }> {
    const left = (await this.#downloadedRuntimeAssets()).some((asset) =>
      image.build === undefined ? asset.version === version : asset.build === image.build,
    );
    if (!left) return {};
    const label = image.build === undefined ? version : `${version} (${image.build})`;
    return {
      residue:
        `The download of iOS ${label} (${IOS_RUNTIME_ASSET_APPROX_SIZE}) is still in ` +
        `${IOS_RUNTIME_ASSET_ROOT}; \`simctl runtime delete\` did not reclaim it and Simlock ` +
        "does not delete files there -- remove the platform in Xcode's Settings -> Platforms " +
        "to get the space back",
    };
  }

  /**
   * `listComponents`' entries, each with the runtime image it describes and the number of its
   * default-set devices that were never used (`devicesPerRuntime`).
   */
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
              // Another image of the same runtime keeps its simulators available after this
              // one goes, so only the runtime's last image has unused devices to report.
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

  /** The receipt of every runtime installed right now, before an installer run. */
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
    // Apple's downloader accepts `-buildVersion <marketing version>` only for whatever it
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

  async provision(spec: DeviceSpec): Promise<DriverDevice> {
    this.#requireIosPlatform(spec.platform);
    const resolved = await this.#resolvedSpec(spec);
    // Cosmetic, and deliberately so: what proves this device is Simlock's is that it
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

  /**
   * The UDID never changes across a boot -- unlike Android's port, there is nothing to
   * re-derive. When the device's spec is slim (`options.mode`, ADR 0007 §7) and its runtime new
   * enough, the boot deadline is widened *before* the first boot (that decision must
   * be made from `driverData` alone, ADR point 9) and, once booted, a slim pass may run: apply the
   * disable list, then reboot once more. A failed or skipped slim never fails the lease -- the
   * device is still returned, just not marked as slimmed.
   *
   * `options.purpose === "recover"` (the one caller: `ManagedDeviceLifecycle.recoverLeased`,
   * safety rule 2's crash-recovery exception on an already-*leased* device) always takes the
   * `"off"` path below -- a single ordinary boot, no slim apply, no second reboot -- regardless
   * of the device's spec mode. Recovery may only get a leased
   * device running again, never change what it's running; a "prepare"-shaped slim pass under an
   * active lease would silently strip push/Spotlight/StoreKit/universal-links mid-lease, which
   * is exactly the broader privilege safety rule 2 says this exception does not grant.
   */
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
      // This boot slimmed nothing: a full spec, a `"recover"` boot, or a runtime-gate skip.
      // The device is full.
      return this.#asIs(device, data, "full");
    }

    return this.#applySlimAndReboot(device, data, plan.slim, bootstatusTimeoutMs);
  }

  /** The device's current `address`/`driverData`, unmodified, tagged with the mode it has. */
  #asIs(device: DriverDevice, data: IosDriverData, mode: DeviceMode): DriverDevice {
    return {
      address: data.udid,
      deviceId: device.deviceId,
      driverData: device.driverData,
      mode,
    };
  }

  /**
   * Boot, tolerate already-booted, wait for `bootstatus -b`; on a bootstatus timeout, make a
   * best-effort shutdown before surfacing `BootTimeoutError` so a hung device isn't left running.
   * Shared by `makeReady`'s first boot and the post-slim reboot -- identical behaviour either way,
   * only the deadline differs.
   */
  async #bootAndWait(udid: string, deviceId: string, bootstatusTimeoutMs: number): Promise<void> {
    const boot = await this.#invokeSimctl(["boot", udid], COMMAND_TIMEOUT_MS);
    if (boot.kind === "timed-out") {
      throw new BootTimeoutError(deviceId);
    }
    if (boot.result.code !== 0 && !alreadyBooted(boot.result.stderr)) {
      this.#assertSuccessful(["boot", udid], boot.result);
    }
    const outcome = await this.#invokeSimctl(["bootstatus", udid, "-b"], bootstatusTimeoutMs);

    if (outcome.kind === "timed-out") {
      await this.#bestEffortShutdown(udid);
      throw new BootTimeoutError(deviceId);
    }

    this.#assertSuccessful(["bootstatus", udid, "-b"], outcome.result);
  }

  /**
   * Runs after the first boot has already succeeded with the slim deadline. Idempotence: skip
   * the whole step (no second boot) only when the stored signature *and* mark token both match
   * what's true right now -- a missing/unreadable token or a differing one means the device was
   * erased (by `reclaim`) since it was last slimmed, and a differing signature means the
   * configured categories (or the shipped label list) changed; either way, re-apply. Applying
   * twice is harmless.
   */
  async #applySlimAndReboot(
    device: DriverDevice,
    data: IosDriverData,
    slim: SlimOptions,
    bootstatusTimeoutMs: number,
  ): Promise<DriverDevice> {
    const resolved = resolveSlimCategories(slim.categories);
    if (resolved.categories.length === 0) {
      // Nothing was ever attempted and no reboot happened: this device is exactly as full-featured
      // as it was before `makeReady` was called.
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
      // Every chunk failed to run (or nothing passed the safety filter): nothing was applied and
      // no reboot happened, so the device is still full-featured.
      return this.#skipApply(device, data, applyOutcome.detail, "full");
    }

    // The reboot below is what makes the disable entries take effect; never write the
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
    // Always re-establish a known-good running device, whether or not the shutdown above actually
    // completed. `#shutdown` throws on a *timeout* of `simctl shutdown`, which is exactly the
    // moment the shutdown is most likely to still be in progress or to have already finished --
    // there is no reliable way to tell which from the exception alone, so this stops guessing:
    // `boot` already tolerates an already-booted device, so the boot below reaches a known-good
    // running device either way. A genuine inability to get it running again propagates as
    // `BootTimeoutError` / `DriverCrashError`, as it should -- that case really does mean the
    // device is left shut down, not "ready" as returning it would falsely claim.
    await this.#bootAndWait(data.udid, device.deviceId, bootstatusTimeoutMs);

    if (shutdownError !== undefined) {
      // The shutdown call itself failed, so whether the labels' reboot actually took effect is
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
      // Partial apply: at least one chunk failed to run outright, so those labels were never even
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

    // Every chunk ran (individual labels may still have been rejected by the script itself, or
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

  /** Reports `device.slim-skipped` with reason `apply-failed` and returns the device as-is. */
  #skipApply(
    device: DriverDevice,
    data: IosDriverData,
    detail: string,
    mode: DeviceMode,
  ): DriverDevice {
    this.#onSlimSkipped?.({ deviceId: device.deviceId, detail, reason: "apply-failed" });
    return this.#asIs(device, data, mode);
  }

  /**
   * Idempotence check split out of `#applySlimAndReboot`: skip the whole step (no second boot)
   * only when the stored signature *and* mark token both match what's true right now -- a
   * missing/unreadable token or a differing one means the device was erased (by `reclaim`) since
   * it was last slimmed, and a differing signature means the configured categories (or the
   * shipped label list) changed; either way, re-apply. Applying twice is harmless.
   */
  async #checkAlreadySlimmed(
    data: IosDriverData,
    signature: string,
  ): Promise<{ readonly alreadySlimmed: boolean; readonly currentToken: string | undefined }> {
    // Derived from the owned device set rather than looked up, so unlike the pre-ADR-0001
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

  /**
   * Builds the post-reboot driver data (new signature + mark token) and reports `device.slimmed`
   * -- split out of `#applySlimAndReboot` so the outer method's own branching stays about
   * *whether* to apply, not the bookkeeping for a successful apply.
   */
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
      // `currentToken` was read from the erasable mark *before* this reboot -- a reboot alone
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

  /**
   * Note (verified on iOS 26.4 / 27.0): `launchctl disable` exits 0 for a label that does not
   * exist and records it anyway, so the per-label failure line below never fires for a renamed
   * or removed daemon -- only for a crashed `launchctl` or a filtered label. Drift in the label
   * list is therefore silent at apply time (see docs/known-pitfalls.md).
   *
   * Batches `launchctl disable system/<label>` calls into shell loops of at most
   * `SLIM_CHUNK_SIZE`, one `simctl spawn` per chunk -- ~170 individual spawns would dominate the
   * slim budget (see `SLIM_CHUNK_SIZE`'s comment). Each label that `launchctl disable` itself
   * rejects (e.g. renamed/removed between runtimes) is caught by the script's own `|| echo` and
   * reported back into `rejectedLabels`, never thrown (ADR point 8) -- only a chunk that fails to
   * run at all (timeout, nonzero exit from the `sh -c` invocation itself) is treated as that
   * chunk's labels never having been attempted (`unattemptedLabels`). See `SlimApplyOutcome` for
   * why the two are tracked separately. The whole apply is reported as failed only when *no*
   * chunk ran successfully.
   */
  async #applySlimLabels(udid: string, labels: readonly string[]): Promise<SlimApplyOutcome> {
    const { safe, rejected } = sanitizeSlimLabels(labels);
    if (safe.length === 0) {
      return { detail: "no labels passed the shell-safety filter", kind: "failed" };
    }

    const chunks = chunk(safe, SLIM_CHUNK_SIZE);
    // `sanitizeSlimLabels`-filtered labels never reached any chunk, so they were rejected the
    // same way an individual `simlock-slim-failed` line is -- not merely "unattempted" (that's
    // reserved for a whole chunk that failed to run).
    const rejectedLabels: string[] = [...rejected];
    const unattemptedLabels: string[] = [];
    let anyChunkSucceeded = false;
    // Why the most recent failed chunk failed, so a skip that drops the whole slim pass says
    // what simctl actually reported rather than only that something went wrong.
    let lastChunkFailure = "";

    for (const chunkLabels of chunks) {
      // `DYLD_ROOT_PATH` is what makes a bare `launchctl` inside the simulator load the
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
  ): Promise<{ readonly state: "shutdown"; readonly strategy: "erase" }> {
    const data = iosDriverData(device);
    await this.#shutdown(data.udid);
    await this.#simctl(["erase", data.udid], COMMAND_TIMEOUT_MS);
    await this.#writeMark(data.udid);

    return { state: "shutdown", strategy: "erase" };
  }

  reclaimStrategy(_options: { readonly clean: "standard" | "full" }): "erase" {
    return "erase";
  }

  async shutdown(device: DriverDevice): Promise<void> {
    await this.#shutdown(iosDriverData(device).udid);
  }

  async destroy(device: DriverDevice): Promise<void> {
    const data = iosDriverData(device);
    await this.#shutdown(data.udid);
    await this.#simctl(["delete", data.udid], COMMAND_TIMEOUT_MS);
  }

  /**
   * Looks for a UDID in the machine's default device set -- where every simulator Simlock
   * created before it owned one still lives. Reached only for a registry device the root no
   * longer holds, and it reads: `simctl list` is the one unscoped call that mutates nothing.
   */
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
      // CoreSimulator lays every set out as `<set>/<UDID>`, data container included, so the
      // container's parent is the device directory -- and where the *old* set is is exactly
      // what this driver no longer knows any other way (ADR 0001, consequences).
      ...(found.dataPath === undefined ? {} : { path: dirname(found.dataPath) }),
    };
  }

  /**
   * Destroys a pre-root simulator through the unscoped path it actually sits on. Permitted
   * despite living outside this driver's root because the registry names it: registry-only
   * destruction (safety rule 1) is satisfied by the record, not by the root. `doctor --fix`
   * is the only caller, and it checks the lease guard before asking.
   */
  async destroyLegacy(device: DriverDevice): Promise<void> {
    const { udid } = iosDriverData(device);
    // Best effort, exactly as the scoped `#shutdown` is: a device that is already shut down
    // reports a failure that says nothing about whether the delete can proceed.
    await this.#invokeLegacySimctl(["shutdown", udid], COMMAND_TIMEOUT_MS);
    await this.#legacySimctl(["delete", udid], COMMAND_TIMEOUT_MS);
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
      // Keyed by name and paired through the device type `resolveSpec` would pick for that name,
      // so two device types that differ only in letter case both list the first one's runtimes.
      // A device type answers to its name only, in any letter case (`findDeviceType`).
      modelAliases: {},
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
        // A slim device pays for a second boot plus a launchctl-disable pass on top of the usual
        // one -- quoting the plain cold-boot number here would make `doctor` flag every slim
        // device as stalled. A full spec never slims, so quoting the slim number to it would
        // make `doctor` flag a perfectly on-time full boot as stalled instead.
        return this.#slim !== undefined && spec.mode === "slim"
          ? SLIM_BOOT_ESTIMATE_MS
          : COLD_BOOT_ESTIMATE_MS;
      case "reclaim":
        // `reclaimStrategy` returns `erase` for both clean levels, so there is nothing to
        // branch on here -- the clean level only matters to a driver that has a fast path.
        return ERASE_ESTIMATE_MS;
    }
  }

  /**
   * Everything only this driver can see about a standing condition of the machine it runs on:
   * the slim-mode runtime gate, and downloaded runtimes whose disk nothing can reclaim. Both
   * are read-only -- at most a `simctl list` runs, no boot, no download, no mutation --
   * matching `listCatalog`'s own contract.
   */
  async advisories(): Promise<readonly DriverAdvisory[]> {
    return [...(await this.#unreclaimableCacheAdvisories()), ...(await this.#slimAdvisories())];
  }

  /**
   * The Xcode version and build `xcodebuild -version` prints. A Mac with only the command line
   * tools has an `xcodebuild` that refuses to run without Xcode: that is no Xcode, and reports
   * no entry. Any other failure -- a run that errors, times out, or prints a shape this does not
   * know -- rejects, so the core keeps the version it last read.
   */
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

  /**
   * Issue #79: a runtime download outlives the runtime. `simctl runtime delete` unregisters
   * the runtime and leaves its ~7.5 GiB bundle in the OS asset store, from which CoreSimulator
   * can re-register it later -- so an operator running `downloads.policy` on a long-lived host
   * loses disk to bundles no Simlock command, and no `simctl` verb, can reclaim, while the
   * download preflight silently measures the space they already spent. Reports one
   * `runtime-cache-unreclaimable` advisory naming every downloaded runtime the catalog no
   * longer installs, and points at the one supported way to reclaim them.
   *
   * Read-only, and quiet on anything it cannot read: the store belongs to macOS, is absent on
   * a machine that never downloaded a runtime, and is a system directory this driver has no
   * business failing `doctor` over. It reads each bundle's own metadata and never its size --
   * measuring the store means walking tens of gigabytes on every `doctor` run.
   */
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

    // Oldest first, by version and then by build, so a store that has been collecting for
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
    const plural = described.length > 1;
    return [
      {
        code: "runtime-cache-unreclaimable",
        message:
          `iOS ${described.join(", ")} ${plural ? "are" : "is"} no longer installed, but ` +
          `${plural ? "their downloads" : "its download"} (${IOS_RUNTIME_ASSET_APPROX_SIZE} each) ` +
          `still ${plural ? "occupy" : "occupies"} ${IOS_RUNTIME_ASSET_ROOT}; ` +
          "`simctl runtime delete` does not reclaim that space and neither can Simlock -- " +
          "remove the platform in Xcode's Settings -> Platforms to get it back",
      },
    ];
  }

  /**
   * Every `*.asset` bundle in the store whose metadata says which runtime build it holds.
   * A bundle whose `Info.plist` is missing, unreadable, or shaped differently than the ones
   * this parses is left out rather than guessed at: an advisory that names a runtime the
   * operator still has installed is worse than one that names one bundle too few.
   */
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

      const asset = parseRuntimeAsset(contents);
      if (asset !== undefined) {
        assets.push(asset);
      }
    }

    return assets;
  }

  /**
   * ADR point 4 (issue #87): slim mode is silent about the runtime gate everywhere except
   * `makeReady`'s per-boot `SlimSkippedFact` -- an operator who never leases a device on an
   * old runtime would otherwise have no way to learn slimming is doing nothing for it. Reports
   * one `slim-runtime-unsupported` advisory naming every installed runtime that predates the
   * 18.5 persistent-override floor, using the same `supportsPersistentSlim(iosRuntimeVersionFromId
   * (runtime.identifier))` call `planSlimBoot` makes for the real per-device decision -- not a
   * second, independent parse of the catalog's marketing `runtime.version` -- so this can never
   * drift from what `makeReady` will actually do: an identifier `iosRuntimeVersionFromId` can't
   * parse is `undefined`, and `supportsPersistentSlim(undefined)` is `false`, so an unparseable
   * runtime is reported unsupported here exactly as `makeReady` treats it as `"unknown-runtime"`.
   * Nothing unless the worker's default mode is slim (ADR 0007 §14), or when every installed
   * runtime qualifies. Read-only: only `#loadCatalog` (a `simctl list`) runs, no boot, no
   * download, no mutation -- matching `listCatalog`'s own contract.
   */
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

  /**
   * The device-set path a lease holder needs to address its simulator at all: inside a
   * custom set a UDID resolves to nothing without it. `docs/CLI.md` publishes the variable
   * name, and `simlock simctl` reads it back.
   */
  leaseEnvironment(): Readonly<Record<string, string>> {
    return { SIMLOCK_IOS_DEVICE_SET: this.#deviceRoot };
  }

  readonly passthroughTool = IOS_PASSTHROUGH_TOOL;

  /**
   * `xcrun simctl --set <root> <args...>`: the same insertion `#invokeSimctl` makes, for a
   * command the caller runs itself. This is still an accident boundary and not a security
   * one (ADR 0001, "Not a security boundary") -- someone who wants to can run
   * `xcrun simctl --set` themselves -- but the wrapper must never be the thing that hands
   * over the set path, so the two globals that could disguise a refused verb are refused
   * before the verb is resolved at all.
   */
  passthrough(args: readonly string[]): PassthroughCommand {
    this.#assertProxyable(args);
    // No environment: on iOS the device set only ever reaches simctl on the command line
    // (ADR 0001 records that every candidate variable was tried and ignored).
    return { args: ["simctl", "--set", this.#deviceRoot, ...args], command: "xcrun", env: {} };
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
    // A bare `simctl` reaches this too, so refusing it takes no capability away. The
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
      this.passthroughTool,
      `Refusing \`simlock simctl ${command}\`: ${guidance}`,
    );
  }

  /**
   * The subcommand and its operands, refusing on the way anything that could be mistaken
   * for a subcommand. simctl's usage is `simctl [--set <path>] [--profiles <path>]
   * <subcommand>`, and this driver has no legitimate caller-supplied global to allow through
   * at all -- unlike adb's `-s`/`-t`/`-d`/`-e`, which is why the Android driver's own version
   * of this scan (`allowedGlobalArity`) is a real allow list rather than "refuse everything".
   * Round 4, F6: this used to allow anything spelled `-...` other than `--set`/`--profiles`
   * to pass by, on the theory that an unrecognized flag takes no value -- structurally the
   * same bug round 3 fixed on the Android side (`--reply-fd 9 -H attacker.example`): an
   * unrecognized flag with a value reads that value as the subcommand and lets the real
   * `--set`/`--profiles` behind it slide past every refusal below unseen
   * (`["-x", "/tmp", "--set", "/evil", "boot", "UDID"]` used to stop the scan at `/tmp`). Since
   * nothing legitimate can precede the subcommand here, the fix does not need adb's value/no
   * -value bookkeeping: **every** `-...` token in this position is refused, named or not,
   * mirroring `allowedGlobalArity`'s "unrecognized is refused, not assumed harmless" rather
   * than pattern-matching for the two names already known to be dangerous.
   */
  #subcommand(args: readonly string[]): readonly string[] {
    for (const [index, argument] of args.entries()) {
      if (!argument.startsWith("-")) return args.slice(index);
      const flag = /^-+([^=]*)/.exec(argument)?.[1];
      if (flag !== undefined && CALLER_SUPPLIED_SCOPE_FLAGS.has(flag)) {
        throw new PassthroughRefusedError(
          this.passthroughTool,
          `Refusing \`simlock simctl ${argument}\`: \`simlock simctl\` supplies the device set itself, and a caller-supplied \`--${flag}\` would point simctl somewhere Simlock does not manage. Drop the flag -- the command is already scoped -- or run \`xcrun simctl\` directly if you mean to leave Simlock's set.`,
        );
      }
      // Not `--set`/`--profiles` by name, but simctl has no other legitimate global here --
      // refused on sight rather than skipped over as presumed harmless, the same way an
      // unrecognized adb global is (`allowedGlobalArity`). Skipping it is exactly what let a
      // caller-supplied `--set`/`--profiles` hide behind an unrecognized flag's *value*.
      throw new PassthroughRefusedError(
        this.passthroughTool,
        `Refusing \`simlock simctl ${argument}\`: \`simlock simctl\` supplies the device set itself, and does not recognize any caller-supplied argument ahead of the subcommand. Drop the flag -- the command is already scoped -- or run \`xcrun simctl\` directly if you mean to leave Simlock's set.`,
      );
    }
    return [];
  }

  /** CoreSimulator lays a set out as `<set>/<UDID>`, so no subprocess can tell us more. */
  #deviceDirectory(udid: string): string {
    return join(this.#deviceRoot, udid);
  }

  /**
   * Data-container path for a device, derived rather than looked up. The driver used to
   * learn it from a `simctl list` (~260ms, on `reclaim`, which runs on every release)
   * because it did not know where its devices lived; owning the set means it does.
   */
  #dataPathFor(udid: string): string {
    return join(this.#deviceDirectory(udid), "data");
  }

  /**
   * Writes the same provenance token into both regions of a device: the
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

  /**
   * Reads both provenance regions for a managed device. Both regions are
   * host-side files readable while the device is shut down, so
   * `erasableReadable` is always `true` on iOS -- the field only ever goes
   * `false` for Android, where the erasable mark lives on-device and is
   * unreachable while the emulator isn't running. A device this driver never
   * marked (both regions absent, e.g. provisioned before this feature
   * shipped) reports `undefined` rather than a half-empty mark, so it stays
   * quiet instead of classifying as tampered on every tick.
   */
  async #readMark(udid: string): Promise<ObservedMark | undefined> {
    const durable = await this.#readToken(join(this.#deviceDirectory(udid), MARK_FILE_NAME));
    const erasable = await this.#readToken(join(this.#dataPathFor(udid), MARK_FILE_NAME));

    if (durable === undefined && erasable === undefined) {
      return undefined;
    }

    return { durable, erasable, erasableReadable: true };
  }

  /**
   * A missing file and a corrupt one both read as an absent mark -- the core
   * classifies "absent" from "present but wrong" itself, and a read must
   * never throw out of `listManaged`.
   */
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

  async #resolvedSpec(spec: DeviceSpec): Promise<ResolvedIosSpec> {
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

  /**
   * The runtime images `simctl runtime list -j` reports, one per downloaded disk image. Read
   * for receipts -- the image identifier is what changes when a runtime is deleted and
   * downloaded again, even at the same version and build -- and, after a removal, for whether
   * the image is still being deleted.
   */
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
      // Boot failure cleanup must not obscure the timeout that triggered it.
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

  /**
   * The single insertion point for `--set`, which scopes every subcommand to the root this
   * driver owns and must therefore precede the subcommand. Every call in this file is
   * spawned with these arguments or through `#invokeLegacySimctl`, and nothing else: a scoped
   * call that slipped past both would address the machine's default set, where Simlock can
   * prove nothing about what it touches.
   */
  #scopedSimctlArgv(args: readonly string[]): string[] {
    return ["simctl", "--set", this.#deviceRoot, ...args];
  }

  async #invokeSimctl(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    return this.#invokeXcrun(this.#scopedSimctlArgv(args), timeoutMs);
  }

  /**
   * Deliberately unscoped, and the only thing in Simlock that is: the pre-root devices
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
        // A process that has already exited needs no timeout cleanup.
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

/**
 * The error for a runtime that is not installed: downloadable, naming `component`, unless the
 * component predates `IOS_DOWNLOAD_FLOOR` -- then no download can help, and saying so here keeps
 * such a request from queueing for an install `installComponent` would refuse anyway.
 */
function missingRuntime(
  osVersion: string,
  message: string,
  component: string,
): RuntimeMissingError {
  return belowDownloadFloor(component)
    ? new IosDownloadFloorError(component)
    : new IosRuntimeMissingError(osVersion, message, component);
}

/** The one floor check, for `resolveSpec` and `installComponent` alike. `latest` has none. */
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

/**
 * A requested OS version outside the model's `[minRuntimeVersion, maxRuntimeVersion]` pairing
 * range. Extends `RuntimeMissingError` (rather than living as an unrelated class) so it flows
 * through the daemon/CLI exactly like `IosRuntimeMissingError` already does -- same error code,
 * same exit status -- without either needing to learn a new type. Unlike a missing runtime, no
 * download can ever fix this, which is why the message states the supported range instead of
 * pointing at `--allow-download`.
 */
class IosVersionOutOfRangeError extends RuntimeMissingError {
  constructor(model: string, requested: string, deviceType: DeviceType) {
    super("ios", requested, { downloadable: false });
    const range = formatVersionRange(deviceType.minRuntimeVersion, deviceType.maxRuntimeVersion);
    this.message = `${model} supports iOS ${range}; iOS ${requested} is out of range`;
  }
}

/**
 * The requested runtime is installed and its version falls in the model's declared range, but
 * the runtime's own `supportedDeviceTypes` (authoritative once it is actually on disk) does not
 * include this model -- e.g. a device Apple dropped support for in a later point release of an
 * OS it otherwise still ships. Extends `RuntimeMissingError` for the same reason
 * `IosVersionOutOfRangeError` does (shared error code / exit status), and sets `downloadable:
 * false` for the same reason: the runtime is already installed, so downloading it again changes
 * nothing.
 */
class IosRuntimeUnpairedError extends RuntimeMissingError {
  constructor(model: string, requested: string) {
    super("ios", requested, { downloadable: false });
    this.message = `iOS ${requested} is installed but does not support ${model}`;
  }
}

/**
 * A requested version predates Xcode's automatic download support (`xcodebuild
 * -downloadPlatform` only reaches back to iOS 16.0 -- see `IOS_DOWNLOAD_FLOOR`), thrown by
 * `resolveSpec` and by `installComponent` before `xcodebuild` runs. Not a driver crash: nothing went wrong, the
 * request is simply outside what a download can ever do.
 * `RuntimeMissingError` with `downloadable: false` reports that distinction the same way the
 * out-of-range and unpaired-runtime errors do, rather than surfacing as an opaque internal error.
 */
class IosDownloadFloorError extends RuntimeMissingError {
  constructor(requested: string) {
    super("ios", requested, { downloadable: false });
    this.message =
      `iOS ${requested} predates Xcode's automatic download support (introduced for iOS ` +
      `16.0 and newer); install it manually via Xcode`;
  }
}

/**
 * `xcodebuild -downloadPlatform iOS -buildVersion <requested>` was rejected outright ("is not
 * available for download") rather than fetching anything -- Apple's live catalog only serves a
 * version-pinned request for whatever it currently offers, and a release it has since retired
 * (superseded by a newer point release), or one still ambiguous across several concurrent
 * beta/seed builds sharing the same marketing version, is refused even though a matching build
 * exists somewhere in Apple's history. `downloadable: false` for the same reason
 * `IosDownloadFloorError` sets it: retrying with `--allow-download` again changes nothing, since
 * it is Apple's catalog, not Simlock, that has stopped (or not yet started) offering this exact
 * version unambiguously.
 */
class IosRuntimeUnavailableForDownloadError extends RuntimeMissingError {
  constructor(requested: string) {
    super("ios", requested, { downloadable: false });
    this.message =
      `iOS ${requested} is not currently offered for download by Apple (likely superseded by a ` +
      `newer point release); request a different --os, or omit --os for the newest available runtime`;
  }
}

/**
 * The configured root, or the per-home default. The default is computed here and not in
 * the core because what `drivers.ios.deviceRoot` means is this module's business
 * (architecture rule 2); the core only hands over the block and `SIMLOCK_HOME`.
 */
function configuredDeviceRoot(options: IosSimctlDriverOptions): string {
  const configured = options.driverConfig["deviceRoot"];

  if (configured !== undefined && typeof configured !== "string") {
    // A `deviceRoot` that is not a usable path refuses this platform's *configuration*,
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
  /** Only `findLegacy` reads this; a scoped listing already knows where its devices are. */
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

/** An entry simctl reports without a name or a udid is not addressable, so it is skipped. */
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

/** `simctl` reports `Booting` / `Shutting Down` mid-transition; both must read as `transitioning`, never as drift. */
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

  // Device types come from the Xcode install itself and are never empty on a working
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

/**
 * Whether an installed runtime is the one this downloaded bundle holds -- the test for
 * "deleting this bundle would delete a runtime the operator still has". Builds decide it
 * whenever simctl reports one, because two runtimes can share a marketing version and a
 * version match would then call an orphaned bundle installed. Marketing version is the
 * fallback for a simctl that reports no build at all: it can only over-match, which costs an
 * advisory that is not shown, never one that names a runtime still in use.
 */
function runtimeMountsAsset(runtime: Runtime, asset: RuntimeAsset): boolean {
  return runtime.build === undefined
    ? runtime.version === asset.version
    : runtime.build === asset.build;
}

/**
 * The build and marketing version out of an asset bundle's `Info.plist`. Read as text rather
 * than through a plist parser: these are two flat string values in a file this driver must
 * never write, and shelling out to `plutil` once per bundle would make a `doctor` run pay for
 * every runtime ever downloaded. Both keys are read from `MobileAssetProperties` onwards, so a
 * same-named key in the surrounding envelope cannot be mistaken for the asset's own.
 */
function parseRuntimeAsset(plist: string): RuntimeAsset | undefined {
  const propertiesAt = plist.indexOf("<key>MobileAssetProperties</key>");
  const properties = propertiesAt === -1 ? plist : plist.slice(propertiesAt);
  const build = /<key>Build<\/key>\s*<string>([^<]+)<\/string>/.exec(properties)?.[1];
  const version = /<key>SimulatorVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(properties)?.[1];

  return build === undefined || version === undefined ? undefined : { build, version };
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

/** One downloaded runtime disk image, as `simctl runtime list -j` reports it. */
interface RuntimeImage {
  /** The image's own identifier: new for every download, even of the same build. */
  readonly identifier: string;
  /** The `SimRuntime` identifier the image provides, as `simctl list runtimes` names it. */
  readonly runtimeIdentifier: string;
  readonly build?: string;
  /** The platform the image is for: `com.apple.platform.iphonesimulator` for iOS. */
  readonly platformIdentifier?: string;
  readonly version?: string;
  readonly sizeBytes?: number;
  /** What the image is doing: `Ready` once installed, and a deleting state after a delete. */
  readonly state?: string;
}

/**
 * Whether `simctl runtime list -j` shows the image as still being deleted, which it does for a
 * few seconds after `simctl runtime delete` answers (#259). The text listing prints
 * `(Deleting)`; the JSON value has not been captured mid-delete, so it is compared ignoring case.
 */
function isBeingDeleted(image: RuntimeImage): boolean {
  return image.state?.toLowerCase() === "deleting";
}

/** The `platformIdentifier` `simctl runtime list -j` gives an iOS simulator runtime image. */
const IOS_SIMULATOR_PLATFORM = "com.apple.platform.iphonesimulator";

/** `simctl runtime list -j` is an object keyed by image identifier; unreadable entries are skipped. */
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

/** `{ [key]: value }` when `value` is a string, and nothing otherwise. */
function optionalString<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  return typeof value === "string" ? ({ [key]: value } as Record<Key, string>) : {};
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The receipt of the installed component a runtime is (ADR 0010 §5): the receipt of the image it
 * is mounted from. A runtime with no image of its own -- one bundled inside Xcode rather than
 * downloaded -- is named by its runtime identifier instead; Simlock never installs one of those,
 * so no record of Simlock's can match it.
 */
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

/**
 * The one function that builds an image's receipt, for an install, a find and a listing alike
 * (ADR 0010 §5): the image identifier and its build. `runtimeReceipt` only picks the image.
 */
function imageReceipt(image: RuntimeImage): ComponentReceipt {
  return { build: image.build ?? "", image: image.identifier };
}

/**
 * Whether an image is an iOS simulator runtime, not a watchOS, tvOS or visionOS one. An image
 * that does not say which platform it is for is not listed: nothing else proves it is iOS.
 */
function isIosImage(image: RuntimeImage): boolean {
  return image.platformIdentifier === IOS_SIMULATOR_PLATFORM;
}

/** One `listComponents` entry with what `removeComponent` needs beyond it. */
type ListedImage = DriverComponent & {
  readonly image: RuntimeImage;
  readonly unusedDevices: number;
};

/**
 * The `residue` sentence for the never-used default-set simulators a runtime removal leaves
 * behind, or nothing when there were none. Simlock does not delete them (safety rule 1).
 */
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

/** The default-set devices of one runtime, split by whether each has been used. */
interface DefaultSetDevices {
  /** Used at least once: these count as users of the runtime (`foreignDevices`). */
  readonly used: number;
  /** Never used: macOS created them on its own, and they do not block a removal. */
  readonly unused: number;
}

/**
 * Counts the default set's devices per runtime identifier: a `simctl list -j devices` answer is
 * keyed by runtime identifier, with one array of devices under each. This is the one place that decides
 * which of them use a runtime, for listing and for removal alike: a device counts when its
 * `simctl list -j devices` entry carries `lastUsedAt`, which only a device that has been booted
 * has; an entry that is not an object counts as used, so an unreadable entry never unblocks a
 * removal. When a runtime install ends, CoreSimulator creates a batch of simulators for it in the
 * default set by itself; those carry no `lastUsedAt`, and counting them would make every runtime
 * Simlock installs unremovable.
 */
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

/**
 * A bare major is the driver's own guess at a bounded model's newest runtime, and Xcode may have
 * no build matching it: a crash there tells the requester to name an exact release instead.
 */
function withBareMajorHint(component: string, error: unknown): unknown {
  if (component === LATEST_COMPONENT || component.includes(".")) return error;
  if (!(error instanceof DriverCrashError)) return error;
  return new DriverCrashError(
    `Could not download a default iOS runtime (tried ${component}): ${error.message}; ` +
      `pass --os <version> to request an exact release`,
  );
}

/**
 * The installed runtime an install of `component` produced: the newest runtime for `latest`,
 * the newest of that major for a bare major (the bounded default), and that exact version
 * otherwise.
 */
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

/** The device type a model name resolves to: first match by lower-cased name, as `resolveSpec` matches. */
function findDeviceType(catalog: SimctlCatalog, model: string): DeviceType | undefined {
  const wanted = model.toLocaleLowerCase();
  return catalog.deviceTypes.find((candidate) => candidate.name.toLocaleLowerCase() === wanted);
}

/**
 * The one place that decides which installed runtimes pair with a device type: available,
 * listing it in `supportedDeviceTypes`, and inside its `[min, max]` range. `resolveSpec` and
 * `listCatalog` both read it, so the catalog cannot list a pair `resolveSpec` refuses (ADR 0008 §3).
 */
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

/** The versions of `pairedInstalledRuntimes`, once each, in simctl's order like `runtimes`. */
function pairedVersions(catalog: SimctlCatalog, deviceType: DeviceType | undefined): string[] {
  if (deviceType === undefined) return [];
  return [
    ...new Set(pairedInstalledRuntimes(catalog, deviceType).map((runtime) => runtime.version)),
  ];
}

/** `simctl`'s `0xAABBCC` encoding -> `[major, minor, patch]`. */
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
    // Both are optional and post-date `state.json` registries written before slim mode
    // shipped -- absent or wrong-typed is tolerated (ignored) rather than rejected, so an old
    // registry keeps loading (compatibility requirement). A `full` key an older daemon stamped
    // here is not read: the spec's mode is the only record of it (ADR 0007 §7).
    ...(typeof value.slimSignature === "string" ? { slimSignature: value.slimSignature } : {}),
    ...(typeof value.slimMarkToken === "string" ? { slimMarkToken: value.slimMarkToken } : {}),
  };
}

/**
 * Parses the iOS version out of a `simctl` runtime identifier, e.g.
 * `com.apple.CoreSimulator.SimRuntime.iOS-18-5` -> `[18, 5]`. Handles a bare major
 * (`iOS-18` -> `[18, 0]`) and a trailing patch segment (`iOS-18-5-1`, patch ignored) the same
 * way. An unparseable or empty `runtimeId` returns `undefined`.
 */
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

/**
 * ADR point 4: `launchctl disable` overrides only persist across reboots on iOS 18.5+; older
 * runtimes accept the commands but silently drop them on reboot, which would make slimming pay
 * for a second boot for nothing. `undefined` (unparseable/empty `runtimeId`) is never supported --
 * an unknown version is not assumed new enough.
 */
export function supportsPersistentSlim(version: readonly [number, number] | undefined): boolean {
  if (version === undefined) {
    return false;
  }
  const [major, minor] = version;
  return major > 18 || (major === 18 && minor >= 5);
}

/**
 * What `makeReady` should do about slimming this boot -- decided from `driverData`, the slim
 * options and the spec mode alone, before any `simctl` call runs. `"off"` covers a full spec,
 * a driver with no slim options, and a recovery boot; `"skip"` is the runtime-gate
 * failure (too old / unparseable), carrying the `SlimSkippedFact` fields `makeReady` reports
 * as-is; `"apply"` carries the resolved `slim` options `#applySlimAndReboot` needs.
 */
type SlimPlan =
  | { readonly kind: "off" }
  | { readonly kind: "skip"; readonly reason: SlimSkippedFact["reason"]; readonly detail: string }
  | { readonly kind: "apply"; readonly slim: SlimOptions };

/**
 * Pure decision step extracted from `makeReady`: given only this device's driver data, the
 * driver's slim options, and the `makeReady` options, decides what this boot should do and how
 * long the initial `bootstatus` wait may take. A full spec, no slim options, and a
 * `"recover"`-purpose call all read as `"off"` -- equivalent from here on (same as-is return,
 * same ordinary boot deadline).
 */
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

/**
 * Defense in depth for the generated `sh -c` script (see `#applySlimLabels`): labels are
 * compile-time constants from `slim-labels.ts`, so this should never actually reject anything in
 * production, but a label containing shell metacharacters must never reach the script unfiltered.
 */
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

/** What simctl reported for a slim chunk that did not run: its timeout, or exit and stderr. */
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

function specKey(spec: DeviceSpec): string {
  return `${spec.model.toLocaleLowerCase()}\u0000${spec.osVersion}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
