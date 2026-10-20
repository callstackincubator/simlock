import { requestedClass } from "../contract/operations.js";
import {
  type OsConstraint as RequestedOs,
  parseOsConstraint,
  satisfies,
} from "../contract/index.js";
import type { DeviceRequest } from "./driver.js";

export type Platform = "ios" | "android";

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

export type DeviceMode = "slim" | "full";

/**
 * A simulator's or emulator's spec. `physical` is always `false` here, in memory and on every
 * spec a driver resolves; a spec read from `devices` in `state.json` has none on disk and gains it
 * on load.
 */
export interface VirtualSpec {
  readonly physical: false;
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

/** The kinds of device an admin can enrol (ADR 0022 §1). */
export type PhysicalClass = "phone" | "tablet";

/**
 * A physical device's spec (ADR 0022 §1): its platform, model, OS version and class, which is
 * recorded at enrolment and not read from a catalog. It has no mode and no image tag; they are
 * declared `undefined` so code that reads a spec's mode or tag compiles for both types.
 */
export interface PhysicalSpec {
  readonly physical: true;
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion: string;
  readonly class: PhysicalClass;
  readonly mode?: undefined;
  readonly imageTag?: undefined;
}

export type DeviceSpec = VirtualSpec | PhysicalSpec;

/**
 * Why a warm target did not resolve to a spec: the platform has no driver on this machine, its
 * runtime is not installed (and a target never downloads), its model is not listed, or the driver
 * refused it some other way.
 */
export type TargetRefusal = "no-driver" | "runtime-missing" | "unknown-model" | "unresolvable";

/** What the request resolver answers for a request that is not going to be granted a lease. */
export type TargetResolution =
  | { readonly spec: VirtualSpec }
  | { readonly refusal: TargetRefusal; readonly message: string };

/** The mode a spec plans: `"slim"` when it says so, `"full"` otherwise. */
export function specMode(spec: DeviceSpec): DeviceMode {
  return spec.mode ?? "full";
}

/**
 * Spec identity as every selection path means it: same type (physical or virtual), platform,
 * model, OS version, mode, and image tag. A spec with no tag and a spec with one never match, so
 * neither pool serves the other, and a physical spec never matches a virtual one.
 */
export function sameSpec(left: DeviceSpec, right: DeviceSpec): boolean {
  return (
    left.physical === right.physical &&
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
export function exactRequirement(spec: VirtualSpec): DeviceRequirement {
  return {
    imageTag: spec.imageTag,
    osVersion: { kind: "exact", version: spec.osVersion },
    platform: spec.platform,
    target: { kind: "model", model: spec.model },
  };
}

/**
 * What `fits` reads of a spec. A gateway builds one from a worker's view, where a physical
 * device's class is not part of its spec, so this is narrower than `DeviceSpec` and both types
 * satisfy it.
 */
export interface FittableSpec {
  readonly physical: boolean;
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion: string;
  readonly imageTag?: string | undefined;
}

export function fits(
  requirement: DeviceRequirement,
  spec: FittableSpec,
  classOf: (model: string) => DeviceClass | undefined,
): boolean {
  if (spec.physical) return false;
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

export type LeaseIdentity = "reusable" | "fresh";

type SharedState = "ready" | "leased" | "reclaiming" | "quarantined";
export type VirtualState = SharedState | "provisioning" | "shutdown" | "deleted";
export type PhysicalState = SharedState | "absent" | "deleted";
export type AbsentReason = "locked" | "untrusted" | "not-present";
export type DeviceState = VirtualState | PhysicalState;

export interface QuarantineCause {
  readonly kind: "purge-failed" | "shutdown-failed" | "delete-failed" | "stalled";
  readonly stalledState?: "provisioning" | "reclaiming" | undefined;
  readonly message?: string | undefined;
}

interface DeviceRecordFields {
  readonly id: string;
  readonly driverDeviceId: string;
  readonly driverData: unknown;
  readonly createdAt: number;
  readonly lastLeaseEndedAt?: number;
  /** why: a record written before this field existed has none and counts as ready since `createdAt`. */
  readonly readyAt?: number;
  readonly shutdownAt?: number;
  readonly foreignStateDetectedAt?: number;
  readonly foreignProvenanceDetectedAt?: number;
  readonly recoveringSince?: number;
  readonly recoveryAttempts?: number;
  readonly deferredReclaimLeaseId?: string;
  /** Set on entry to `quarantined`; the wall-clock moment the first purge failed. */
  readonly quarantinedAt?: number;
  /** Failed retry count since entering quarantine (the triggering failure itself is not a retry). */
  readonly quarantineAttempts?: number;
  /** When the next purge retry is armed for, so a restarted daemon can re-arm it faithfully. */
  readonly quarantineNextRetryAt?: number;
  readonly quarantineCause?: QuarantineCause;
  /**
   * The driver-reported address (see `DriverDevice.address`), current as of this device's
   * last `ready` transition. Undefined for a device still `provisioning` (never made ready
   * yet) and, as an upgrade path, for a record written by a pre-address daemon -- `state.json`
   * from before this field existed loads without one rather than failing to start. It becomes
   * defined the next time the device is made ready (`bootForLease`/`readyProvisionedForLease`);
   * nothing here ever guesses at a value it wasn't told.
   */
  readonly address?: string;
}

/** A simulator or emulator Simlock created in a root it owns. */
export interface VirtualDevice extends DeviceRecordFields {
  readonly physical: false;
  readonly spec: VirtualSpec;
  readonly state: VirtualState;
  readonly mode: DeviceMode;
  /** why: a record written before this field existed loads as `reusable`. */
  readonly leaseIdentity?: LeaseIdentity;
}

/** why: `mode` and `leaseIdentity` are declared `undefined` so code that reads them compiles for both types. */
export interface PhysicalDevice extends DeviceRecordFields {
  readonly physical: true;
  readonly spec: PhysicalSpec;
  readonly state: PhysicalState;
  readonly enrolledApps: readonly string[];
  readonly reclaimingSince?: number;
  readonly absentReason?: AbsentReason;
  readonly mode?: undefined;
  readonly leaseIdentity?: undefined;
}

export type DeviceRecord = VirtualDevice | PhysicalDevice;

/**
 * why: a physical record here means a broken invariant: the ID came from a virtual read, so the caller
 * must not go on to touch it.
 */
export function assertVirtual(device: DeviceRecord): VirtualDevice {
  if (device.physical) {
    throw new Error(`Device ${device.id} is physical; only a virtual device may be acted on here`);
  }
  return device;
}

export function readySince(device: DeviceRecord): number {
  return device.readyAt ?? device.createdAt;
}

/**
 * The one answer to "may this device be handed to a new lease?". A `fresh` device that has ended
 * a lease is spent: `beginRelease` stamps `lastLeaseEndedAt` on every lease end, so that stamp is
 * the proof it already served its one lease. Every other device is grantable as far as identity
 * goes; state, spec, and claims are the caller's own checks. A physical device has no
 * `leaseIdentity`, so it is always reusable: `lease.identity` does not apply to it.
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
  /**
   * Whether the requester chose `id` (`lease.request`'s `leaseId`, ADR 0020) rather than simlock
   * generating it. Written at grant. A record written before this field existed loads with
   * `false`: every ID then was generated.
   */
  readonly idChosenByRequester: boolean;
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
  /**
   * The lease ID the requester chose (ADR 0020), kept beside the request, not in it, so the
   * request stays the device it names. While the record is `open` it holds that ID: nothing else
   * is granted it.
   */
  readonly leaseId?: string;
  /**
   * The gateway's request id (ADR 0021) when this request is a gateway dispatch, a probe. Kept so
   * a probe settled at the next start still names it.
   */
  readonly fleetRequestId?: string;
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
 * why: `quarantined` counts against running capacity (a virtual device only) but is never grantable: it
 * sits outside the `ready`/`shutdown` states every grant and eviction path selects on.
 */
const legalTransitions: Readonly<Record<VirtualState, readonly VirtualState[]>> = {
  provisioning: ["ready", "deleted", "quarantined"],
  ready: ["leased", "shutdown"],
  leased: ["reclaiming"],
  reclaiming: ["ready", "shutdown", "quarantined"],
  quarantined: ["ready", "shutdown", "deleted"],
  shutdown: ["ready", "deleted", "quarantined"],
  deleted: [],
};

/** why: `quarantined` never moves to `absent`: a gone quarantined device keeps its retries. */
const legalPhysicalTransitions: Readonly<Record<PhysicalState, readonly PhysicalState[]>> = {
  ready: ["leased", "absent", "deleted"],
  leased: ["reclaiming", "absent"],
  reclaiming: ["ready", "quarantined", "absent"],
  quarantined: ["ready", "deleted"],
  absent: ["reclaiming", "ready", "deleted"],
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

export interface DeviceTransitionUpdate {
  readonly address?: string;
  readonly readyAt?: number;
  readonly shutdownAt?: number;
  readonly driverData?: unknown;
  readonly mode?: DeviceMode;
  readonly osVersion?: string;
  readonly absentReason?: AbsentReason;
  readonly reclaimingSince?: number;
}

export function transition(
  current: VirtualDevice,
  to: VirtualState,
  update?: DeviceTransitionUpdate,
): VirtualDevice;
export function transition(
  current: PhysicalDevice,
  to: PhysicalState,
  update?: DeviceTransitionUpdate,
): PhysicalDevice;
export function transition(
  current: DeviceRecord,
  to: DeviceState,
  update?: DeviceTransitionUpdate,
): DeviceRecord;
export function transition(
  current: DeviceRecord,
  to: DeviceState,
  update?: DeviceTransitionUpdate,
): DeviceRecord {
  if (current.physical) return transitionPhysical(current, to, update);
  if (!isVirtualState(to) || !legalTransitions[current.state].includes(to)) {
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

function transitionPhysical(
  current: PhysicalDevice,
  to: DeviceState,
  update: DeviceTransitionUpdate | undefined,
): PhysicalDevice {
  // `current.state` is typed `PhysicalState`, so the check on it narrows nothing. It refuses, at
  // runtime, a record whose state is outside that type (the load refuses one too).
  if (
    !isPhysicalState(current.state) ||
    !isPhysicalState(to) ||
    !legalPhysicalTransitions[current.state].includes(to)
  ) {
    throw new IllegalTransition(current.state, to);
  }
  // A physical device has no driver-reported mode, and a deferred reclaim ends with any exit.
  const { absentReason: _left, deferredReclaimLeaseId: _deferred, ...record } = current;
  const { absentReason, mode: _mode, osVersion, ...fields } = update ?? {};
  return {
    ...record,
    ...(osVersion === undefined ? {} : { spec: { ...record.spec, osVersion } }),
    ...fields,
    ...(to === "absent" && absentReason !== undefined ? { absentReason } : {}),
    state: to,
  };
}

function isVirtualState(state: DeviceState): state is VirtualState {
  return Object.hasOwn(legalTransitions, state);
}

function isPhysicalState(state: DeviceState): state is PhysicalState {
  return Object.hasOwn(legalPhysicalTransitions, state);
}

/** why: a record written before `reclaimingSince` existed falls back to `lastLeaseEndedAt` for when it entered `reclaiming`. */
export function transitionEnteredAt(record: DeviceRecord): number | undefined {
  switch (record.state) {
    case "provisioning":
      return record.createdAt;
    case "reclaiming":
      return record.physical
        ? (record.reclaimingSince ?? record.lastLeaseEndedAt)
        : record.lastLeaseEndedAt;
    default:
      return undefined;
  }
}

export type LeaseProgress =
  | { readonly stage: "queued"; readonly queuePosition: number }
  | {
      readonly stage: "downloading";
      readonly component: string;
      readonly waiting: boolean;
      readonly percent?: number | undefined;
    }
  | { readonly stage: "provisioning"; readonly etaMs: number }
  | { readonly stage: "booting"; readonly etaMs: number }
  | { readonly stage: "reclaiming"; readonly etaMs: number };

export interface PhysicalRequest {
  readonly platform: Platform;
  readonly model?: string;
  readonly class?: DeviceClass;
  readonly osVersion?: string;
}

export interface FittablePhysical {
  readonly spec: {
    readonly platform: Platform;
    readonly model: string;
    readonly osVersion: string;
    readonly class?: PhysicalClass;
  };
  readonly class?: PhysicalClass;
}

export function fitsPhysical(device: FittablePhysical, request: PhysicalRequest): boolean {
  const { spec } = device;
  if (spec.platform !== request.platform) return false;
  if (request.model === undefined) {
    if ((device.class ?? spec.class) !== requestedClass({ class: request.class })) return false;
  } else if (spec.model.toLowerCase() !== request.model.toLowerCase()) {
    return false;
  }
  if (request.osVersion === undefined) return true;
  const constraint = parseOsConstraint(request.osVersion);
  return constraint.ok && satisfies(spec.osVersion, constraint.constraint);
}

/** A range is not echoed: its text is what the message names as the fix. */
function osPhrase(osVersion: string | undefined): readonly string[] {
  if (osVersion === undefined) return [];
  const parsed = parseOsConstraint(osVersion);
  return parsed.ok && parsed.constraint.kind === "range"
    ? ["os in the requested range"]
    : [`os ${osVersion}`];
}

function rangeAround(osVersion: string): string {
  const parts = osVersion.split(".").map(Number);
  const raised = parts.map((part, index) => (index === parts.length - 1 ? part + 1 : part));
  return `>=${parts.join(".")} <${raised.join(".")}`;
}

export function noPhysicalMatch(request: PhysicalRequest): {
  readonly message: string;
  readonly details: {
    readonly platform: Platform;
    readonly model?: string;
    readonly class?: DeviceClass;
    readonly osVersion?: string;
  };
} {
  const named = [
    request.model === undefined ? `class ${request.class ?? "phone"}` : `model ${request.model}`,
    ...osPhrase(request.osVersion),
  ];
  const range =
    request.platform === "ios" &&
    request.osVersion !== undefined &&
    /^\d+(\.\d+)?$/.test(request.osVersion)
      ? `; --os is exact, for any ${request.osVersion}.x write --os "${rangeAround(request.osVersion)}"`
      : "";
  return {
    details: {
      platform: request.platform,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.class === undefined ? {} : { class: request.class }),
      ...(request.osVersion === undefined ? {} : { osVersion: request.osVersion }),
    },
    message: `no enrolled physical device can match ${request.platform} ${named.join(" ")}${range}`,
  };
}
