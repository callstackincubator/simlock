import { type OsConstraint as RequestedOs, satisfies } from "../contract/os-range.js";
import type { DeviceRequest } from "./driver.js";

export type Platform = "ios" | "android";

/**
 * ADR 0015 §3: the kind of device a model is. Declared here beside `Platform` rather than
 * imported from the contract; which family or tag is which class is the driver's to say.
 */
export const DEVICE_CLASSES = [
  "phone",
  "tablet",
  "watch",
  "tv",
  "vision",
  "auto",
  "desktop",
] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/** The mode a device actually has: slimmed by its driver, or not. */
export type DeviceMode = "slim" | "full";

export interface DeviceSpec {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion: string;
  /**
   * The mode this device is planned to have: `"slim"` for a device its driver will slim, absent
   * for a full one (ADR 0007 §6). Only a driver's `resolveSpec` sets it, and only for a slim
   * request it will actually slim; `LeaseAcquisitionCoordinator` refuses it on any other request.
   * Part of spec identity (`sameSpec`), so slim and full devices never share a pool, and fixed
   * for as long as the device exists. The mode the device actually has is `DeviceRecord.mode`.
   */
  readonly mode?: "slim";
  /**
   * The image type the request named, as the driver's catalog lists it (`images[].tag`); absent
   * when the request named none. Set only by a driver's `resolveSpec`, for a request that named
   * it; `LeaseAcquisitionCoordinator` refuses a spec whose tag is not the request's. The core
   * carries it and compares it in `sameSpec`, and never reads what it means.
   */
  readonly imageTag?: string;
}

/** The mode a spec plans: `"slim"` when it says so, `"full"` otherwise. */
export function specMode(spec: DeviceSpec): DeviceMode {
  return spec.mode ?? "full";
}

/**
 * Spec identity as every selection path means it: same platform, model, OS version, mode, and
 * image tag. A spec with no tag and a spec with one never match, so neither pool serves the other.
 */
export function sameSpec(left: DeviceSpec, right: DeviceSpec): boolean {
  return (
    left.platform === right.platform &&
    left.model === right.model &&
    left.osVersion === right.osVersion &&
    specMode(left) === specMode(right) &&
    left.imageTag === right.imageTag
  );
}

/**
 * The OS a requirement accepts (ADR 0015 §5). `exact` is one version, the one an exact request
 * resolves to or one the request named; `installed` is any runtime the catalog lists as installed,
 * which is what a class request with no OS accepts. A `range` is the request's own range, parsed
 * by the contract's `os-range`, the one grammar.
 */
export type OsRequirement =
  | RequestedOs
  | { readonly kind: "installed"; readonly versions: readonly string[] };

/**
 * What an existing device must satisfy to serve a request (ADR 0015 §5): the platform, the
 * model or the class, the OS, and the image tag. The mode is not part of it; the planner
 * compares pool mode beside `fits` (§6).
 */
export interface DeviceRequirement {
  readonly platform: Platform;
  readonly target:
    | { readonly kind: "model"; readonly model: string }
    | { readonly kind: "class"; readonly class: DeviceClass };
  readonly osVersion: OsRequirement;
  readonly imageTag: string | undefined;
}

/**
 * A lease request that has no device yet, reduced to what decides whether a device serves it: its
 * platform, what a device must satisfy, and the pool mode its spec resolved to. `classOf` is the
 * catalog's model-to-class lookup the requirement may need. `inFlight` is a request whose device
 * work has begun (a provision, boot or eviction): it is being served, not waiting, but it still
 * has a slot coming that is not yet reserved.
 */
export interface WaitingDemand {
  readonly inFlight: boolean;
  readonly platform: Platform;
  readonly requirement: DeviceRequirement;
  readonly mode: DeviceMode;
  readonly classOf: (model: string) => DeviceClass | undefined;
}

/** The requirement an exact request has once its driver resolved it: that spec's model, OS and tag. */
export function exactRequirement(spec: DeviceSpec): DeviceRequirement {
  return {
    imageTag: spec.imageTag,
    osVersion: { kind: "exact", version: spec.osVersion },
    platform: spec.platform,
    target: { kind: "model", model: spec.model },
  };
}

/**
 * The one place a requirement meets a device (ADR 0015 §6; architecture rule 10). Holds when the
 * platform is equal, the model is equal or `classOf` says the device's model is the requested
 * class, the OS satisfies the constraint, and the image tag is equal or both absent. It does not
 * read the mode. `sameSpec` stays what names pool identity everywhere else.
 */
export function fits(
  requirement: DeviceRequirement,
  spec: DeviceSpec,
  classOf: (model: string) => DeviceClass | undefined,
): boolean {
  if (requirement.platform !== spec.platform || requirement.imageTag !== spec.imageTag) {
    return false;
  }
  return (
    fitsTarget(requirement.target, spec.model, classOf) &&
    satisfiesOs(requirement.osVersion, spec.osVersion)
  );
}

function fitsTarget(
  target: DeviceRequirement["target"],
  model: string,
  classOf: (model: string) => DeviceClass | undefined,
): boolean {
  switch (target.kind) {
    case "model":
      return target.model === model;
    case "class":
      return classOf(model) === target.class;
  }
}

function satisfiesOs(constraint: OsRequirement, osVersion: string): boolean {
  return constraint.kind === "installed"
    ? constraint.versions.includes(osVersion)
    : satisfies(osVersion, constraint);
}

/**
 * Whether a device may serve more than one lease. `reusable` devices are purged and returned to
 * the pool after each lease; a `fresh` device serves exactly one lease and is then deleted. Read
 * from `lease.identity.<platform>` when the device is created and fixed on its record from then on.
 */
export type LeaseIdentity = "reusable" | "fresh";

export type DeviceState =
  | "provisioning"
  | "ready"
  | "leased"
  | "reclaiming"
  | "quarantined"
  | "shutdown"
  | "deleted";

export interface DeviceRecord {
  readonly id: string;
  readonly driverDeviceId: string;
  readonly spec: DeviceSpec;
  readonly state: DeviceState;
  readonly driverData: unknown;
  readonly createdAt: number;
  readonly lastLeaseEndedAt?: number;
  readonly foreignStateDetectedAt?: number;
  readonly foreignProvenanceDetectedAt?: number;
  readonly recoveringSince?: number;
  readonly recoveryAttempts?: number;
  /**
   * Set while a device sits `reclaiming` with its wipe not yet started, because the daemon start
   * that ended its lease could not read its platform (ADR 0019 §2). It names that lease. A later
   * start that can read the platform runs the full reclaim, purge included, for a device that
   * carries it, instead of the shutdown-only recovery of a reclaim a crash interrupted. Any
   * transition drops it.
   */
  readonly deferredReclaimLeaseId?: string;
  /** Set on entry to `quarantined`; the wall-clock moment the first purge failed. */
  readonly quarantinedAt?: number;
  /** Failed retry count since entering quarantine (the triggering failure itself is not a retry). */
  readonly quarantineAttempts?: number;
  /** When the next purge retry is armed for, so a restarted daemon can re-arm it faithfully. */
  readonly quarantineNextRetryAt?: number;
  /**
   * The driver-reported address (see `DriverDevice.address`), current as of this device's
   * last `ready` transition. Undefined for a device still `provisioning` (never made ready
   * yet) and, as an upgrade path, for a record written by a pre-address daemon -- `state.json`
   * from before this field existed loads without one rather than failing to start. It becomes
   * defined the next time the device is made ready (`bootForLease`/`readyProvisionedForLease`);
   * nothing here ever guesses at a value it wasn't told.
   */
  readonly address?: string;
  /**
   * The mode the device actually has (see `DriverDevice.mode`), current as of its last `ready`
   * transition. `registerDevice` writes `"full"` for a device that has not booted yet, and a
   * record written before this field existed loads as `"full"`.
   */
  readonly mode: DeviceMode;
  /**
   * The lease-identity policy this device was created under (see `LeaseIdentity`). The registry
   * stamps it on every device it registers and loads a record written before this field existed
   * as `reusable`; absent reads the same way.
   */
  readonly leaseIdentity?: LeaseIdentity;
}

/**
 * The one answer to "may this device be handed to a new lease?". A `fresh` device that has ended
 * a lease is spent: `beginRelease` stamps `lastLeaseEndedAt` on every lease end, so that stamp is
 * the proof it already served its one lease. Every other device is grantable as far as identity
 * goes; state, spec, and claims are the caller's own checks.
 */
export function mayBeGranted(device: DeviceRecord): boolean {
  return device.leaseIdentity !== "fresh" || device.lastLeaseEndedAt === undefined;
}

export interface LeaseRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly requesterId: string;
  /**
   * The session principal (ADR 0003 §4) that requested this lease -- the identity `renew`,
   * `release`, and `list` compare against, not `requesterId` (which is attribution, defaults to
   * the principal, but a connection may set it to something else per request so one connection
   * can hold many leases). A record written before this field existed loads with `ownerId` equal
   * to `requesterId` -- see `parseLease` in `registry.ts`.
   */
  readonly ownerId: string;
  readonly grantedAt: number;
  /**
   * The width this lease was granted with, or last renewed with when a renew named one (ADR
   * 0004 §4). Stored, not derived: a `lease.renew` carrying no `ttlMs` re-applies exactly this,
   * rather than falling back to `lease.defaultTtlMs`, so a lease granted for four hours does
   * not shrink to fifteen minutes the first time something renews it. A record written before
   * ADR 0004 loads with `lease.defaultTtlMs` here -- see `parseLease` in `registry.ts`.
   */
  readonly ttlMs: number;
  readonly ttlDeadline: number;
  /**
   * When this lease was last renewed -- written at grant and on every renew. It replaces the
   * old `lastHeartbeatAt`, which was never stored at all: the dispatcher derived it as
   * `ttlDeadline - heldTtlBackstopMs`, arithmetic that only worked while every held lease
   * shared one backstop width. A record written before ADR 0004 loads with `grantedAt` here.
   */
  readonly lastRenewedAt: number;
}

export interface LeaseTiming {
  readonly estimatedProvisionMs: number;
  readonly estimatedBootMs: number;
  readonly estimatedReclaimMs: number;
  readonly estimatedReadyMs: number;
}

export interface LeaseGrant {
  readonly device: DeviceRecord;
  /**
   * What the holder needs in its environment to reach this device at all -- the owning
   * driver's own answer, forwarded verbatim. Empty is a legitimate answer; the core never
   * reads a key here (architecture rule 2).
   */
  readonly environment: Readonly<Record<string, string>>;
  readonly lease: LeaseRecord;
  readonly timing: LeaseTiming;
}

/**
 * Where a stored lease request stands. `open` is the only state something is still driving;
 * the other three are its result, and a result is never re-evaluated (see `isSettled`).
 */
export type LeaseRequestState = "open" | "granted" | "failed" | "cancelled";

/**
 * Why a request failed, as the wire will report it. `code` is a contract error code the daemon
 * classified the failure as; the core stores and returns it without reading it.
 */
export interface LeaseRequestFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * One lease request, stored before it is queued or any driver work starts, so a client that
 * lost its answer can repeat the request and get the same one. `idempotencyKey` is optional: a
 * request without one is still stored and still settled at startup, it just cannot be replayed.
 * `ownerId` is the session principal that sent it -- what authorizes a replay, since
 * `requesterId` and `idempotencyKey` are both the caller's own claims.
 *
 * Generic over the grant so a gateway, whose grants carry a worker's device untyped, keeps the
 * same record in memory; the daemon's registry stores `LeaseGrant`.
 */
export interface LeaseRequestRecord<Grant = LeaseGrant> {
  readonly id: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly idempotencyKey?: string;
  readonly request: DeviceRequest;
  readonly createdAt: number;
  readonly state: LeaseRequestState;
  /** When the request left `open`. Retention counts from here. */
  readonly settledAt?: number;
  /** Set exactly when `state` is `granted`. */
  readonly grant?: Grant;
  /** Set exactly when `state` is `failed`. */
  readonly failure?: LeaseRequestFailure;
}

/** The one answer to "does this request have its result?". */
export function isSettled(record: Pick<LeaseRequestRecord<unknown>, "state">): boolean {
  return record.state !== "open";
}

/**
 * `quarantined` is the shared "present in the registry, counts against running
 * capacity, but not grantable" disposition: a device the core cannot vouch for
 * right now, sitting outside the `ready`/`shutdown` states every grant and
 * eviction path already selects on. `reclaiming -> quarantined` is its release-time
 * purge-failure entry (see ReclaimCoordinator); `provisioning -> quarantined` is its
 * stalled-transition entry (Doctor, for a `provisioning` that never finished);
 * `shutdown -> quarantined` is a spent fresh device whose delete failed after its
 * lease-end shutdown committed -- each its own entry into the same state rather than a
 * second one. Exits: `ready` on a successful retry, `deleted` on a successful retried
 * delete, `shutdown`/`deleted` on giving up.
 */
const legalTransitions: Readonly<Record<DeviceState, readonly DeviceState[]>> = {
  provisioning: ["ready", "deleted", "quarantined"],
  ready: ["leased", "shutdown"],
  leased: ["reclaiming"],
  reclaiming: ["ready", "shutdown", "quarantined"],
  quarantined: ["ready", "shutdown", "deleted"],
  shutdown: ["ready", "deleted", "quarantined"],
  deleted: [],
};

export class IllegalTransition extends Error {
  constructor(
    readonly from: DeviceState,
    readonly to: DeviceState,
  ) {
    super(`Cannot transition device from ${from} to ${to}`);
    this.name = "IllegalTransition";
  }
}

/** Fields a driver call resolved alongside a transition -- currently a fresh `makeReady` address. */
export interface DeviceTransitionUpdate {
  readonly address?: string;
  readonly driverData?: unknown;
  readonly mode?: DeviceMode;
}

export function transition(
  current: DeviceRecord,
  to: DeviceState,
  update?: DeviceTransitionUpdate,
): DeviceRecord {
  if (!legalTransitions[current.state].includes(to)) {
    throw new IllegalTransition(current.state, to);
  }

  // A deferred reclaim (ADR 0019 §2) ends with any transition out of `reclaiming`.
  const { deferredReclaimLeaseId: _deferred, ...record } = current;

  if (to === "shutdown") {
    // Nothing is listening at the old address once the device stops, and the next
    // `makeReady` supplies a fresh one on the way back to `ready` -- so dropping it here
    // costs nothing and keeps `list --devices` from showing an address no one can reach.
    //
    // Deliberately *not* extended to `quarantined`, though a quarantined device is equally
    // unreachable: `quarantined -> ready` is a `reclaim`, and `ReclaimResult` carries no
    // address for `Registry.recoverFromQuarantine` to restore. Dropping it there stranded
    // the device permanently -- `AcquisitionPlanner` would then grant it, `grantedDevice`
    // makes `address` optional so nothing rejected it, and the holder got a grant with no
    // adb serial it could not recover (`driverData`, which holds the port, is not part of a
    // grant). The address is also not what a port collision is made of: Android records a
    // boot's console port in `driverData.port`, and after a daemon restart only a recovery
    // boot reuses it (see `ManagedDeviceLifecycle.recoverLeased`); any other takes a new one.
    const { address: _stale, ...stopped } = record;
    return { ...stopped, ...update, state: to };
  }

  return { ...record, ...update, state: to };
}

/**
 * The wall-clock moment a `provisioning` or `reclaiming` device most recently entered
 * that state -- `undefined` for every other state, which either isn't mid-transition
 * or already has its own dedicated timestamp for the same purpose (`quarantinedAt`).
 * No dedicated field was added for this: `createdAt` already doubles as provisioning's
 * entry time, since nothing ever transitions back into `provisioning` (see
 * `legalTransitions`), and `lastLeaseEndedAt` already doubles as reclaiming's, since
 * `beginRelease` is reclaiming's only entry point and stamps it fresh on every entry.
 * Used by Doctor to age a mid-transition device against a driver-derived stall
 * threshold.
 */
export function transitionEnteredAt(record: DeviceRecord): number | undefined {
  switch (record.state) {
    case "provisioning":
      return record.createdAt;
    case "reclaiming":
      return record.lastLeaseEndedAt;
    default:
      return undefined;
  }
}

/** Request-scoped progress for the lease action currently being performed. */
export type LeaseProgress =
  | { readonly stage: "queued"; readonly queuePosition: number }
  /**
   * The request waits on a component download (ADR 0010 §3). `component` is the string the
   * driver named, carried unread. `waiting` is true while another install on the platform runs
   * ahead of it. `percent`, a whole number from 0 to 100, is there when the installer printed one.
   */
  | {
      readonly stage: "downloading";
      readonly component: string;
      readonly waiting: boolean;
      readonly percent?: number | undefined;
    }
  | { readonly stage: "provisioning"; readonly etaMs: number }
  | { readonly stage: "booting"; readonly etaMs: number }
  | { readonly stage: "reclaiming"; readonly etaMs: number };
