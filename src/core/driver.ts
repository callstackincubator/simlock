import type { DeviceSpec, Platform } from "./domain.js";

export interface DeviceRequest {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string;
}

export interface DriverDevice {
  readonly deviceId: string;
  readonly driverData: unknown;
}

/**
 * Observed boot state of a managed device. `transitioning` covers states a
 * driver cannot settle into `running` or `stopped` yet -- simulators report
 * `Booting` / `Shutting Down`, emulators appear `offline` in `adb devices`
 * before they answer `getprop` -- and must never produce a drift finding.
 */
export type ObservedRunState = "running" | "stopped" | "transitioning";

/**
 * Provenance-mark readings for one managed device. Pitlane writes the same
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
  /** Devices whose platform-owned name proves that Pitlane created them. */
  readonly devices: readonly ObservedDevice[];
  /** Running, Pitlane-attributable device processes not necessarily in the registry. */
  readonly processes: readonly DriverDevice[];
}

export interface ReclaimResult {
  readonly state: "ready" | "shutdown";
  readonly strategy: "erase" | "snapshot" | "wipe";
}

export type ReclaimStrategy = ReclaimResult["strategy"];

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
  makeReady(device: DriverDevice): Promise<void>;
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
  estimate(operation: "provision" | "boot" | "reclaim", spec: DeviceSpec): number;
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
