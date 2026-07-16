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

export interface ReclaimResult {
  readonly state: "ready" | "shutdown";
  readonly strategy: "erase" | "snapshot" | "wipe";
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
  shutdown(device: DriverDevice): Promise<void>;
  destroy(device: DriverDevice): Promise<void>;
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
