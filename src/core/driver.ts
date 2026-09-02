import type { Filesystem } from "../ports/index.js";
import type { DeviceSpec, DeviceTransitionUpdate, Platform } from "./domain.js";

export interface DeviceRequest {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string;
  /**
   * Platform-neutral request for a device with no driver-side resource reduction -- the
   * iOS driver happens to implement this as "do not slim"; other drivers ignore it. Never
   * read by the core beyond stamping it onto the resolved spec (see `DeviceSpec.full` and
   * the comment where `LeaseAcquisitionCoordinator` does that stamping).
   */
  readonly full?: boolean;
}

export interface DriverDevice {
  readonly deviceId: string;
  readonly driverData: unknown;
  /**
   * The opaque string platform tooling accepts right now -- a simctl UDID for iOS, an adb
   * serial (`emulator-<port>`) for Android. The core carries it without interpreting it; only
   * the owning driver module knows what it means. Unlike `deviceId` (Simlock's own, stable
   * `simlock-`/`simlock_`-prefixed name proving Simlock created the device), this can change
   * across a boot -- see `Driver.makeReady`.
   */
  readonly address: string;
  /**
   * What the driver actually produced for this device, as of its last `makeReady` --
   * platform-neutral so the core can report feature loss without reading a driver's opaque
   * `driverData`. `"reduced"` means the driver cut the device's feature set (the iOS driver's
   * slim mode); `"full"` means it did not. `undefined` means the driver does not reduce
   * anything at all -- today's behaviour, and every non-iOS driver.
   */
  readonly featureProfile?: "full" | "reduced";
}

/**
 * Builds a `DeviceTransitionUpdate` from a driver's freshly re-read device, always including
 * `featureProfile` -- even when the driver returned `undefined`. `transition`'s
 * `{...record, ...update}` spread only clears a stale value when the update object *has* the
 * key; omitting it (as a conditional spread like `...(fp === undefined ? {} : { featureProfile:
 * fp })` does) would let a previous `"reduced"` survive a re-boot where slimming wasn't applied
 * this time, reporting `slim: true` on a device that is actually full-fat.
 * `DeviceTransitionUpdate["featureProfile"]` itself can't say "present but undefined" under
 * `exactOptionalPropertyTypes`, so the object is built with the wider type and cast at the
 * boundary -- the explicit `undefined` here is a deliberate runtime value, not a type-checking
 * gap. Shared by every readiness path that commits a driver's post-`makeReady` result
 * (`ManagedDeviceLifecycle`, `WarmPoolCoordinator`) so they can't drift on this.
 */
export function readyTransitionUpdate(readyDevice: DriverDevice): DeviceTransitionUpdate {
  const update: {
    readonly address: string;
    readonly driverData: unknown;
    readonly featureProfile: "full" | "reduced" | undefined;
  } = {
    address: readyDevice.address,
    driverData: readyDevice.driverData,
    featureProfile: readyDevice.featureProfile,
  };
  return update as DeviceTransitionUpdate;
}

/**
 * Observed boot state of a managed device. `transitioning` covers states a
 * driver cannot settle into `running` or `stopped` yet -- simulators report
 * `Booting` / `Shutting Down`, emulators appear `offline` in `adb devices`
 * before they answer `getprop` -- and must never produce a drift finding.
 */
export type ObservedRunState = "running" | "stopped" | "transitioning";

/**
 * Provenance-mark readings for one managed device. Simlock writes the same
 * token into two regions of a device it owns: one that survives a fresh-state
 * erase and one the erase destroys. Comparing the pair is what makes a foreign
 * erase visible -- an erased device still exists and still boots, so run-state
 * comparison alone can never see it.
 *
 * Where each region lives is the driver's business; the core only compares.
 */
export interface ObservedMark {
  /** Token in the region that survives an erase, or undefined when absent. */
  readonly durable: string | undefined;
  /** Token in the region an erase destroys, or undefined when absent. */
  readonly erasable: string | undefined;
  /**
   * False when the erasable region could not be read at all this tick -- an
   * Android mark lives on the userdata partition and is only reachable over
   * `adb` while the emulator runs. Unreadable is not the same as absent and
   * must never be reported as an erase.
   */
  readonly erasableReadable: boolean;
}

export interface ObservedDevice extends DriverDevice {
  readonly runState: ObservedRunState;
  /** Undefined from drivers that do not implement provenance marks. */
  readonly mark?: ObservedMark;
}

/** Reality observable by a driver without trusting the registry. */
export interface DriverReality {
  /** Devices whose platform-owned name proves that Simlock created them. */
  readonly devices: readonly ObservedDevice[];
  /** Running, Simlock-attributable device processes not necessarily in the registry. */
  readonly processes: readonly DriverDevice[];
}

export interface ReclaimResult {
  readonly state: "ready" | "shutdown";
  readonly strategy: "erase" | "snapshot" | "wipe";
}

export type ReclaimStrategy = ReclaimResult["strategy"];

/**
 * What `estimate` is being asked to price. `reclaim` carries the clean level because it is
 * the input `reclaimStrategy` already selects on, and the strategies it picks between differ
 * by an order of magnitude -- an iOS `erase` runs tens of seconds while an Android `snapshot`
 * restore runs in a few. A single blended reclaim number cannot be right for both, and the
 * callers that consume it (a requester's ETA, `Doctor`'s stalled-transition threshold) are
 * both misled by one that is wrong in the optimistic direction.
 */
export type DriverEstimate =
  | { readonly operation: "provision" }
  | { readonly operation: "boot" }
  | { readonly operation: "reclaim"; readonly clean: "standard" | "full" };

/**
 * What a driver can resolve right now, read from the platform SDK without
 * side effects: resolvable device models plus installed runtimes / system
 * images, and which installed runtime `resolveSpec` would pick by default
 * (the newest). `defaultRuntime` is `undefined` when no runtime is installed.
 */
export interface DriverCatalogEntry {
  readonly models: readonly string[];
  readonly runtimes: readonly string[];
  readonly defaultRuntime: string | undefined;
}

/**
 * A configuration-level problem only the owning driver can see -- reported by `doctor`
 * alongside its own drift findings (`src/core/doctor.ts`'s `driver-advisory` finding kind).
 * Unlike drift, this is never something `--fix` acts on: it describes a standing condition of
 * the driver's own configuration (e.g. a feature silently doing nothing given the installed
 * runtimes), not a divergence between the registry and reality.
 */
export interface DriverAdvisory {
  /** Short kebab-case identifier the driver owns; the core never interprets it. */
  readonly code: string;
  readonly message: string;
}

export interface Driver {
  readonly platform: Platform;
  /**
   * True when this driver may hand back devices with a reduced feature set (the iOS driver's
   * slim mode, when actually enabled), so a caller's `full` request is meaningful and must not
   * share a pool key with a normal one. Optional; a driver that never reduces anything -- the
   * default, and every non-iOS driver -- omits it, equivalent to `false`. Read once per spec
   * resolution by `LeaseAcquisitionCoordinator`, which is the only place `DeviceSpec.full` gets
   * stamped onto a resolved spec.
   */
  readonly reducesFeatures?: boolean;
  resolveSpec(
    request: DeviceRequest,
    options: {
      readonly allowDownload: boolean;
      /**
       * The requester on whose behalf this resolution runs, when known. Optional: a caller that
       * resolves outside of a lease request (e.g. a driver revalidating its own cached spec) has
       * no requester to attribute. Threaded through to a driver's component-install diagnostics
       * so the resulting `component.install-*` events carry it -- see `docs/EVENTS.md`.
       */
      readonly requesterId?: string;
    },
  ): Promise<DeviceSpec>;
  provision(spec: DeviceSpec): Promise<DriverDevice>;
  /**
   * Boots the device and returns it with a freshly read `address`. Never trust the address a
   * caller passed in or one captured at `provision` -- an Android console port is assigned per
   * boot, so a device coming back from `shutdown` (or a driver restart) can land on a different
   * one. `deviceId` and the registry-relevant parts of `driverData` do not change.
   */
  makeReady(
    device: DriverDevice,
    options?: {
      /**
       * What this readiness call is for. `"prepare"` (the default) may do work that changes
       * the device's configuration -- a fresh boot, a driver's own opt-in configuration pass
       * (the iOS driver's slim apply). `"recover"` is the one caller (`ManagedDeviceLifecycle.
       * recoverLeased`, safety rule 2's narrow crash-recovery exception) that reboots a device
       * that is still `leased`: it must do the minimum needed to get that device running again
       * and must never change its configuration, so a driver treats `"recover"` as "boot only,
       * do not apply anything new".
       */
      readonly purpose: "prepare" | "recover";
    },
  ): Promise<DriverDevice>;
  reclaim(
    device: DriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult>;
  reclaimStrategy(options: { readonly clean: "standard" | "full" }): ReclaimStrategy;
  shutdown(device: DriverDevice): Promise<void>;
  destroy(device: DriverDevice): Promise<void>;
  listManaged(): Promise<DriverReality>;
  /** Read-only: must never trigger a runtime / system-image download. */
  listCatalog(): Promise<DriverCatalogEntry>;
  estimate(estimate: DriverEstimate, spec: DeviceSpec): number;
  /**
   * Configuration-level problems only this driver can see -- reported by `doctor` alongside its
   * drift findings. Read-only and side-effect free (same contract as `listCatalog`): it must
   * never trigger a download, boot, or mutate anything. Optional: a driver with nothing to
   * advise omits it.
   */
  advisories?(): Promise<readonly DriverAdvisory[]>;
}

export class RuntimeMissingError extends Error {
  /**
   * Whether a download could plausibly fix this. `true` by default -- a plain "runtime not
   * installed" is exactly what `--allow-download` exists for. A subclass reporting a request
   * no download can ever satisfy (out of the model's pairing range, an installed runtime that
   * does not pair with the model, a version older than Xcode's automatic-download floor) sets
   * this `false` so callers (see the daemon's download-policy suffix) don't point someone at a
   * flag that cannot help.
   */
  readonly downloadable: boolean;

  constructor(
    readonly platform: Platform,
    readonly osVersion: string,
    options?: { readonly downloadable?: boolean },
  ) {
    super(`Runtime missing for ${platform} ${osVersion}`);
    this.name = "RuntimeMissingError";
    this.downloadable = options?.downloadable ?? true;
  }
}

export class UnknownModelError extends Error {
  constructor(
    readonly platform: Platform,
    readonly model: string,
  ) {
    super(`Unknown ${platform} model: ${model}`);
    this.name = "UnknownModelError";
  }
}

export class BootTimeoutError extends Error {
  constructor(readonly deviceId: string) {
    super(`Timed out waiting for device to boot: ${deviceId}`);
    this.name = "BootTimeoutError";
  }
}

export class DriverCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverCrashError";
  }
}

export class InsufficientDiskSpaceError extends Error {
  constructor(
    readonly platform: Platform,
    readonly requiredBytes: number,
    readonly availableBytes: number,
  ) {
    super(
      `Not enough free disk space to install a ${platform} component: needs ~` +
        `${formatGibibytes(requiredBytes)} free, only ${formatGibibytes(availableBytes)} available`,
    );
    this.name = "InsufficientDiskSpaceError";
  }
}

function formatGibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * A component install was refused because a required license/EULA is not accepted --
 * platform-agnostic the same way `RuntimeMissingError` is, so the daemon can map it to a
 * stable error code without importing a driver module. `AndroidLicenseNotAcceptedError` (the
 * only concrete case today) extends this with its own message; a future platform with the same
 * shape of gate would do the same rather than the daemon special-casing Android.
 */
export class LicenseNotAcceptedError extends Error {
  constructor(
    readonly platform: Platform,
    readonly componentName: string,
  ) {
    super(`A license required to install ${componentName} for ${platform} is not accepted`);
    this.name = "LicenseNotAcceptedError";
  }
}

/**
 * Serializes disk-space preflight across concurrent component installs sharing a volume.
 * `assertDiskSpace` alone only ever sees the disk's free space at the instant it is called: two
 * installs racing the same preflight (an iOS runtime download and an Android system-image
 * install, or two of either) can each observe enough free space and both proceed, jointly
 * overfilling the volume neither alone would have. A single shared `DiskSpaceGuard` instance,
 * injected into every driver that installs components (wired once in `src/daemon/main.ts`),
 * fixes that by tracking bytes reserved but not yet released, keyed per path, and checking free
 * space *minus* those outstanding reservations rather than free space alone.
 *
 * `reserve` resolves or throws synchronously with respect to any other in-flight `reserve` call:
 * the only `await` is `filesystem.diskFree`, and the check-then-record step immediately after it
 * runs to completion before any other queued continuation gets a turn (JS's single-threaded
 * run-to-completion semantics), so two concurrent reservations against the same path can never
 * both observe headroom the other has already claimed.
 */
export class DiskSpaceGuard {
  readonly #outstandingBytesByPath = new Map<string, number>();

  /**
   * Reserves `requiredBytes` against `path`'s free space, minus whatever this guard already has
   * outstanding there. Throws `InsufficientDiskSpaceError` (same shape `assertDiskSpace` throws)
   * when the reservation would not fit. On success, returns a release function the caller must
   * invoke exactly once (typically in a `finally`) once the install this reservation was made
   * for has settled, freeing the bytes for the next reservation.
   */
  async reserve(
    filesystem: Pick<Filesystem, "diskFree">,
    platform: Platform,
    requiredBytes: number,
    path = ".",
  ): Promise<() => void> {
    const availableBytes = await filesystem.diskFree(path);
    const outstandingBytes = this.#outstandingBytesByPath.get(path) ?? 0;
    const effectivelyAvailableBytes = availableBytes - outstandingBytes;
    if (effectivelyAvailableBytes < requiredBytes) {
      throw new InsufficientDiskSpaceError(
        platform,
        requiredBytes,
        Math.max(0, effectivelyAvailableBytes),
      );
    }
    this.#outstandingBytesByPath.set(path, outstandingBytes + requiredBytes);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#outstandingBytesByPath.get(path) ?? 0) - requiredBytes;
      if (remaining <= 0) {
        this.#outstandingBytesByPath.delete(path);
      } else {
        this.#outstandingBytesByPath.set(path, remaining);
      }
    };
  }
}

/**
 * Checked before a driver starts any multi-GB component download/install, so a full disk fails
 * fast with a clear message instead of filling up mid-download (see safety rule 4's spirit --
 * downloads must never surprise the machine they run on). `path` defaults to `"."`, the same
 * convention `CleanupReaper` uses for its own disk-pressure check (`src/core/reaper.ts`): the
 * daemon process's own working-directory volume. Single-shot: does not account for another
 * concurrent install's own in-flight reservation -- see `DiskSpaceGuard` for that.
 */
export async function assertDiskSpace(
  filesystem: Pick<Filesystem, "diskFree">,
  platform: Platform,
  requiredBytes: number,
  path = ".",
): Promise<void> {
  const availableBytes = await filesystem.diskFree(path);
  if (availableBytes < requiredBytes) {
    throw new InsufficientDiskSpaceError(platform, requiredBytes, availableBytes);
  }
}
