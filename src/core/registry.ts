import type { EventBus, EventMap } from "../bus/index.js";
import type { Clock, IdGenerator } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import { DEFAULT_LEASE_MAX_REQUEST_RECORDS, DEFAULT_LEASE_REQUEST_RETENTION_MS } from "./config.js";
import {
  type AbsentReason,
  type DeviceRecord,
  type QuarantineCause,
  type DeviceState,
  type DeviceTransitionUpdate,
  IllegalTransition,
  isSettled,
  type LeaseGrant,
  type LeaseIdentity,
  type LeaseRecord,
  type LeaseRequestFailure,
  type LeaseRequestRecord,
  type PhysicalClass,
  type PhysicalDevice,
  type Platform,
  transition,
  type VirtualDevice,
  type VirtualSpec,
} from "./domain.js";
import type { ComponentReceipt, DeviceDataTable } from "./driver.js";
import {
  type LeaseRequestLimits,
  type LeaseRequestOutcome,
  type LeaseRequestStore,
  type NewLeaseRequest,
  newLeaseRequestId,
  newLeaseRequestRecord,
  retainedLeaseRequests,
  withNewLeaseRequest,
  withSettledLeaseRequest,
} from "./lease-request-store.js";
import {
  deleteComponentRows,
  deleteLease,
  deleteLeaseRequest,
  loadRegistryRows,
  writeComponent,
  writeDevice,
  writeLease,
  writeLeaseRequest,
} from "./registry-rows.js";

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

export class UnknownDeviceError extends Error {
  constructor(readonly deviceId: string) {
    super(`Unknown device: ${deviceId}`);
    this.name = "UnknownDeviceError";
  }
}

export class UnknownLeaseError extends Error {
  constructor(readonly leaseId: string) {
    super(`Unknown lease: ${leaseId}`);
    this.name = "UnknownLeaseError";
  }
}

export class RegistryEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryEventError";
  }
}

/**
 * Devices, leases, lease requests (stored before they are queued, see `LeaseRequestBook`) and
 * the components Simlock installed (`ComponentRecord`). All four are written through one
 * `#commit`, so no two of them are ever on disk in separate files.
 */
export class Registry implements LeaseRequestStore<LeaseGrant> {
  #devices: DeviceRecord[] = [];
  #leases: LeaseRecord[] = [];
  #leaseRequests: readonly LeaseRequestRecord[] = [];
  #components: readonly ComponentRecord[] = [];
  readonly #commitListeners: (() => void)[] = [];

  private constructor(private readonly options: Required<RegistryOptions>) {}

  static async load(options: RegistryOptions): Promise<Registry> {
    const registry = new Registry({
      ...options,
      leaseIdentity: options.leaseIdentity ?? { android: "reusable", ios: "reusable" },
      leaseRequestLimits: options.leaseRequestLimits ?? {
        maxRecords: DEFAULT_LEASE_MAX_REQUEST_RECORDS,
        retentionMs: DEFAULT_LEASE_REQUEST_RETENTION_MS,
      },
    });
    const loaded = loadRegistryRows(options.state.database, options.deviceData);
    registry.#devices = loaded.devices;
    registry.#leases = loaded.leases;
    registry.#leaseRequests = loaded.leaseRequests;
    registry.#components = loaded.components;
    return registry;
  }

  get snapshot(): RegistrySnapshot {
    const devices = [
      ...this.#devices.filter((device) => !device.physical),
      ...this.#devices.filter((device) => device.physical),
    ].map(cloneDevice);
    return {
      devices,
      virtualDevices: devices.filter(isVirtual),
      leases: this.#leases.map((lease) => ({ ...lease })),
      components: this.#components.map(cloneComponent),
    };
  }

  /**
   * Stores the record of a component Simlock installed, replacing one with the same platform
   * and version (ADR 0010 §5). `ComponentInstaller` calls it before it emits
   * `component.installed`, so the event never describes an install the registry does not hold.
   */
  async recordComponent(record: ComponentRecord): Promise<void> {
    const components = [
      ...this.#components.filter(
        (existing) => existing.platform !== record.platform || existing.version !== record.version,
      ),
      cloneComponent(record),
    ];
    this.#commit(this.#devices, this.#leases, this.#leaseRequests, components);
  }

  /**
   * Deletes the record of the component of this platform and version (ADR 0010 §8).
   * `ComponentInstaller` calls it once the driver removed the component, before it emits
   * `component.removed`. Deleting a record that is not there commits nothing.
   */
  async deleteComponent(platform: Platform, version: string): Promise<void> {
    const components = this.#components.filter(
      (existing) => existing.platform !== platform || existing.version !== version,
    );
    if (components.length === this.#components.length) return;
    this.#commit(this.#devices, this.#leases, this.#leaseRequests, components);
  }

  async registerDevice({
    driverData,
    driverDeviceId,
    provisionDuration,
    spec,
  }: RegisterDeviceInput): Promise<VirtualDevice> {
    const record: VirtualDevice = {
      createdAt: this.options.clock.now(),
      driverData,
      driverDeviceId,
      id: `dev_${this.options.idGenerator.generate()}`,
      leaseIdentity: this.options.leaseIdentity[spec.platform],
      mode: "full",
      physical: false,
      spec: { ...spec },
      state: "provisioning",
    };
    const devices = [...this.#devices, record];

    this.#commit(devices, this.#leases);
    this.options.eventBus.emit(
      "device.provisioned",
      {
        deviceId: record.id,
        driver: spec.platform,
        duration: provisionDuration,
        spec: record.spec,
      },
      "registry",
    );

    return cloneDevice(record);
  }

  async transitionDevice(
    deviceId: string,
    to: DeviceState,
    event?: RegistryDeviceEvent,
    update?: DeviceTransitionUpdate,
  ): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (to === "deleted" && this.#leases.some((lease) => lease.deviceId === deviceId)) {
      throw new RegistryEventError(`Cannot delete device with an active lease: ${deviceId}`);
    }

    assertTransitionEvent(device, to, event);

    const updated = this.#transitioned(device, to, update);
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);

    if (event !== undefined) {
      this.#emitDeviceEvent(event, updated);
    }

    return this.#committed(deviceId);
  }

  async completeReclaimWithoutPurge(deviceId: string): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.state !== "reclaiming") {
      throw new RegistryEventError(`Device is not reclaiming: ${deviceId}`);
    }
    const updated = this.#transitioned(device, "shutdown");
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  /**
   * Commits quarantine entry from any of its legal sources (see domain.ts): a
   * release-time purge failure, or a fresh device's failed lease-end shutdown, leaves
   * `reclaiming`; a fresh device's failed delete leaves `shutdown`; and a
   * stalled-transition timeout leaves `provisioning`. The caller -- QuarantineCoordinator,
   * reached from ReclaimCoordinator for the lease-end paths -- emits `device.quarantined`
   * (and, for a lease-end failure, `device.purge-failed`) after this commits.
   */
  async enterQuarantine(
    deviceId: string,
    nextRetryAt: number,
    cause: QuarantineCause,
  ): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (
      device.state !== "reclaiming" &&
      device.state !== "provisioning" &&
      device.state !== "shutdown"
    ) {
      throw new RegistryEventError(
        `Device is not reclaiming, provisioning, or shutdown: ${deviceId}`,
      );
    }
    const updated: DeviceRecord = {
      ...this.#transitioned(device, "quarantined"),
      quarantineAttempts: 0,
      quarantineNextRetryAt: nextRetryAt,
      quarantinedAt: this.options.clock.now(),
      quarantineCause: cause,
    };
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  /** Records a failed purge retry without leaving `quarantined`; the caller re-arms backoff. */
  async recordQuarantineRetryFailure(
    deviceId: string,
    attempts: number,
    nextRetryAt: number,
  ): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.state !== "quarantined") {
      throw new RegistryEventError(`Device is not quarantined: ${deviceId}`);
    }
    const updated: DeviceRecord = {
      ...device,
      quarantineAttempts: attempts,
      quarantineNextRetryAt: nextRetryAt,
    };
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  #transitioned(
    device: DeviceRecord,
    to: DeviceState,
    update?: DeviceTransitionUpdate,
  ): DeviceRecord {
    const now = this.options.clock.now();
    if (to === "ready") return transition(device, to, { ...update, readyAt: now });
    if (to === "shutdown") return transition(device, to, { ...update, shutdownAt: now });
    if (to === "reclaiming" && device.physical) {
      return transition(device, to, { ...update, reclaimingSince: now });
    }
    return transition(device, to, update);
  }

  async recoverFromQuarantine(deviceId: string, to: "ready" | "shutdown"): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.state !== "quarantined") {
      throw new RegistryEventError(`Device is not quarantined: ${deviceId}`);
    }
    const {
      quarantineAttempts: _quarantineAttempts,
      quarantineNextRetryAt: _quarantineNextRetryAt,
      quarantinedAt: _quarantinedAt,
      ...updated
    } = this.#transitioned(device, to);
    const devices = [...this.#devices];
    devices[index] = updated as DeviceRecord;
    this.#commit(devices, this.#leases);
    return this.#committed(deviceId);
  }

  /**
   * Records that a quarantined device exhausted its retries *and* could not be destroyed, so
   * nothing is armed for it any more. Clears the retry deadline rather than leaving a stale one
   * behind: readers (`status`) would otherwise report a retry that is never coming, and a
   * restarting daemon re-arms from this field -- undefined makes it retry once promptly instead
   * of at a timestamp that has long since passed.
   */
  // fallow-ignore-next-line unused-class-member -- called through QuarantineCoordinator's registry port.
  async strandQuarantine(deviceId: string, attempts: number): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.state !== "quarantined") {
      throw new RegistryEventError(`Device is not quarantined: ${deviceId}`);
    }
    const { quarantineNextRetryAt: _quarantineNextRetryAt, ...rest } = device;
    const updated: DeviceRecord = { ...rest, quarantineAttempts: attempts };
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  async deleteQuarantined(deviceId: string, initiator: string): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.state !== "quarantined") {
      throw new RegistryEventError(`Device is not quarantined: ${deviceId}`);
    }
    const {
      quarantineAttempts: _quarantineAttempts,
      quarantineNextRetryAt: _quarantineNextRetryAt,
      quarantinedAt: _quarantinedAt,
      ...updated
    } = this.#transitioned(device, "deleted");
    const devices = [...this.#devices];
    devices[index] = updated as DeviceRecord;
    this.#commit(devices, this.#leases);
    this.options.eventBus.emit(
      "device.deleted",
      { deviceId, initiator, physical: device.physical },
      "registry",
    );
    return this.#committed(deviceId);
  }

  async markForeignStateDetected(deviceId: string, at: number): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    // why: Doctor re-reports persistent drift on every reaper tick; keep the first-detected
    // timestamp and skip the commit so a flagged device stops rewriting its row.
    if (device.foreignStateDetectedAt !== undefined) {
      return cloneDevice(device);
    }
    const updated = { ...device, foreignStateDetectedAt: at };
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  async markForeignProvenanceDetected(deviceId: string, at: number): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.foreignProvenanceDetectedAt !== undefined) {
      return cloneDevice(device);
    }
    const updated = { ...device, foreignProvenanceDetectedAt: at };
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  /** Clears the foreign-state flag once `doctor --fix` has reconciled the device. */
  async clearForeignStateDetected(deviceId: string): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.foreignStateDetectedAt === undefined) {
      return cloneDevice(device);
    }
    const { foreignStateDetectedAt: _foreignStateDetectedAt, ...rest } = device;
    const updated = rest as DeviceRecord;
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  /** Marks a recovery boot attempt; keeps the first-seen start time across retries. */
  async markRecoveryAttempt(deviceId: string, at: number): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    const updated = {
      ...device,
      recoveringSince: device.recoveringSince ?? at,
      recoveryAttempts: (device.recoveryAttempts ?? 0) + 1,
    };
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  /** Clears recovery markers once recovery has finished, one way or another. */
  async clearRecovery(deviceId: string): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.recoveringSince === undefined && device.recoveryAttempts === undefined) {
      return cloneDevice(device);
    }
    const {
      recoveringSince: _recoveringSince,
      recoveryAttempts: _recoveryAttempts,
      ...rest
    } = device;
    const updated = rest as DeviceRecord;
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  async markDeviceMissing(deviceId: string, initiator: string): Promise<DeviceRecord> {
    const { device } = this.#requireDeviceRecord(deviceId);
    if (this.#leases.some((lease) => lease.deviceId === deviceId)) {
      throw new RegistryEventError(`Cannot mark leased device missing: ${deviceId}`);
    }
    if (device.state === "deleted") {
      return cloneDevice(device);
    }
    this.#commitMissing(device, this.#leases);
    this.options.eventBus.emit(
      "device.deleted",
      { deviceId, initiator, physical: device.physical },
      "registry",
    );
    return this.#committed(deviceId);
  }

  /**
   * Removes a lease and marks its device missing in one write, for a device a daemon start found
   * gone from a platform it could read. There is nothing left to wipe, so no `reclaiming` state
   * stands between: the lease and the device leave `leased` together. The device record is
   * written exactly as `markDeviceMissing` writes it.
   *
   * `announceLeaseEnd` runs once the write has committed and before `device.deleted` is emitted,
   * so the lease's own fact precedes the device's. The registry never names a lease event itself.
   */
  async endLeaseAndMarkDeviceMissing(
    leaseId: string,
    initiator: string,
    announceLeaseEnd: (ended: ReleasedLease) => void,
  ): Promise<ReleasedLease> {
    const lease = this.#leases.find((candidate) => candidate.id === leaseId);
    if (lease === undefined) {
      throw new UnknownLeaseError(leaseId);
    }
    const { device } = this.#requireDeviceRecord(lease.deviceId);
    const deleted = this.#commitMissing(
      device,
      this.#leases.filter((candidate) => candidate.id !== leaseId),
    );
    const ended = { device: cloneDevice(deleted), lease: cloneLease(lease) };
    announceLeaseEnd(ended);
    this.options.eventBus.emit(
      "device.deleted",
      { deviceId: device.id, initiator, physical: device.physical },
      "registry",
    );
    return ended;
  }

  /** why: `announceLeaseEnd` runs after the commit and before `device.absence-detected`, so the lease's fact comes first. */
  async endLeaseAndMarkDeviceAbsent(
    leaseId: string,
    absentReason: AbsentReason,
    announceLeaseEnd: (ended: ReleasedLease) => void,
  ): Promise<ReleasedLease> {
    const lease = this.#leases.find((candidate) => candidate.id === leaseId);
    if (lease === undefined) {
      throw new UnknownLeaseError(leaseId);
    }
    const { device, index } = this.#requireDeviceRecord(lease.deviceId);
    const absent = {
      ...this.#transitioned(device, "absent", { absentReason }),
      lastLeaseEndedAt: this.options.clock.now(),
    };
    const devices = [...this.#devices];
    devices[index] = absent;
    this.#commit(
      devices,
      this.#leases.filter((candidate) => candidate.id !== leaseId),
    );
    const ended = { device: cloneDevice(absent), lease: cloneLease(lease) };
    announceLeaseEnd(ended);
    this.options.eventBus.emit(
      "device.absence-detected",
      { absentReason, deviceId: device.id, previousState: "leased" },
      "registry",
    );
    return ended;
  }

  async rewriteAbsentReason(deviceId: string, absentReason: AbsentReason): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (!device.physical || device.state !== "absent") {
      throw new RegistryEventError(`Device is not absent: ${deviceId}`);
    }
    const updated: PhysicalDevice = { ...device, absentReason };
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  /**
   * The one place a device is written as missing. Recovery markers go with it: a deleted device
   * has no recovery to track, and a stale count would only mislead a reader of the record.
   */
  #commitMissing(device: DeviceRecord, leases: LeaseRecord[]): DeviceRecord {
    // A physical record is never written as missing: that would unenrol it (ADR 0022 §4).
    if (device.physical) {
      throw new RegistryEventError(`Cannot mark a physical device missing: ${device.id}`);
    }
    const {
      recoveringSince: _recoveringSince,
      recoveryAttempts: _recoveryAttempts,
      deferredReclaimLeaseId: _deferred,
      ...rest
    } = device;
    const deleted = { ...rest, state: "deleted" as const } as DeviceRecord;
    const devices = this.#devices.map((candidate) =>
      candidate.id === device.id ? deleted : candidate,
    );
    this.#commit(devices, leases);
    return deleted;
  }

  async enrollPhysical(input: PhysicalEnrollmentInput): Promise<PhysicalDevice> {
    const now = this.options.clock.now();
    const record: PhysicalDevice = {
      createdAt: now,
      driverData: {},
      driverDeviceId: input.driverDeviceId,
      enrolledApps: [...input.apps],
      id: `dev_${this.options.idGenerator.generate()}`,
      physical: true,
      readyAt: now,
      spec: {
        class: input.class,
        model: input.model,
        osVersion: input.osVersion,
        physical: true,
        platform: input.platform,
      },
      state: "ready",
    };
    this.#commit([...this.#devices, record], this.#leases);
    this.#emitEnrolled(record, false);
    return cloneDevice(record) as PhysicalDevice;
  }

  async reenrollPhysical(
    deviceId: string,
    input: PhysicalEnrollmentInput,
  ): Promise<PhysicalDevice> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (!device.physical) throw new RegistryEventError(`Cannot re-enrol device: ${deviceId}`);
    const {
      quarantineAttempts: _quarantineAttempts,
      quarantineNextRetryAt: _quarantineNextRetryAt,
      quarantinedAt: _quarantinedAt,
      deferredReclaimLeaseId: _deferred,
      ...kept
    } = device;
    let settled: PhysicalDevice = kept;
    if (device.state !== "ready") {
      try {
        settled = transition(kept, "ready");
      } catch (error) {
        if (error instanceof IllegalTransition) {
          throw new RegistryEventError(`Cannot re-enrol device: ${deviceId}`);
        }
        throw error;
      }
    }
    const updated: PhysicalDevice = {
      ...settled,
      enrolledApps: [...input.apps],
      readyAt: this.options.clock.now(),
      spec: {
        class: input.class,
        model: input.model,
        osVersion: input.osVersion,
        physical: true,
        platform: device.spec.platform,
      },
    };
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    this.#emitEnrolled(updated, true);
    return this.#committed(deviceId) as PhysicalDevice;
  }

  async unenrollPhysical(deviceId: string): Promise<PhysicalDevice> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (!device.physical) throw new RegistryEventError(`Cannot unenrol device: ${deviceId}`);
    const {
      quarantineAttempts: _quarantineAttempts,
      quarantineNextRetryAt: _quarantineNextRetryAt,
      quarantinedAt: _quarantinedAt,
      ...kept
    } = device;
    let updated: PhysicalDevice;
    try {
      updated = transition(kept, "deleted");
    } catch (error) {
      if (error instanceof IllegalTransition) {
        throw new RegistryEventError(`Cannot unenrol device: ${deviceId}`);
      }
      throw error;
    }
    const devices = [...this.#devices];
    devices[index] = updated;
    this.#commit(devices, this.#leases);
    this.options.eventBus.emit(
      "device.deleted",
      { deviceId, initiator: "operator", physical: true },
      "registry",
    );
    return this.#committed(deviceId) as PhysicalDevice;
  }

  #emitEnrolled(device: PhysicalDevice, reenrolled: boolean): void {
    this.options.eventBus.emit(
      "device.enrolled",
      {
        appCount: device.enrolledApps.length,
        class: device.spec.class,
        deviceId: device.id,
        driverDeviceId: device.driverDeviceId,
        model: device.spec.model,
        osVersion: device.spec.osVersion,
        platform: device.spec.platform,
        reenrolled,
      },
      "registry",
    );
  }

  async createLease({
    deviceId,
    ownerId,
    requesterId,
    ttlMs,
    ttlDeadline,
    leaseId,
    request,
  }: CreateLeaseInput): Promise<LeaseRecord> {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    if (index === -1) {
      throw new UnknownDeviceError(deviceId);
    }

    const device = this.#devices[index];
    if (device === undefined) {
      throw new UnknownDeviceError(deviceId);
    }
    if (this.#leases.some((lease) => lease.deviceId === deviceId)) {
      throw new RegistryEventError(`Device already has an active lease: ${deviceId}`);
    }

    const leasedDevice = this.#transitioned(device, "leased");
    const grantedAt = this.options.clock.now();
    const lease: LeaseRecord = {
      deviceId,
      grantedAt,
      id: leaseId ?? `lse_${this.options.idGenerator.generate()}`,
      idChosenByRequester: leaseId !== undefined,
      // ADR 0004: set at grant, then again on every renew -- a lease that has never been
      // renewed reports the moment it was granted rather than nothing at all.
      lastRenewedAt: grantedAt,
      ownerId,
      requesterId,
      ttlMs,
      ttlDeadline,
    };
    const devices = [...this.#devices];
    devices[index] = leasedDevice;
    // The request's result goes in the same write as the lease: a crash leaves both or neither.
    // A request that is gone or already settled is left alone, as the book's own settle does.
    const leaseRequests =
      request === undefined
        ? this.#leaseRequests
        : withSettledLeaseRequest(
            this.#leaseRequests,
            request.id,
            {
              grant: {
                device: leasedDevice,
                environment: request.environment,
                lease,
                timing: request.timing,
              },
              state: "granted",
            },
            grantedAt,
          ).records;
    this.#commit(devices, [...this.#leases, lease], leaseRequests);

    return cloneLease(lease);
  }

  async beginRelease(
    leaseId: string,
    options: { readonly deferReclaim?: boolean } = {},
  ): Promise<ReleasedLease> {
    const leaseIndex = this.#leases.findIndex((lease) => lease.id === leaseId);
    const lease = this.#leases[leaseIndex];
    if (leaseIndex === -1 || lease === undefined) {
      throw new UnknownLeaseError(leaseId);
    }
    const deviceIndex = this.#devices.findIndex((device) => device.id === lease.deviceId);
    const device = this.#devices[deviceIndex];
    if (deviceIndex === -1 || device === undefined) {
      throw new UnknownDeviceError(lease.deviceId);
    }

    const {
      recoveringSince: _recoveringSince,
      recoveryAttempts: _recoveryAttempts,
      ...withoutRecoveryMarkers
    } = device;
    const reclaiming = {
      ...this.#transitioned(withoutRecoveryMarkers as DeviceRecord, "reclaiming"),
      lastLeaseEndedAt: this.options.clock.now(),
      // The wipe is not started now; a later start that can read the platform runs it.
      ...(options.deferReclaim === true ? { deferredReclaimLeaseId: leaseId } : {}),
    };
    const devices = [...this.#devices];
    devices[deviceIndex] = reclaiming;
    const leases = this.#leases.filter((candidate) => candidate.id !== leaseId);
    this.#commit(devices, leases);

    return { device: cloneDevice(reclaiming), lease: cloneLease(lease) };
  }

  /**
   * Commits a renewal: the new deadline, the width it was applied at (which becomes what the
   * *next* body-less renew re-applies), and `lastRenewedAt`. All three are persisted together,
   * so a daemon restart mid-lease restores the renewed deadline rather than the grant-time one.
   */
  async renewLease(leaseId: string, ttlDeadline: number, ttlMs: number): Promise<LeaseRecord> {
    const index = this.#leases.findIndex((lease) => lease.id === leaseId);
    const lease = this.#leases[index];
    if (index === -1 || lease === undefined) {
      throw new UnknownLeaseError(leaseId);
    }

    const renewed = { ...lease, lastRenewedAt: this.options.clock.now(), ttlDeadline, ttlMs };
    const leases = [...this.#leases];
    leases[index] = renewed;
    this.#commit(this.#devices, leases);
    return cloneLease(renewed);
  }

  leaseRequests(): readonly LeaseRequestRecord[] {
    return retainedLeaseRequests(
      this.#leaseRequests,
      this.options.clock.now(),
      this.options.leaseRequestLimits.retentionMs,
    ).map((record) => this.#withCurrentDevice(record));
  }

  /** why: a granted request stores the lease, environment and timing as first answered, but names its device only by id (ADR 0036 §4). */
  #withCurrentDevice(record: LeaseRequestRecord): LeaseRequestRecord {
    const copy = cloneLeaseRequest(record);
    if (copy.grant === undefined) return copy;
    const { grant } = copy;
    const device = this.#devices.find((candidate) => candidate.id === grant.device.id);
    return device === undefined
      ? copy
      : { ...copy, grant: { ...grant, device: cloneDevice(device) } };
  }

  async createLeaseRequest(input: NewLeaseRequest): Promise<LeaseRequestRecord> {
    const now = this.options.clock.now();
    const record = newLeaseRequestRecord<LeaseGrant>(
      input.id ?? newLeaseRequestId(this.options.idGenerator),
      input,
      now,
    );
    const leaseRequests = withNewLeaseRequest(
      this.#leaseRequests,
      record,
      now,
      this.options.leaseRequestLimits,
    );
    this.#commit(this.#devices, this.#leases, leaseRequests);
    return cloneLeaseRequest(record);
  }

  async settleLeaseRequest(
    id: string,
    outcome: LeaseRequestOutcome<LeaseGrant>,
  ): Promise<LeaseRequestRecord | undefined> {
    const { records, settled } = withSettledLeaseRequest(
      this.#leaseRequests,
      id,
      outcome,
      this.options.clock.now(),
    );
    if (settled === undefined) return undefined;
    this.#commit(this.#devices, this.#leases, records);
    return this.#withCurrentDevice(settled);
  }

  /**
   * Settles every request still open as `failed`, in one write. Startup calls it before admission
   * opens: nothing in a new process drives a wait the old one started, so an open record from
   * before the restart would otherwise stay open with nothing to settle it.
   */
  // fallow-ignore-next-line unused-class-member -- called through LeaseStartup's registry port (LeaseStartupRegistry).
  async failOpenLeaseRequests(
    failure: LeaseRequestFailure,
  ): Promise<readonly LeaseRequestRecord[]> {
    let records = this.#leaseRequests;
    const settled: LeaseRequestRecord[] = [];
    const now = this.options.clock.now();
    for (const open of this.#leaseRequests.filter((record) => !isSettled(record))) {
      const result = withSettledLeaseRequest(records, open.id, { failure, state: "failed" }, now);
      records = result.records;
      if (result.settled !== undefined) settled.push(result.settled);
    }
    if (settled.length > 0) this.#commit(this.#devices, this.#leases, records);
    return settled.map((record) => this.#withCurrentDevice(record));
  }

  /** why: the exits return the committed record, which has dropped any cause. */
  #committed(deviceId: string): DeviceRecord {
    return cloneDevice(this.#requireDeviceRecord(deviceId).device);
  }

  #requireDeviceRecord(deviceId: string): {
    readonly device: DeviceRecord;
    readonly index: number;
  } {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    const device = this.#devices[index];
    if (index === -1 || device === undefined) {
      throw new UnknownDeviceError(deviceId);
    }
    return { device, index };
  }

  #commit(
    devices: DeviceRecord[],
    leases: LeaseRecord[],
    leaseRequests: readonly LeaseRequestRecord[] = this.#leaseRequests,
    components: readonly ComponentRecord[] = this.#components,
  ): void {
    const committed = devices.map(withoutCauseUnlessQuarantined);
    const { deviceData, state } = this.options;
    state.transaction(() => {
      const { database } = state;
      const device = changes(this.#devices, committed, (record) => record.id);
      const lease = changes(this.#leases, leases, (record) => record.id);
      const request = changes(this.#leaseRequests, leaseRequests, (record) => record.id);
      const component = changes(this.#components, components, componentKey);
      for (const id of request.removed) deleteLeaseRequest(database, id);
      for (const record of device.changed) writeDevice(database, record, deviceData);
      for (const id of lease.removed) deleteLease(database, id);
      for (const record of lease.changed) writeLease(database, record);
      for (const record of request.changed) writeLeaseRequest(database, record);
      for (const key of component.removed) {
        const [platform, version] = key.split("\0") as [Platform, string];
        deleteComponentRows(database, platform, version);
      }
      for (const record of component.changed) writeComponent(database, record);
    });
    this.#devices = committed;
    this.#leases = leases;
    this.#leaseRequests = leaseRequests;
    this.#components = components;
    this.#commitListeners.forEach((listener) => listener());
  }

  /** Calls `listener` after every commit, once the new state is what `snapshot` reads. */
  onCommit(listener: () => void): void {
    this.#commitListeners.push(listener);
  }

  #emitDeviceEvent(event: RegistryDeviceEvent, device: DeviceRecord): void {
    switch (event.event) {
      case "device.ready":
        this.options.eventBus.emit(
          event.event,
          { ...event.payload, platform: device.spec.platform },
          "registry",
        );
        return;
      case "device.reclaimed":
        this.options.eventBus.emit(event.event, event.payload, "registry");
        return;
      case "device.shutdown":
        this.options.eventBus.emit(event.event, event.payload, "registry");
        return;
      case "device.absence-detected":
        this.options.eventBus.emit(event.event, event.payload, "registry");
        return;
      case "device.returned":
        this.options.eventBus.emit(event.event, event.payload, "registry");
        return;
      case "device.deleted":
        this.options.eventBus.emit(
          event.event,
          { ...event.payload, physical: device.physical },
          "registry",
        );
    }
  }
}

function componentKey(record: ComponentRecord): string {
  return `${record.platform}\0${record.version}`;
}

/** why: records are immutable, so a record that is not the committed object has changed and one that is not in `after` is gone. */
function changes<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (record: T) => string,
): { readonly changed: T[]; readonly removed: string[] } {
  const committed = new Map(before.map((record) => [keyOf(record), record]));
  const kept = new Set(after.map(keyOf));
  return {
    changed: after.filter((record) => committed.get(keyOf(record)) !== record),
    removed: [...committed.keys()].filter((key) => !kept.has(key)),
  };
}

function cloneDevice<T extends DeviceRecord>(device: T): T {
  return { ...device, spec: { ...device.spec } } as T;
}

function isVirtual(device: DeviceRecord): device is VirtualDevice {
  return !device.physical;
}

/** why: the one place a cause goes when its device leaves quarantine, however it left. */
function withoutCauseUnlessQuarantined(device: DeviceRecord): DeviceRecord {
  if (device.state === "quarantined" || device.quarantineCause === undefined) return device;
  const { quarantineCause: _cause, ...rest } = device;
  return rest as DeviceRecord;
}

function cloneLease(lease: LeaseRecord): LeaseRecord {
  return { ...lease };
}

function cloneComponent(record: ComponentRecord): ComponentRecord {
  return { ...record, receipt: { ...record.receipt } };
}

function cloneLeaseRequest(record: LeaseRequestRecord): LeaseRequestRecord {
  return { ...record, request: { ...record.request } };
}

/** The one device event a transition carries must be the one its states call for, about this device. */
function assertTransitionEvent(
  device: DeviceRecord,
  to: DeviceState,
  event: RegistryDeviceEvent | undefined,
): void {
  const expectedEvent = eventForTransition(device.state, to);
  if (event?.event !== expectedEvent) {
    throw new RegistryEventError(
      `Transition from ${device.state} to ${to} requires ${expectedEvent ?? "no"} device event`,
    );
  }
  if (event !== undefined && event.payload.deviceId !== device.id) {
    throw new RegistryEventError(`Device event payload does not match device: ${device.id}`);
  }
}

function eventForTransition(
  from: DeviceState,
  to: DeviceState,
): RegistryDeviceEvent["event"] | undefined {
  if (to === "absent") {
    return "device.absence-detected";
  }
  if (from === "absent" && to === "reclaiming") {
    return "device.returned";
  }
  if (from === "reclaiming") {
    return "device.reclaimed";
  }
  if (to === "ready") {
    return "device.ready";
  }
  if (to === "shutdown") {
    return "device.shutdown";
  }
  if (to === "deleted") {
    return "device.deleted";
  }
  return undefined;
}
