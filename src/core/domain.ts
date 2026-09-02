export type Platform = "ios" | "android";

export interface DeviceSpec {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion: string;
  /**
   * Set when this spec was resolved from a `--full` request (see `DeviceRequest.full`): a
   * device with no driver-side resource reduction. Part of spec identity (`sameSpec`) so a
   * `--full` request never matches, and never shares a pool key with, a slim device -- the
   * ADR's "serve from a separate pool key". Never `false`; omitted for every request that did
   * not ask for it, so specs stay byte-identical to before this field existed.
   */
  readonly full?: boolean;
}

/**
 * Spec identity as every selection path means it: same platform, model, OS version, and
 * `full`-ness. `undefined` and `false` compare equal for `full` so registries written before
 * this field existed keep matching.
 */
export function sameSpec(left: DeviceSpec, right: DeviceSpec): boolean {
  return (
    left.platform === right.platform &&
    left.model === right.model &&
    left.osVersion === right.osVersion &&
    (left.full ?? false) === (right.full ?? false)
  );
}

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
   * defined the next time the device is made ready (`boot`/`readyProvisioned`); nothing here
   * ever guesses at a value it wasn't told.
   */
  readonly address?: string;
  /**
   * Mirrors `DriverDevice.featureProfile` (see `driver.ts`), current as of this device's last
   * `ready` transition. Undefined for a device still `provisioning` (never made ready yet)
   * and for any driver that does not reduce anything -- today's behaviour, and every non-iOS
   * driver.
   */
  readonly featureProfile?: "full" | "reduced";
}

export interface LeaseRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly requesterId: string;
  readonly mode: "held" | "detached";
  readonly grantedAt: number;
  readonly ttlDeadline: number;
}

/**
 * `quarantined` is the shared "present in the registry, counts against running
 * capacity, but not grantable" disposition: a device the core cannot vouch for
 * right now, sitting outside the `ready`/`shutdown` states every grant and
 * eviction path already selects on. `reclaiming -> quarantined` is its release-time
 * purge-failure entry (see WarmPoolCoordinator); `provisioning -> quarantined` is its
 * stalled-transition entry (Doctor, for a `provisioning` that never finished) -- its
 * own entry into the same state rather than a second one. Exits are symmetric either
 * way: `ready` on a successful retry, `shutdown`/`deleted` on giving up.
 */
const legalTransitions: Readonly<Record<DeviceState, readonly DeviceState[]>> = {
  provisioning: ["ready", "deleted", "quarantined"],
  ready: ["leased", "shutdown"],
  leased: ["reclaiming"],
  reclaiming: ["ready", "shutdown", "quarantined"],
  quarantined: ["ready", "shutdown", "deleted"],
  shutdown: ["ready", "deleted"],
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
  readonly featureProfile?: "full" | "reduced";
}

export function transition(
  record: DeviceRecord,
  to: DeviceState,
  update?: DeviceTransitionUpdate,
): DeviceRecord {
  if (!legalTransitions[record.state].includes(to)) {
    throw new IllegalTransition(record.state, to);
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
