import type { EventMap } from "../bus/index.js";
import type { Filesystem } from "../ports/index.js";
import type { RootRejectionReason } from "./device-root.js";
import type { DeviceSpec, DeviceTransitionUpdate, Platform } from "./domain.js";

export interface DeviceRequest {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string;
  /**
   * Platform-neutral request for a device with no driver-side resource reduction -- the
   * iOS driver happens to implement this as "do not slim"; other drivers ignore it. Never
   * read by the core beyond stamping it onto the resolved spec (see `DeviceSpec.full` and
   * the comment where `LeaseAcquisitionCoordinator` does that stamping).
   */
  readonly full?: boolean;
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
   * What the driver actually produced for this device, as of its last `makeReady` --
   * platform-neutral so the core can report feature loss without reading a driver's opaque
   * `driverData`. `"reduced"` means the driver cut the device's feature set (the iOS driver's
   * slim mode); `"full"` means it did not. `undefined` means the driver does not reduce
   * anything at all -- today's behaviour, and every non-iOS driver.
   */
  readonly featureProfile?: "full" | "reduced";
}

/**
 * Builds a `DeviceTransitionUpdate` from a driver's freshly re-read device, always including
 * `featureProfile` -- even when the driver returned `undefined`. `transition`'s
 * `{...record, ...update}` spread only clears a stale value when the update object *has* the
 * key; omitting it (as a conditional spread like `...(fp === undefined ? {} : { featureProfile:
 * fp })` does) would let a previous `"reduced"` survive a re-boot where slimming wasn't applied
 * this time, reporting `slim: true` on a device that is actually full-fat.
 * `DeviceTransitionUpdate["featureProfile"]` itself can't say "present but undefined" under
 * `exactOptionalPropertyTypes`, so the object is built with the wider type and cast at the
 * boundary -- the explicit `undefined` here is a deliberate runtime value, not a type-checking
 * gap. Shared by every readiness path that commits a driver's post-`makeReady` result
 * (`ManagedDeviceLifecycle`, `WarmPoolCoordinator`) so they can't drift on this.
 */
export function readyTransitionUpdate(readyDevice: DriverDevice): DeviceTransitionUpdate {
  const update: {
    readonly address: string;
    readonly driverData: unknown;
    readonly featureProfile: "full" | "reduced" | undefined;
  } = {
    address: readyDevice.address,
    driverData: readyDevice.driverData,
    featureProfile: readyDevice.featureProfile,
  };
  return update as DeviceTransitionUpdate;
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
 */
export interface DriverCatalogEntry {
  readonly models: readonly string[];
  readonly runtimes: readonly string[];
  readonly defaultRuntime: string | undefined;
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
   * True when this driver may hand back devices with a reduced feature set (the iOS driver's
   * slim mode, when actually enabled), so a caller's `full` request is meaningful and must not
   * share a pool key with a normal one. Optional; a driver that never reduces anything -- the
   * default, and every non-iOS driver -- omits it, equivalent to `false`. Read once per spec
   * resolution by `LeaseAcquisitionCoordinator`, which is the only place `DeviceSpec.full` gets
   * stamped onto a resolved spec.
   */
  readonly reducesFeatures?: boolean;
  resolveSpec(
    request: DeviceRequest,
    options: {
      readonly allowDownload: boolean;
      /**
       * The requester on whose behalf this resolution runs, when known. Optional: a caller that
       * resolves outside of a lease request (e.g. a driver revalidating its own cached spec) has
       * no requester to attribute. Threaded through to a driver's component-install diagnostics
       * so the resulting `component.install-*` events carry it -- see `docs/EVENTS.md`.
       */
      readonly requesterId?: string;
    },
  ): Promise<DeviceSpec>;
  provision(spec: DeviceSpec): Promise<DriverDevice>;
  /**
   * Boots the device and returns it with a freshly read `address`. Never trust the address a
   * caller passed in or one captured at `provision` -- an Android console port is assigned per
   * boot, so a device coming back from `shutdown` (or a driver restart) can land on a different
   * one. `deviceId` and the registry-relevant parts of `driverData` do not change.
   */
  makeReady(
    device: DriverDevice,
    options?: {
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
   * adb server it must reap by pid, since nothing else can (`docs/known-pitfalls.md`).
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
 * `docs/EVENTS.md`, so the vocabulary is fixed and closed.
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
 * this is the only place the wire contract in `docs/EVENTS.md` can still be checked -- a
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

export class RuntimeMissingError extends Error {
  /**
   * Whether a download could plausibly fix this. `true` by default -- a plain "runtime not
   * installed" is exactly what `--allow-download` exists for. A subclass reporting a request
   * no download can ever satisfy (out of the model's pairing range, an installed runtime that
   * does not pair with the model, a version older than Xcode's automatic-download floor) sets
   * this `false` so callers (see the daemon's download-policy suffix) don't point someone at a
   * flag that cannot help.
   */
  readonly downloadable: boolean;

  constructor(
    readonly platform: Platform,
    readonly osVersion: string,
    options?: { readonly downloadable?: boolean },
  ) {
    super(`Runtime missing for ${platform} ${osVersion}`);
    this.name = "RuntimeMissingError";
    this.downloadable = options?.downloadable ?? true;
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
 * `assertDiskSpace` alone only ever sees the disk's free space at the instant it is called: two
 * installs racing the same preflight (an iOS runtime download and an Android system-image
 * install, or two of either) can each observe enough free space and both proceed, jointly
 * overfilling the volume neither alone would have. A single shared `DiskSpaceGuard` instance,
 * injected into every driver that installs components (wired once in `src/daemon/main.ts`),
 * fixes that by tracking bytes reserved but not yet released, keyed per path, and checking free
 * space *minus* those outstanding reservations rather than free space alone.
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
   * outstanding there. Throws `InsufficientDiskSpaceError` (same shape `assertDiskSpace` throws)
   * when the reservation would not fit. On success, returns a release function the caller must
   * invoke exactly once (typically in a `finally`) once the install this reservation was made
   * for has settled, freeing the bytes for the next reservation.
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

/**
 * Checked before a driver starts any multi-GB component download/install, so a full disk fails
 * fast with a clear message instead of filling up mid-download (see safety rule 4's spirit --
 * downloads must never surprise the machine they run on). `path` defaults to `"."`, the same
 * convention `CleanupReaper` uses for its own disk-pressure check (`src/core/reaper.ts`): the
 * daemon process's own working-directory volume. Single-shot: does not account for another
 * concurrent install's own in-flight reservation -- see `DiskSpaceGuard` for that.
 */
export async function assertDiskSpace(
  filesystem: Pick<Filesystem, "diskFree">,
  platform: Platform,
  requiredBytes: number,
  path = ".",
): Promise<void> {
  const availableBytes = await filesystem.diskFree(path);
  if (availableBytes < requiredBytes) {
    throw new InsufficientDiskSpaceError(platform, requiredBytes, availableBytes);
  }
}
