import type { Clock } from "../ports/index.js";
import type { DeviceSpec, Platform } from "./domain.js";
import {
  type DeviceRequest,
  type Driver,
  type DriverDevice,
  RuntimeMissingError,
  UnknownModelError,
} from "./driver.js";

export type FakeDriverOperation =
  | "resolveSpec"
  | "provision"
  | "makeReady"
  | "reclaim"
  | "shutdown"
  | "destroy";

export type DriverEstimateOperation = "provision" | "boot" | "reclaim";

export interface FakeDriverCall {
  readonly arguments: readonly unknown[];
  readonly operation: FakeDriverOperation;
}

export interface FakeDriverOptions {
  readonly availableOsVersions?: readonly string[];
  readonly clock: Clock;
  readonly estimateMs?: Partial<Record<DriverEstimateOperation, number>>;
  readonly knownModels?: readonly string[];
  readonly latencyMs?: Partial<Record<FakeDriverOperation, number>>;
  readonly platform: Platform;
  readonly reclaimResult?: "ready" | "shutdown";
  readonly reclaimStrategy?: "erase" | "snapshot" | "wipe";
}

export class FakeDriverUnknownDeviceError extends Error {
  constructor(readonly deviceId: string) {
    super(`Unknown fake driver device: ${deviceId}`);
    this.name = "FakeDriverUnknownDeviceError";
  }
}

export class FakeDriver implements Driver {
  readonly platform: Platform;
  readonly #availableOsVersions: Set<string>;
  readonly #callCounts = new Map<FakeDriverOperation, number>();
  readonly #calls: FakeDriverCall[] = [];
  readonly #clock: Clock;
  readonly #estimateMs: FakeDriverOptions["estimateMs"];
  readonly #failures = new Map<string, Error>();
  #hangMakeReady = false;
  readonly #knownModels: Set<string> | undefined;
  readonly #latencyMs: FakeDriverOptions["latencyMs"];
  #nextDeviceNumber = 1;
  readonly #pendingMakeReady: (() => void)[] = [];
  readonly #reclaimResult: "ready" | "shutdown";
  readonly #reclaimStrategy: "erase" | "snapshot" | "wipe";
  readonly #devices = new Map<string, "provisioned" | "ready" | "shutdown">();

  constructor(options: FakeDriverOptions) {
    this.#availableOsVersions = new Set(options.availableOsVersions ?? ["latest"]);
    this.#clock = options.clock;
    this.#estimateMs = options.estimateMs;
    this.#knownModels =
      options.knownModels === undefined ? undefined : new Set(options.knownModels);
    this.#latencyMs = options.latencyMs;
    this.platform = options.platform;
    this.#reclaimResult = options.reclaimResult ?? "ready";
    this.#reclaimStrategy = options.reclaimStrategy ?? "wipe";
  }

  get calls(): readonly FakeDriverCall[] {
    return this.#calls.map((call) => ({ ...call, arguments: [...call.arguments] }));
  }

  async resolveSpec(
    request: DeviceRequest,
    options: { readonly allowDownload: boolean },
  ): Promise<DeviceSpec> {
    await this.#beforeCall("resolveSpec", request, options);
    this.#assertMatchingPlatform(request.platform);

    if (this.#knownModels !== undefined && !this.#knownModels.has(request.model)) {
      throw new UnknownModelError(this.platform, request.model);
    }

    const osVersion = request.osVersion ?? newestVersion(this.#availableOsVersions);
    if (osVersion === undefined) {
      throw new RuntimeMissingError(this.platform, "default");
    }
    if (!this.#availableOsVersions.has(osVersion)) {
      if (!options.allowDownload) {
        throw new RuntimeMissingError(this.platform, osVersion);
      }
      this.#availableOsVersions.add(osVersion);
    }

    return { model: request.model, osVersion, platform: this.platform };
  }

  async provision(spec: DeviceSpec): Promise<DriverDevice> {
    await this.#beforeCall("provision", spec);
    this.#assertMatchingPlatform(spec.platform);

    const deviceId = `fake-${this.platform}-${this.#nextDeviceNumber}`;
    this.#nextDeviceNumber += 1;
    this.#devices.set(deviceId, "provisioned");

    return { deviceId, driverData: { fakeDeviceId: deviceId } };
  }

  async makeReady(device: DriverDevice): Promise<void> {
    await this.#beforeCall("makeReady", device);
    this.#requireDevice(device);

    if (this.#hangMakeReady) {
      await new Promise<void>((resolve) => {
        this.#pendingMakeReady.push(resolve);
      });
    }

    this.#devices.set(device.deviceId, "ready");
  }

  async reclaim(
    device: DriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): Promise<{
    readonly state: "ready" | "shutdown";
    readonly strategy: "erase" | "snapshot" | "wipe";
  }> {
    await this.#beforeCall("reclaim", device, options);
    this.#requireDevice(device);
    this.#devices.set(device.deviceId, this.#reclaimResult);
    return { state: this.#reclaimResult, strategy: this.#reclaimStrategy };
  }

  async shutdown(device: DriverDevice): Promise<void> {
    await this.#beforeCall("shutdown", device);
    this.#requireDevice(device);
    this.#devices.set(device.deviceId, "shutdown");
  }

  async destroy(device: DriverDevice): Promise<void> {
    await this.#beforeCall("destroy", device);
    this.#requireDevice(device);
    this.#devices.delete(device.deviceId);
  }

  estimate(operation: DriverEstimateOperation, _spec: DeviceSpec): number {
    return this.#estimateMs?.[operation] ?? 0;
  }

  failOn(operation: FakeDriverOperation, callNumber: number, error: Error): void {
    this.#failures.set(failureKey(operation, callNumber), error);
  }

  hangMakeReady(): void {
    this.#hangMakeReady = true;
  }

  releaseMakeReady(): void {
    this.#hangMakeReady = false;
    for (const resolve of this.#pendingMakeReady.splice(0)) {
      resolve();
    }
  }

  async #beforeCall(operation: FakeDriverOperation, ...arguments_: unknown[]): Promise<void> {
    this.#calls.push({ arguments: arguments_, operation });
    const callNumber = (this.#callCounts.get(operation) ?? 0) + 1;
    this.#callCounts.set(operation, callNumber);
    await this.#delay(this.#latencyMs?.[operation] ?? 0);

    const failure = this.#failures.get(failureKey(operation, callNumber));
    if (failure !== undefined) {
      throw failure;
    }
  }

  #assertMatchingPlatform(platform: Platform): void {
    if (platform !== this.platform) {
      throw new Error(`Fake ${this.platform} driver cannot handle ${platform} requests`);
    }
  }

  #delay(milliseconds: number): Promise<void> {
    if (milliseconds === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.#clock.setTimer(milliseconds, resolve);
    });
  }

  #requireDevice(device: DriverDevice): void {
    if (!this.#devices.has(device.deviceId)) {
      throw new FakeDriverUnknownDeviceError(device.deviceId);
    }
  }
}

function failureKey(operation: FakeDriverOperation, callNumber: number): string {
  return `${operation}:${callNumber}`;
}

function newestVersion(versions: ReadonlySet<string>): string | undefined {
  return [...versions].sort(compareVersions).at(-1);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return left.localeCompare(right);
}
