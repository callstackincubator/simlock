import type { EventBus, EventMap } from "../bus/index.js";
import { quarantineCauseSchema } from "../contract/index.js";
import type { Clock, Filesystem, IdGenerator } from "../ports/index.js";
import {
  DEFAULT_LEASE_MAX_REQUEST_RECORDS,
  DEFAULT_LEASE_REQUEST_RETENTION_MS,
  DEFAULT_LEASE_TTL_MS,
} from "./config.js";
import {
  type AbsentReason,
  DEVICE_CLASSES,
  type DeviceClass,
  type DeviceMode,
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
  type LeaseRequestState,
  type PhysicalClass,
  type PhysicalDevice,
  type PhysicalSpec,
  type PhysicalState,
  type Platform,
  transition,
  type VirtualDevice,
  type VirtualSpec,
  type VirtualState,
} from "./domain.js";
import type { ComponentReceipt, DeviceRequest } from "./driver.js";
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

const DEFAULT_REGISTRY_PATH = "~/.simlock/state.json";

export interface RegistryOptions {
  readonly filesystem: Filesystem;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly eventBus: EventBus;
  readonly statePath?: string;
  /**
   * The width a lease record written before ADR 0004 loads with, since it has none of its own
   * (`lease.defaultTtlMs`; the daemon passes the configured value, and `DEFAULT_LEASE_TTL_MS`
   * stands in for a caller that has no config to hand). Only ever read during that migration --
   * a granted lease's width always comes from the grant itself.
   */
  readonly defaultTtlMs?: number;
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

class RegistryLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryLoadError";
  }
}

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
  #unknownState: Record<string, unknown> = {};
  readonly #unknownDeviceFields = new Map<string, Record<string, unknown>>();
  readonly #unknownLeaseFields = new Map<string, Record<string, unknown>>();
  readonly #unknownLeaseRequestFields = new Map<string, Record<string, unknown>>();

  private constructor(private readonly options: Required<RegistryOptions>) {}

  static async load(options: RegistryOptions): Promise<Registry> {
    const registry = new Registry({
      ...options,
      defaultTtlMs: options.defaultTtlMs ?? DEFAULT_LEASE_TTL_MS,
      leaseIdentity: options.leaseIdentity ?? { android: "reusable", ios: "reusable" },
      leaseRequestLimits: options.leaseRequestLimits ?? {
        maxRecords: DEFAULT_LEASE_MAX_REQUEST_RECORDS,
        retentionMs: DEFAULT_LEASE_REQUEST_RETENTION_MS,
      },
      statePath: options.statePath ?? DEFAULT_REGISTRY_PATH,
    });

    if (await registry.options.filesystem.exists(registry.options.statePath)) {
      registry.#restore(await registry.options.filesystem.readFile(registry.options.statePath));
    }

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
    await this.#commit(this.#devices, this.#leases, this.#leaseRequests, components);
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
    await this.#commit(this.#devices, this.#leases, this.#leaseRequests, components);
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

    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);

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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
    this.options.eventBus.emit(
      "device.deleted",
      { deviceId, initiator, physical: device.physical },
      "registry",
    );
    return this.#committed(deviceId);
  }

  async markForeignStateDetected(deviceId: string, at: number): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    // Doctor re-reports persistent drift on every reaper tick; keep the first-detected
    // timestamp and skip the commit so a flagged device stops rewriting state.json.
    if (device.foreignStateDetectedAt !== undefined) {
      return cloneDevice(device);
    }
    const updated = { ...device, foreignStateDetectedAt: at };
    const devices = [...this.#devices];
    devices[index] = updated;
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commitMissing(device, this.#leases);
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
    const deleted = await this.#commitMissing(
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
    await this.#commit(
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
    await this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  /**
   * The one place a device is written as missing. Recovery markers go with it: a deleted device
   * has no recovery to track, and a stale count would only mislead a reader of the record.
   */
  async #commitMissing(device: DeviceRecord, leases: LeaseRecord[]): Promise<DeviceRecord> {
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
    await this.#commit(devices, leases);
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
    await this.#commit([...this.#devices, record], this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, this.#leases);
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
    await this.#commit(devices, [...this.#leases, lease], leaseRequests);

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
    await this.#commit(devices, leases);

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
    await this.#commit(this.#devices, leases);
    return cloneLease(renewed);
  }

  leaseRequests(): readonly LeaseRequestRecord[] {
    return retainedLeaseRequests(
      this.#leaseRequests,
      this.options.clock.now(),
      this.options.leaseRequestLimits.retentionMs,
    ).map(cloneLeaseRequest);
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
    await this.#commit(this.#devices, this.#leases, leaseRequests);
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
    await this.#commit(this.#devices, this.#leases, records);
    return cloneLeaseRequest(settled);
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
    if (settled.length > 0) await this.#commit(this.#devices, this.#leases, records);
    return settled.map(cloneLeaseRequest);
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

  async #commit(
    devices: DeviceRecord[],
    leases: LeaseRecord[],
    leaseRequests: readonly LeaseRequestRecord[] = this.#leaseRequests,
    components: readonly ComponentRecord[] = this.#components,
  ): Promise<void> {
    await this.options.filesystem.mkdirp(parentDirectory(this.options.statePath));
    const committed = devices.map(withoutCauseUnlessQuarantined);
    await this.options.filesystem.writeFileAtomic(
      this.options.statePath,
      JSON.stringify({
        ...this.#unknownState,
        devices: committed
          .filter(isVirtual)
          .map((device) => ({ ...this.#unknownDeviceFields.get(device.id), ...stored(device) })),
        physicalDevices: committed.filter(isPhysical).map((device) => ({
          ...this.#unknownDeviceFields.get(device.id),
          ...device,
        })),
        leases: leases.map((lease) => ({
          ...this.#unknownLeaseFields.get(lease.id),
          ...lease,
        })),
        leaseRequests: leaseRequests.map((record) => ({
          ...this.#unknownLeaseRequestFields.get(record.id),
          ...record,
        })),
        components,
      }),
      { mode: 0o600 },
    );
    this.#devices = committed;
    this.#leases = leases;
    this.#leaseRequests = leaseRequests;
    this.#components = components;
    this.#commitListeners.forEach((listener) => listener());
  }

  /** Calls `listener` after every commit, once the new state is what `snapshot` reads. */
  // fallow-ignore-next-line unused-class-member -- called by createCore, which holds the registry as a `Registry`; the audit does not follow it.
  onCommit(listener: () => void): void {
    this.#commitListeners.push(listener);
  }

  #restore(contents: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      throw new RegistryLoadError(`Invalid JSON in registry state: ${this.options.statePath}`);
    }

    if (!isObject(parsed) || !Array.isArray(parsed.devices) || !Array.isArray(parsed.leases)) {
      throw new RegistryLoadError(`Invalid registry state: ${this.options.statePath}`);
    }

    if (parsed.physicalDevices !== undefined && !Array.isArray(parsed.physicalDevices)) {
      throw new RegistryLoadError(`Invalid registry state: ${this.options.statePath}`);
    }

    this.#unknownState = unknownFields(parsed, [
      "devices",
      "physicalDevices",
      "leases",
      "leaseRequests",
      "components",
    ]);
    const restore = (device: unknown, physical: boolean): DeviceRecord => {
      const record = parseDevice(device, physical);
      this.#unknownDeviceFields.set(
        record.id,
        unknownFields(device as Record<string, unknown>, [
          ...deviceRecordKeys,
          ...retiredDeviceRecordKeys,
        ]),
      );
      return record;
    };
    this.#devices = [
      ...parsed.devices.map((device) => restore(device, false)),
      ...((parsed.physicalDevices ?? []) as unknown[]).map((device) => restore(device, true)),
    ];
    this.#leases = parsed.leases.map((lease) => {
      const record = parseLease(lease, this.options.defaultTtlMs);
      this.#unknownLeaseFields.set(
        record.id,
        unknownFields(lease, [...leaseRecordKeys, ...retiredLeaseRecordKeys]),
      );
      return record;
    });
    this.#leaseRequests = this.#restoreLeaseRequests(parsed.leaseRequests);
    this.#components = restoreComponents(parsed.components);
  }

  /**
   * A state file written before lease requests were stored has no `leaseRequests` key and loads
   * with none, and so does one whose key is not a list. A record that does not parse is dropped rather than failing the load: a request
   * is not worth every device Simlock knows about, and a client repeating a dropped request
   * simply starts a new one.
   */
  #restoreLeaseRequests(value: unknown): LeaseRequestRecord[] {
    if (!Array.isArray(value)) return [];
    const records: LeaseRequestRecord[] = [];
    for (const candidate of value) {
      const record = parseLeaseRequest(candidate);
      if (record === undefined) continue;
      this.#unknownLeaseRequestFields.set(
        record.id,
        unknownFields(candidate as Record<string, unknown>, leaseRequestRecordKeys),
      );
      records.push(record);
    }
    return records;
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

const deviceRecordKeys = [
  "id",
  "driverDeviceId",
  "spec",
  "state",
  "driverData",
  "createdAt",
  "lastLeaseEndedAt",
  "readyAt",
  "shutdownAt",
  "foreignStateDetectedAt",
  "foreignProvenanceDetectedAt",
  "recoveringSince",
  "recoveryAttempts",
  "deferredReclaimLeaseId",
  "quarantinedAt",
  "quarantineAttempts",
  "quarantineNextRetryAt",
  "quarantineCause",
  "address",
  "mode",
  "leaseIdentity",
  "physical",
  "enrolledApps",
  "reclaimingSince",
  "absentReason",
] as const;
const retiredDeviceRecordKeys = ["featureProfile"] as const;
const leaseRecordKeys = [
  "id",
  "deviceId",
  "requesterId",
  "ownerId",
  "grantedAt",
  "ttlMs",
  "ttlDeadline",
  "lastRenewedAt",
  "idChosenByRequester",
] as const;
const leaseRequestRecordKeys = [
  "id",
  "requesterId",
  "ownerId",
  "idempotencyKey",
  "leaseId",
  "fleetRequestId",
  "request",
  "createdAt",
  "state",
  "settledAt",
  "grant",
  "failure",
] as const;
/**
 * Fields a lease record written before ADR 0004 carries that this daemon neither reads nor
 * keeps. Listed here so they are stripped on load rather than preserved through the
 * unknown-field forward-compatibility path -- `mode` is not a field from a *newer* schema this
 * daemon should hand back untouched, it is a concept that no longer exists.
 */
const retiredLeaseRecordKeys = ["mode"] as const;

function cloneDevice<T extends DeviceRecord>(device: T): T {
  return { ...device, spec: { ...device.spec } } as T;
}

function isVirtual(device: DeviceRecord): device is VirtualDevice {
  return !device.physical;
}

function isPhysical(device: DeviceRecord): device is PhysicalDevice {
  return device.physical;
}

/**
 * A virtual record as `devices` holds it: with no `physical` key on the record or its spec, so
 * the file reads the same to an older Simlock as it did before physical devices existed.
 */
function stored(device: VirtualDevice): Record<string, unknown> {
  const { physical: _physical, spec, ...record } = device;
  const { physical: _specPhysical, ...storedSpec } = spec;
  return { ...record, spec: storedSpec };
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

/**
 * A state file written before components were recorded has no `components` key and loads with
 * none. A record that does not parse is dropped rather than failing the load, like a lease
 * request: losing it only means Simlock no longer claims that component, which errs towards
 * never removing it (safety rule 1).
 */
function restoreComponents(value: unknown): ComponentRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate: unknown) => {
    const record = parseComponent(candidate);
    return record === undefined ? [] : [record];
  });
}

function parseComponent(value: unknown): ComponentRecord | undefined {
  if (
    !isObject(value) ||
    !isPlatform(value.platform) ||
    typeof value.version !== "string" ||
    typeof value.installedAt !== "number" ||
    !isObject(value.receipt) ||
    !Object.values(value.receipt).every((field) => typeof field === "string")
  ) {
    return undefined;
  }
  return {
    installedAt: value.installedAt,
    platform: value.platform,
    receipt: { ...(value.receipt as Record<string, string>) },
    version: value.version,
  };
}

function cloneLeaseRequest(record: LeaseRequestRecord): LeaseRequestRecord {
  return { ...record, request: { ...record.request } };
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
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

/**
 * why: parsed as one group so `parseDevice`'s required-field check does not grow two branches per
 * field added.
 */
const optionalDeviceNumberKeys = [
  "lastLeaseEndedAt",
  "readyAt",
  "shutdownAt",
  "foreignStateDetectedAt",
  "foreignProvenanceDetectedAt",
  "recoveringSince",
  "recoveryAttempts",
  "quarantinedAt",
  "quarantineAttempts",
  "quarantineNextRetryAt",
] as const;

type OptionalDeviceNumbers = Partial<Record<(typeof optionalDeviceNumberKeys)[number], number>>;

function parseOptionalDeviceNumbers(value: Record<string, unknown>): OptionalDeviceNumbers {
  const parsed: OptionalDeviceNumbers = {};
  for (const key of optionalDeviceNumberKeys) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number") {
      throw new RegistryLoadError("Invalid device record in registry state");
    }
    parsed[key] = candidate;
  }
  return parsed;
}

function parseDevice(value: unknown, physical: boolean): DeviceRecord {
  if (!isObject(value)) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }

  const { spec, state } = value;
  if (!isObject(spec)) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }
  const shared = parseSharedDeviceFields(value);
  const record = physical
    ? parsePhysicalDevice(value, spec, state, shared)
    : parseVirtualDevice(value, spec, state, shared);
  // why: a cause is for a quarantined record alone; on any other it is dropped unchecked.
  if (record.state !== "quarantined" || value.quarantineCause === undefined) return record;
  const cause = quarantineCauseSchema.safeParse(value.quarantineCause);
  if (!cause.success) throw new RegistryLoadError("Invalid device record in registry state");
  return { ...record, quarantineCause: cause.data };
}

/** What a record in `devices` and one in `physicalDevices` both carry, checked once. */
function parseSharedDeviceFields(value: Record<string, unknown>): SharedDeviceFields {
  const { address, createdAt, deferredReclaimLeaseId, driverData, driverDeviceId, id } = value;
  if (
    typeof id !== "string" ||
    typeof driverDeviceId !== "string" ||
    typeof createdAt !== "number" ||
    !("driverData" in value) ||
    // Every other optional field is a number and is swept by
    // `parseOptionalDeviceNumbers`, except `leaseIdentity`, which `parseLeaseIdentity` checks;
    // `address` and `deferredReclaimLeaseId` are the strings checked here.
    // Missing is expected of a record written by a daemon that predates the field;
    // present-but-wrong-typed is corrupt.
    !isOptionalString(address) ||
    !isOptionalString(deferredReclaimLeaseId)
  ) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }
  return {
    ...parseOptionalDeviceNumbers(value),
    ...(address === undefined ? {} : { address }),
    ...(deferredReclaimLeaseId === undefined ? {} : { deferredReclaimLeaseId }),
    createdAt,
    driverData,
    driverDeviceId,
    id,
  };
}

type SharedDeviceFields = Omit<
  VirtualDevice,
  "leaseIdentity" | "mode" | "physical" | "spec" | "state"
>;

/** A record in `devices` is virtual: `physical` and a class are for `physicalDevices` alone. */
function parseVirtualDevice(
  value: Record<string, unknown>,
  spec: Record<string, unknown>,
  state: unknown,
  shared: SharedDeviceFields,
): VirtualDevice {
  const virtualState = state === "warm" ? "reclaiming" : state;
  if (
    !isVirtualState(virtualState) ||
    (value.physical !== undefined && value.physical !== false) ||
    (spec.physical !== undefined && spec.physical !== false) ||
    "class" in spec
  ) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }
  return {
    ...shared,
    leaseIdentity: parseLeaseIdentity(value.leaseIdentity),
    mode: parseDeviceMode(value.mode),
    physical: false,
    spec: parseVirtualSpec(spec),
    state: virtualState,
  };
}

/** A record in `physicalDevices` must be physical through and through (ADR 0022 §1). */
function parsePhysicalDevice(
  value: Record<string, unknown>,
  spec: Record<string, unknown>,
  state: unknown,
  shared: SharedDeviceFields,
): PhysicalDevice {
  const { enrolledApps } = value;
  if (
    !isPhysicalState(state) ||
    value.physical !== true ||
    value.mode !== undefined ||
    value.leaseIdentity !== undefined ||
    !Array.isArray(enrolledApps) ||
    !enrolledApps.every((app) => typeof app === "string")
  ) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }
  return {
    ...shared,
    enrolledApps: [...(enrolledApps as string[])],
    physical: true,
    ...parsePhysicalMarks(state, value),
    spec: parsePhysicalSpec(spec),
    state,
  };
}

function parsePhysicalMarks(
  state: PhysicalState,
  value: Record<string, unknown>,
): Pick<PhysicalDevice, "absentReason" | "reclaimingSince"> {
  const { absentReason, reclaimingSince } = value;
  const absent = state === "absent" ? isAbsentReason(absentReason) : absentReason === undefined;
  if (!absent || !isOptionalNumber(reclaimingSince)) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }
  return {
    ...(reclaimingSince === undefined ? {} : { reclaimingSince }),
    ...(absentReason === undefined ? {} : { absentReason: absentReason as AbsentReason }),
  };
}

function parsePhysicalSpec(value: Record<string, unknown>): PhysicalSpec {
  if (
    value.physical !== true ||
    !isPlatform(value.platform) ||
    typeof value.model !== "string" ||
    typeof value.osVersion !== "string" ||
    !isPhysicalClass(value.class) ||
    value.mode !== undefined ||
    value.imageTag !== undefined
  ) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }
  return {
    class: value.class,
    model: value.model,
    osVersion: value.osVersion,
    physical: true,
    platform: value.platform,
  };
}

function isPhysicalClass(value: unknown): value is PhysicalClass {
  return value === "phone" || value === "tablet";
}

/**
 * A record written before `leaseIdentity` existed was created under the only policy there was,
 * so it loads as `reusable`. A present-but-unknown value fails the load: guessing `reusable` for
 * it could hand a fresh identity out for a second lease.
 */
function parseLeaseIdentity(value: unknown): LeaseIdentity {
  if (value === undefined) return "reusable";
  if (value === "reusable" || value === "fresh") return value;
  throw new RegistryLoadError("Invalid device record in registry state");
}

/**
 * A record written before `mode` existed loads as `full` (ADR 0007 §11). A present-but-unknown
 * value fails the load rather than being guessed at: a wrong `full` would let a slimmed device
 * be granted as a full one.
 */
function parseDeviceMode(value: unknown): DeviceMode {
  if (value === undefined) return "full";
  if (value === "slim" || value === "full") return value;
  throw new RegistryLoadError("Invalid device record in registry state");
}

/**
 * A spec's planned mode (ADR 0007 §6, §11). A spec written before it existed has none and loads
 * as full; its retired `full` key is dropped, so it is not written back. A `mode` other than
 * `"slim"` fails the load: no other value can be planned, and guessing could pool a slim device
 * with full ones.
 */
function parseVirtualSpec(value: Record<string, unknown>): VirtualSpec {
  const { full: _retired, ...spec } = value;
  if (!isVirtualSpecShape(spec) || (spec.mode !== undefined && spec.mode !== "slim")) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }
  return { ...spec, physical: false };
}

/**
 * ADR 0003 §4: a lease record written before `ownerId` existed loads with `ownerId` equal to
 * `requesterId`; present-but-wrong-typed is still corrupt, same treatment as every other
 * load-time migration in this module (see `address` on `parseDevice`). Split out of
 * `parseLease` purely to keep that function's own branch count down -- this check has no
 * meaning on its own outside a lease record's already-validated `requesterId`.
 */
function isValidOwnerId(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** The required-string and timing fields every lease record has always had -- split out of
 * `parseLease` so that function's own branch count reflects only what changes per schema
 * version (the `ownerId` migration, and ADR 0004's `ttlMs`/`lastRenewedAt` one), not the whole
 * record shape at once. `mode` is deliberately not checked any more: a record written before
 * ADR 0004 still carries one, and it is simply dropped on load rather than being a reason to
 * refuse the whole registry. */
function hasValidLeaseCore(value: Record<string, unknown>): value is Record<string, unknown> & {
  id: string;
  deviceId: string;
  requesterId: string;
  grantedAt: number;
  ttlDeadline: number;
} {
  return (
    typeof value.id === "string" &&
    typeof value.deviceId === "string" &&
    typeof value.requesterId === "string" &&
    typeof value.grantedAt === "number" &&
    typeof value.ttlDeadline === "number"
  );
}

/**
 * ADR 0004's migration, for the two fields a lease written before it does not have. Neither
 * can be recovered from what is on disk (`ttlDeadline - grantedAt` is the grant-time width
 * only until the first renewal moves the deadline), so each takes its documented default
 * rather than a guess dressed up as arithmetic. A value that is present but unusable takes the
 * same default: it is one field of one record, and refusing to load the whole registry over it
 * would cost an operator every device Simlock knows about.
 *
 * They are validated separately because they are different kinds of number. A timestamp only
 * has to be a finite number -- any point on the clock is a legitimate answer to "when was this
 * last renewed", including zero. A duration additionally has to be positive: a `ttlMs` of `0`
 * or a negative one would make every renewal of that lease resolve to a deadline in the past,
 * which `LeaseExpiryScheduler` reads as "expire immediately".
 */
function finiteTimestampOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveDurationOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseLease(value: unknown, defaultTtlMs: number): LeaseRecord {
  if (!isObject(value) || !hasValidLeaseCore(value) || !isValidOwnerId(value.ownerId)) {
    throw new RegistryLoadError("Invalid lease record in registry state");
  }

  const { deviceId, grantedAt, id, lastRenewedAt, ownerId, requesterId, ttlDeadline, ttlMs } =
    value;
  return {
    deviceId,
    grantedAt,
    id,
    idChosenByRequester: value.idChosenByRequester === true,
    lastRenewedAt: finiteTimestampOr(lastRenewedAt, grantedAt),
    ownerId: ownerId ?? requesterId,
    requesterId,
    ttlDeadline,
    ttlMs: positiveDurationOr(ttlMs, defaultTtlMs),
  };
}

/**
 * `undefined` for anything that is not a whole, consistent record: every required field typed,
 * and the result its state promises present (see `parseLeaseRequestResult`).
 */
function parseLeaseRequest(value: unknown): LeaseRequestRecord | undefined {
  if (!hasLeaseRequestFields(value)) return undefined;
  const {
    createdAt,
    fleetRequestId,
    id,
    idempotencyKey,
    leaseId,
    ownerId,
    request,
    requesterId,
    state,
  } = value;
  const result = parseLeaseRequestResult(state, value);
  if (result === undefined) return undefined;
  return {
    createdAt,
    id,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(leaseId === undefined ? {} : { leaseId }),
    ...(fleetRequestId === undefined ? {} : { fleetRequestId }),
    ownerId,
    request: withoutRetiredRequestKeys(request),
    requesterId,
    state,
    ...result,
  };
}

/** The fields every lease-request record has, whatever its state. */
// fallow-ignore-next-line complexity -- one type guard, one check per field of the record.
function hasLeaseRequestFields(value: unknown): value is Record<string, unknown> & {
  readonly createdAt: number;
  readonly fleetRequestId?: string;
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly leaseId?: string;
  readonly ownerId: string;
  readonly request: DeviceRequest;
  readonly requesterId: string;
  readonly state: LeaseRequestState;
} {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.requesterId === "string" &&
    typeof value.ownerId === "string" &&
    isOptionalString(value.idempotencyKey) &&
    isOptionalString(value.leaseId) &&
    isOptionalString(value.fleetRequestId) &&
    isDeviceRequest(value.request) &&
    typeof value.createdAt === "number" &&
    isLeaseRequestState(value.state)
  );
}

/** A settled record's settlement time and the result its state promises: a `granted` record's
 * grant, a `failed` one's failure. An open record has none of them. */
function parseLeaseRequestResult(
  state: LeaseRequestState,
  value: Record<string, unknown>,
): Pick<LeaseRequestRecord, "failure" | "grant" | "settledAt"> | undefined {
  if (state === "open") return {};
  const { failure, grant, settledAt } = value;
  if (typeof settledAt !== "number") return undefined;
  if (state === "granted") {
    const parsed = parseStoredGrant(grant);
    return parsed === undefined ? undefined : { grant: parsed, settledAt };
  }
  if (state === "failed") {
    return isLeaseRequestFailure(failure) ? { failure, settledAt } : undefined;
  }
  return { settledAt };
}

/**
 * A stored grant's device follows the device record's own load rule (ADR 0007 §11): no `mode`
 * loads as `full`, the retired keys (and the spec's `full`) are dropped, and an unknown `mode` makes the record
 * unusable, so it is skipped like any other inconsistent lease request. Its lease loads
 * `idChosenByRequester` as a lease record does (`parseLease`).
 */
function parseStoredGrant(grant: unknown): LeaseGrant | undefined {
  if (!isObject(grant) || !isObject(grant.device)) return undefined;
  const device = storedGrantDevice(grant.device);
  if (device === undefined) return undefined;
  // A grant written before ADR 0020 names a lease whose ID simlock generated, as every ID then was.
  const lease = isObject(grant.lease)
    ? { ...grant.lease, idChosenByRequester: grant.lease.idChosenByRequester === true }
    : grant.lease;
  return { ...grant, device, lease } as unknown as LeaseGrant;
}

/**
 * The device of a stored grant as it loads: the retired keys dropped, a grant written before
 * physical devices existed naming a virtual device, and the mode rule of its type. `undefined`
 * for one that breaks it: a virtual device with a mode that is not `slim` or `full`, or a
 * physical device with any mode at all.
 */
function storedGrantDevice(stored: Record<string, unknown>): Record<string, unknown> | undefined {
  const device: Record<string, unknown> = { ...stored };
  for (const key of retiredDeviceRecordKeys) delete device[key];
  device.physical ??= false;
  if (isObject(device.spec)) device.spec = storedGrantSpec(device.spec);
  if (device.physical !== true) device.mode ??= "full";
  return hasStoredGrantMode(device) ? device : undefined;
}

/** A stored grant's spec: the retired `full` key dropped, and `physical` false when it has none. */
function storedGrantSpec(stored: Record<string, unknown>): Record<string, unknown> {
  const { full: _retired, ...spec } = stored;
  return { ...spec, physical: spec.physical ?? false };
}

/** A virtual device has a `slim` or `full` mode and a physical one has none. */
function hasStoredGrantMode(device: Record<string, unknown>): boolean {
  if (device.physical === true) return device.mode === undefined;
  return device.mode === "slim" || device.mode === "full";
}

function isDeviceRequest(value: unknown): value is DeviceRequest {
  return (
    isObject(value) &&
    isPlatform(value.platform) &&
    isOptionalString(value.model) &&
    (value.class === undefined || isDeviceClass(value.class)) &&
    hasOptionalRequestFields(value)
  );
}

function hasOptionalRequestFields(value: Record<string, unknown>): boolean {
  return (
    isOptionalString(value.osVersion) &&
    (value.mode === undefined || value.mode === "slim" || value.mode === "full") &&
    isOptionalString(value.imageTag)
  );
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function withoutRetiredRequestKeys(request: DeviceRequest): DeviceRequest {
  const {
    full: _retired,
    physical,
    ...current
  } = request as DeviceRequest & { readonly full?: unknown };
  return physical === true ? { ...current, physical: true } : current;
}

function isLeaseRequestState(value: unknown): value is LeaseRequestState {
  return value === "open" || value === "granted" || value === "failed" || value === "cancelled";
}

function isLeaseRequestFailure(value: unknown): value is LeaseRequestFailure {
  return isObject(value) && typeof value.code === "string" && typeof value.message === "string";
}

function isVirtualSpecShape(value: unknown): value is VirtualSpec {
  return (
    isObject(value) &&
    isPlatform(value.platform) &&
    typeof value.model === "string" &&
    typeof value.osVersion === "string" &&
    isOptionalString(value.imageTag)
  );
}

function isDeviceClass(value: unknown): value is DeviceClass {
  return DEVICE_CLASSES.some((deviceClass) => deviceClass === value);
}

function isPlatform(value: unknown): value is Platform {
  return value === "ios" || value === "android";
}

function isVirtualState(value: unknown): value is VirtualState {
  return (
    value === "provisioning" ||
    value === "ready" ||
    value === "leased" ||
    value === "reclaiming" ||
    value === "quarantined" ||
    value === "shutdown" ||
    value === "deleted"
  );
}

function isAbsentReason(value: unknown): value is AbsentReason {
  return value === "locked" || value === "untrusted" || value === "not-present";
}

function isPhysicalState(value: unknown): value is PhysicalState {
  return (
    value === "ready" ||
    value === "absent" ||
    value === "leased" ||
    value === "reclaiming" ||
    value === "quarantined" ||
    value === "deleted"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownFields(
  value: Record<string, unknown>,
  knownKeys: readonly string[],
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!knownKeys.includes(key)) {
      fields[key] = child;
    }
  }
  return fields;
}
