import type { EventMap } from "../bus/index.js";
import type { Filesystem, SqliteDatabase, SqliteSchemaOwner } from "../ports/index.js";
import type { RootRejectionReason } from "./device-root.js";
import type { ScreenCapture } from "./screen.js";
import type {
  AbsentReason,
  DeviceClass,
  DeviceMode,
  DeviceRecord,
  DeviceSpec,
  DeviceTransitionUpdate,
  PhysicalClass,
  PhysicalDevice,
  Platform,
  VirtualDevice,
  VirtualSpec,
} from "./domain.js";

export interface DeviceDataTable extends SqliteSchemaOwner {
  write(database: SqliteDatabase, deviceId: string, driverData: unknown): void;
  read(database: SqliteDatabase, deviceId: string): unknown;
}

export interface ExactDeviceRequest {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string;
  readonly mode?: DeviceMode;
  readonly imageTag?: string;
}

export interface DeviceRequest extends Omit<ExactDeviceRequest, "model"> {
  readonly model?: string;
  readonly class?: DeviceClass;
  readonly physical?: boolean;
}

export interface DriverDevice {
  readonly deviceId: string;
  readonly driverData: unknown;
  readonly address: string;
  readonly mode?: DeviceMode;
}

export type VirtualDriverDevice = DriverDevice & { readonly physical: false };

export type PhysicalDriverDevice = DriverDevice & {
  readonly physical: true;
  readonly enrolledApps: readonly string[];
};

export function isPhysicalDriverDevice(device: DriverDevice): device is PhysicalDriverDevice {
  return (device as Partial<PhysicalDriverDevice>).physical === true;
}

export interface PresentPhysical {
  readonly driverDeviceId: string;
  readonly present: boolean;
  readonly osVersion?: string;
  readonly reason?: AbsentReason;
}

export function toDriverDevice(device: VirtualDevice): VirtualDriverDevice;
export function toDriverDevice(device: PhysicalDevice): PhysicalDriverDevice;
export function toDriverDevice(device: DeviceRecord): VirtualDriverDevice | PhysicalDriverDevice;
export function toDriverDevice(device: DeviceRecord): VirtualDriverDevice | PhysicalDriverDevice {
  const base = {
    address: device.address ?? "",
    deviceId: device.driverDeviceId,
    driverData: device.driverData,
  };
  return device.physical
    ? { ...base, enrolledApps: device.enrolledApps, physical: true }
    : { ...base, physical: false };
}

export function uninstallPlan(
  listedNow: readonly string[],
  enrolledApps: readonly string[],
): { readonly uninstall: readonly string[]; readonly missing: readonly string[] } {
  const enrolled = new Set(enrolledApps);
  const listed = new Set(listedNow);
  return {
    missing: enrolledApps.filter((app) => !listed.has(app)),
    uninstall: listedNow.filter((app) => !enrolled.has(app)),
  };
}

export function virtualDriverDevice(device: DriverDevice): VirtualDriverDevice {
  return { ...device, physical: false };
}

/** why: Always writes `mode`, defaulting `undefined` to `"full"` here and nowhere else, so a stale `"slim"` cannot outlive a re-boot that did not slim. */
export function readyTransitionUpdate(readyDevice: DriverDevice): DeviceTransitionUpdate {
  return {
    address: readyDevice.address,
    driverData: readyDevice.driverData,
    mode: readyDevice.mode ?? "full",
  };
}

/**
 * why: Observed boot state of a managed device. `transitioning` covers states a
 * driver cannot settle into `running` or `stopped` yet -- simulators report
 * `Booting` / `Shutting Down`, emulators appear `offline` in `adb devices`
 * before they answer `getprop` -- and must never produce a drift finding.
 */
export type ObservedRunState = "running" | "stopped" | "transitioning";

/**
 * why: Provenance-mark readings for one managed device. Simlock writes the same
 * token into two regions of a device it owns: one that survives a fresh-state
 * erase and one the erase destroys. Comparing the pair is what makes a foreign
 * erase visible -- an erased device still exists and still boots, so run-state
 * comparison alone can never see it.
 *
 * Where each region lives is the driver's business; the core only compares.
 */
export interface ObservedMark {
  readonly durable: string | undefined;
  readonly erasable: string | undefined;
  /** why: Unreadable is not absent and must never be reported as an erase. */
  readonly erasableReadable: boolean;
}

export interface ObservedDevice extends DriverDevice {
  readonly runState: ObservedRunState;
  readonly mark?: ObservedMark;
}

export interface DriverReality {
  readonly devices: readonly ObservedDevice[];
  readonly processes: readonly DriverDevice[];
}

export interface ReclaimResult {
  readonly state: "ready" | "shutdown";
  readonly strategy: "erase" | "snapshot" | "wipe" | "uninstall";
  readonly missingApps?: readonly string[];
}

export type ReclaimStrategy = ReclaimResult["strategy"];

/**
 * why: `reclaim` carries the clean level because the strategies differ by an order of magnitude
 * (iOS `erase` tens of seconds, Android `snapshot` restore a few); one blended number is wrong for both.
 */
export type DriverEstimate =
  | { readonly operation: "provision" }
  | {
      readonly operation: "boot";
      /** why: With a `device` a driver may quote that device's own boot path, which it reads asynchronously. */
      readonly device?: DriverDevice;
      readonly purpose?: "prepare" | "recover";
    }
  | { readonly operation: "reclaim"; readonly clean: "standard" | "full" };

export interface DriverCatalogEntry {
  readonly models: readonly string[];
  readonly runtimes: readonly string[];
  readonly defaultRuntime: string | undefined;
  readonly modelRuntimes: Readonly<Record<string, readonly string[]>>;
  readonly modelAliases: Readonly<Record<string, readonly string[]>>;
  readonly modelClasses: Readonly<Record<string, DeviceClass>>;
  readonly images?: readonly DriverCatalogImage[];
  readonly customModels?: readonly string[];
}

export interface DriverCatalogImage {
  readonly runtime: string;
  readonly tag: string;
  readonly abi: string;
}

export interface DriverAdvisory {
  readonly code: string;
  readonly message: string;
}

export interface MissingPrerequisite {
  readonly prerequisite: string;
  readonly message: string;
  readonly remedy: string;
}

/**
 * why: Looks for one platform's prerequisites on this machine. Deliberately not a `Driver` method:
 * it has to answer exactly when the driver could not be built, because a prerequisite is
 * missing. Read-only -- it never installs, downloads or writes -- and every process it starts
 * is bounded. It rejects when it cannot tell, rather than reporting something missing.
 */
export interface PrerequisiteCheck {
  readonly platform: Platform;
  check(): Promise<readonly MissingPrerequisite[]>;
}

export interface DriverToolVersion {
  readonly name: string;
  readonly version: string;
  readonly build?: string;
}

export type DriverRefusalReason =
  | "not-connected"
  | "network-only"
  | "untrusted"
  | "developer-mode-off"
  | "os-too-old"
  | "unsupported-kind"
  | "locked"
  | "unreadable"
  | "virtual-device";

export type PhysicalInspection =
  | {
      readonly enrollable: true;
      readonly driverDeviceId: string;
      readonly model: string;
      readonly osVersion: string;
      readonly class: PhysicalClass;
      readonly apps: readonly string[];
    }
  | {
      readonly enrollable: false;
      readonly reason: DriverRefusalReason;
      readonly message: string;
    };

export interface Driver {
  readonly platform: Platform;
  readonly defaultModels: Readonly<Partial<Record<DeviceClass, readonly string[]>>>;
  readonly deviceRoot: string;
  /**
   * why: Ownership is proven once, at startup, and then trusted for the life of the process --
   * tolerable for reporting, not for destroying. A daemon that has been up for days is one
   * `mv` or one symlink away from `deviceRoot` naming the user's own device set, at which
   * point `listManaged` answers with every simulator on the machine and
   * `doctor --purge-orphans` would destroy them. Only the driver can re-run the check,
   * because only it knows how its root was built (architecture rule 2).
   */
  revalidateRoot(): Promise<void>;
  resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec>;
  findComponent(component: string): Promise<InstalledComponent | undefined>;
  installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult>;
  readonly componentFootprint: { readonly path: string; readonly bytes: number };
  /**
   * why: Counting `foreignDevices` is the only place a driver looks at devices outside its own root;
   * it reads them and never writes there (safety rule 1).
   */
  listComponents(): Promise<readonly DriverComponent[]>;
  removeComponent(
    receipt: ComponentReceipt,
    options: { readonly signal: AbortSignal },
  ): Promise<ComponentRemoval>;
  provision(spec: VirtualSpec): Promise<DriverDevice>;
  /**
   * why: Boots the device and returns it with a freshly read `address`. Never trust the address a
   * caller passed in or one captured at `provision` -- an Android console port is assigned per
   * boot, so a device coming back from `shutdown` (or a driver restart) can land on a different
   * one. `deviceId` and the registry-relevant parts of `driverData` do not change.
   */
  makeReady(
    device: VirtualDriverDevice,
    options: {
      readonly purpose: "prepare" | "recover";
      readonly mode: DeviceMode;
    },
  ): Promise<DriverDevice>;
  reclaim(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult>;
  reclaimStrategy(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): ReclaimStrategy;
  shutdown(device: VirtualDriverDevice): Promise<void>;
  destroy(device: VirtualDriverDevice): Promise<void>;
  listManaged(): Promise<DriverReality>;
  inspectPhysical(id: string): Promise<PhysicalInspection>;
  listPresentPhysical(enrolledIds: readonly string[]): Promise<readonly PresentPhysical[]>;
  listCatalog(): Promise<DriverCatalogEntry>;
  estimate(
    estimate: DriverEstimate & { readonly operation: "boot"; readonly device: DriverDevice },
    spec: DeviceSpec,
  ): number | Promise<number>;
  estimate(estimate: DriverEstimate, spec: DeviceSpec): number;
  leaseEnvironment(
    device: VirtualDriverDevice | PhysicalDriverDevice,
  ): Readonly<Record<string, string>>;
  virtualLeaseEnvironment(): Readonly<Record<string, string>>;
  /** why: Android must reap the adb server it supervises by pid; nothing else can. */
  dispose?(): Promise<void>;
  /** why: Spelled `| undefined` so a driver that decides at construction can still say it has none. */
  readonly passthroughTools?: readonly string[] | undefined;
  // why: optional because a platform whose screen cannot be taken leaves it out, and the stream
  // module learns that from its absence rather than from a platform name.
  readonly screenCapture?: ScreenCapture | undefined;
  /** why: `device.exec` has no pseudo-terminal (ADR 0005 §19c), so a driver may refuse there what it allows locally. */
  passthrough?(
    tool: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand>;
  findLegacy?(driverDeviceId: string): Promise<LegacyDevice | undefined>;
  destroyLegacy?(device: VirtualDriverDevice): Promise<void>;
  advisories?(): Promise<readonly DriverAdvisory[]>;
  toolVersions?(): Promise<readonly DriverToolVersion[]>;
}

export interface LegacyDevice {
  readonly device: DriverDevice;
  readonly path?: string;
}

// why: the frontend that runs it merges `env` over a base environment (the CLI's own; for
// `device.exec`, the daemon's allowlisted keys), because a tool spawned without `PATH` would not
// be found, and then deletes every key in `unsetEnv` from the child's.
export interface PassthroughCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly unsetEnv?: readonly string[];
}

/**
 * why: a driver cannot see the process that will run its command or the lease's platform, so
 * the caller states `hasTerminal` (to refuse what needs one, a bare `adb shell`) and, on
 * `device.exec`, the lease's `platform` (to refuse a tool that is another platform's). It is
 * not a general-purpose "who is asking".
 */
export interface PassthroughContext {
  readonly hasTerminal: boolean;
  readonly platform?: Platform;
}

/**
 * why: The wrappers exist to inject scoping
 * flags, and injecting them into `simctl delete` would hand back exactly the capability
 * the containment root exists to remove -- so the refusal, and the message naming what to
 * run instead, live with the driver that knows which verbs those are.
 */
export class PassthroughRefusedError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "PassthroughRefusedError";
  }
}

type DriverRejectionEvent = "driver.root-rejected" | "driver.adb-server-rejected";

export type AdbServerRejectionReason = "occupied" | "start-failed" | "invalid-port";

/**
 * why: Typed rather than a bare `string` so a reason that no
 * documented vocabulary contains cannot reach `doctor` output or the bus: the whole value
 * of publishing these words is that a user who reads one can look it up.
 */
export type DriverRejectionReason = RootRejectionReason | AdbServerRejectionReason;

/**
 * why: The pairing is the point. The core forwards `payload` to the bus without reading it, so
 * this is the only place the wire contract in `docs/internal/EVENTS.md` can still be checked -- a
 * wider `Record<string, string | number>` would type-check an adb rejection carrying a
 * string port, or a root rejection with no root at all, and it would reach
 * `simlock events --json` unexamined.
 */
interface DriverRefusal<Event extends DriverRejectionEvent> {
  readonly platform: Platform;
  readonly event: Event;
  readonly payload: EventMap[Event];
  /**
   * why: The refusal's vocabulary term (`missing-marker`, `occupied`, ...), stated separately
   * rather than read back out of `payload`, which is a wire contract the core does not
   * open. `doctor` reports it as the failing reason.
   */
  readonly reason: DriverRejectionReason;
  /**
   * why: the `simlock <tool>` wrappers this driver would have answered to are carried because a passthrough that finds no driver is otherwise indistinguishable
   * from a host with no SDK, and safety rule 9 promises Simlock reports *why*. The core
   * only compares it to the requested tool name; the name itself is the driver's.
   */
  readonly passthroughTools?: readonly string[];
  readonly summary: string;
}

/**
 * why: A driver that refuses to start fails closed and takes only
 * its own platform with it (safety rule 9), so the daemon has to be able to report the
 * refusal without understanding it: the driver module names the event and builds the
 * payload, and the core carries both to the bus and to `doctor` unread.
 */
export type DriverRejection =
  | DriverRefusal<"driver.root-rejected">
  | DriverRefusal<"driver.adb-server-rejected">;

export type ComponentReceipt = Readonly<Record<string, string>>;

export function sameReceipt(left: ComponentReceipt, right: ComponentReceipt): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

export interface InstalledComponent {
  readonly version: string;
  readonly receipt: ComponentReceipt;
}

export interface DriverComponent extends InstalledComponent {
  readonly variant?: string;
  readonly sizeBytes?: number;
  readonly foreignDevices: number;
}

export interface ComponentInstallResult extends InstalledComponent {
  readonly outcome: "installed" | "already-installed";
}

export interface ComponentRemoval {
  readonly sizeBytes?: number;
  readonly residue?: string;
}

export const COMPONENT_REMOVAL_TIMEOUT_MS = 5 * 60_000;

export async function removeListedComponent<Listed extends DriverComponent>(options: {
  readonly platform: Platform;
  readonly receipt: ComponentReceipt;
  readonly list: () => Promise<readonly Listed[]>;
  readonly remove: (component: Listed) => Promise<{ readonly residue?: string }>;
}): Promise<ComponentRemoval> {
  const { platform, receipt } = options;
  const target = (await options.list()).find((listed) => sameReceipt(listed.receipt, receipt));
  if (target === undefined) {
    throw new ComponentNotOwnedError(
      platform,
      `The ${platform} component Simlock installed is no longer installed as Simlock installed ` +
        "it, so Simlock will not remove anything",
    );
  }
  if (target.foreignDevices > 0) {
    throw new ComponentInUseError(platform, target.version, {
      devices: 0,
      foreignDevices: target.foreignDevices,
    });
  }
  const { residue } = await options.remove(target);
  if ((await options.list()).some((listed) => sameReceipt(listed.receipt, receipt))) {
    throw new DriverCrashError(
      `${platform} ${target.version} is still installed after it was removed`,
    );
  }
  return {
    ...(target.sizeBytes === undefined ? {} : { sizeBytes: target.sizeBytes }),
    ...(residue === undefined ? {} : { residue }),
  };
}

export class ComponentNotOwnedError extends Error {
  constructor(
    readonly platform: Platform,
    message: string,
  ) {
    super(message);
    this.name = "ComponentNotOwnedError";
  }
}

export class ComponentInUseError extends Error {
  readonly devices: number;
  readonly foreignDevices: number;

  constructor(
    readonly platform: Platform,
    readonly version: string,
    counts: { readonly devices: number; readonly foreignDevices: number },
  ) {
    super(
      `${platform} ${version} is in use by ${String(counts.devices)} Simlock ` +
        `${counts.devices === 1 ? "device" : "devices"} and ${String(counts.foreignDevices)} ` +
        `other ${counts.foreignDevices === 1 ? "device" : "devices"}; delete ` +
        `${counts.devices + counts.foreignDevices === 1 ? "it" : "them"} before removing it`,
    );
    this.name = "ComponentInUseError";
    this.devices = counts.devices;
    this.foreignDevices = counts.foreignDevices;
  }
}

export class ComponentBusyError extends Error {
  constructor(
    readonly platform: Platform,
    readonly version: string,
  ) {
    super(
      `Cannot remove ${platform} ${version} while a ${platform} component is being installed or ` +
        "removed; try again when it has finished",
    );
    this.name = "ComponentBusyError";
  }
}

export interface ComponentInstallProgress {
  readonly stage: "downloading";
  readonly percent: number;
}

export class ComponentInstallTimeoutError extends Error {
  constructor(
    readonly platform: Platform,
    readonly component: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Installing ${platform} ${component} did not finish within downloads.timeoutMs ` +
        `(${String(timeoutMs)}ms), counting the time spent waiting for another download`,
    );
    this.name = "ComponentInstallTimeoutError";
  }
}

export class RuntimeMissingError extends Error {
  readonly downloadable: boolean;
  readonly component?: string;

  constructor(
    readonly platform: Platform,
    readonly osVersion: string,
    options?: { readonly downloadable?: false } | { readonly component: string },
  ) {
    super(`Runtime missing for ${platform} ${osVersion}`);
    this.name = "RuntimeMissingError";
    if (options !== undefined && "component" in options) {
      this.downloadable = true;
      this.component = options.component;
    } else {
      this.downloadable = false;
    }
  }
}

export class UnsupportedRequestOptionError extends Error {
  constructor(
    readonly platform: Platform,
    readonly option: string,
  ) {
    super(`${platform} lease requests do not take ${option}`);
    this.name = "UnsupportedRequestOptionError";
  }
}

export class UnknownModelError extends Error {
  readonly class: DeviceClass | undefined;
  readonly model: string | undefined;

  constructor(
    readonly platform: Platform,
    model: string | undefined,
    deviceClass?: DeviceClass,
  ) {
    super(
      deviceClass === undefined
        ? `Unknown ${platform} model: ${String(model)}`
        : `No ${platform} model of class ${deviceClass} is listed on this host; ` +
            `name one in ${platform}.defaultModels.${deviceClass}`,
    );
    this.name = "UnknownModelError";
    this.model = model;
    this.class = deviceClass;
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
 * why: A check of free space alone only ever sees the
 * disk at the instant it runs: two installs racing the same preflight (an iOS runtime download
 * and an Android system-image install, or two of either) can each observe enough free space and
 * both proceed, jointly overfilling the volume neither alone would have. A single shared
 * `DiskSpaceGuard` instance, held by `ComponentInstaller` (wired once in `src/daemon/main.ts`;
 * drivers never see it), fixes that by tracking bytes reserved but not yet released, keyed per
 * path, and checking free space *minus* those outstanding reservations rather than free space
 * alone.
 *
 * `reserve` resolves or throws synchronously with respect to any other in-flight `reserve` call:
 * the only `await` is `filesystem.diskFree`, and the check-then-record step immediately after it
 * runs to completion before any other queued continuation gets a turn (JS's single-threaded
 * run-to-completion semantics), so two concurrent reservations against the same path can never
 * both observe headroom the other has already claimed.
 */
export class DiskSpaceGuard {
  readonly #outstandingBytesByPath = new Map<string, number>();

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
