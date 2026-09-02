import {
  BootTimeoutError,
  type DeviceRequest,
  DiskSpaceGuard,
  type Driver,
  type DriverCatalogEntry,
  type DriverDevice,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  InsufficientDiskSpaceError,
  type ObservedDevice,
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
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
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
  readonly processRunner: ProcessRunner;
  /** Slim mode; omitted or `enabled: false` means today's behaviour exactly. */
  readonly slim?: {
    readonly enabled: boolean;
    readonly categories?: readonly string[];
    readonly bootTimeoutMs: number;
  };
}

type SlimOptions = NonNullable<IosSimctlDriverOptions["slim"]>;

/** Result of `#applySlimLabels`: either every label was attempted (some may still have failed
 * individually, tracked in `failedLabels`), or the whole apply never ran. */
type SlimApplyOutcome =
  | { readonly kind: "applied"; readonly failedLabels: readonly string[] }
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
  readonly #slim: SlimOptions | undefined;
  #devicesRoot: string | undefined;

  constructor(options: IosSimctlDriverOptions) {
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
    this.#slim = options.slim;
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
    const name = `simlock-${this.#idGenerator.generate()}`;
    const result = await this.#simctl(
      ["create", name, resolved.deviceType.identifier, resolved.runtime.identifier],
      COMMAND_TIMEOUT_MS,
    );
    const udid = result.stdout.trim();

    if (udid === "") {
      throw new DriverCrashError("simctl create returned no device UDID");
    }

    const dataPath = await this.#dataPathFor(udid);
    if (dataPath !== undefined) {
      await this.#writeMark(udid, dataPath);
    }

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
   */
  async makeReady(device: DriverDevice): Promise<DriverDevice> {
    const data = iosDriverData(device);
    const { plan, bootstatusTimeoutMs } = planSlimBoot(data, this.#slim);

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

  /** The device's current `address`/`driverData`, unmodified, tagged with the feature profile. */
  #asIs(
    device: DriverDevice,
    data: IosDriverData,
    featureProfile: "full" | "reduced",
  ): DriverDevice {
    return {
      address: data.udid,
      deviceId: device.deviceId,
      driverData: device.driverData,
      featureProfile,
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
      return this.#skipApply(
        device,
        data,
        `none of the configured slim categories (${(slim.categories ?? []).join(", ")}) are known`,
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
      return this.#skipApply(device, data, applyOutcome.detail);
    }

    // The reboot below is what makes the disable entries take effect; never write the
    // idempotence marker or report `device.slimmed` on a device that hasn't actually rebooted
    // with them applied.
    await this.#shutdown(data.udid);
    await this.#bootAndWait(data.udid, device.deviceId, bootstatusTimeoutMs);

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
  #skipApply(device: DriverDevice, data: IosDriverData, detail: string): DriverDevice {
    this.#onSlimSkipped?.({ deviceId: device.deviceId, detail, reason: "apply-failed" });
    return this.#asIs(device, data, "full");
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
    const dataPath = await this.#dataPathFor(data.udid);
    const currentToken =
      dataPath === undefined ? undefined : await this.#readToken(`${dataPath}/${MARK_FILE_NAME}`);

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
      unknownLabels: [...resolved.unknown, ...applyOutcome.failedLabels],
    });

    return {
      address: data.udid,
      deviceId: device.deviceId,
      driverData: newDriverData,
      featureProfile: "reduced",
    };
  }

  /**
   * Batches `launchctl disable system/<label>` calls into shell loops of at most
   * `SLIM_CHUNK_SIZE`, one `simctl spawn` per chunk -- ~170 individual spawns would dominate the
   * slim budget (see `SLIM_CHUNK_SIZE`'s comment). Each label that `launchctl disable` itself
   * rejects (e.g. renamed/removed between runtimes) is caught by the script's own `|| echo` and
   * reported back, never thrown (ADR point 8) -- only a chunk that fails to run at all (timeout,
   * nonzero exit from the `sh -c` invocation itself) is treated as that chunk's labels failing
   * outright. The whole apply is reported as failed only when *no* chunk ran successfully.
   */
  async #applySlimLabels(udid: string, labels: readonly string[]): Promise<SlimApplyOutcome> {
    const { safe, rejected } = sanitizeSlimLabels(labels);
    if (safe.length === 0) {
      return { detail: "no labels passed the shell-safety filter", kind: "failed" };
    }

    const chunks = chunk(safe, SLIM_CHUNK_SIZE);
    const failedLabels: string[] = [...rejected];
    let anyChunkSucceeded = false;

    for (const chunkLabels of chunks) {
      const script =
        `for l in ${chunkLabels.join(" ")}; do launchctl disable "system/$l" ` +
        `>/dev/null 2>&1 || echo "${SLIM_FAILED_MARKER} $l"; done`;
      const outcome = await this.#invokeSimctl(
        ["spawn", udid, "/bin/sh", "-c", script],
        SLIM_CHUNK_TIMEOUT_MS,
      );

      if (outcome.kind === "timed-out" || outcome.result.code !== 0) {
        failedLabels.push(...chunkLabels);
        continue;
      }

      anyChunkSucceeded = true;
      for (const line of outcome.result.stdout.split("\n")) {
        const match = /^simlock-slim-failed (\S+)$/.exec(line.trim());
        if (match?.[1] !== undefined) {
          failedLabels.push(match[1]);
        }
      }
    }

    if (!anyChunkSucceeded) {
      return { detail: `all ${String(chunks.length)} chunk(s) failed to run`, kind: "failed" };
    }

    return { failedLabels, kind: "applied" };
  }

  async reclaim(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): Promise<{ readonly state: "shutdown"; readonly strategy: "erase" }> {
    const data = iosDriverData(device);
    await this.#shutdown(data.udid);
    await this.#simctl(["erase", data.udid], COMMAND_TIMEOUT_MS);

    const dataPath = await this.#dataPathFor(data.udid);
    if (dataPath !== undefined) {
      await this.#writeMark(data.udid, dataPath);
    }

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

  async listManaged(): Promise<DriverReality> {
    const result = await this.#simctl(["list", "-j", "devices"], COMMAND_TIMEOUT_MS);
    const parsed = parseManagedDevices(JSON.parse(result.stdout) as unknown);
    this.#rememberDevicesRoot(parsed);
    const devices: ObservedDevice[] = await Promise.all(
      parsed.map(async (device) => {
        const mark = await this.#readMark(device.dataPath);
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

  estimate(estimate: DriverEstimate, _spec: DeviceSpec): number {
    switch (estimate.operation) {
      case "provision":
        return PROVISION_ESTIMATE_MS;
      case "boot":
        // Slim mode pays for a second boot plus a launchctl-disable pass on top of the usual
        // one -- quoting the plain cold-boot number here would make `doctor` flag every slim
        // device as stalled.
        return this.#slim?.enabled === true ? SLIM_BOOT_ESTIMATE_MS : COLD_BOOT_ESTIMATE_MS;
      case "reclaim":
        // `reclaimStrategy` returns `erase` for both clean levels, so there is nothing to
        // branch on here -- the clean level only matters to a driver that has a fast path.
        return ERASE_ESTIMATE_MS;
    }
  }

  /**
   * Data-container path for a device. `simctl create` returns only the UDID,
   * and a `simctl list` costs ~260ms -- enough to matter on `reclaim`, which
   * runs on every release. So the devices root is learned once from simctl's
   * own answer and every later lookup is derived from it, keeping the extra
   * subprocess off the lease path. Falls back to listing until something has
   * primed the root.
   */
  async #dataPathFor(udid: string): Promise<string | undefined> {
    if (this.#devicesRoot !== undefined) {
      return `${this.#devicesRoot}/${udid}/data`;
    }
    const result = await this.#simctl(["list", "-j", "devices"], COMMAND_TIMEOUT_MS);
    const parsed = parseManagedDevices(JSON.parse(result.stdout) as unknown);
    this.#rememberDevicesRoot(parsed);
    return parsed.find((device) => device.udid === udid)?.dataPath;
  }

  /** `<devicesRoot>/<UDID>/data` -- two levels up from any device's data container. */
  #rememberDevicesRoot(devices: readonly ParsedManagedDevice[]): void {
    if (this.#devicesRoot !== undefined) return;
    const dataPath = devices.find((device) => device.dataPath !== undefined)?.dataPath;
    if (dataPath === undefined) return;
    const root = parentDirectory(parentDirectory(dataPath));
    if (root !== "/") this.#devicesRoot = root;
  }

  /**
   * Writes the same provenance token into both regions of a device: the
   * device root (durable -- survives `simctl erase`) and the data container
   * (erasable -- destroyed by it). Both halves are written together so a
   * partial write never reads as drift.
   */
  async #writeMark(udid: string, dataPath: string): Promise<void> {
    const token = this.#idGenerator.generate();
    const contents = JSON.stringify({
      token,
      udid,
      writtenAt: new Date(this.#clock.now()).toISOString(),
    });
    const durablePath = `${parentDirectory(dataPath)}/${MARK_FILE_NAME}`;
    const erasablePath = `${dataPath}/${MARK_FILE_NAME}`;

    await Promise.all([
      this.#filesystem.writeFileAtomic(durablePath, contents),
      this.#filesystem.writeFileAtomic(erasablePath, contents),
    ]);
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
  async #readMark(dataPath: string | undefined): Promise<ObservedMark | undefined> {
    if (dataPath === undefined) {
      return undefined;
    }

    const durable = await this.#readToken(`${parentDirectory(dataPath)}/${MARK_FILE_NAME}`);
    const erasable = await this.#readToken(`${dataPath}/${MARK_FILE_NAME}`);

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
    const outcome = await this.#invokeSimctl(args, timeoutMs);

    if (outcome.kind === "timed-out") {
      throw new DriverCrashError(`simctl ${args.join(" ")} timed out after ${timeoutMs}ms`);
    }

    this.#assertSuccessful(args, outcome.result);
    return outcome.result;
  }

  async #invokeSimctl(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    let process;
    try {
      process = this.#processRunner.spawn("xcrun", ["simctl", ...args], { timeoutMs });
    } catch (error: unknown) {
      throw new DriverCrashError(
        `Could not start simctl ${args.join(" ")}: ${errorMessage(error)}`,
      );
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
      throw new DriverCrashError(`simctl ${args.join(" ")} failed: ${errorMessage(error)}`);
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

interface ParsedManagedDevice {
  readonly dataPath: string | undefined;
  readonly name: string;
  readonly runState: ObservedRunState;
  readonly udid: string;
}

// fallow-ignore-next-line complexity -- runtime-keyed device JSON is walked and filtered in one pass by design.
function parseManagedDevices(value: unknown): ParsedManagedDevice[] {
  if (!isRecord(value) || !isRecord(value.devices)) {
    throw new DriverCrashError("Invalid simctl device list JSON");
  }
  const devices: ParsedManagedDevice[] = [];
  for (const runtimeDevices of Object.values(value.devices)) {
    if (!Array.isArray(runtimeDevices)) continue;
    for (const device of runtimeDevices) {
      if (!isRecord(device) || typeof device.name !== "string" || typeof device.udid !== "string") {
        continue;
      }
      if (!device.name.startsWith("simlock-")) continue;
      devices.push({
        dataPath: typeof device.dataPath === "string" ? device.dataPath : undefined,
        name: device.name,
        runState: simctlRunState(device.state),
        udid: device.udid,
      });
    }
  }
  return devices;
}

/** Mirrors `parentPath` in the `Filesystem` port: the parent of a `dataPath` is the device root. */
function parentDirectory(path: string): string {
  const lastSeparator = path.lastIndexOf("/");
  return lastSeparator <= 0 ? "/" : path.slice(0, lastSeparator);
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
 * wait may take. Slim mode off, or this device's `full: true` opt-out, both read as `"off"` --
 * the two are equivalent from here on (same as-is return, same ordinary boot deadline).
 */
function planSlimBoot(
  data: IosDriverData,
  slim: SlimOptions | undefined,
): { readonly plan: SlimPlan; readonly bootstatusTimeoutMs: number } {
  if (slim === undefined || !slim.enabled || data.full === true) {
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
