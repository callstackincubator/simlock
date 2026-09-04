import type { EventMap } from "../bus/index.js";
import type { RootRejectionReason } from "./device-root.js";
import type { DeviceSpec, Platform } from "./domain.js";

export interface DeviceRequest {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion?: string;
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

export interface Driver {
  readonly platform: Platform;
  /**
   * Absolute path of the root this driver owns and scopes every platform command to.
   * Membership in it is what proves a device is Simlock's; the core carries the string
   * around without interpreting it, the same way it carries `address`.
   */
  readonly deviceRoot: string;
  resolveSpec(
    request: DeviceRequest,
    options: { readonly allowDownload: boolean },
  ): Promise<DeviceSpec>;
  provision(spec: DeviceSpec): Promise<DriverDevice>;
  /**
   * Boots the device and returns it with a freshly read `address`. Never trust the address a
   * caller passed in or one captured at `provision` -- an Android console port is assigned per
   * boot, so a device coming back from `shutdown` (or a driver restart) can land on a different
   * one. `deviceId` and the registry-relevant parts of `driverData` do not change.
   */
  makeReady(device: DriverDevice): Promise<DriverDevice>;
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
