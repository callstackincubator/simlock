import type { Clock } from "../ports/index.js";
import type {
  DeviceClass,
  DeviceMode,
  DeviceSpec,
  PhysicalClass,
  Platform,
  VirtualSpec,
} from "./domain.js";
import {
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type ComponentRemoval,
  type ExactDeviceRequest,
  type DeviceDataTable,
  type Driver,
  type DriverCatalogEntry,
  type DriverCatalogImage,
  type DriverComponent,
  type DriverDevice,
  type DriverEstimate,
  type DriverReality,
  type DriverRefusalReason,
  type InstalledComponent,
  type LegacyDevice,
  type ObservedRunState,
  type PassthroughCommand,
  PassthroughRefusedError,
  type PassthroughContext,
  isPhysicalDriverDevice,
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
  type PhysicalInspection,
  type PresentPhysical,
  type ReclaimResult,
  removeListedComponent,
  RuntimeMissingError,
  UnknownModelError,
  uninstallPlan,
} from "./driver.js";
import type { DeviceInputFactory } from "./input.js";
import type { ScreenCapture } from "./screen.js";

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
  | "inspectPhysical"
  | "listPresentPhysical"
  | "listCatalog"
  | "listComponents"
  | "removeComponent"
  | "revalidateRoot"
  | "findLegacy"
  | "destroyLegacy";

export type DriverEstimateOperation = "provision" | "boot" | "reclaim";

export interface FakePhysicalDevice {
  readonly ids: readonly string[];
  readonly model?: string;
  readonly osVersion?: string;
  readonly class?: PhysicalClass;
  readonly apps?: readonly string[];
  readonly refusal?: { readonly reason: DriverRefusalReason; readonly message: string };
}

export interface FakeDriverCall {
  readonly arguments: readonly unknown[];
  readonly operation: FakeDriverOperation;
}

export interface FakeDriverOptions {
  readonly availableOsVersions?: readonly string[];
  readonly clock: Clock;
  readonly componentFootprint?: { readonly path: string; readonly bytes: number };
  readonly installProgress?: readonly number[];
  readonly componentSizes?: Readonly<Record<string, number>>;
  readonly foreignDevices?: Readonly<Record<string, number>>;
  readonly removalResidue?: string;
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
  /** The built-in preference lists the driver carries, per class; none unless a test says otherwise. */
  readonly defaultModels?: Readonly<Partial<Record<DeviceClass, readonly string[]>>>;
  /** What `listCatalog` reports as each model's class; empty unless a test says otherwise. */
  readonly modelClasses?: Readonly<Record<string, DeviceClass>>;
  /**
   * What `listCatalog` reports as installed images; the field is absent unless set. A request
   * naming an image tag resolves only to a runtime listed here with that tag.
   */
  readonly images?: readonly DriverCatalogImage[];
  /** What `listCatalog` reports as custom models; the field is absent unless set. */
  readonly customModels?: readonly string[];
  readonly latencyMs?: Partial<Record<FakeDriverOperation, number>>;
  /** What a grant for this driver's devices should carry; empty unless a test says otherwise. */
  readonly leaseEnvironment?: Readonly<Record<string, string>>;
  /** why: absent by default, so two fakes in one catalog do not both answer to the same tool. */
  readonly passthroughTools?: readonly string[];
  readonly screenCapture?: ScreenCapture;
  readonly input?: DeviceInputFactory;
  readonly passthrough?: (
    tool: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
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
  readonly physicalDevices?: readonly FakePhysicalDevice[];
  /**
   * why: a real iOS simulator is addressed by its device id; set it to give a virtual device that
   * address, so a test can tell a virtual device from a phone by more than the id.
   */
  readonly addressIsDeviceId?: boolean;
}

export class FakeDriverUnknownDeviceError extends Error {
  constructor(readonly deviceId: string) {
    super(`Unknown fake driver device: ${deviceId}`);
    this.name = "FakeDriverUnknownDeviceError";
  }
}

export class FakeDriver implements Driver {
  readonly platform: Platform;
  readonly #defaultModels: FakeDriverOptions["defaultModels"];
  readonly deviceRoot: string;
  readonly #availableOsVersions: Set<string>;
  readonly #receipts: Map<string, ComponentReceipt>;
  #installCount = 0;
  readonly #install: Pick<
    FakeDriverOptions,
    | "componentFootprint"
    | "componentSizes"
    | "foreignDevices"
    | "installProgress"
    | "removalResidue"
  >;
  #holdInstalls = false;
  readonly #pendingInstalls: (() => void)[] = [];
  #holdRemovals = false;
  readonly #pendingRemovals: (() => void)[] = [];
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
  readonly #modelClasses: FakeDriverOptions["modelClasses"];
  readonly #images: FakeDriverOptions["images"];
  readonly #customModels: FakeDriverOptions["customModels"];
  readonly #latencyMs: FakeDriverOptions["latencyMs"];
  readonly #leaseEnvironment: Readonly<Record<string, string>>;
  readonly passthroughTools: readonly string[] | undefined;
  readonly screenCapture: ScreenCapture | undefined;
  readonly input: DeviceInputFactory | undefined;
  readonly #passthrough: FakeDriverOptions["passthrough"];
  #nextDeviceNumber = 1;
  readonly #pendingMakeReady: (() => void)[] = [];
  readonly #reclaimResult: "ready" | "shutdown";
  readonly #reclaimStrategy: "erase" | "snapshot" | "wipe";
  readonly #devices = new Map<string, "provisioned" | "ready" | "shutdown">();
  readonly #legacyDevices: Map<string, LegacyDevice>;
  /** Bumped on every `makeReady` boot -- mirrors a real driver reassigning a port per boot. */
  readonly #bootCounts = new Map<string, number>();
  readonly #addressIsDeviceId: boolean;
  #managedReality: DriverReality | undefined;
  #physicalDevices: readonly FakePhysicalDevice[] | undefined;
  readonly #presentPhysical = new Set<string>();
  readonly #absentReasons = new Map<string, "locked" | "untrusted" | "not-present">();
  readonly #presentOsVersions = new Map<string, string>();
  readonly #heldPresenceReads = new Set<string>();
  readonly #pendingPresenceReads: (() => void)[] = [];
  readonly #scriptedPhysicalDevices: FakeDriverOptions["physicalDevices"];

  constructor(options: FakeDriverOptions) {
    this.#addressIsDeviceId = options.addressIsDeviceId === true;
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
    this.#modelClasses = options.modelClasses;
    this.#defaultModels = options.defaultModels;
    this.#images = options.images;
    this.#customModels = options.customModels;
    this.#latencyMs = options.latencyMs;
    this.#leaseEnvironment = options.leaseEnvironment ?? {};
    this.#legacyDevices = new Map(Object.entries(options.legacyDevices ?? {}));
    this.passthroughTools = options.passthroughTools;
    this.screenCapture = options.screenCapture;
    this.input = options.input;
    this.#passthrough = options.passthrough;
    this.platform = options.platform;
    this.deviceRoot = options.deviceRoot ?? `/fake/${options.platform}`;
    this.#reclaimResult = options.reclaimResult ?? "ready";
    this.#reclaimStrategy = options.reclaimStrategy ?? "wipe";
    this.#scriptedPhysicalDevices = options.physicalDevices;
    this.#install = options;
    this.#receipts = preinstalledReceipts(this.#availableOsVersions);
  }

  get componentFootprint(): { readonly path: string; readonly bytes: number } {
    return this.#install.componentFootprint ?? { bytes: 0, path: this.deviceRoot };
  }

  get calls(): readonly FakeDriverCall[] {
    return this.#calls.map((call) => ({ ...call, arguments: [...call.arguments] }));
  }

  get defaultModels(): Readonly<Partial<Record<DeviceClass, readonly string[]>>> {
    return this.#defaultModels ?? {};
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
  async resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    await this.#beforeCall("resolveSpec", request);
    this.#assertMatchingPlatform(request.platform);

    if (this.#knownModels !== undefined && !this.#knownModels.has(request.model)) {
      throw new UnknownModelError(this.platform, request.model);
    }

    const osVersion =
      request.imageTag === undefined
        ? this.#resolveOsVersion(request.osVersion)
        : this.#resolveTaggedOsVersion(request.osVersion, request.imageTag);

    return {
      model: request.model,
      osVersion,
      physical: false,
      platform: this.platform,
      ...(request.imageTag === undefined ? {} : { imageTag: request.imageTag }),
      ...(request.mode === "slim" && this.#slimmableOsVersions.has(osVersion)
        ? { mode: "slim" as const }
        : {}),
    };
  }

  /** Defaults to the newest available version; a missing one fails, naming it as the component. */
  #resolveOsVersion(requested: string | undefined): string {
    const osVersion = requested ?? newestVersion(this.#availableOsVersions);
    if (osVersion === undefined) {
      throw new RuntimeMissingError(this.platform, "default", { component: "latest" });
    }
    if (!this.#availableOsVersions.has(osVersion)) {
      throw new RuntimeMissingError(this.platform, osVersion, { component: osVersion });
    }
    return osVersion;
  }

  /**
   * A version with a scripted image (`images`) of `imageTag`: the requested one, or else the
   * newest. None fails naming no component, so a tagged request is never offered a download.
   */
  #resolveTaggedOsVersion(requested: string | undefined, imageTag: string): string {
    const tagged = new Set(
      (this.#images ?? []).filter((image) => image.tag === imageTag).map((image) => image.runtime),
    );
    const osVersion = requested ?? newestVersion(tagged);
    if (osVersion === undefined || !tagged.has(osVersion)) {
      throw new RuntimeMissingError(this.platform, osVersion ?? "default");
    }
    return osVersion;
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
    if (this.#holdInstalls) await this.#held(this.#pendingInstalls, options.signal);
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
    return this.#listedComponents();
  }

  /**
   * Removes the available version whose receipt this is, through the same steps every driver
   * takes (`removeListedComponent`), reading the same listing `listComponents` answers. Scripted
   * through `failOn("removeComponent", n, error)`, `holdRemovals()` (it then waits for
   * `releaseRemovals()` or its signal) and the `removalResidue` option.
   */
  async removeComponent(
    receipt: ComponentReceipt,
    options: { readonly signal: AbortSignal },
  ): Promise<ComponentRemoval> {
    await this.#beforeCall("removeComponent", receipt);
    return removeListedComponent({
      list: async () => this.#listedComponents(),
      platform: this.platform,
      receipt,
      remove: async ({ version }) => {
        if (this.#holdRemovals) await this.#held(this.#pendingRemovals, options.signal);
        this.#availableOsVersions.delete(version);
        this.#receipts.delete(version);
        const residue = this.#install.removalResidue;
        return residue === undefined ? {} : { residue };
      },
    });
  }

  holdRemovals(): void {
    this.#holdRemovals = true;
  }

  releaseRemovals(): void {
    this.#holdRemovals = false;
    for (const resolve of this.#pendingRemovals.splice(0)) resolve();
  }

  #listedComponents(): readonly DriverComponent[] {
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

  #held(pending: (() => void)[], signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      pending.push(resolve);
      signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
    });
  }

  #addressOf(deviceId: string, bootCount: number): string {
    return this.#addressIsDeviceId ? deviceId : addressFor(deviceId, bootCount);
  }

  async provision(spec: VirtualSpec): Promise<DriverDevice> {
    await this.#beforeCall("provision", spec);
    this.#assertMatchingPlatform(spec.platform);

    const deviceId = `fake-${this.platform}-${this.#nextDeviceNumber}`;
    this.#nextDeviceNumber += 1;
    this.#devices.set(deviceId, "provisioned");

    return {
      address: this.#addressOf(deviceId, 0),
      deviceId,
      driverData: { fakeDeviceId: deviceId },
    };
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
      address: this.#addressOf(device.deviceId, bootCount),
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
  ): Promise<ReclaimResult> {
    await this.#beforeCall("reclaim", device, options);
    if (isPhysicalDriverDevice(device)) return this.#reclaimPhysical(device);
    this.#requireDevice(device);
    this.#devices.set(device.deviceId, this.#reclaimResult);
    return { state: this.#reclaimResult, strategy: this.#reclaimStrategy };
  }

  #reclaimPhysical(device: PhysicalDriverDevice): ReclaimResult {
    const scripted = (this.#physicalDevices ?? this.#scriptedPhysicalDevices ?? []).find(
      (candidate) => candidate.ids.includes(device.deviceId),
    );
    const plan = uninstallPlan(scripted?.apps ?? [], device.enrolledApps);
    return { missingApps: plan.missing, state: "ready", strategy: "uninstall" };
  }

  reclaimStrategy(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): "erase" | "snapshot" | "wipe" | "uninstall" {
    return isPhysicalDriverDevice(device) ? "uninstall" : this.#reclaimStrategy;
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
        address: this.#addressOf(deviceId, this.#bootCounts.get(deviceId) ?? 0),
        deviceId,
        driverData: { fakeDeviceId: deviceId },
        runState: runStateFor(status),
      })),
      processes: [],
    };
  }

  setPhysicalDevices(devices: readonly FakePhysicalDevice[]): void {
    this.#physicalDevices = devices;
  }

  async listPresentPhysical(enrolledIds: readonly string[]): Promise<readonly PresentPhysical[]> {
    await this.#beforeCall("listPresentPhysical", enrolledIds);
    if (enrolledIds.some((id) => this.#heldPresenceReads.has(id))) {
      await new Promise<void>((resolve) => {
        this.#pendingPresenceReads.push(resolve);
      });
    }
    return enrolledIds.map((driverDeviceId) => {
      if (this.#presentPhysical.has(driverDeviceId)) {
        return {
          driverDeviceId,
          osVersion: this.#presentOsVersions.get(driverDeviceId) ?? "1.0",
          present: true,
        };
      }
      return {
        driverDeviceId,
        present: false,
        reason: this.#absentReasons.get(driverDeviceId) ?? "not-present",
      };
    });
  }

  setPhysicalPresence(
    driverDeviceId: string,
    present: boolean,
    detail: {
      readonly reason?: "locked" | "untrusted" | "not-present";
      readonly osVersion?: string;
    } = {},
  ): void {
    if (present) this.#presentPhysical.add(driverDeviceId);
    else this.#presentPhysical.delete(driverDeviceId);
    this.#absentReasons.set(driverDeviceId, detail.reason ?? "not-present");
    if (detail.osVersion === undefined) this.#presentOsVersions.delete(driverDeviceId);
    else this.#presentOsVersions.set(driverDeviceId, detail.osVersion);
  }

  holdPresenceReads(...driverDeviceIds: readonly string[]): void {
    for (const id of driverDeviceIds) this.#heldPresenceReads.add(id);
  }

  releasePresenceReads(): void {
    this.#heldPresenceReads.clear();
    for (const resolve of this.#pendingPresenceReads.splice(0)) resolve();
  }

  async inspectPhysical(id: string): Promise<PhysicalInspection> {
    await this.#beforeCall("inspectPhysical", id);
    const scripted = this.#physicalDevices ?? this.#scriptedPhysicalDevices ?? [];
    const device = scripted.find((candidate) => candidate.ids.includes(id));
    if (device === undefined) {
      return { enrollable: false, message: `${id} is not connected`, reason: "not-connected" };
    }
    if (device.refusal !== undefined) return { enrollable: false, ...device.refusal };
    return readPhysical(device, id);
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    await this.#beforeCall("listCatalog");
    const runtimes = [...this.#availableOsVersions].sort(compareVersions);
    const models = this.#knownModels === undefined ? [] : [...this.#knownModels];
    return {
      defaultRuntime: newestVersion(this.#availableOsVersions),
      ...(this.#images === undefined ? {} : { images: [...this.#images] }),
      ...(this.#customModels === undefined ? {} : { customModels: [...this.#customModels] }),
      modelAliases: { ...this.#modelAliases },
      modelClasses: { ...this.#modelClasses },
      modelRuntimes: Object.fromEntries(
        models.map((model) => [model, [...(this.#modelRuntimes?.[model] ?? runtimes)]]),
      ),
      models,
      runtimes,
    };
  }

  estimate(estimate: DriverEstimate, spec: DeviceSpec): number {
    if (estimate.operation !== "reclaim") return this.#estimateMs?.[estimate.operation] ?? 0;
    return this.#reclaimEstimate(estimate.clean, spec);
  }

  #reclaimEstimate(clean: "standard" | "full", spec: DeviceSpec): number {
    if (spec.physical) return PHYSICAL_RECLAIM_ESTIMATE_MS;
    if (clean === "full") return this.#fullCleanReclaimEstimateMs ?? this.#estimateMs?.reclaim ?? 0;
    return this.#estimateMs?.reclaim ?? 0;
  }

  virtualLeaseEnvironment(): Readonly<Record<string, string>> {
    return this.#leaseEnvironment;
  }

  leaseEnvironment(_device: DriverDevice): Readonly<Record<string, string>> {
    return this.#leaseEnvironment;
  }

  async passthrough(
    tool: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand> {
    if (this.#passthrough === undefined) {
      throw new PassthroughRefusedError(tool, "Fake driver builds no passthrough command");
    }
    return await Promise.resolve(this.#passthrough(tool, device, args, context));
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

/** One 30 s read limit plus one 60 s uninstall limit: what the real physical drivers will answer. */
const PHYSICAL_RECLAIM_ESTIMATE_MS = 90_000;

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

function readPhysical(device: FakePhysicalDevice, id: string): PhysicalInspection {
  return {
    apps: [...(device.apps ?? [])],
    class: device.class ?? "phone",
    driverDeviceId: device.ids[0] ?? id,
    enrollable: true,
    model: device.model ?? "Fake Phone",
    osVersion: device.osVersion ?? "1.0",
  };
}

export const fakeDeviceDataTable: DeviceDataTable = {
  migrations: [
    "CREATE TABLE fake_device_data (device_id TEXT PRIMARY KEY, fake_device_id TEXT NOT NULL) STRICT",
  ],
  name: "fake-device-data",
  read(database, deviceId) {
    const row = database
      .prepare("SELECT fake_device_id FROM fake_device_data WHERE device_id = ?")
      .get(deviceId);
    if (row === undefined) throw new Error(`No fake driver data for device ${deviceId}`);
    return { fakeDeviceId: row.fake_device_id };
  },
  version: 1,
  write(database, deviceId, driverData) {
    const data = driverData as Record<string, unknown> | null | undefined;
    const fakeDeviceId = data?.fakeDeviceId;
    if (typeof fakeDeviceId !== "string" || Object.keys(data ?? {}).length !== 1) {
      throw new Error(`Invalid fake driver data for device ${deviceId}`);
    }
    database
      .prepare(
        `INSERT INTO fake_device_data (device_id, fake_device_id) VALUES (?, ?)
         ON CONFLICT (device_id) DO UPDATE SET fake_device_id = excluded.fake_device_id`,
      )
      .run(deviceId, fakeDeviceId);
  },
};
