import type { EventBus, EventMap } from "../bus/index.js";
import type { Clock, IdGenerator } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import type { ComponentReceipt, DeviceDataTable } from "./driver.js";
import type { LeaseRequestLimits } from "./lease-request-store.js";
import type {
  DeviceRecord,
  LeaseGrant,
  LeaseIdentity,
  LeaseRecord,
  PhysicalClass,
  Platform,
  VirtualDevice,
  VirtualSpec,
} from "./domain.js";

export interface RegistryOptions {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly eventBus: EventBus;
  readonly state: StateDatabase;
  readonly deviceData: ReadonlyMap<Platform, DeviceDataTable>;
  /**
   * `lease.identity`: the policy a newly registered device is stamped with, looked up by its
   * spec's platform. Only registration reads it -- a loaded record keeps the policy it was
   * created under. Defaults to `reusable` for both platforms.
   */
  readonly leaseIdentity?: Readonly<Record<Platform, LeaseIdentity>>;
  /**
   * `lease.requestRetentionMs` and `lease.maxRequestRecords`: how long a settled lease request is
   * kept and how many are kept at most. Defaults to the config defaults.
   */
  readonly leaseRequestLimits?: LeaseRequestLimits;
  /** why: `devices.deletedRetentionMs`, how long a `deleted` device record is kept; defaults to the config default. */
  readonly deletedRetentionMs?: number;
  /** why: `lease.endedIdRetentionMs`, how long a chosen lease id is remembered after its lease ended; defaults to the config default. */
  readonly endedIdRetentionMs?: number;
}

export interface RegistrySnapshot {
  /** Every device: the records of `devices`, then those of `physicalDevices`. */
  readonly devices: readonly DeviceRecord[];
  readonly virtualDevices: readonly VirtualDevice[];
  readonly leases: readonly LeaseRecord[];
  readonly components: readonly ComponentRecord[];
}

/**
 * The fourth record type: a component Simlock installed (ADR 0010 §5). `receipt` is the
 * driver's own, opaque to the core and compared only for equality -- a component is Simlock's
 * when a record's receipt equals the receipt of something installed now. One record per platform
 * and version: a later install of the same version replaces it.
 */
export interface ComponentRecord {
  readonly platform: Platform;
  readonly version: string;
  readonly installedAt: number;
  readonly receipt: ComponentReceipt;
}

export interface RegisterDeviceInput {
  readonly driverDeviceId: string;
  readonly spec: VirtualSpec;
  readonly driverData: unknown;
  readonly provisionDuration: number;
}

export interface PhysicalEnrollmentInput {
  readonly platform: Platform;
  readonly driverDeviceId: string;
  readonly model: string;
  readonly osVersion: string;
  readonly class: PhysicalClass;
  readonly apps: readonly string[];
  readonly hardwareSerial?: string;
  /** why: who enrolled the phone, for `device.enrolled`; an operator's `device add` unless the worker's auto-enroller says otherwise. */
  readonly initiator?: "operator" | "auto";
}

export interface ReleasedLease {
  readonly device: DeviceRecord;
  readonly lease: LeaseRecord;
}

export interface CreateLeaseInput {
  readonly deviceId: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly ttlDeadline: number;
  /** why: the caller has already refused an ID that is in use: one place enforces that rule. */
  readonly leaseId?: string;
  readonly runId?: string;
  /** why: the categories the lease keeps running, written to the device in the commit that leases it (ADR 0066 §4). */
  readonly except?: readonly string[];
  /**
   * why: when given, the commit that adds the lease also marks the request `granted`, so no crash can
   * fall between the two.
   */
  readonly request?: {
    readonly id: string;
    readonly environment: LeaseGrant["environment"];
    readonly timing: LeaseGrant["timing"];
  };
}

export type RegistryDeviceEvent =
  | {
      readonly event: "device.ready";
      readonly payload: Omit<EventMap["device.ready"], "platform">;
    }
  | { readonly event: "device.reclaimed"; readonly payload: EventMap["device.reclaimed"] }
  | { readonly event: "device.shutdown"; readonly payload: EventMap["device.shutdown"] }
  | {
      readonly event: "device.absence-detected";
      readonly payload: EventMap["device.absence-detected"];
    }
  | { readonly event: "device.returned"; readonly payload: EventMap["device.returned"] }
  | {
      readonly event: "device.deleted";
      readonly payload: Omit<EventMap["device.deleted"], "physical">;
    };
