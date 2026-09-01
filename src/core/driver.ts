import type { Filesystem } from "../ports/index.js";
import type { DeviceSpec, Platform } from "./domain.js";

export interface DeviceRequest {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string;
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

export interface Driver {
  readonly platform: Platform;
  resolveSpec(
    request: DeviceRequest,
    options: { readonly allowDownload: boolean },
  ): Promise<DeviceSpec>;
  provision(spec: DeviceSpec): Promise<DriverDevice>;
  /**
   * Boots the device and returns it with a freshly read `address`. Never trust the address a
   * caller passed in or one captured at `provision` -- an Android console port is assigned per
   * boot, so a device coming back from `shutdown` (or a driver restart) can land on a different
   * one. `deviceId` and the registry-relevant parts of `driverData` do not change.
   */
  makeReady(device: DriverDevice): Promise<DriverDevice>;
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
}

export class RuntimeMissingError extends Error {
  constructor(
    readonly platform: Platform,
    readonly osVersion: string,
  ) {
    super(`Runtime missing for ${platform} ${osVersion}`);
    this.name = "RuntimeMissingError";
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
 * Checked before a driver starts any multi-GB component download/install, so a full disk fails
 * fast with a clear message instead of filling up mid-download (see safety rule 4's spirit --
 * downloads must never surprise the machine they run on). `path` defaults to `"."`, the same
 * convention `CleanupReaper` uses for its own disk-pressure check (`src/core/reaper.ts`): the
 * daemon process's own working-directory volume.
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
