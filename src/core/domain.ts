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
  /**
   * The driver-reported address (see `DriverDevice.address`), current as of this device's
   * last `ready` transition. Undefined for a device still `provisioning` (never made ready
   * yet) and, as an upgrade path, for a record written by a pre-address daemon -- `state.json`
   * from before this field existed loads without one rather than failing to start. It becomes
   * defined the next time the device is made ready (`boot`/`readyProvisioned`); nothing here
   * ever guesses at a value it wasn't told.
   */
  readonly address?: string;
}

export interface LeaseRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly requesterId: string;
  readonly mode: "held" | "detached";
  readonly grantedAt: number;
  readonly ttlDeadline: number;
}

const legalTransitions: Readonly<Record<DeviceState, readonly DeviceState[]>> = {
  provisioning: ["ready", "deleted"],
  ready: ["leased", "shutdown"],
  leased: ["reclaiming"],
  reclaiming: ["ready", "shutdown"],
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
