export type Platform = "ios" | "android";

export interface DeviceSpec {
  readonly platform: Platform;
  readonly model: string;
  readonly osVersion: string;
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
  /** Set on entry to `quarantined`; the wall-clock moment the first purge failed. */
  readonly quarantinedAt?: number;
  /** Failed retry count since entering quarantine (the triggering failure itself is not a retry). */
  readonly quarantineAttempts?: number;
  /** When the next purge retry is armed for, so a restarted daemon can re-arm it faithfully. */
  readonly quarantineNextRetryAt?: number;
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
 * purge-failure entry (see WarmPoolCoordinator); a future stalled-transition timeout
 * (e.g. `provisioning` that never finishes) would add `provisioning -> quarantined`
 * as its own entry into the same state rather than inventing a second one. Exits are
 * symmetric either way: `ready` on a successful retry, `shutdown`/`deleted` on giving
 * up.
 */
const legalTransitions: Readonly<Record<DeviceState, readonly DeviceState[]>> = {
  provisioning: ["ready", "deleted"],
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

export function transition(record: DeviceRecord, to: DeviceState): DeviceRecord {
  if (!legalTransitions[record.state].includes(to)) {
    throw new IllegalTransition(record.state, to);
  }

  return { ...record, state: to };
}
