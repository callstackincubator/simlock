import type { EventBus, EventMap } from "../bus/index.js";
import type { Clock, Filesystem, IdGenerator } from "../ports/index.js";
import { DEFAULT_LEASE_TTL_MS } from "./config.js";
import {
  type DeviceRecord,
  type DeviceSpec,
  type DeviceState,
  type DeviceTransitionUpdate,
  type LeaseRecord,
  type Platform,
  transition,
} from "./domain.js";

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
}

export interface RegistrySnapshot {
  readonly devices: readonly DeviceRecord[];
  readonly leases: readonly LeaseRecord[];
}

export interface RegisterDeviceInput {
  readonly driverDeviceId: string;
  readonly spec: DeviceSpec;
  readonly driverData: unknown;
  readonly provisionDuration: number;
}

export interface ReleasedLease {
  readonly device: DeviceRecord;
  readonly lease: LeaseRecord;
}

export interface CreateLeaseInput {
  readonly deviceId: string;
  readonly requesterId: string;
  readonly ownerId: string;
  /** The width this lease is granted with; stored on the record, see `LeaseRecord.ttlMs`. */
  readonly ttlMs: number;
  readonly ttlDeadline: number;
}

export type RegistryDeviceEvent =
  | { readonly event: "device.ready"; readonly payload: EventMap["device.ready"] }
  | { readonly event: "device.reclaimed"; readonly payload: EventMap["device.reclaimed"] }
  | { readonly event: "device.shutdown"; readonly payload: EventMap["device.shutdown"] }
  | { readonly event: "device.deleted"; readonly payload: EventMap["device.deleted"] };

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

export class Registry {
  #devices: DeviceRecord[] = [];
  #leases: LeaseRecord[] = [];
  #unknownState: Record<string, unknown> = {};
  readonly #unknownDeviceFields = new Map<string, Record<string, unknown>>();
  readonly #unknownLeaseFields = new Map<string, Record<string, unknown>>();

  private constructor(private readonly options: Required<RegistryOptions>) {}

  static async load(options: RegistryOptions): Promise<Registry> {
    const registry = new Registry({
      ...options,
      defaultTtlMs: options.defaultTtlMs ?? DEFAULT_LEASE_TTL_MS,
      statePath: options.statePath ?? DEFAULT_REGISTRY_PATH,
    });

    if (await registry.options.filesystem.exists(registry.options.statePath)) {
      registry.#restore(await registry.options.filesystem.readFile(registry.options.statePath));
    }

    return registry;
  }

  get snapshot(): RegistrySnapshot {
    return {
      devices: this.#devices.map((device) => ({ ...device, spec: { ...device.spec } })),
      leases: this.#leases.map((lease) => ({ ...lease })),
    };
  }

  async registerDevice({
    driverData,
    driverDeviceId,
    provisionDuration,
    spec,
  }: RegisterDeviceInput): Promise<DeviceRecord> {
    const record: DeviceRecord = {
      createdAt: this.options.clock.now(),
      driverData,
      driverDeviceId,
      id: `dev_${this.options.idGenerator.generate()}`,
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
    /** Fields a driver call resolved alongside this transition -- currently a fresh `makeReady` address. */
    update?: DeviceTransitionUpdate,
  ): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (to === "deleted" && this.#leases.some((lease) => lease.deviceId === deviceId)) {
      throw new RegistryEventError(`Cannot delete device with an active lease: ${deviceId}`);
    }

    const expectedEvent = eventForTransition(device.state, to);
    if (expectedEvent === undefined ? event !== undefined : event?.event !== expectedEvent) {
      throw new RegistryEventError(
        `Transition from ${device.state} to ${to} requires ${expectedEvent ?? "no"} device event`,
      );
    }
    if (event !== undefined && event.payload.deviceId !== deviceId) {
      throw new RegistryEventError(`Device event payload does not match device: ${deviceId}`);
    }

    const updated = transition(device, to, update);
    const devices = [...this.#devices];
    devices[index] = updated;
    await this.#commit(devices, this.#leases);

    if (event !== undefined) {
      this.#emitDeviceEvent(event);
    }

    return cloneDevice(updated);
  }

  /** Commits an unleased reclaim interrupted by daemon shutdown, found still `reclaiming` at startup. */
  // fallow-ignore-next-line unused-class-member -- called through WarmPoolCoordinator's registry port.
  async completeInterruptedReclaim(deviceId: string): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.state !== "reclaiming") {
      throw new RegistryEventError(`Device is not reclaiming: ${deviceId}`);
    }
    const updated = transition(device, "shutdown");
    const devices = [...this.#devices];
    devices[index] = updated;
    await this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  /**
   * Commits quarantine entry from either of its two legal sources (see domain.ts):
   * a release-time purge failure leaves `reclaiming`, and a stalled-transition
   * timeout leaves `provisioning`. The caller -- WarmPoolCoordinator for the former,
   * QuarantineCoordinator's stalled-transition entry point for the latter -- emits
   * `device.quarantined` (and, for a purge failure, `device.purge-failed`) after this
   * commits.
   */
  // fallow-ignore-next-line unused-class-member -- called through QuarantineCoordinator's registry port.
  async enterQuarantine(deviceId: string, nextRetryAt: number): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.state !== "reclaiming" && device.state !== "provisioning") {
      throw new RegistryEventError(`Device is not reclaiming or provisioning: ${deviceId}`);
    }
    const updated: DeviceRecord = {
      ...transition(device, "quarantined"),
      quarantineAttempts: 0,
      quarantineNextRetryAt: nextRetryAt,
      quarantinedAt: this.options.clock.now(),
    };
    const devices = [...this.#devices];
    devices[index] = updated;
    await this.#commit(devices, this.#leases);
    return cloneDevice(updated);
  }

  /** Records a failed purge retry without leaving `quarantined`; the caller re-arms backoff. */
  // fallow-ignore-next-line unused-class-member -- called through QuarantineCoordinator's registry port.
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

  /** Commits a successful quarantine retry; the device rejoins the warm pool. */
  // fallow-ignore-next-line unused-class-member -- called through QuarantineCoordinator's registry port.
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
    } = transition(device, to);
    const devices = [...this.#devices];
    devices[index] = updated as DeviceRecord;
    await this.#commit(devices, this.#leases);
    return cloneDevice(updated as DeviceRecord);
  }

  /** Commits giving up on a quarantined device once its driver `destroy` has already run. */
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

  // fallow-ignore-next-line unused-class-member -- called through QuarantineCoordinator's registry port.
  async abandonQuarantine(deviceId: string): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (device.state !== "quarantined") {
      throw new RegistryEventError(`Device is not quarantined: ${deviceId}`);
    }
    const {
      quarantineAttempts: _quarantineAttempts,
      quarantineNextRetryAt: _quarantineNextRetryAt,
      quarantinedAt: _quarantinedAt,
      ...updated
    } = transition(device, "deleted");
    const devices = [...this.#devices];
    devices[index] = updated as DeviceRecord;
    await this.#commit(devices, this.#leases);
    this.options.eventBus.emit(
      "device.deleted",
      { deviceId, initiator: "quarantine-coordinator" },
      "registry",
    );
    return cloneDevice(updated as DeviceRecord);
  }

  /** Flags a device whose observed boot state disagrees with the committed registry state. */
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

  /** Flags a device whose provenance marks no longer prove Simlock owns it. */
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
  // fallow-ignore-next-line unused-class-member -- called through LeaseHealthMonitor's registry port.
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
  // fallow-ignore-next-line unused-class-member -- called through LeaseHealthMonitor's registry port.
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

  /** Records externally verified disappearance; no driver verb is invoked. */
  async markDeviceMissing(deviceId: string, initiator: string): Promise<DeviceRecord> {
    const { device, index } = this.#requireDeviceRecord(deviceId);
    if (this.#leases.some((lease) => lease.deviceId === deviceId)) {
      throw new RegistryEventError(`Cannot mark leased device missing: ${deviceId}`);
    }
    if (device.state === "deleted") {
      return cloneDevice(device);
    }
    const updated = { ...device, state: "deleted" as const };
    const devices = [...this.#devices];
    devices[index] = updated;
    await this.#commit(devices, this.#leases);
    this.options.eventBus.emit("device.deleted", { deviceId, initiator }, "registry");
    return cloneDevice(updated);
  }

  async createLease({
    deviceId,
    ownerId,
    requesterId,
    ttlMs,
    ttlDeadline,
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

    const leasedDevice = transition(device, "leased");
    const grantedAt = this.options.clock.now();
    const lease: LeaseRecord = {
      deviceId,
      grantedAt,
      id: `lse_${this.options.idGenerator.generate()}`,
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
    await this.#commit(devices, [...this.#leases, lease]);

    return cloneLease(lease);
  }

  async beginRelease(leaseId: string): Promise<ReleasedLease> {
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
      ...transition(withoutRecoveryMarkers as DeviceRecord, "reclaiming"),
      lastLeaseEndedAt: this.options.clock.now(),
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
  // fallow-ignore-next-line unused-class-member -- called through LeaseLifecycle's registry port.
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

  async #commit(devices: DeviceRecord[], leases: LeaseRecord[]): Promise<void> {
    await this.options.filesystem.mkdirp(parentDirectory(this.options.statePath));
    await this.options.filesystem.writeFileAtomic(
      this.options.statePath,
      JSON.stringify({
        ...this.#unknownState,
        devices: devices.map((device) => ({
          ...this.#unknownDeviceFields.get(device.id),
          ...device,
        })),
        leases: leases.map((lease) => ({
          ...this.#unknownLeaseFields.get(lease.id),
          ...lease,
        })),
      }),
    );
    this.#devices = devices;
    this.#leases = leases;
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

    this.#unknownState = unknownFields(parsed, ["devices", "leases"]);
    this.#devices = parsed.devices.map((device) => {
      const record = parseDevice(device);
      this.#unknownDeviceFields.set(record.id, unknownFields(device, deviceRecordKeys));
      return record;
    });
    this.#leases = parsed.leases.map((lease) => {
      const record = parseLease(lease, this.options.defaultTtlMs);
      this.#unknownLeaseFields.set(
        record.id,
        unknownFields(lease, [...leaseRecordKeys, ...retiredLeaseRecordKeys]),
      );
      return record;
    });
  }

  #emitDeviceEvent(event: RegistryDeviceEvent): void {
    switch (event.event) {
      case "device.ready":
        this.options.eventBus.emit(event.event, event.payload, "registry");
        return;
      case "device.reclaimed":
        this.options.eventBus.emit(event.event, event.payload, "registry");
        return;
      case "device.shutdown":
        this.options.eventBus.emit(event.event, event.payload, "registry");
        return;
      case "device.deleted":
        this.options.eventBus.emit(event.event, event.payload, "registry");
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
  "foreignStateDetectedAt",
  "foreignProvenanceDetectedAt",
  "recoveringSince",
  "recoveryAttempts",
  "quarantinedAt",
  "quarantineAttempts",
  "quarantineNextRetryAt",
  "address",
  "featureProfile",
] as const;
const leaseRecordKeys = [
  "id",
  "deviceId",
  "requesterId",
  "ownerId",
  "grantedAt",
  "ttlMs",
  "ttlDeadline",
  "lastRenewedAt",
] as const;
/**
 * Fields a lease record written before ADR 0004 carries that this daemon neither reads nor
 * keeps. Listed here so they are stripped on load rather than preserved through the
 * unknown-field forward-compatibility path -- `mode` is not a field from a *newer* schema this
 * daemon should hand back untouched, it is a concept that no longer exists.
 */
const retiredLeaseRecordKeys = ["mode"] as const;

function cloneDevice(device: DeviceRecord): DeviceRecord {
  return { ...device, spec: { ...device.spec } };
}

function cloneLease(lease: LeaseRecord): LeaseRecord {
  return { ...lease };
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function eventForTransition(
  from: DeviceState,
  to: DeviceState,
): RegistryDeviceEvent["event"] | undefined {
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
 * Every optional field on a device record happens to be a number, so they are
 * parsed as one group: absent stays absent, present-but-not-a-number is a
 * corrupt record. Keeping them out of `parseDevice`'s required-field check is
 * what stops that check growing another two branches per field added.
 */
const optionalDeviceNumberKeys = [
  "lastLeaseEndedAt",
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

function parseDevice(value: unknown): DeviceRecord {
  if (!isObject(value)) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }

  const { address, createdAt, driverData, driverDeviceId, featureProfile, id, spec, state } = value;
  if (
    typeof id !== "string" ||
    typeof driverDeviceId !== "string" ||
    typeof createdAt !== "number" ||
    !(isDeviceState(state) || state === "warm") ||
    !isDeviceSpec(spec) ||
    !("driverData" in value) ||
    // Every other optional field is a number and is swept by
    // `parseOptionalDeviceNumbers`; `address` is the lone string. Missing is expected of a
    // record written by a pre-address daemon; present-but-wrong-typed is corrupt.
    (address !== undefined && typeof address !== "string")
  ) {
    throw new RegistryLoadError("Invalid device record in registry state");
  }

  return {
    ...parseOptionalDeviceNumbers(value),
    ...(address === undefined ? {} : { address }),
    ...(isFeatureProfile(featureProfile) ? { featureProfile } : {}),
    createdAt,
    driverData,
    driverDeviceId,
    id,
    spec,
    state: state === "warm" ? "reclaiming" : state,
  };
}

/**
 * Unlike `address`, a garbage `featureProfile` is dropped rather than failing the whole record --
 * it is a derived, re-derivable-on-next-boot hint (see `domain.ts`), not load-bearing identity, so
 * a corrupt value should not stop the registry (and every other device in it) from loading.
 */
function isFeatureProfile(value: unknown): value is "full" | "reduced" {
  return value === "full" || value === "reduced";
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
 * would cost an operator every device Simlock knows about (the same trade `featureProfile`
 * already makes).
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
    lastRenewedAt: finiteTimestampOr(lastRenewedAt, grantedAt),
    ownerId: ownerId ?? requesterId,
    requesterId,
    ttlDeadline,
    ttlMs: positiveDurationOr(ttlMs, defaultTtlMs),
  };
}

function isDeviceSpec(value: unknown): value is DeviceSpec {
  return (
    isObject(value) &&
    isPlatform(value.platform) &&
    typeof value.model === "string" &&
    typeof value.osVersion === "string"
  );
}

function isPlatform(value: unknown): value is Platform {
  return value === "ios" || value === "android";
}

function isDeviceState(value: unknown): value is DeviceState {
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
