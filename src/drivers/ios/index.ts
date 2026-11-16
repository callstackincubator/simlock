import { dirname, join } from "node:path";
import {
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type ComponentRemoval,
  type DeviceInputFactory,
  type DeviceTcp,
  type ExactDeviceRequest,
  type Driver,
  type DriverAdvisory,
  type DriverToolVersion,
  type DriverCatalogEntry,
  type DriverComponent,
  type DriverDevice,
  type DriverSource,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  type PhysicalDriverDevice,
  type PhysicalInspection,
  type ReclaimResult,
  type VirtualDriverDevice,
  isPhysicalDriverDevice,
  type EnrolledPhysical,
  type PresentPhysical,
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  type InstalledComponent,
  type LegacyDevice,
  type ObservedDevice,
  type PassthroughCommand,
  type PassthroughContext,
  removeListedComponent,
  type DeviceClass,
  type DeviceMode,
  type DeviceSpec,
  type VirtualSpec,
  type ScreenCapture,
} from "../../core/index.js";
import type { Clock, ProcessRunner } from "../../ports/index.js";
import { runAfterBoot, type AfterBoot } from "./boot-courtesies.js";
import { runCommand } from "./command-run.js";
import { SeedTurns } from "./seed-turns.js";
import { COMMAND_TIMEOUT_MS, Simctl } from "./simctl.js";
import { DeviceMarks } from "./marks.js";
import { SimulatorBoot } from "./simulator-boot.js";
import { DeviceHubPreferences } from "./devicehub.js";
import { DEFAULT_OVERRIDES_ROOT, SlimBoot, type SlimOptions } from "./slim-boot.js";
import { RuntimeComponents } from "./components.js";
import { SimulatorCatalog } from "./catalog.js";
import { Seeds } from "./seeds.js";

import {
  refuseDefaultSourcesLeftovers,
  refuseOwnSetLeftovers,
  refuseXcodeSetLeftovers,
} from "./device-set-leftovers.js";
import { createIosDeviceTcpFor } from "./device-tcp.js";
import { IosPhysicalHandler } from "./physical.js";
import { iosRuntimeVersionFromId } from "./runtime-version.js";
import { sourcesSetFor } from "./source-data.js";
import {
  configuredDeviceRoot,
  configuredDeviceSet,
  createInputFor,
  createScreenCaptureFor,
  type IosSimctlDriverOptions,
  xcodeDeviceSetPath,
} from "./driver-options.js";

import { parseManagedDevices } from "./simctl-parse.js";

import { type IosDriverData, iosDriverData, requireIosPlatform } from "./simulator-data.js";
import { IOS_PASSTHROUGH_TOOLS, passthroughCommand } from "./passthrough-rules.js";
import { IOS_RUNTIME_MIN_FREE_BYTES } from "./runtime-images.js";

const DEFAULT_FULL_BOOT_TIMEOUT_MS = 300_000;
const PROVISION_ESTIMATE_MS = 500;
// why: A cold `simctl boot` to `bootstatus` measures roughly 30s on a fast, idle machine and up to
// a minute on a loaded or slower one. The upper end is the estimate, deliberately: this number
// is what a waiting requester is quoted, and quoting 30s to someone who then waits 60s is the
// failure mode #56 is about. The cost is that `Doctor`'s `provisioning` stall threshold widens
// with it -- see the note there on why that is the cheaper of the two errors.
const COLD_BOOT_ESTIMATE_MS = 60_000;
// why: measured, not guessed: a single `simctl erase` took ~34s in #43's investigation. A
// simulator is no longer erased -- a lease's end deletes it (ADR 0061 §2) -- but the number stays
// as the simulator "reclaim" estimate, which only widens `Doctor`'s stall threshold (#1204).
// A physical device reclaim uninstalls apps instead and has its own estimate below.
const ERASE_ESTIMATE_MS = 34_000;
const PHYSICAL_RECLAIM_ESTIMATE_MS = 90_000;

const IOS_DEFAULT_MODELS: Readonly<Partial<Record<DeviceClass, readonly string[]>>> = {
  phone: ["iPhone 17", "iPhone 16", "iPhone 15", "iPhone 14", "iPhone 13"],
  tablet: [
    "iPad Pro 11-inch (M5)",
    "iPad Pro 11-inch (M4)",
    "iPad Air 11-inch (M3)",
    "iPad (A16)",
    "iPad (10th generation)",
  ],
  tv: ["Apple TV 4K (3rd generation)", "Apple TV"],
  vision: ["Apple Vision Pro"],
  watch: [
    "Apple Watch Series 11 (46mm)",
    "Apple Watch Series 10 (46mm)",
    "Apple Watch Series 9 (45mm)",
  ],
};

export class IosSimctlDriver implements Driver {
  readonly platform = "ios" as const;
  readonly rebootReadyBeforeGrant: boolean;
  readonly defaultModels = IOS_DEFAULT_MODELS;
  readonly #clock: Clock;
  readonly componentFootprint: { readonly path: string; readonly bytes: number };
  readonly #processRunner: ProcessRunner;
  readonly #physical: IosPhysicalHandler;
  readonly #simctl: Simctl;
  readonly #boot: SimulatorBoot;
  readonly #deviceHub: DeviceHubPreferences;
  readonly #marks: DeviceMarks;
  readonly #slimBoot: SlimBoot;
  readonly #catalog: SimulatorCatalog;
  readonly #components: RuntimeComponents;
  readonly #seeds: Seeds;
  readonly #deviceRoot: string;
  readonly #rootOptions: EnsureOwnedRootOptions | undefined;
  readonly #slim: SlimOptions | undefined;
  readonly #fullBootTimeoutMs: number;
  readonly #afterBoot: AfterBoot;
  readonly #slimByDefault: boolean;
  readonly #seedTurns = new SeedTurns();

  private constructor(
    options: IosSimctlDriverOptions,
    deviceRoot: string,
    rootOptions: EnsureOwnedRootOptions | undefined,
  ) {
    this.rebootReadyBeforeGrant = rootOptions === undefined;
    this.#clock = options.clock;
    this.componentFootprint = {
      bytes: IOS_RUNTIME_MIN_FREE_BYTES,
      path: options.coreSimulatorRoot ?? ".",
    };
    this.#processRunner = options.processRunner;
    this.#simctl = new Simctl({
      clock: options.clock,
      createTimeoutMs: options.config?.simulator?.createTimeoutMs ?? COMMAND_TIMEOUT_MS,
      deviceRoot,
      logger: options.logger,
      ownsDeviceSet: rootOptions !== undefined,
      processRunner: options.processRunner,
      seedTurns: this.#seedTurns,
    });
    this.#boot = new SimulatorBoot({
      clock: options.clock,
      ownsDeviceSet: rootOptions !== undefined,
      simctl: this.#simctl,
    });
    this.#marks = new DeviceMarks({
      clock: options.clock,
      deviceRoot,
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      ownsDeviceSet: rootOptions !== undefined,
    });
    this.#components = new RuntimeComponents({
      clock: options.clock,
      filesystem: options.filesystem,
      marks: this.#marks,
      processRunner: options.processRunner,
      simctl: this.#simctl,
    });
    this.#deviceHub = new DeviceHubPreferences({
      clock: options.clock,
      filesystem: options.filesystem,
      logger: options.logger,
      overridesRoot: options.launchdOverridesRoot ?? DEFAULT_OVERRIDES_ROOT,
      processRunner: options.processRunner,
    });
    this.#physical = new IosPhysicalHandler({
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      invoke: (argv, timeoutMs) => this.#simctl.invokeXcrun(argv, timeoutMs),
      simlockHome: options.simlockHome,
    });
    this.#deviceRoot = deviceRoot;
    this.#rootOptions = rootOptions;
    this.#slim = options.config?.slim;
    this.#fullBootTimeoutMs = options.config?.full?.bootTimeoutMs ?? DEFAULT_FULL_BOOT_TIMEOUT_MS;
    this.#afterBoot = this.#afterBootFor(options);
    this.#slimByDefault = options.slimByDefault === true;
    this.#catalog = new SimulatorCatalog({
      simctl: this.#simctl,
      slim: this.#slim,
      slimByDefault: this.#slimByDefault,
    });
    this.#slimBoot = new SlimBoot({
      clock: options.clock,
      filesystem: options.filesystem,
      fullBootTimeoutMs: this.#fullBootTimeoutMs,
      logger: options.logger,
      onSlimmed: options.onSlimmed,
      onSlimSkipped: options.onSlimSkipped,
      overridesRoot: options.launchdOverridesRoot ?? DEFAULT_OVERRIDES_ROOT,
      simctl: this.#simctl,
      slim: this.#slim,
    });
    this.#seeds = new Seeds({
      boot: this.#boot,
      clock: options.clock,
      slimBoot: this.#slimBoot,
      database: options.database,
      deviceRoot,
      filesystem: options.filesystem,
      fullBootTimeoutMs: this.#fullBootTimeoutMs,
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      logger: options.logger,
      marks: this.#marks,
      ownsDeviceSet: rootOptions !== undefined,
      seedTurns: this.#seedTurns,
      simctl: this.#simctl,
      sourcesSet: sourcesSetFor(options.simlockHome, deviceRoot, rootOptions !== undefined),
    });
    this.screenCapture = createScreenCaptureFor(
      options,
      deviceRoot,
      rootOptions !== undefined,
      (udid) => this.#physical.osVersion(udid),
    );
    this.input = createInputFor(options, deviceRoot, rootOptions !== undefined);
    this.deviceTcp = createIosDeviceTcpFor(options);
  }

  #afterBootFor(options: IosSimctlDriverOptions): AfterBoot {
    return {
      silent: options.config?.simulator?.audio === false,
      headless: options.config?.simulator?.headless !== false,
      commands: {
        simctl: (args, timeoutMs) => this.#simctl.invoke(args, timeoutMs),
        open: (args, timeoutMs) =>
          runCommand(this.#processRunner, this.#clock, "open", args, timeoutMs),
      },
      onSilenceFailed: options.onSilenceFailed,
      onWindowFailed: options.onWindowFailed,
    };
  }

  readonly screenCapture: ScreenCapture | undefined;
  readonly input: DeviceInputFactory | undefined;
  readonly deviceTcp: DeviceTcp | undefined;

  /**
   * why: Establishes the device set this driver owns before it can be asked to do anything,
   * which is why construction is asynchronous: a driver that had not yet proven its root
   * would be a driver that can address devices it cannot prove are Simlock's, and every
   * later `--set` would be pointing at an unvalidated path. An `OwnedRootError` here is
   * the fail-closed path -- the caller skips iOS entirely rather than falling back to the
   * machine's default device set (safety rule 9).
   */
  static async create(options: IosSimctlDriverOptions): Promise<IosSimctlDriver> {
    const deviceSet = configuredDeviceSet(options);
    if (deviceSet === "default") {
      await refuseOwnSetLeftovers(options.filesystem, join(options.simlockHome, "devices", "ios"));
      return new IosSimctlDriver(options, xcodeDeviceSetPath(options), undefined);
    }
    await refuseDefaultSourcesLeftovers(
      options.filesystem,
      join(options.simlockHome, "devices", "ios-sources"),
    );
    if (options.coreSimulatorRoot !== undefined) {
      await refuseXcodeSetLeftovers(
        options.filesystem,
        xcodeDeviceSetPath(options),
        options.instanceId,
      );
    }
    const rootOptions: EnsureOwnedRootOptions = {
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      path: configuredDeviceRoot(options),
      platform: "ios",
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.pid === undefined ? {} : { pid: options.pid }),
    };
    const deviceRoot = await ensureOwnedRoot(rootOptions);

    return new IosSimctlDriver(options, deviceRoot, rootOptions);
  }

  get deviceRoot(): string {
    return this.#deviceRoot;
  }

  /**
   * why: The same call `create` made, with the same arguments, because the proof *is* that call:
   * a cheaper second check here would be a second validator, free to drift from the one
   * every start is judged by. It is asked for immediately before Simlock destroys anything
   * inside this set, since between then and startup the path can have become a symlink, or
   * a `mv` can have left the user's own device set standing where this one was.
   */
  async revalidateRoot(): Promise<void> {
    if (this.#rootOptions === undefined) return;
    await ensureOwnedRoot(this.#rootOptions);
  }

  resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    return this.#catalog.resolveSpec(request);
  }

  findComponent(component: string): Promise<InstalledComponent | undefined> {
    return this.#components.findComponent(component);
  }

  installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult> {
    return this.#components.installComponent(component, options);
  }

  listComponents(): Promise<readonly DriverComponent[]> {
    return this.#components.listComponents();
  }

  async removeComponent(
    receipt: ComponentReceipt,
    options: { readonly signal: AbortSignal },
  ): Promise<ComponentRemoval> {
    return removeListedComponent({
      list: () => this.#components.listedImages(),
      platform: this.platform,
      receipt,
      remove: async (listed) => {
        await this.#seeds.destroySeedsOf(listed.image.runtimeIdentifier);
        return this.#components.removeImage(listed, options.signal);
      },
    });
  }

  listSources(): Promise<readonly DriverSource[]> {
    return this.#seeds.listSources();
  }

  saveSource(device: VirtualDriverDevice): Promise<{ sourceId: string; sizeBytes?: number }> {
    return this.#seeds.saveSource(device);
  }

  destroySource(sourceId: string): Promise<void> {
    return this.#seeds.destroySource(sourceId);
  }

  async provision(
    spec: VirtualSpec,
    options?: { readonly source?: string },
  ): Promise<DriverDevice> {
    requireIosPlatform(spec.platform);
    const resolved = await this.#catalog.resolvedSpec(spec);
    return this.#seeds.provision(resolved, options);
  }

  async makeReady(
    device: DriverDevice,
    options: {
      readonly purpose: "prepare" | "recover";
      readonly mode: DeviceMode;
      readonly except?: readonly string[];
    },
  ): Promise<DriverDevice> {
    const data = iosDriverData(device);
    if (this.#rootOptions === undefined) await this.#deviceHub.disablePasteboardSync(data.udid);
    const { plan, bootstatusTimeoutMs } = this.#slimBoot.plan(data, options);
    const write =
      plan.kind === "apply"
        ? await this.#slimBoot.writeOverrides(data.udid, plan.slim, options.except)
        : undefined;

    await this.#boot.bootAndWait(
      data.udid,
      device.deviceId,
      bootstatusTimeoutMs,
      undefined,
      options.purpose === "prepare",
    );
    await runAfterBoot(this.#afterBoot, data.udid, device.deviceId);
    return this.#slimBoot.settle(device, data, plan, write);
  }

  async reclaim(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult> {
    if (isPhysicalDriverDevice(device)) return this.#physical.reclaim(device);
    throw new DriverCrashError("virtual devices are not reclaimed");
  }

  reclaimStrategy(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): "uninstall" {
    if (isPhysicalDriverDevice(device)) return "uninstall";
    throw new DriverCrashError("virtual devices are not reclaimed");
  }

  async shutdown(device: DriverDevice): Promise<void> {
    await this.#simctl.shutdown(iosDriverData(device).udid);
  }

  async destroy(device: DriverDevice): Promise<void> {
    const data = iosDriverData(device);
    await this.#simctl.shutdown(data.udid);
    await this.#simctl.run(["delete", data.udid], COMMAND_TIMEOUT_MS);
    if (this.#rootOptions === undefined)
      await this.#deviceHub.removePasteboardPreference(data.udid);
    await this.#slimBoot.removeOverrides(data.udid);
  }

  async findLegacy(driverDeviceId: string): Promise<LegacyDevice | undefined> {
    // why: Under Xcode's set the default set is the driver's own, so no device is "pre-root"
    // there, and a lost mark stays a report-only finding instead of a deletable legacy device.
    if (this.#rootOptions === undefined) return undefined;
    const result = await this.#simctl.runLegacy(["list", "-j", "devices"], COMMAND_TIMEOUT_MS);
    const found = parseManagedDevices(JSON.parse(result.stdout) as unknown).find(
      (device) => device.udid === driverDeviceId,
    );
    if (found === undefined) {
      return undefined;
    }

    return {
      device: {
        address: found.udid,
        deviceId: found.udid,
        driverData: {
          deviceTypeId: "",
          name: found.name,
          runtimeId: "",
          udid: found.udid,
        } satisfies IosDriverData,
      },
      ...(found.dataPath === undefined ? {} : { path: dirname(found.dataPath) }),
    };
  }

  async destroyLegacy(device: DriverDevice): Promise<void> {
    const { udid } = iosDriverData(device);
    // why: Best effort: a device that is already shut down reports a failure unrelated to the delete.
    await this.#simctl.invokeLegacy(["shutdown", udid], COMMAND_TIMEOUT_MS);
    await this.#simctl.runLegacy(["delete", udid], COMMAND_TIMEOUT_MS);
    await this.#slimBoot.removeOverrides(udid);
  }

  async listPresentPhysical(
    enrolled: readonly EnrolledPhysical[],
  ): Promise<readonly PresentPhysical[]> {
    return this.#physical.listPresent(enrolled.map((entry) => entry.driverDeviceId));
  }

  async listAttachedPhysical(): Promise<readonly string[]> {
    return this.#physical.listAttached();
  }

  async inspectPhysical(id: string): Promise<PhysicalInspection> {
    return this.#physical.inspect(id);
  }

  async listManaged(): Promise<DriverReality> {
    const result = await this.#simctl.run(["list", "-j", "devices"], COMMAND_TIMEOUT_MS);
    const listed = parseManagedDevices(JSON.parse(result.stdout) as unknown);
    // why: Xcode's set also holds the user's own simulators and other Simlocks'; only a
    // durable mark naming this instance proves a simulator here is ours.
    const parsed =
      this.#rootOptions !== undefined
        ? listed
        : (
            await Promise.all(
              listed.map(async (device) =>
                (await this.#marks.isMarkedByThisInstance(device.udid)) ? [device] : [],
              ),
            )
          ).flat();
    const devices: ObservedDevice[] = await Promise.all(
      parsed.map(async (device) => {
        const mark = await this.#marks.readMark(device.udid);
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

  listCatalog(): Promise<DriverCatalogEntry> {
    return this.#catalog.listCatalog();
  }

  estimate(estimate: DriverEstimate, spec: DeviceSpec): number {
    switch (estimate.operation) {
      case "provision":
        return PROVISION_ESTIMATE_MS;
      case "boot":
        return COLD_BOOT_ESTIMATE_MS;
      case "reclaim":
        if (spec.physical) return PHYSICAL_RECLAIM_ESTIMATE_MS;
        return ERASE_ESTIMATE_MS;
    }
  }

  async advisories(): Promise<readonly DriverAdvisory[]> {
    return [
      ...(await this.#components.cacheAdvisories()),
      ...(await this.#catalog.slimAdvisories()),
    ];
  }

  toolVersions(): Promise<readonly DriverToolVersion[]> {
    return this.#components.toolVersions();
  }

  virtualLeaseEnvironment(): Readonly<Record<string, string>> {
    return this.#rootOptions === undefined ? {} : { SIMLOCK_IOS_DEVICE_SET: this.#deviceRoot };
  }

  leaseEnvironment(device: DriverDevice): Readonly<Record<string, string>> {
    if (isPhysicalDriverDevice(device)) return { SIMLOCK_DEVICE_UDID: device.deviceId };
    return this.virtualLeaseEnvironment();
  }

  readonly passthroughTools = IOS_PASSTHROUGH_TOOLS;

  passthrough(
    tool: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand> {
    return passthroughCommand(tool, device, args, context, (a) => this.#simctl.scopedArgv(a));
  }
}

export { iosRuntimeVersionFromId };

export type { SilenceFailedFact, WindowFailedFact } from "./boot-courtesies.js";
export type { IosSimctlDriverOptions } from "./driver-options.js";
export { supportsPersistentSlim, type SlimmedFact, type SlimSkippedFact } from "./slim-boot.js";
export { type IosDriverConfig, iosDriverConfig } from "./definition.js";
export { iosDeviceDataTable } from "./device-data.js";
export { iosSourceDataOwner } from "./source-data.js";
export { iosPrerequisites } from "./prerequisites.js";
export { labelsFor, SLIM_CATEGORIES, slimSignature } from "./slim-labels.js";

export { IOS_PASSTHROUGH_TOOLS } from "./passthrough-rules.js";
export { REFUSED_SIMCTL_VERBS } from "./passthrough-rules.js";
export { CALLER_SUPPLIED_SCOPE_FLAGS } from "./passthrough-rules.js";
export { SHUTDOWN_ALL_TARGET } from "./passthrough-rules.js";
export { REFUSED_RUNTIME_OPERATION } from "./passthrough-rules.js";
