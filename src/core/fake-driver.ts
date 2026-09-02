import type { Clock } from "../ports/index.js";
import type { DeviceSpec, Platform } from "./domain.js";
import {
  type DeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverDevice,
  type DriverEstimate,
  type DriverReality,
  type ObservedRunState,
  RuntimeMissingError,
  UnknownModelError,
} from "./driver.js";

export type FakeDriverOperation =
  | "resolveSpec"
  | "provision"
  | "makeReady"
  | "reclaim"
  | "shutdown"
  | "destroy"
  | "listManaged"
  | "listCatalog";

export type DriverEstimateOperation = "provision" | "boot" | "reclaim";

export interface FakeDriverCall {
  readonly arguments: readonly unknown[];
  readonly operation: FakeDriverOperation;
}

export interface FakeDriverOptions {
  readonly availableOsVersions?: readonly string[];
  readonly clock: Clock;
  /** Stands in for a real driver's owned root; nothing here validates or creates it. */
  readonly deviceRoot?: string;
  readonly estimateMs?: Partial<Record<DriverEstimateOperation, number>>;
  /**
   * Reclaim estimate for a `full` clean, when a test needs the two clean levels priced apart
   * the way a real driver prices them (an Android `snapshot` against a `wipe`). Falls back to
   * `estimateMs.reclaim`, so a test that does not care about the split says nothing.
   */
  readonly fullCleanReclaimEstimateMs?: number;
  readonly knownModels?: readonly string[];
  readonly latencyMs?: Partial<Record<FakeDriverOperation, number>>;
  /** What a grant for this driver's devices should carry; empty unless a test says otherwise. */
  readonly leaseEnvironment?: Readonly<Record<string, string>>;
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
  readonly deviceRoot: string;
  readonly #availableOsVersions: Set<string>;
  readonly #callCounts = new Map<FakeDriverOperation, number>();
  readonly #calls: FakeDriverCall[] = [];
  readonly #clock: Clock;
  readonly #estimateMs: FakeDriverOptions["estimateMs"];
  readonly #fullCleanReclaimEstimateMs: number | undefined;
  readonly #failures = new Map<string, Error>();
  #hangMakeReady = false;
  readonly #knownModels: Set<string> | undefined;
  readonly #latencyMs: FakeDriverOptions["latencyMs"];
  readonly #leaseEnvironment: Readonly<Record<string, string>>;
  #nextDeviceNumber = 1;
  readonly #pendingMakeReady: (() => void)[] = [];
  readonly #reclaimResult: "ready" | "shutdown";
  readonly #reclaimStrategy: "erase" | "snapshot" | "wipe";
  readonly #devices = new Map<string, "provisioned" | "ready" | "shutdown">();
  /** Bumped on every `makeReady` boot -- mirrors a real driver reassigning a port per boot. */
  readonly #bootCounts = new Map<string, number>();
  #managedReality: DriverReality | undefined;

  constructor(options: FakeDriverOptions) {
    this.#availableOsVersions = new Set(options.availableOsVersions ?? ["latest"]);
    this.#clock = options.clock;
    this.#estimateMs = options.estimateMs;
    this.#fullCleanReclaimEstimateMs = options.fullCleanReclaimEstimateMs;
    this.#knownModels =
      options.knownModels === undefined ? undefined : new Set(options.knownModels);
    this.#latencyMs = options.latencyMs;
    this.#leaseEnvironment = options.leaseEnvironment ?? {};
    this.platform = options.platform;
    this.deviceRoot = options.deviceRoot ?? `/fake/${options.platform}`;
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

    return { address: addressFor(deviceId, 0), deviceId, driverData: { fakeDeviceId: deviceId } };
  }

  /** Each boot re-reads a fresh address, same as the real drivers -- never the caller's. */
  async makeReady(device: DriverDevice): Promise<DriverDevice> {
    await this.#beforeCall("makeReady", device);
    this.#requireDevice(device);

    if (this.#hangMakeReady) {
      await new Promise<void>((resolve) => {
        this.#pendingMakeReady.push(resolve);
      });
    }

    this.#devices.set(device.deviceId, "ready");
    const bootCount = (this.#bootCounts.get(device.deviceId) ?? 0) + 1;
    this.#bootCounts.set(device.deviceId, bootCount);
    return {
      address: addressFor(device.deviceId, bootCount),
      deviceId: device.deviceId,
      driverData: device.driverData,
    };
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

  reclaimStrategy(_options: {
    readonly clean: "standard" | "full";
  }): "erase" | "snapshot" | "wipe" {
    return this.#reclaimStrategy;
  }

  async shutdown(device: DriverDevice): Promise<void> {
    await this.#beforeCall("shutdown", device);
    this.#requireDevice(device);
    this.#devices.set(device.deviceId, "shutdown");
    this.#managedReality = removeManagedProcess(this.#managedReality, device.deviceId);
  }

  async destroy(device: DriverDevice): Promise<void> {
    await this.#beforeCall("destroy", device);
    this.#requireDevice(device);
    this.#devices.delete(device.deviceId);
    this.#managedReality = removeManagedDevice(this.#managedReality, device.deviceId);
  }

  async listManaged(): Promise<DriverReality> {
    await this.#beforeCall("listManaged");
    if (this.#managedReality !== undefined) {
      return cloneReality(this.#managedReality);
    }
    return {
      devices: [...this.#devices.entries()].map(([deviceId, status]) => ({
        address: addressFor(deviceId, this.#bootCounts.get(deviceId) ?? 0),
        deviceId,
        driverData: { fakeDeviceId: deviceId },
        runState: runStateFor(status),
      })),
      processes: [],
    };
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    await this.#beforeCall("listCatalog");
    const runtimes = [...this.#availableOsVersions].sort(compareVersions);
    return {
      defaultRuntime: newestVersion(this.#availableOsVersions),
      models: this.#knownModels === undefined ? [] : [...this.#knownModels],
      runtimes,
    };
  }

  estimate(estimate: DriverEstimate, _spec: DeviceSpec): number {
    if (estimate.operation === "reclaim" && estimate.clean === "full") {
      return this.#fullCleanReclaimEstimateMs ?? this.#estimateMs?.reclaim ?? 0;
    }
    return this.#estimateMs?.[estimate.operation] ?? 0;
  }

  leaseEnvironment(): Readonly<Record<string, string>> {
    return this.#leaseEnvironment;
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

  /**
   * Stages what `listManaged` reports. Everything passed in is reported back, name and
   * all: a real driver answers from what sits inside the root it owns, so a double that
   * screened entries by prefix would be modelling ownership Simlock stopped inferring
   * (safety rule 8).
   */
  setManagedReality(reality: DriverReality): void {
    this.#managedReality = cloneReality(reality);
    for (const device of reality.devices) {
      this.#devices.set(device.deviceId, statusFor(device.runState));
    }
    for (const device of reality.processes) {
      if (!this.#devices.has(device.deviceId)) {
        this.#devices.set(device.deviceId, "ready");
      }
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

function addressFor(deviceId: string, bootCount: number): string {
  return `${deviceId}-addr-${bootCount}`;
}

function runStateFor(status: "provisioned" | "ready" | "shutdown"): ObservedRunState {
  switch (status) {
    case "ready":
      return "running";
    case "shutdown":
      return "stopped";
    case "provisioned":
      return "transitioning";
  }
}

function statusFor(runState: ObservedRunState): "provisioned" | "ready" | "shutdown" {
  switch (runState) {
    case "running":
      return "ready";
    case "stopped":
      return "shutdown";
    case "transitioning":
      return "provisioned";
  }
}

function cloneReality(reality: DriverReality): DriverReality {
  return {
    devices: reality.devices.map((device) => ({ ...device })),
    processes: reality.processes.map((device) => ({ ...device })),
  };
}

function removeManagedDevice(
  reality: DriverReality | undefined,
  deviceId: string,
): DriverReality | undefined {
  if (reality === undefined) return undefined;
  return { ...reality, devices: reality.devices.filter((device) => device.deviceId !== deviceId) };
}

function removeManagedProcess(
  reality: DriverReality | undefined,
  deviceId: string,
): DriverReality | undefined {
  if (reality === undefined) return undefined;
  return {
    ...reality,
    processes: reality.processes.filter((device) => device.deviceId !== deviceId),
  };
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
