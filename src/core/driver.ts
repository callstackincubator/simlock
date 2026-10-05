import type { EventMap } from "../bus/index.js";
import type { Filesystem } from "../ports/index.js";
import type { RootRejectionReason } from "./device-root.js";
import type {
  DeviceClass,
  DeviceMode,
  DeviceSpec,
  DeviceTransitionUpdate,
  Platform,
} from "./domain.js";

export interface DeviceRequest {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string;
  /**
   * The device mode the request asked for; absent when it named none (ADR 0007 §1). Transports
   * carry it as it arrived. `LeaseAcquisitionCoordinator` is the one place an absent mode gets
   * the worker's default, and a driver's `resolveSpec` always receives it resolved.
   */
  readonly mode?: DeviceMode;
  /**
   * The image type the request names, as the driver's catalog lists it; absent when it names
   * none. Transports carry it as it arrived. Only a driver knows what a tag is: one that has none
   * throws `UnsupportedRequestOptionError`, and one that has them resolves only to an installed
   * image of that tag, never to a download.
   */
  readonly imageTag?: string;
}

export interface DriverDevice {
  readonly deviceId: string;
  readonly driverData: unknown;
  /**
   * The opaque string platform tooling accepts right now -- a simctl UDID for iOS, an adb
   * serial (`emulator-<port>`) for Android. The core carries it without interpreting it; only
   * the owning driver module knows what it means. Unlike `deviceId`, which identifies the
   * device for as long as it exists, this can change across a boot -- see `Driver.makeReady`.
   */
  readonly address: string;
  /**
   * The mode the driver actually produced for this device, as of its last `makeReady` --
   * platform-neutral so the core can report it without reading a driver's opaque
   * `driverData`. `"slim"` means the driver cut the device's feature set (the iOS driver's
   * slim pass); `"full"` means it did not. `undefined` means the driver does not slim at all
   * -- every non-iOS driver -- and is stored as `"full"` (see `readyTransitionUpdate`).
   */
  readonly mode?: DeviceMode;
}

/**
 * Builds a `DeviceTransitionUpdate` from a driver's freshly re-read device. It always writes
 * `mode`, defaulting a driver's `undefined` to `"full"` here and nowhere else, so a stale
 * `"slim"` can never outlive a re-boot that did not slim. Shared by every readiness path that
 * commits a driver's post-`makeReady` result (`ManagedDeviceLifecycle`, `WarmPoolCoordinator`)
 * so they can't drift on this.
 */
export function readyTransitionUpdate(readyDevice: DriverDevice): DeviceTransitionUpdate {
  return {
    address: readyDevice.address,
    driverData: readyDevice.driverData,
    mode: readyDevice.mode ?? "full",
  };
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
  /** Devices whose membership in the driver's root proves that Simlock created them. */
  readonly devices: readonly ObservedDevice[];
  /** Running device processes from that same root, not necessarily in the registry. */
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
 *
 * `modelRuntimes` has an entry for every name in `models`: the installed runtimes that model
 * pairs with, decided by the same function `resolveSpec` uses, so every listed pair resolves
 * (ADR 0008 §3). An empty list means no installed runtime pairs with that model.
 *
 * `modelAliases` maps a name in `models` to the other names `resolveSpec` accepts for it, from
 * the same matcher `resolveSpec` uses; a model with no other name has no entry. `images` is
 * present only for a driver whose runtimes come as installed images, one entry per image.
 *
 * `modelClasses` maps a name in `models` to its class when the platform's tools report one; a
 * model they say nothing usable about has no entry. The core carries it and reads nothing from
 * it.
 *
 * `customModels` names the values from `models` that exist because of something on this
 * machine, not because of the platform's tools. The core carries it and never reads it; a
 * driver with no such models omits the field.
 */
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

/**
 * One installed image. `runtime` is a value from the entry's `runtimes`; `tag` and `abi` are
 * the driver's own words for the image's variant and instruction set, carried unread.
 */
export interface DriverCatalogImage {
  readonly runtime: string;
  readonly tag: string;
  readonly abi: string;
}

/**
 * A configuration-level problem only the owning driver can see -- reported by `doctor`
 * alongside its own drift findings (`src/core/doctor.ts`'s `driver-advisory` finding kind).
 * Unlike drift, this is never something `--fix` acts on: it describes a standing condition of
 * the driver's own configuration (e.g. a feature silently doing nothing given the installed
 * runtimes), not a divergence between the registry and reality.
 */
export interface DriverAdvisory {
  /** Short kebab-case identifier the driver owns; the core never interprets it. */
  readonly code: string;
  readonly message: string;
}

/**
 * A tool Simlock needs and does not install, found missing by a `PrerequisiteCheck`. Every
 * field is the driver module's own text; the core carries all three unread.
 */
export interface MissingPrerequisite {
  /** Short kebab-case identifier the driver module owns. */
  readonly prerequisite: string;
  /** What is missing. */
  readonly message: string;
  /** The command or step that installs it. */
  readonly remedy: string;
}

/**
 * Looks for one platform's prerequisites on this machine. Deliberately not a `Driver` method:
 * it has to answer exactly when the driver could not be built, because a prerequisite is
 * missing. Read-only -- it never installs, downloads or writes -- and every process it starts
 * is bounded. It rejects when it cannot tell, rather than reporting something missing.
 */
export interface PrerequisiteCheck {
  readonly platform: Platform;
  check(): Promise<readonly MissingPrerequisite[]>;
}

/**
 * One platform tool a driver uses and the version installed (ADR 0008 §6). `name` and the
 * version format are the driver's own; the core reports them and reads neither.
 */
export interface DriverToolVersion {
  readonly name: string;
  readonly version: string;
  /** A build identifier the tool reports beside its version, when it has one. */
  readonly build?: string;
}

export interface Driver {
  readonly platform: Platform;
  /**
   * Absolute path of the root this driver owns and scopes every platform command to.
   * Membership in it is what proves a device is Simlock's; the core carries the string
   * around without interpreting it, the same way it carries `address`.
   */
  readonly deviceRoot: string;
  /**
   * Re-runs this driver's own root validation, resolving only while the root still proves
   * ownership and rejecting with the driver's own refusal (an `OwnedRootError`) when it
   * does not.
   *
   * Ownership is proven once, at startup, and then trusted for the life of the process --
   * tolerable for reporting, not for destroying. A daemon that has been up for days is one
   * `mv` or one symlink away from `deviceRoot` naming the user's own device set, at which
   * point `listManaged` answers with every simulator on the machine and
   * `doctor --purge-orphans` would destroy them. Only the driver can re-run the check,
   * because only it knows how its root was built (architecture rule 2).
   */
  revalidateRoot(): Promise<void>;
  /**
   * Resolves a request into the spec a device is planned on. `request.mode` is always set here,
   * resolved by the core. A driver returns a spec with `mode: "slim"` only for a slim request it
   * will actually slim; for any other request, and for a slim one it cannot slim, it returns a
   * full spec (ADR 0007 §4). A driver that does not slim at all never sets the spec's mode.
   */
  /*
   * Never downloads (ADR 0010 §2). When a download could satisfy the request it throws
   * `RuntimeMissingError` with `downloadable: true` and `component`, the string to hand to
   * `installComponent` -- the core never decides whether to download from inside a driver.
   */
  resolveSpec(request: DeviceRequest): Promise<DeviceSpec>;
  /**
   * A read: the installed component that satisfies `component`, with its exact version and its
   * receipt, or `undefined`. Never downloads. A string that is not a version, such as the
   * driver's word for "newest", answers `undefined`: only an installer run can tell.
   */
  findComponent(component: string): Promise<InstalledComponent | undefined>;
  /**
   * Runs the platform installer for `component` and verifies the result against a fresh read.
   * `installed` when the receipt it ends with was not there before the run, `already-installed`
   * when it was. Ends the installer when `signal` fires. Joins no callers, checks no disk, emits
   * no events and reads no policy: `ComponentInstaller` is its only caller and does all four.
   */
  installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult>;
  /**
   * The disk one install needs, as a fixed estimate, and the path it lands on. Neither platform
   * installer reports a size before it downloads, so this is what `ComponentInstaller` reserves.
   */
  readonly componentFootprint: { readonly path: string; readonly bytes: number };
  /**
   * Every component installed on the machine now, one entry each (ADR 0010 §8). Read-only, never
   * downloads, and every process it starts is bounded: the same contract as `listCatalog`.
   * Counting `foreignDevices` is the only place a driver looks at devices outside its own root;
   * it reads them and never writes there (safety rule 1).
   */
  listComponents(): Promise<readonly DriverComponent[]>;
  /**
   * Removes the installed component whose receipt equals `receipt` (ADR 0010 §8), through
   * `removeListedComponent`: it proves the receipt against a fresh listing
   * (`ComponentNotOwnedError` when nothing matches), refuses when a foreign device uses it
   * (`ComponentInUseError`), runs the platform's own removal bounded by
   * `COMPONENT_REMOVAL_TIMEOUT_MS` and ended by `signal`, and lists again to verify it is gone.
   * `ComponentInstaller` is its only caller, and calls it only for a component it has a record
   * of and no Simlock device uses.
   */
  removeComponent(
    receipt: ComponentReceipt,
    options: { readonly signal: AbortSignal },
  ): Promise<ComponentRemoval>;
  provision(spec: DeviceSpec): Promise<DriverDevice>;
  /**
   * Boots the device and returns it with a freshly read `address`. Never trust the address a
   * caller passed in or one captured at `provision` -- an Android console port is assigned per
   * boot, so a device coming back from `shutdown` (or a driver restart) can land on a different
   * one. `deviceId` and the registry-relevant parts of `driverData` do not change.
   */
  makeReady(
    device: DriverDevice,
    options: {
      /**
       * What this readiness call is for. `"prepare"` (the default) may do work that changes
       * the device's configuration -- a fresh boot, a driver's own opt-in configuration pass
       * (the iOS driver's slim apply). `"recover"` is the one caller (`ManagedDeviceLifecycle.
       * recoverLeased`, safety rule 2's narrow crash-recovery exception) that reboots a device
       * that is still `leased`: it must do the minimum needed to get that device running again
       * and must never change its configuration, so a driver treats `"recover"` as "boot only,
       * do not apply anything new".
       */
      readonly purpose: "prepare" | "recover";
      /**
       * The mode the device's spec plans (`specMode`). The registry is the only record of it
       * (ADR 0007 §7): a driver keeps no copy and reads it from here on every boot. A
       * `"recover"` boot still applies nothing new, whatever this says.
       */
      readonly mode: DeviceMode;
    },
  ): Promise<DriverDevice>;
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
  /**
   * Opaque environment a lease holder needs to reach a device in this driver's root --
   * containment cuts both ways, so a grant that did not carry it would hand out a device
   * nobody could address. The core forwards it verbatim; no key here means anything to it.
   */
  leaseEnvironment(): Readonly<Record<string, string>>;
  /**
   * Releases whatever this driver holds outside its own process -- Android supervises an
   * adb server it must reap by pid, since nothing else can (`docs/internal/KNOWN-PITFALLS.md`).
   * Optional because most drivers hold nothing; the daemon calls it on every shutdown
   * path and never lets a failure here abort the rest of one.
   */
  dispose?(): Promise<void>;
  /**
   * The `simlock <tool>` name this driver answers to (`simctl`, `adb`), when it wraps a
   * platform tool at all. Spelled `| undefined` rather than left plain optional so a
   * driver that decides at construction time whether it has one can still say so.
   */
  readonly passthroughTool?: string | undefined;
  /**
   * Scoped command for `simlock <tool> <args>`, or `PassthroughRefusedError` for a verb
   * this driver will not proxy. Both halves are the driver's business: only it knows
   * which flag points its tool at the root it owns, and only it knows which verbs would
   * change a device's lifecycle behind the registry's back (ADR 0001, decision 7).
   *
   * `context` says what the caller can offer the command, which is the one thing about the
   * *caller* a driver's refusal list legitimately depends on: `device.exec` runs the command
   * on the daemon's machine with no pseudo-terminal (ADR 0005 §19c), so a driver may refuse
   * something there that it allows for a local `simlock <tool>` invocation with a terminal
   * behind it. Omitted means a terminal is available -- today's local path, unchanged.
   */
  passthrough?(args: readonly string[], context?: PassthroughContext): PassthroughCommand;
  /**
   * Looks for a registry device in the location this platform used before Simlock owned a
   * root, and reports it without touching it. Optional: a driver with no pre-root history
   * has nothing to find. The core only ever asks about a device the root itself no longer
   * holds, so a "yes" here is what separates "stranded by the migration" from "gone".
   */
  findLegacy?(driverDeviceId: string): Promise<LegacyDevice | undefined>;
  /**
   * Destroys such a device through the old, unscoped path it actually lives on. This is
   * the only Simlock call that reaches outside an owned root, and it is permitted because
   * the device is in the registry: registry-only destruction (safety rule 1) is satisfied
   * by the record, not by the root (ADR 0001, Migration).
   */
  destroyLegacy?(device: DriverDevice): Promise<void>;
  /**
   * Configuration-level problems only this driver can see -- reported by `doctor` alongside its
   * drift findings. Read-only and side-effect free (same contract as `listCatalog`): it must
   * never trigger a download, boot, or mutate anything. Optional: a driver with nothing to
   * advise omits it.
   */
  advisories?(): Promise<readonly DriverAdvisory[]>;
  /**
   * The versions of the platform tools this driver uses, for `status.get`'s host facts.
   * Read-only and never downloads, like `advisories`. A tool that is not installed is left out.
   * A read that fails -- a tool that is there but errors, times out, or answers in a shape the
   * driver does not know -- rejects, and the core keeps what this driver reported last
   * (`HostFactsReader`). Every process it starts is bounded. Optional: a driver with no tools to
   * report omits it.
   */
  toolVersions?(): Promise<readonly DriverToolVersion[]>;
}

/**
 * A device this driver created before Simlock owned a root, still sitting where the
 * platform put it. Neither CoreSimulator nor the Android SDK can relocate a device, so
 * these are reported and destroyed rather than migrated, and users re-provision.
 */
export interface LegacyDevice {
  /** Addressed through the driver's unscoped path, never through the root's. */
  readonly device: DriverDevice;
  /** Where the driver found it, for the report. Absent when the tool does not say. */
  readonly path?: string;
}

/**
 * A ready-to-run invocation of a platform tool, already scoped to the driver's root. The
 * frontend that runs it merges `env` over its own environment rather than replacing it --
 * these are only the scoping keys, and a tool spawned without `PATH` would not be found.
 */
export interface PassthroughCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * What the caller can give the command it is asking for. One field today: whether the process
 * that runs it has a terminal. A driver reads it to refuse what cannot work without one (a
 * bare `adb shell`), and nothing else -- it is not a general-purpose "who is asking".
 */
export interface PassthroughContext {
  readonly hasTerminal: boolean;
}

/**
 * A passthrough verb a driver refuses to proxy. The wrappers exist to inject scoping
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

/** The events a driver may refuse to start with; each pairs with its own payload below. */
type DriverRejectionEvent = "driver.root-rejected" | "driver.adb-server-rejected";

/**
 * Why Simlock's own adb server could not be established. Wire-visible, like the root
 * reasons: these travel in the `driver.adb-server-rejected` payload and are listed in
 * `docs/internal/EVENTS.md`, so the vocabulary is fixed and closed.
 *
 * It sits beside the event names rather than in `drivers/android` because the two are one
 * contract: the core publishes neither without the other, and a driver module cannot be
 * the place a core type is defined. Nothing here interprets a term (architecture rule 2).
 */
export type AdbServerRejectionReason = "occupied" | "start-failed" | "invalid-port";

/**
 * Every term a refusal may report. Typed rather than a bare `string` so a reason that no
 * documented vocabulary contains cannot reach `doctor` output or the bus: the whole value
 * of publishing these words is that a user who reads one can look it up.
 */
export type DriverRejectionReason = RootRejectionReason | AdbServerRejectionReason;

/**
 * One refusal, with the payload the event it names is published with.
 *
 * The pairing is the point. The core forwards `payload` to the bus without reading it, so
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
   * The refusal's vocabulary term (`missing-marker`, `occupied`, ...), stated separately
   * rather than read back out of `payload`, which is a wire contract the core does not
   * open. `doctor` reports it as the failing reason.
   */
  readonly reason: DriverRejectionReason;
  /**
   * The `simlock <tool>` wrapper this driver would have answered to, when it has one.
   * Carried because a passthrough that finds no driver is otherwise indistinguishable
   * from a host with no SDK, and safety rule 9 promises Simlock reports *why*. The core
   * only compares it to the requested tool name; the name itself is the driver's.
   */
  readonly passthroughTool?: string;
  /** One line, for `doctor` output and the startup log. */
  readonly summary: string;
}

/**
 * Why a driver could not start. A driver that refuses to start fails closed and takes only
 * its own platform with it (safety rule 9), so the daemon has to be able to report the
 * refusal without understanding it: the driver module names the event and builds the
 * payload, and the core carries both to the bus and to `doctor` unread.
 */
export type DriverRejection =
  | DriverRefusal<"driver.root-rejected">
  | DriverRefusal<"driver.adb-server-rejected">;

/**
 * What names an installed component itself, opaque to the core: it compares receipts for
 * equality and reads nothing in them (ADR 0010 §5). It differs for every install, so a component
 * the user deleted and installed again does not match a record of Simlock's earlier install.
 */
export type ComponentReceipt = Readonly<Record<string, string>>;

/** Whether two receipts name the same installed thing: the same keys with the same values. */
export function sameReceipt(left: ComponentReceipt, right: ComponentReceipt): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

/** An installed component: the exact version the catalog lists, and its receipt. */
export interface InstalledComponent {
  readonly version: string;
  readonly receipt: ComponentReceipt;
}

/**
 * One component `listComponents` found installed. `receipt` is built by the same function
 * `findComponent` and `installComponent` use, so a listed component and the record of its install
 * compare equal with `sameReceipt`. `variant` is the driver's own words for what tells two
 * components of one version apart, carried unread. `sizeBytes` is absent when the driver could
 * not read it. `foreignDevices` is the number of devices outside Simlock's root that count as
 * users of it; the driver decides what counts as a user, and a removal is refused while it is
 * above zero.
 */
export interface DriverComponent extends InstalledComponent {
  readonly variant?: string;
  readonly sizeBytes?: number;
  readonly foreignDevices: number;
}

/**
 * What one `installComponent` run ended with. `installed` when the receipt was not there before
 * the run; `already-installed` when it was, so Simlock never records a component it did not put
 * there.
 */
export interface ComponentInstallResult extends InstalledComponent {
  readonly outcome: "installed" | "already-installed";
}

/**
 * What one `removeComponent` freed and left. `sizeBytes` is the component's size as listed just
 * before it was removed, absent when the driver could not read it. `residue` is one sentence or
 * more for the operator when something stays on disk after the removal, and how to reclaim it.
 */
export interface ComponentRemoval {
  readonly sizeBytes?: number;
  readonly residue?: string;
}

/**
 * How long one platform removal (`simctl runtime delete`, `sdkmanager --uninstall`) may run,
 * measured from its start. A driver that waits after the tool answers spends the same budget.
 */
export const COMPONENT_REMOVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * The one shape of `Driver.removeComponent`, for every driver alike (ADR 0010 §8):
 *
 * 1. find the listed component whose receipt equals `receipt`; none is `ComponentNotOwnedError`;
 * 2. a foreign device that uses it is `ComponentInUseError`;
 * 3. `remove` it, the driver's own platform step;
 * 4. list again, and fail when a component with that receipt is still there.
 *
 * `list` is the driver's listing, the same one `listComponents` answers from, so the "in use"
 * answer here and in `component.list` cannot differ. A listing that rejects rejects the removal.
 */
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

/**
 * A removal Simlock refuses because the component is not Simlock's (ADR 0010 §5): there is no
 * record of installing it, or what is installed now is not what the record names.
 */
export class ComponentNotOwnedError extends Error {
  constructor(
    readonly platform: Platform,
    message: string,
  ) {
    super(message);
    this.name = "ComponentNotOwnedError";
  }
}

/**
 * A removal Simlock refuses because a device uses the component (ADR 0010 §8): `devices` of
 * Simlock's own, in any state but deleted, and `foreignDevices` outside Simlock.
 */
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

/** A removal refused because an install, or another removal, is running or waiting on the platform. */
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

/** A driver's progress report while it installs: the percentage its installer printed. */
export interface ComponentInstallProgress {
  readonly stage: "downloading";
  readonly percent: number;
}

/**
 * A component install call ran out of its one budget, `downloads.timeoutMs`, measured from the
 * moment the call arrived (ADR 0010 §3). Waiting for the platform's turn spends it too.
 */
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
  /**
   * Whether a download could plausibly fix this: `true` exactly when the thrower names the
   * `component` to install -- a plain "runtime not installed" is what `--allow-download` exists
   * for. Without one (out of the model's pairing range, an installed runtime that does not pair
   * with the model, a version below a download floor) it is `false`, so callers (see the
   * daemon's download-policy suffix) don't point someone at a flag that cannot help.
   */
  readonly downloadable: boolean;
  /**
   * The string to hand to `Driver.installComponent` (ADR 0010 §2), set whenever `downloadable`
   * is. It may be broader than a version -- the driver's word for "newest" -- and the core hands
   * it back unread.
   */
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

/**
 * A request named an option this driver does not have, such as an image tag on a platform whose
 * runtimes come in one type. The driver decides that itself, so the core keeps no list of which
 * platforms take which option.
 */
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
 * A component install was refused because a required license/EULA is not accepted --
 * platform-agnostic the same way `RuntimeMissingError` is, so the daemon can map it to a
 * stable error code without importing a driver module. `AndroidLicenseNotAcceptedError` (the
 * only concrete case today) extends this with its own message; a future platform with the same
 * shape of gate would do the same rather than the daemon special-casing Android.
 */
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
 * Serializes disk-space preflight across concurrent component installs sharing a volume.
 * Checked before any multi-GB component download/install, so a full disk fails fast with a
 * clear message instead of filling up mid-download (see safety rule 4's spirit -- downloads
 * must never surprise the machine they run on). A check of free space alone only ever sees the
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

  /**
   * Reserves `requiredBytes` against `path`'s free space, minus whatever this guard already has
   * outstanding there. Throws `InsufficientDiskSpaceError` when the reservation would not fit.
   * On success, returns a release function the caller must invoke exactly once (typically in a
   * `finally`) once the install this reservation was made for has settled, freeing the bytes for
   * the next reservation.
   */
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
