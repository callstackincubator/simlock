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

/** Reality observable by a driver without trusting the registry. */
export interface DriverReality {
  /** Devices whose platform-owned name proves that Pitlane created them. */
  readonly devices: readonly DriverDevice[];
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
