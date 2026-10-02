import type { Clock } from "../ports/index.js";
import type { DeviceMode, DeviceSpec, Platform } from "./domain.js";
import {
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type DeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverCatalogImage,
  type DriverComponent,
  type DriverDevice,
  type DriverEstimate,
  type DriverReality,
  type InstalledComponent,
  type LegacyDevice,
  type ObservedRunState,
  type PassthroughCommand,
  PassthroughRefusedError,
  type PassthroughContext,
  RuntimeMissingError,
  UnknownModelError,
} from "./driver.js";

export type FakeDriverOperation =
  | "resolveSpec"
  | "findComponent"
  | "installComponent"
  | "provision"
  | "makeReady"
  | "reclaim"
  | "shutdown"
  | "destroy"
  | "listManaged"
  | "listCatalog"
  | "listComponents"
  /** Recorded like every other call, so a test can pin that it precedes the first destroy. */
  | "revalidateRoot"
  | "findLegacy"
  | "destroyLegacy";

export type DriverEstimateOperation = "provision" | "boot" | "reclaim";

export interface FakeDriverCall {
  readonly arguments: readonly unknown[];
  readonly operation: FakeDriverOperation;
}

export interface FakeDriverOptions {
  readonly availableOsVersions?: readonly string[];
  readonly clock: Clock;
  /** What `componentFootprint` states. Defaults to nothing to reserve, at the device root. */
  readonly componentFootprint?: { readonly path: string; readonly bytes: number };
  /** The percentages every `installComponent` reports through `onProgress`, in order. */
  readonly installProgress?: readonly number[];
  /** What `listComponents` reports as each version's size; absent for a version left out. */
  readonly componentSizes?: Readonly<Record<string, number>>;
  /** What `listComponents` reports as each version's foreign devices; 0 for one left out. */
  readonly foreignDevices?: Readonly<Record<string, number>>;
  /** Stands in for a real driver's owned root; nothing here validates or creates it. */
  readonly deviceRoot?: string;
  readonly estimateMs?: Partial<Record<DriverEstimateOperation, number>>;
  /**
   * Reclaim estimate for a `full` clean, when a test needs the two clean levels priced apart
   * the way a real driver prices them (an Android `snapshot` against a `wipe`). Falls back to
   * `estimateMs.reclaim`, so a test that does not care about the split says nothing.
   */
  readonly fullCleanReclaimEstimateMs?: number;
  /**
   * The `DriverDevice.mode` `makeReady` reports for every boot, overriding what it would
   * otherwise report -- settable by a test that needs a slim pass that did not happen, or the
   * core's `mode` persistence without a real iOS driver.
   */
  readonly mode?: DeviceMode | undefined;
  /**
   * The OS versions this fake can slim. A slim request on one of them resolves to a slim spec,
   * and a prepare boot of a slim-spec device reports `"slim"`. Absent or empty: this fake knows
   * nothing of modes, like every real driver but iOS, and every request resolves to a full spec.
   */
  readonly slimmableOsVersions?: readonly string[];
  readonly knownModels?: readonly string[];
  /**
   * What `listCatalog` reports a model pairs with. A model left out pairs with every available
   * version, which is also the default for every model.
   */
  readonly modelRuntimes?: Readonly<Record<string, readonly string[]>>;
  /** What `listCatalog` reports as other names per model; none unless a test says otherwise. */
  readonly modelAliases?: Readonly<Record<string, readonly string[]>>;
  /** What `listCatalog` reports as installed images; the field is absent unless set. */
  readonly images?: readonly DriverCatalogImage[];
  readonly latencyMs?: Partial<Record<FakeDriverOperation, number>>;
  /** What a grant for this driver's devices should carry; empty unless a test says otherwise. */
  readonly leaseEnvironment?: Readonly<Record<string, string>>;
  /**
   * The `simlock <tool>` name this fake claims, when a test needs one. Absent by default so
   * two fakes in one catalog do not both answer to the same tool.
   */
  readonly passthroughTool?: string;
  /**
   * Builds the scoped command for that tool. Throw `PassthroughRefusedError` from here to
   * model a driver's own refusal rules; omit it and every argument list is refused, which
   * is what a driver claiming a tool it cannot build a command for would mean.
   */
  readonly passthrough?: (
    args: readonly string[],
    context?: PassthroughContext,
  ) => PassthroughCommand;
  readonly platform: Platform;
  /**
   * What this driver claims to find outside its root for a given device id, keyed by
   * `driverDeviceId`. Empty by default: a driver that has never had a pre-root life finds
   * nothing, which is what keeps every other test's missing device simply missing.
   */
  readonly legacyDevices?: Readonly<Record<string, LegacyDevice>>;
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
  /** One receipt per installed version; an install replaces it with a new one. */
  readonly #receipts: Map<string, ComponentReceipt>;
  #installCount = 0;
  readonly #install: Pick<
    FakeDriverOptions,
    "componentFootprint" | "componentSizes" | "foreignDevices" | "installProgress"
  >;
  #holdInstalls = false;
  readonly #pendingInstalls: (() => void)[] = [];
  readonly #callCounts = new Map<FakeDriverOperation, number>();
  readonly #calls: FakeDriverCall[] = [];
  readonly #clock: Clock;
  readonly #estimateMs: FakeDriverOptions["estimateMs"];
  readonly #mode: DeviceMode | undefined;
  readonly #slimmableOsVersions: ReadonlySet<string>;
  readonly #fullCleanReclaimEstimateMs: number | undefined;
  readonly #failures = new Map<string, Error>();
  #hangMakeReady = false;
  readonly #knownModels: Set<string> | undefined;
  readonly #modelRuntimes: FakeDriverOptions["modelRuntimes"];
  readonly #modelAliases: FakeDriverOptions["modelAliases"];
  readonly #images: FakeDriverOptions["images"];
  readonly #latencyMs: FakeDriverOptions["latencyMs"];
  readonly #leaseEnvironment: Readonly<Record<string, string>>;
  readonly passthroughTool: string | undefined;
  readonly #passthrough:
    | ((args: readonly string[], context?: PassthroughContext) => PassthroughCommand)
    | undefined;
  #nextDeviceNumber = 1;
  readonly #pendingMakeReady: (() => void)[] = [];
  readonly #reclaimResult: "ready" | "shutdown";
  readonly #reclaimStrategy: "erase" | "snapshot" | "wipe";
  readonly #devices = new Map<string, "provisioned" | "ready" | "shutdown">();
  readonly #legacyDevices: Map<string, LegacyDevice>;
  /** Bumped on every `makeReady` boot -- mirrors a real driver reassigning a port per boot. */
  readonly #bootCounts = new Map<string, number>();
  #managedReality: DriverReality | undefined;

  constructor(options: FakeDriverOptions) {
    this.#availableOsVersions = new Set(options.availableOsVersions ?? ["latest"]);
    this.#clock = options.clock;
    this.#estimateMs = options.estimateMs;
    this.#mode = options.mode;
    this.#slimmableOsVersions = new Set(options.slimmableOsVersions ?? []);
    this.#fullCleanReclaimEstimateMs = options.fullCleanReclaimEstimateMs;
    this.#knownModels =
      options.knownModels === undefined ? undefined : new Set(options.knownModels);
    this.#modelRuntimes = options.modelRuntimes;
    this.#modelAliases = options.modelAliases;
    this.#images = options.images;
    this.#latencyMs = options.latencyMs;
    this.#leaseEnvironment = options.leaseEnvironment ?? {};
    this.#legacyDevices = new Map(Object.entries(options.legacyDevices ?? {}));
    this.passthroughTool = options.passthroughTool;
    this.#passthrough = options.passthrough;
    this.platform = options.platform;
    this.deviceRoot = options.deviceRoot ?? `/fake/${options.platform}`;
    this.#reclaimResult = options.reclaimResult ?? "ready";
    this.#reclaimStrategy = options.reclaimStrategy ?? "wipe";
    this.#install = options;
    this.#receipts = preinstalledReceipts(this.#availableOsVersions);
  }

  get componentFootprint(): { readonly path: string; readonly bytes: number } {
    return this.#install.componentFootprint ?? { bytes: 0, path: this.deviceRoot };
  }

  get calls(): readonly FakeDriverCall[] {
    return this.#calls.map((call) => ({ ...call, arguments: [...call.arguments] }));
  }

  /**
   * Succeeds unless a test fails it through `failOn`. A real driver re-runs the filesystem
   * checks here; the fake only has to be refusable, since what `Doctor` does with a refusal
   * is the behaviour under test.
   */
  async revalidateRoot(): Promise<void> {
    await this.#beforeCall("revalidateRoot");
  }

  async findLegacy(driverDeviceId: string): Promise<LegacyDevice | undefined> {
    await this.#beforeCall("findLegacy", driverDeviceId);
    return this.#legacyDevices.get(driverDeviceId);
  }

  async destroyLegacy(device: DriverDevice): Promise<void> {
    await this.#beforeCall("destroyLegacy", device);
    this.#legacyDevices.delete(device.deviceId);
  }

  /** Never installs: a version that is not available throws, naming it as the component. */
  async resolveSpec(request: DeviceRequest): Promise<DeviceSpec> {
    await this.#beforeCall("resolveSpec", request);
    this.#assertMatchingPlatform(request.platform);

    if (this.#knownModels !== undefined && !this.#knownModels.has(request.model)) {
      throw new UnknownModelError(this.platform, request.model);
    }

    const osVersion = request.osVersion ?? newestVersion(this.#availableOsVersions);
    if (osVersion === undefined) {
      throw new RuntimeMissingError(this.platform, "default", { component: "latest" });
    }
    if (!this.#availableOsVersions.has(osVersion)) {
      throw new RuntimeMissingError(this.platform, osVersion, { component: osVersion });
    }

    return {
      model: request.model,
      osVersion,
      platform: this.platform,
      ...(request.mode === "slim" && this.#slimmableOsVersions.has(osVersion)
        ? { mode: "slim" as const }
        : {}),
    };
  }

  /** `"latest"` is not a version, so it is never found here -- only an install run can tell. */
  async findComponent(component: string): Promise<InstalledComponent | undefined> {
    await this.#beforeCall("findComponent", component);
    return this.#installed(component);
  }

  /**
   * Makes `component` available and logs the call. `"latest"` is the newest available version,
   * or a version called `latest` when there is none. Scripted through `failOn("installComponent",
   * n, error)`, `holdInstalls()` (it then waits for `releaseInstalls()` or its signal) and the
   * `installProgress` option.
   */
  async installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult> {
    await this.#beforeCall("installComponent", component);
    for (const percent of this.#install.installProgress ?? []) {
      options.onProgress({ percent, stage: "downloading" });
    }
    if (this.#holdInstalls) await this.#heldInstall(options.signal);
    const version =
      component === "latest" ? (newestVersion(this.#availableOsVersions) ?? component) : component;
    const existing = this.#installed(version);
    if (existing !== undefined) return { ...existing, outcome: "already-installed" };
    this.#installCount += 1;
    const receipt = { install: String(this.#installCount), version };
    this.#availableOsVersions.add(version);
    this.#receipts.set(version, receipt);
    return { outcome: "installed", receipt, version };
  }

  /**
   * One entry per available version, with the receipt `findComponent` and `installComponent`
   * report for it, and the scripted size and foreign devices.
   */
  async listComponents(): Promise<readonly DriverComponent[]> {
    await this.#beforeCall("listComponents");
    return [...this.#availableOsVersions].flatMap((version): DriverComponent[] => {
      const installed = this.#installed(version);
      if (installed === undefined) return [];
      const sizeBytes = this.#install.componentSizes?.[version];
      return [
        {
          ...installed,
          foreignDevices: this.#install.foreignDevices?.[version] ?? 0,
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        },
      ];
    });
  }

  holdInstalls(): void {
    this.#holdInstalls = true;
  }

  releaseInstalls(): void {
    this.#holdInstalls = false;
    for (const resolve of this.#pendingInstalls.splice(0)) resolve();
  }

  #installed(version: string): InstalledComponent | undefined {
    const receipt = this.#receipts.get(version);
    return this.#availableOsVersions.has(version) && receipt !== undefined
      ? { receipt: { ...receipt }, version }
      : undefined;
  }

  #heldInstall(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      this.#pendingInstalls.push(resolve);
      signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
    });
  }

  async provision(spec: DeviceSpec): Promise<DriverDevice> {
    await this.#beforeCall("provision", spec);
    this.#assertMatchingPlatform(spec.platform);

    const deviceId = `fake-${this.platform}-${this.#nextDeviceNumber}`;
    this.#nextDeviceNumber += 1;
    this.#devices.set(deviceId, "provisioned");

    return { address: addressFor(deviceId, 0), deviceId, driverData: { fakeDeviceId: deviceId } };
  }

  /**
   * Each boot re-reads a fresh address, same as the real drivers -- never the caller's.
   * `options` is recorded on the call log (`calls`) so a test can assert what a caller passed.
   * A slimming fake (`slimmableOsVersions`) reports `"slim"` for a prepare boot of a slim-spec
   * device and nothing on a recover boot, as the iOS driver does; the `mode` option overrides it.
   */
  async makeReady(
    device: DriverDevice,
    options: { readonly purpose: "prepare" | "recover"; readonly mode: DeviceMode },
  ): Promise<DriverDevice> {
    await this.#beforeCall("makeReady", device, options);
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
      ...this.#reportedMode(options),
    };
  }

  #reportedMode(options: { readonly purpose: "prepare" | "recover"; readonly mode: DeviceMode }): {
    readonly mode?: DeviceMode;
  } {
    if (this.#mode !== undefined) return { mode: this.#mode };
    if (this.#slimmableOsVersions.size === 0) return {};
    return { mode: options.mode === "slim" && options.purpose === "prepare" ? "slim" : "full" };
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
    const models = this.#knownModels === undefined ? [] : [...this.#knownModels];
    return {
      defaultRuntime: newestVersion(this.#availableOsVersions),
      ...(this.#images === undefined ? {} : { images: [...this.#images] }),
      modelAliases: { ...this.#modelAliases },
      modelRuntimes: Object.fromEntries(
        models.map((model) => [model, [...(this.#modelRuntimes?.[model] ?? runtimes)]]),
      ),
      models,
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

  passthrough(args: readonly string[], context?: PassthroughContext): PassthroughCommand {
    if (this.#passthrough === undefined) {
      throw new PassthroughRefusedError(
        this.passthroughTool ?? "",
        "Fake driver builds no passthrough command",
      );
    }
    return this.#passthrough(args, context);
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

function preinstalledReceipts(versions: ReadonlySet<string>): Map<string, ComponentReceipt> {
  return new Map([...versions].map((version) => [version, { preinstalled: version }]));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Install aborted");
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
