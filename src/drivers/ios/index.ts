import { dirname, join } from "node:path";

import {
  BootTimeoutError,
  type DeviceRequest,
  DiskSpaceGuard,
  type Driver,
  type DriverAdvisory,
  type DriverCatalogEntry,
  type DriverDevice,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  InsufficientDiskSpaceError,
  type LegacyDevice,
  type ObservedDevice,
  OwnedRootError,
  type PassthroughCommand,
  PassthroughRefusedError,
  type ObservedRunState,
  RuntimeMissingError,
  UnknownModelError,
} from "../../core/index.js";
import type { ObservedMark } from "../../core/driver.js";
import type { DeviceSpec } from "../../core/index.js";
import { stableError } from "../../core/stable-error.js";
import type {
  Clock,
  Filesystem,
  IdGenerator,
  ProcessResult,
  ProcessRunner,
} from "../../ports/index.js";
import type { ComponentInstallDiagnostic } from "../diagnostics.js";
import { labelsFor, resolveSlimCategories, slimSignature } from "./slim-labels.js";

const COMMAND_TIMEOUT_MS = 30_000;
const BOOTSTATUS_TIMEOUT_MS = 120_000;
const PROVISION_ESTIMATE_MS = 500;
// Mirrors `downloads.timeoutMs`'s config default (`src/core/config.ts`) -- used only when a
// caller constructs the driver directly without threading the configured value through (tests,
// `SIMLOCK_DRIVERS_MODULE`).
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 1_200_000;
// `simctl`'s `minRuntimeVersion` / `maxRuntimeVersion` encode "no bound" as 0xFFFFFF
// (255.255.255) rather than omitting the field.
const UNBOUNDED_VERSION = 0xff_ff_ff;
// `xcodebuild -downloadPlatform iOS -buildVersion` only reaches back to iOS 16.0 (Xcode
// 16.1+); older runtimes must be installed through Xcode itself.
const IOS_DOWNLOAD_FLOOR: readonly [number, number, number] = [16, 0, 0];
// Conservative estimate for a simulator runtime download+install (~7 GB observed, rounded up
// with headroom) -- checked before `xcodebuild -downloadPlatform` ever starts, so a full disk
// fails fast instead of filling up mid-download.
const IOS_RUNTIME_MIN_FREE_BYTES = 8 * 1024 ** 3;
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
  /** Per-lease override (set by `provision` from the device spec): never slim this device. */
  readonly full?: boolean;
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
   * Volume a runtime download actually lands on, for the disk preflight in
   * `#installComponent` -- simulator runtimes install under `~/Library/Developer/
   * CoreSimulator`, which is not necessarily the same volume as the daemon's working
   * directory. Defaults to `"."` (the daemon process's own volume) only when nothing better
   * is available, mirroring the Android driver's use of `sdk.root`.
   */
  readonly coreSimulatorRoot?: string;
  /** Per-download timeout; defaults to `downloads.timeoutMs`'s own default. */
  readonly downloadTimeoutMs?: number;
  /**
   * Disk-space preflight, shared with every other driver that installs components -- a bare
   * `assertDiskSpace` call only ever sees an instantaneous free-space reading, so two concurrent
   * installs (this driver's and the Android driver's, or two of this driver's own) can each pass
   * it and jointly overfill the volume neither alone would have. Defaults to a private,
   * driver-local guard when omitted (tests, `SIMLOCK_DRIVERS_MODULE`); production wiring
   * (`src/daemon/main.ts`) passes one instance to every driver so the tracking is actually
   * shared.
   */
  readonly diskSpaceGuard?: DiskSpaceGuard;
  /**
   * Reports `component.install-*` facts for the daemon layer to bridge onto the event bus --
   * this driver never depends on the bus directly (architecture rule 5). Mirrors the Android
   * driver's `onDiagnostic` option.
   */
  readonly onDiagnostic?: (diagnostic: ComponentInstallDiagnostic) => void;
  /**
   * Reports the `device.slimmed` fact for the daemon layer to bridge onto the event bus -- this
   * driver never depends on the bus directly (architecture rule 5). Mirrors `onDiagnostic`.
   */
  readonly onSlimmed?: (fact: SlimmedFact) => void;
  /** Reports why a device slim didn't happen when slim mode is on. Mirrors `onDiagnostic`. */
  readonly onSlimSkipped?: (fact: SlimSkippedFact) => void;
  /** Slim mode; omitted or `enabled: false` means today's behaviour exactly. */
  readonly slim?: {
    readonly enabled: boolean;
    readonly categories?: readonly string[];
    readonly bootTimeoutMs: number;
  };
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
  readonly isAvailable: boolean;
  /** Device type identifiers this runtime pairs with -- authoritative once the runtime is installed. */
  readonly supportedDeviceTypeIds: ReadonlySet<string>;
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
  /**
   * `true` only when slim mode is actually enabled -- a `--full` request against this driver
   * is only meaningful (and only earns its own, separate pool key -- see `Driver.reducesFeatures`)
   * while this driver might otherwise hand back a reduced device. Static per driver instance:
   * slim mode is process-wide configuration, not something that varies per request.
   */
  readonly reducesFeatures: boolean;
  readonly #clock: Clock;
  readonly #coreSimulatorRoot: string;
  readonly #diskSpaceGuard: DiskSpaceGuard;
  readonly #downloadLocks = new Map<string, Promise<number>>();
  readonly #downloadTimeoutMs: number;
  readonly #filesystem: Filesystem;
  readonly #idGenerator: IdGenerator;
  readonly #onDiagnostic: ((diagnostic: ComponentInstallDiagnostic) => void) | undefined;
  readonly #onSlimmed: ((fact: SlimmedFact) => void) | undefined;
  readonly #onSlimSkipped: ((fact: SlimSkippedFact) => void) | undefined;
  readonly #processRunner: ProcessRunner;
  readonly #resolvedSpecs = new Map<string, ResolvedIosSpec>();
  readonly #deviceRoot: string;
  readonly #rootOptions: EnsureOwnedRootOptions;
  readonly #slim: SlimOptions | undefined;

  private constructor(
    options: IosSimctlDriverOptions,
    deviceRoot: string,
    rootOptions: EnsureOwnedRootOptions,
  ) {
    this.#clock = options.clock;
    this.#coreSimulatorRoot = options.coreSimulatorRoot ?? ".";
    this.#diskSpaceGuard = options.diskSpaceGuard ?? new DiskSpaceGuard();
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.#filesystem = options.filesystem;
    this.#idGenerator = options.idGenerator;
    this.#onDiagnostic = options.onDiagnostic;
    this.#onSlimmed = options.onSlimmed;
    this.#onSlimSkipped = options.onSlimSkipped;
    this.#processRunner = options.processRunner;
    this.#deviceRoot = deviceRoot;
    this.#rootOptions = rootOptions;
    this.#slim = options.slim;
    this.reducesFeatures = options.slim?.enabled === true;
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

  async resolveSpec(
    request: DeviceRequest,
    options: { readonly allowDownload: boolean; readonly requesterId?: string },
  ): Promise<DeviceSpec> {
    this.#requireIosPlatform(request.platform);
    const catalog = await this.#loadCatalog();
    const deviceType = catalog.deviceTypes.find(
      (candidate) => candidate.name.toLocaleLowerCase() === request.model.toLocaleLowerCase(),
    );

    if (deviceType === undefined) {
      throw new IosUnknownModelError(request.model);
    }

    return request.osVersion === undefined
      ? this.#resolveDefaultRuntime(deviceType, catalog, options)
      : this.#resolveExactRuntime(deviceType, request.osVersion, catalog, options);
  }

  /**
   * Version requested explicitly: validated against the model's `[min, max]` pairing range
   * *before* anything else -- an out-of-range request can never be fixed by downloading, so it
   * must never even reach the download decision.
   */
  // fallow-ignore-next-line complexity -- range/pairing checks, the download decision, and post-download verification are one resolution attempt.
  async #resolveExactRuntime(
    deviceType: DeviceType,
    osVersion: string,
    catalog: SimctlCatalog,
    options: { readonly allowDownload: boolean; readonly requesterId?: string },
  ): Promise<DeviceSpec> {
    if (!isVersionInRange(osVersion, deviceType)) {
      throw new IosVersionOutOfRangeError(deviceType.name, osVersion, deviceType);
    }

    const installed = findInstalledRuntime(catalog, osVersion);
    if (installed !== undefined) {
      // In the model's declared `[min, max]` range is necessary but not sufficient: a runtime
      // can be installed and still not pair with this specific device type (`supportedDeviceTypeIds`
      // is the authoritative source once a runtime is actually on disk -- the range above is
      // only a static hint). Checked before committing, so a mismatch never reaches `simctl create`.
      if (!installed.supportedDeviceTypeIds.has(deviceType.identifier)) {
        throw new IosRuntimeUnpairedError(deviceType.name, osVersion);
      }
      return this.#commitResolution(deviceType, installed);
    }

    if (!options.allowDownload) {
      throw new IosRuntimeMissingError(
        osVersion,
        `iOS ${osVersion} is not installed; pass --allow-download (or set downloads.policy) ` +
          `to download it`,
      );
    }

    if (isTooOldToDownload(osVersion)) {
      throw new IosDownloadFloorError(osVersion);
    }

    const startedAt = await this.#downloadRuntime(
      osVersion,
      ["-downloadPlatform", "iOS", "-buildVersion", osVersion],
      options.requesterId,
    );
    // `component.installed` is a verified fact, not "xcodebuild exited 0": re-scan the catalog
    // and confirm the thing this request actually needed -- a runtime at this version, paired
    // with this device type -- is now present before reporting success. Either failure mode
    // reports `component-install-failed`, never `component-installed`.
    const refreshed = await this.#loadCatalog();
    const runtime = findInstalledRuntime(refreshed, osVersion);
    if (runtime === undefined) {
      const message = `xcodebuild reported success but iOS ${osVersion} is still not installed`;
      this.#reportVerificationFailure(osVersion, startedAt, message, options.requesterId);
      throw new DriverCrashError(message);
    }
    // A version match alone is not enough: the same pairing check that gates an
    // already-installed runtime above must also gate a freshly downloaded one -- a version can
    // be on disk and still not pair with this specific device type.
    if (!runtime.supportedDeviceTypeIds.has(deviceType.identifier)) {
      this.#reportVerificationFailure(
        osVersion,
        startedAt,
        `iOS ${osVersion} installed but does not pair with ${deviceType.name}`,
        options.requesterId,
      );
      throw new IosRuntimeUnpairedError(deviceType.name, osVersion);
    }
    this.#onDiagnostic?.({
      componentId: osVersion,
      durationMs: this.#clock.now() - startedAt,
      kind: "component-installed",
      ...(options.requesterId === undefined ? {} : { requesterId: options.requesterId }),
    });
    return this.#commitResolution(deviceType, runtime);
  }

  /**
   * No version requested: defaults to the newest *installed* runtime that both falls in the
   * model's range and actually pairs with it (`supportedDeviceTypes`) -- not the newest
   * installed runtime overall, which may have dropped this model (iOS 26 dropping iPhone
   * XS/XR support is the motivating case).
   */
  // fallow-ignore-next-line complexity -- the download-target decision and post-download verification are one resolution attempt.
  async #resolveDefaultRuntime(
    deviceType: DeviceType,
    catalog: SimctlCatalog,
    options: { readonly allowDownload: boolean; readonly requesterId?: string },
  ): Promise<DeviceSpec> {
    const paired = pairedInstalledRuntime(catalog, deviceType);
    if (paired !== undefined) {
      return this.#commitResolution(deviceType, paired);
    }

    if (!options.allowDownload) {
      throw new IosRuntimeMissingError(
        "default",
        `No installed iOS runtime pairs with ${deviceType.name}; pass --allow-download (or ` +
          `set downloads.policy) to download a compatible runtime`,
      );
    }

    let componentId: string;
    let startedAt: number;
    if (isUnboundedMax(deviceType.maxRuntimeVersion)) {
      // No upper bound on this model's pairing range: any released version works, so there is
      // nothing more specific to ask for than "latest".
      componentId = "latest";
      startedAt = await this.#downloadRuntime(
        componentId,
        ["-downloadPlatform", "iOS"],
        options.requesterId,
      );
    } else {
      const major = majorVersionString(deviceType.maxRuntimeVersion);
      componentId = major;
      try {
        startedAt = await this.#downloadRuntime(
          major,
          ["-downloadPlatform", "iOS", "-buildVersion", major],
          options.requesterId,
        );
      } catch (error: unknown) {
        // A disk preflight failure or a typed "nothing to do here" (e.g. a concurrent caller's
        // RuntimeMissingError) is meaningful on its own and must reach the caller unchanged --
        // wrapping it in a DriverCrashError below would bury a clean, actionable error under an
        // opaque "could not download" one.
        if (error instanceof InsufficientDiskSpaceError || error instanceof RuntimeMissingError) {
          throw error;
        }
        throw new DriverCrashError(
          `Could not download a default iOS runtime for ${deviceType.name} (tried ${major}): ` +
            `${errorMessage(error)}; pass --os <version> to request an exact release`,
        );
      }
    }

    // Same verified-fact requirement as the exact-version path: only report `component-installed`
    // once a paired runtime for this device type is actually present in a re-scanned catalog.
    const refreshed = await this.#loadCatalog();
    const runtime = pairedInstalledRuntime(refreshed, deviceType);
    if (runtime === undefined) {
      const message =
        `xcodebuild reported success but no installed iOS runtime pairs with ` +
        `${deviceType.name} yet`;
      this.#reportVerificationFailure(componentId, startedAt, message, options.requesterId);
      throw new DriverCrashError(message);
    }
    this.#onDiagnostic?.({
      componentId,
      durationMs: this.#clock.now() - startedAt,
      kind: "component-installed",
      ...(options.requesterId === undefined ? {} : { requesterId: options.requesterId }),
    });
    return this.#commitResolution(deviceType, runtime);
  }

  /**
   * Reports the terminal `component-install-failed` diagnostic for the "xcodebuild exited 0 but
   * post-download verification didn't find what this request needed" case -- pairing failure or
   * outright absence. `#installComponent` already reports `component-install-failed` for a
   * nonzero xcodebuild exit; this covers the other way an install attempt can fail to produce a
   * usable component.
   */
  #reportVerificationFailure(
    componentId: string,
    startedAt: number,
    message: string,
    requesterId: string | undefined,
  ): void {
    this.#onDiagnostic?.({
      componentId,
      durationMs: this.#clock.now() - startedAt,
      error: message,
      kind: "component-install-failed",
      ...(requesterId === undefined ? {} : { requesterId }),
    });
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
   * Runs `xcodebuild -downloadPlatform iOS [-buildVersion <version>]`, deduping concurrent
   * callers that ask for the exact same invocation behind one in-flight promise -- mirrors the
   * Android driver's `#locks` pattern, sized to a single component instead of a whole device.
   * The map entry is removed once the download settles (success or failure), so a later,
   * non-concurrent call starts a fresh attempt rather than replaying a stale result. `componentId`
   * is the runtime version being installed ("latest" for a bare `-downloadPlatform iOS`, the bare
   * major version for the bounded-default case) -- reported on `component.install-*`, never
   * parsed back out of `args`. Resolves to the `started` timestamp on success rather than
   * `void`: the caller needs it to compute an accurate `durationMs` once its own post-download
   * catalog re-scan confirms (or fails to confirm) the component it actually needed.
   */
  async #downloadRuntime(
    componentId: string,
    args: readonly string[],
    requesterId: string | undefined,
  ): Promise<number> {
    const key = args.join(" ");
    const inFlight = this.#downloadLocks.get(key);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const promise = this.#installComponent(componentId, args, requesterId).finally(() => {
      if (this.#downloadLocks.get(key) === promise) {
        this.#downloadLocks.delete(key);
      }
    });
    this.#downloadLocks.set(key, promise);
    return promise;
  }

  /**
   * Disk preflight (via the shared `DiskSpaceGuard`, released once `xcodebuild` settles either
   * way), then `xcodebuild`, wrapped with `component.install-*` diagnostics. A preflight failure
   * is reported before any diagnostic fires -- no install was actually attempted, so there is
   * nothing to report as started or failed.
   */
  async #installComponent(
    componentId: string,
    args: readonly string[],
    requesterId: string | undefined,
  ): Promise<number> {
    const release = await this.#diskSpaceGuard.reserve(
      this.#filesystem,
      this.platform,
      IOS_RUNTIME_MIN_FREE_BYTES,
      this.#coreSimulatorRoot,
    );
    try {
      this.#onDiagnostic?.({
        componentId,
        kind: "component-install-started",
        ...(requesterId === undefined ? {} : { requesterId }),
      });
      const startedAt = this.#clock.now();
      try {
        await this.#xcodebuildOrThrow(args);
      } catch (error: unknown) {
        this.#onDiagnostic?.({
          componentId,
          durationMs: this.#clock.now() - startedAt,
          error: stableError(error),
          kind: "component-install-failed",
          ...(requesterId === undefined ? {} : { requesterId }),
        });
        throw error;
      }
      // No `component-installed` here: xcodebuild exiting 0 only means the tool claims success,
      // not that the catalog now has what a specific caller needed (an exact version, or one
      // that pairs with a specific device type). The caller re-scans and reports the terminal
      // fact itself -- see `#reportVerificationFailure` and its call sites.
      return startedAt;
    } finally {
      release();
    }
  }

  async #xcodebuildOrThrow(args: readonly string[]): Promise<void> {
    const result = await this.#processRunner.run("xcodebuild", args, {
      timeoutMs: this.#downloadTimeoutMs,
    });
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
        // Per-lease opt-out (`DeviceSpec.full`, ADR "serve from a separate pool key"): stamped
        // onto driver data only when set, so a normal (non-`--full`) request's driver data stays
        // byte-identical to a spec resolved before this field existed.
        ...(spec.full === true ? { full: true } : {}),
      } satisfies IosDriverData,
    };
  }

  /**
   * The UDID never changes across a boot -- unlike Android's port, there is nothing to
   * re-derive. When slim mode is on and this device qualifies (not `full`, runtime new enough --
   * `#slimApplicable`), the boot deadline is widened *before* the first boot (that decision must
   * be made from `driverData` alone, ADR point 9) and, once booted, a slim pass may run: apply the
   * disable list, then reboot once more. A failed or skipped slim never fails the lease -- the
   * device is still returned, just not marked as slimmed.
   *
   * `options.purpose === "recover"` (the one caller: `ManagedDeviceLifecycle.recoverLeased`,
   * safety rule 2's crash-recovery exception on an already-*leased* device) always takes the
   * `"off"` path below -- a single ordinary boot, no slim apply, no second reboot -- regardless
   * of slim configuration or this device's own eligibility. Recovery may only get a leased
   * device running again, never change what it's running; a "prepare"-shaped slim pass under an
   * active lease would silently strip push/Spotlight/StoreKit/universal-links mid-lease, which
   * is exactly the broader privilege safety rule 2 says this exception does not grant.
   */
  async makeReady(
    device: DriverDevice,
    options?: { readonly purpose: "prepare" | "recover" },
  ): Promise<DriverDevice> {
    const data = iosDriverData(device);
    const { plan, bootstatusTimeoutMs } = planSlimBoot(data, this.#slim, options?.purpose);

    await this.#bootAndWait(data.udid, device.deviceId, bootstatusTimeoutMs);

    if (plan.kind === "skip") {
      this.#onSlimSkipped?.({
        deviceId: device.deviceId,
        detail: plan.detail,
        reason: plan.reason,
      });
    }

    if (plan.kind !== "apply") {
      // `undefined` (not "full") whenever slim mode isn't enabled at all -- `DriverDevice.
      // featureProfile`'s contract is that `undefined` means "this driver does not reduce
      // anything", which is only true while slim mode is off. Once slim mode is on, "full" is
      // meaningful (this particular boot didn't reduce anything -- a per-device `full: true`
      // opt-out, a `"recover"` boot, or a runtime-gate skip) and is reported as such.
      return this.#asIs(device, data, this.#slim?.enabled === true ? "full" : undefined);
    }

    return this.#applySlimAndReboot(device, data, plan.slim, bootstatusTimeoutMs);
  }

  /** The device's current `address`/`driverData`, unmodified, tagged with the feature profile. */
  #asIs(
    device: DriverDevice,
    data: IosDriverData,
    featureProfile: "full" | "reduced" | undefined,
  ): DriverDevice {
    return {
      address: data.udid,
      deviceId: device.deviceId,
      driverData: device.driverData,
      ...(featureProfile === undefined ? {} : { featureProfile }),
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
      return this.#asIs(device, data, "reduced");
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
      // marker on it (same reasoning as the partial-apply case below), and report "reduced" (not
      // "full") under that uncertainty: telling a caller a device is slim when it is not is
      // benign -- it just avoids features it could have used -- while telling it a device is full
      // when it is not makes push / Spotlight / StoreKit fail with no explanation, exactly the
      // confusion the `slim` flag exists to prevent.
      return this.#skipApply(
        device,
        data,
        `slim shutdown failed: ${errorMessage(shutdownError)}`,
        "reduced",
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
      // harmless (same comment on `#checkAlreadySlimmed`). "reduced" because the labels that did
      // apply really are gone.
      return this.#skipApply(
        device,
        data,
        `${String(applyOutcome.unattemptedLabels.length)} of ${String(labels.length)} labels were never attempted (a chunk failed to run)`,
        "reduced",
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
    featureProfile: "full" | "reduced",
  ): DriverDevice {
    this.#onSlimSkipped?.({ deviceId: device.deviceId, detail, reason: "apply-failed" });
    return this.#asIs(device, data, featureProfile);
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
      featureProfile: "reduced",
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
      return { detail: `all ${String(chunks.length)} chunk(s) failed to run`, kind: "failed" };
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
    return {
      defaultRuntime: newestRuntime(installedRuntimes)?.version,
      models: catalog.deviceTypes.map((deviceType) => deviceType.name),
      runtimes: installedRuntimes.map((runtime) => runtime.version),
    };
  }

  estimate(estimate: DriverEstimate, spec: DeviceSpec): number {
    switch (estimate.operation) {
      case "provision":
        return PROVISION_ESTIMATE_MS;
      case "boot":
        // Slim mode pays for a second boot plus a launchctl-disable pass on top of the usual
        // one -- quoting the plain cold-boot number here would make `doctor` flag every slim
        // device as stalled. But a `full` spec never slims (`planSlimBoot`'s `data.full === true`
        // branch), so quoting the slim number to a request that will never pay it would make
        // `doctor` flag a perfectly on-time `full` boot as stalled instead.
        return this.#slim?.enabled === true && spec.full !== true
          ? SLIM_BOOT_ESTIMATE_MS
          : COLD_BOOT_ESTIMATE_MS;
      case "reclaim":
        // `reclaimStrategy` returns `erase` for both clean levels, so there is nothing to
        // branch on here -- the clean level only matters to a driver that has a fast path.
        return ERASE_ESTIMATE_MS;
    }
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
   * Nothing when slim mode is off (there is no gate to warn about) or when every installed
   * runtime qualifies. Read-only: only `#loadCatalog` (a `simctl list`) runs, no boot, no
   * download, no mutation -- matching `listCatalog`'s own contract.
   */
  async advisories(): Promise<readonly DriverAdvisory[]> {
    if (this.#slim === undefined || !this.#slim.enabled) {
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
          `Slim mode is enabled, but iOS ${unsupportedVersions.join(", ")} ${plural ? "are" : "is"} ` +
          `below the 18.5 persistent-override floor; devices on ${plural ? "those runtimes" : "that runtime"} ` +
          `are never slimmed -- \`launchctl disable\` overrides do not survive a reboot below iOS 18.5`,
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
    // wrapper is advertised as the safe path, and being the convenient route to an
    // unrecoverable multi-gigabyte deletion is not that.
    if (verb === "runtime" && operands.find((operand) => !operand.startsWith("-")) === "delete") {
      this.#refuse(
        "runtime delete",
        "it deletes a runtime shared with Xcode, and Simlock will not download one back (`--allow-download` cannot install iOS runtimes). Delete it through Xcode if that is really what you meant.",
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
   * for a subcommand. A caller-supplied `--set`/`--profiles` (any spelling, `--set=<path>`
   * included) is the only way a non-flag argument can precede the subcommand, so once
   * those are gone the first non-flag argument *is* the subcommand.
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

    await this.resolveSpec(spec, { allowDownload: false });
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
   * spawned through here or through `#invokeLegacySimctl`, and nothing else: a scoped call
   * that slipped past both would address the machine's default set, where Simlock can prove
   * nothing about what it touches.
   */
  async #invokeSimctl(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    return this.#invokeXcrun(["simctl", "--set", this.#deviceRoot, ...args], timeoutMs);
  }

  /**
   * Deliberately unscoped, and the only thing in Simlock that is: the pre-root devices
   * `findLegacy` / `destroyLegacy` deal with are in the machine's default set, which is
   * where a `--set` would stop reaching them. Only those two may call it, and only for a
   * UDID a registry record names -- registry-only destruction (safety rule 1) is satisfied
   * by that record, not by the root.
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

class IosRuntimeMissingError extends RuntimeMissingError {
  constructor(osVersion: string, message: string) {
    super("ios", osVersion);
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
 * -downloadPlatform` only reaches back to iOS 16.0 -- see `IOS_DOWNLOAD_FLOOR`). Not a driver
 * crash: nothing went wrong, the request is simply outside what `--allow-download` can ever do.
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
      identifier: value.identifier,
      isAvailable: value.isAvailable,
      name: value.name,
      supportedDeviceTypeIds: parseSupportedDeviceTypeIds(value.supportedDeviceTypes),
      version: value.version,
    },
  ];
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

function findInstalledRuntime(catalog: SimctlCatalog, version: string): Runtime | undefined {
  return catalog.runtimes.find((runtime) => runtime.isAvailable && runtime.version === version);
}

/** Installed, in the model's range, and pairs with it -- the newest of those, or none. */
function pairedInstalledRuntime(
  catalog: SimctlCatalog,
  deviceType: DeviceType,
): Runtime | undefined {
  const candidates = catalog.runtimes.filter(
    (runtime) =>
      runtime.isAvailable &&
      runtime.supportedDeviceTypeIds.has(deviceType.identifier) &&
      isVersionInRange(runtime.version, deviceType),
  );
  return newestRuntime(candidates);
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
    // All three are optional and post-date `state.json` registries written before slim mode
    // shipped -- absent or wrong-typed is tolerated (ignored) rather than rejected, so an old
    // registry keeps loading (compatibility requirement).
    ...(typeof value.full === "boolean" ? { full: value.full } : {}),
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
 * What `makeReady` should do about slimming this boot -- decided from `driverData` and the slim
 * options alone, before any `simctl` call runs. `"off"` covers both slim mode being disabled
 * entirely and this device's per-lease `full: true` opt-out; `"skip"` is the runtime-gate
 * failure (too old / unparseable), carrying the `SlimSkippedFact` fields `makeReady` reports
 * as-is; `"apply"` carries the resolved `slim` options `#applySlimAndReboot` needs.
 */
type SlimPlan =
  | { readonly kind: "off" }
  | { readonly kind: "skip"; readonly reason: SlimSkippedFact["reason"]; readonly detail: string }
  | { readonly kind: "apply"; readonly slim: SlimOptions };

/**
 * Pure decision step extracted from `makeReady`: given only this device's driver data and the
 * driver's slim options, decides what this boot should do and how long the initial `bootstatus`
 * wait may take. Slim mode off, this device's `full: true` opt-out, and a `"recover"`-purpose
 * call all read as `"off"` -- equivalent from here on (same as-is return, same ordinary boot
 * deadline). `purpose` defaults to `"prepare"`, matching `Driver.makeReady`'s own default.
 */
function planSlimBoot(
  data: IosDriverData,
  slim: SlimOptions | undefined,
  purpose: "prepare" | "recover" = "prepare",
): { readonly plan: SlimPlan; readonly bootstatusTimeoutMs: number } {
  if (purpose === "recover" || slim === undefined || !slim.enabled || data.full === true) {
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
