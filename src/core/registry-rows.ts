import type { SqliteDatabase, SqliteValue } from "../ports/index.js";
import {
  type AbsentReason,
  DEVICE_CLASSES,
  type DeviceClass,
  type DeviceMode,
  type DeviceRecord,
  type LeaseGrant,
  type LeaseIdentity,
  type LeaseRecord,
  type LeaseRequestRecord,
  type LeaseRequestState,
  type LeaseTiming,
  type PhysicalClass,
  type PhysicalState,
  type Platform,
  type QuarantineCause,
  type VirtualDevice,
  type VirtualState,
} from "./domain.js";
import type { DeviceDataTable, DeviceRequest } from "./driver.js";
import type { ComponentRecord } from "./registry.js";

type Row = Record<string, unknown>;

export class RegistryLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryLoadError";
  }
}

const PLATFORMS: readonly Platform[] = ["ios", "android"];
const VIRTUAL_STATES: readonly VirtualState[] = [
  "provisioning",
  "ready",
  "leased",
  "reclaiming",
  "quarantined",
  "shutdown",
  "deleted",
];
const PHYSICAL_STATES: readonly PhysicalState[] = [
  "ready",
  "absent",
  "leased",
  "reclaiming",
  "quarantined",
  "deleted",
];
const ABSENT_REASONS: readonly AbsentReason[] = ["locked", "untrusted", "not-present"];
const PHYSICAL_CLASSES: readonly PhysicalClass[] = ["phone", "tablet"];
const DEVICE_MODES: readonly DeviceMode[] = ["slim", "full"];
const LEASE_IDENTITIES: readonly LeaseIdentity[] = ["reusable", "fresh"];
const LEASE_REQUEST_STATES: readonly LeaseRequestState[] = [
  "open",
  "granted",
  "failed",
  "cancelled",
];
const QUARANTINE_KINDS: readonly QuarantineCause["kind"][] = [
  "purge-failed",
  "shutdown-failed",
  "delete-failed",
  "stalled",
];
const STALLED_STATES: readonly NonNullable<QuarantineCause["stalledState"]>[] = [
  "provisioning",
  "reclaiming",
];

class RowReader {
  constructor(
    private readonly table: string,
    private readonly key: string,
    private readonly row: Row,
  ) {}

  #fail(column: string): never {
    throw new RegistryLoadError(`Invalid ${this.table} row ${this.key}: bad value in ${column}`);
  }

  #present(column: string): unknown {
    const value = this.row[column];
    return value === null || value === undefined ? undefined : value;
  }

  text(column: string): string {
    return this.optText(column) ?? this.#fail(column);
  }

  optText(column: string): string | undefined {
    const value = this.#present(column);
    if (value !== undefined && typeof value !== "string") this.#fail(column);
    return value;
  }

  int(column: string): number {
    return this.optInt(column) ?? this.#fail(column);
  }

  optInt(column: string): number | undefined {
    const value = this.#present(column);
    if (value !== undefined && typeof value !== "number") this.#fail(column);
    return value;
  }

  flag(column: string): boolean {
    return this.optFlag(column) ?? this.#fail(column);
  }

  optFlag(column: string): boolean | undefined {
    const value = this.#present(column);
    if (value === undefined) return undefined;
    if (value !== 0 && value !== 1) this.#fail(column);
    return value === 1;
  }

  oneOf<T extends string>(column: string, allowed: readonly T[]): T {
    return this.optOneOf(column, allowed) ?? this.#fail(column);
  }

  optOneOf<T extends string>(column: string, allowed: readonly T[]): T | undefined {
    const value = this.optText(column);
    if (value !== undefined && !allowed.some((candidate) => candidate === value)) {
      this.#fail(column);
    }
    return value as T | undefined;
  }
}

function present<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

const DEVICE_OPTIONAL_NUMBERS = [
  ["lastLeaseEndedAt", "last_lease_ended_at"],
  ["readyAt", "ready_at"],
  ["shutdownAt", "shutdown_at"],
  ["foreignStateDetectedAt", "foreign_state_detected_at"],
  ["foreignProvenanceDetectedAt", "foreign_provenance_detected_at"],
  ["recoveringSince", "recovering_since"],
  ["recoveryAttempts", "recovery_attempts"],
  ["quarantinedAt", "quarantined_at"],
  ["quarantineAttempts", "quarantine_attempts"],
  ["quarantineNextRetryAt", "quarantine_next_retry_at"],
] as const;

const DEVICE_COLUMNS = [
  "id",
  "platform",
  "physical",
  "driver_device_id",
  "state",
  "model",
  "os_version",
  "spec_mode",
  "image_tag",
  "class",
  "mode",
  "lease_identity",
  "created_at",
  ...DEVICE_OPTIONAL_NUMBERS.map(([, column]) => column),
  "deferred_reclaim_lease_id",
  "quarantine_cause_kind",
  "quarantine_cause_stalled_state",
  "quarantine_cause_message",
  "address",
  "reclaiming_since",
  "absent_reason",
] as const;

const LEASE_COLUMNS = [
  "id",
  "device_id",
  "requester_id",
  "owner_id",
  "granted_at",
  "ttl_ms",
  "ttl_deadline",
  "last_renewed_at",
  "id_chosen_by_requester",
] as const;

const REQUEST_COLUMNS = [
  "id",
  "requester_id",
  "owner_id",
  "idempotency_key",
  "lease_id",
  "fleet_request_id",
  "platform",
  "model",
  "os_version",
  "mode",
  "image_tag",
  "class",
  "physical",
  "created_at",
  "state",
  "settled_at",
  "failure_code",
  "failure_message",
] as const;

const GRANT_COLUMNS = [
  "request_id",
  "device_id",
  "lease_id",
  "requester_id",
  "owner_id",
  "granted_at",
  "ttl_ms",
  "ttl_deadline",
  "last_renewed_at",
  "id_chosen_by_requester",
  "estimated_provision_ms",
  "estimated_boot_ms",
  "estimated_reclaim_ms",
  "estimated_ready_ms",
] as const;

function upsertSql(table: string, columns: readonly string[], key: string): string {
  const updates = columns
    .filter((column) => column !== key)
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
    ON CONFLICT (${key}) DO UPDATE SET ${updates}`;
}

function flagValue(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function specColumns(device: DeviceRecord): SqliteValue[] {
  if (device.physical) return [null, null, device.spec.class];
  return [device.spec.mode ?? null, device.spec.imageTag ?? null, null];
}

function causeColumns(cause: QuarantineCause | undefined): SqliteValue[] {
  return [cause?.kind ?? null, cause?.stalledState ?? null, cause?.message ?? null];
}

function physicalColumns(device: DeviceRecord): SqliteValue[] {
  if (!device.physical) return [null, null];
  return [device.reclaimingSince ?? null, device.absentReason ?? null];
}

function deviceValues(device: DeviceRecord): SqliteValue[] {
  return [
    device.id,
    device.spec.platform,
    flagValue(device.physical),
    device.driverDeviceId,
    device.state,
    device.spec.model,
    device.spec.osVersion,
    ...specColumns(device),
    device.mode ?? null,
    device.leaseIdentity ?? null,
    device.createdAt,
    ...DEVICE_OPTIONAL_NUMBERS.map(([property]) => device[property] ?? null),
    device.deferredReclaimLeaseId ?? null,
    ...causeColumns(device.quarantineCause),
    device.address ?? null,
    ...physicalColumns(device),
  ];
}

const UPSERT_DEVICE = upsertSql("devices", DEVICE_COLUMNS, "id");
const UPSERT_LEASE = upsertSql("leases", LEASE_COLUMNS, "id");
const UPSERT_REQUEST = upsertSql("lease_requests", REQUEST_COLUMNS, "id");
const UPSERT_GRANT = upsertSql("lease_grants", GRANT_COLUMNS, "request_id");

export function writeDevice(
  database: SqliteDatabase,
  device: DeviceRecord,
  deviceData: ReadonlyMap<Platform, DeviceDataTable>,
): void {
  database.prepare(UPSERT_DEVICE).run(...deviceValues(device));
  if (device.physical) {
    database.prepare("DELETE FROM device_enrolled_apps WHERE device_id = ?").run(device.id);
    device.enrolledApps.forEach((app, position) => {
      database
        .prepare("INSERT INTO device_enrolled_apps (device_id, position, app) VALUES (?, ?, ?)")
        .run(device.id, position, app);
    });
    return;
  }
  const table = deviceData.get(device.spec.platform);
  if (table === undefined) {
    throw new Error(`No device-data table for platform ${device.spec.platform}`);
  }
  table.write(database, device.id, device.driverData);
}

function leaseValues(lease: LeaseRecord): SqliteValue[] {
  return [
    lease.id,
    lease.deviceId,
    lease.requesterId,
    lease.ownerId,
    lease.grantedAt,
    lease.ttlMs,
    lease.ttlDeadline,
    lease.lastRenewedAt,
    flagValue(lease.idChosenByRequester),
  ];
}

export function writeLease(database: SqliteDatabase, lease: LeaseRecord): void {
  database.prepare(UPSERT_LEASE).run(...leaseValues(lease));
}

export function deleteLease(database: SqliteDatabase, id: string): void {
  database.prepare("DELETE FROM leases WHERE id = ?").run(id);
}

export function writeLeaseRequest(database: SqliteDatabase, record: LeaseRequestRecord): void {
  const { request } = record;
  database
    .prepare(UPSERT_REQUEST)
    .run(
      record.id,
      record.requesterId,
      record.ownerId,
      record.idempotencyKey ?? null,
      record.leaseId ?? null,
      record.fleetRequestId ?? null,
      request.platform,
      request.model ?? null,
      request.osVersion ?? null,
      request.mode ?? null,
      request.imageTag ?? null,
      request.class ?? null,
      flagValue(request.physical),
      record.createdAt,
      record.state,
      record.settledAt ?? null,
      record.failure?.code ?? null,
      record.failure?.message ?? null,
    );
  if (record.grant === undefined) return;
  const { grant } = record;
  const { lease } = grant;
  database
    .prepare(UPSERT_GRANT)
    .run(
      record.id,
      grant.device.id,
      lease.id,
      lease.requesterId,
      lease.ownerId,
      lease.grantedAt,
      lease.ttlMs,
      lease.ttlDeadline,
      lease.lastRenewedAt,
      flagValue(lease.idChosenByRequester),
      grant.timing.estimatedProvisionMs,
      grant.timing.estimatedBootMs,
      grant.timing.estimatedReclaimMs,
      grant.timing.estimatedReadyMs,
    );
  database.prepare("DELETE FROM lease_grant_environment WHERE request_id = ?").run(record.id);
  for (const [name, value] of Object.entries(grant.environment)) {
    database
      .prepare("INSERT INTO lease_grant_environment (request_id, name, value) VALUES (?, ?, ?)")
      .run(record.id, name, value);
  }
}

export function deleteLeaseRequest(database: SqliteDatabase, id: string): void {
  database.prepare("DELETE FROM lease_grant_environment WHERE request_id = ?").run(id);
  database.prepare("DELETE FROM lease_grants WHERE request_id = ?").run(id);
  database.prepare("DELETE FROM lease_requests WHERE id = ?").run(id);
}

export function writeComponent(database: SqliteDatabase, record: ComponentRecord): void {
  deleteComponentRows(database, record.platform, record.version);
  database
    .prepare("INSERT INTO components (platform, version, installed_at) VALUES (?, ?, ?)")
    .run(record.platform, record.version, record.installedAt);
  for (const [key, value] of Object.entries(record.receipt)) {
    database
      .prepare("INSERT INTO component_receipt (platform, version, key, value) VALUES (?, ?, ?, ?)")
      .run(record.platform, record.version, key, value);
  }
}

export function deleteComponentRows(
  database: SqliteDatabase,
  platform: Platform,
  version: string,
): void {
  database
    .prepare("DELETE FROM component_receipt WHERE platform = ? AND version = ?")
    .run(platform, version);
  database
    .prepare("DELETE FROM components WHERE platform = ? AND version = ?")
    .run(platform, version);
}

export interface LoadedRegistry {
  readonly devices: DeviceRecord[];
  readonly leases: LeaseRecord[];
  readonly leaseRequests: LeaseRequestRecord[];
  readonly components: ComponentRecord[];
}

export function loadRegistryRows(
  database: SqliteDatabase,
  deviceData: ReadonlyMap<Platform, DeviceDataTable>,
): LoadedRegistry {
  const appsByDevice = new Map<string, string[]>();
  for (const row of database
    .prepare("SELECT device_id, app FROM device_enrolled_apps ORDER BY device_id, position")
    .all()) {
    const reader = new RowReader("device_enrolled_apps", String(row.device_id), row);
    const apps = appsByDevice.get(reader.text("device_id")) ?? [];
    apps.push(reader.text("app"));
    appsByDevice.set(reader.text("device_id"), apps);
  }
  const devices = database
    .prepare("SELECT * FROM devices ORDER BY rowid")
    .all()
    .map((row) => deviceFromRow(database, row, appsByDevice, deviceData));
  const leases = database
    .prepare("SELECT * FROM leases ORDER BY rowid")
    .all()
    .map((row) => leaseFromRow("leases", String(row.id), row, "id"));
  const byId = new Map(devices.map((device) => [device.id, device]));
  return {
    components: loadComponents(database),
    devices,
    leaseRequests: loadLeaseRequests(database, byId),
    leases,
  };
}

function deviceFromRow(
  database: SqliteDatabase,
  row: Row,
  appsByDevice: ReadonlyMap<string, string[]>,
  deviceData: ReadonlyMap<Platform, DeviceDataTable>,
): DeviceRecord {
  const reader = new RowReader("devices", String(row.id), row);
  const id = reader.text("id");
  const platform = reader.oneOf("platform", PLATFORMS);
  const physical = reader.flag("physical");
  const shared = {
    createdAt: reader.int("created_at"),
    driverDeviceId: reader.text("driver_device_id"),
    id,
    ...Object.fromEntries(
      DEVICE_OPTIONAL_NUMBERS.flatMap(([property, column]) => {
        const value = reader.optInt(column);
        return value === undefined ? [] : [[property, value]];
      }),
    ),
    ...present("address", reader.optText("address")),
    ...present("deferredReclaimLeaseId", reader.optText("deferred_reclaim_lease_id")),
    ...present("quarantineCause", quarantineCause(reader)),
  };
  const model = reader.text("model");
  const osVersion = reader.text("os_version");
  if (physical) {
    return {
      ...shared,
      driverData: {},
      enrolledApps: appsByDevice.get(id) ?? [],
      physical: true,
      ...present("reclaimingSince", reader.optInt("reclaiming_since")),
      ...present("absentReason", reader.optOneOf("absent_reason", ABSENT_REASONS)),
      spec: {
        class: reader.oneOf("class", PHYSICAL_CLASSES),
        model,
        osVersion,
        physical: true,
        platform,
      },
      state: reader.oneOf("state", PHYSICAL_STATES),
    };
  }
  const virtual: VirtualDevice = {
    ...shared,
    driverData: readDeviceData(database, deviceData, platform, id),
    ...present("leaseIdentity", reader.optOneOf("lease_identity", LEASE_IDENTITIES)),
    mode: reader.oneOf("mode", DEVICE_MODES),
    physical: false,
    spec: {
      ...present("imageTag", reader.optText("image_tag")),
      ...present("mode", reader.optOneOf("spec_mode", ["slim"] as const)),
      model,
      osVersion,
      physical: false,
      platform,
    },
    state: reader.oneOf("state", VIRTUAL_STATES),
  };
  return virtual;
}

function quarantineCause(reader: RowReader): QuarantineCause | undefined {
  const kind = reader.optOneOf("quarantine_cause_kind", QUARANTINE_KINDS);
  if (kind === undefined) return undefined;
  return {
    kind,
    ...present("stalledState", reader.optOneOf("quarantine_cause_stalled_state", STALLED_STATES)),
    ...present("message", reader.optText("quarantine_cause_message")),
  };
}

function readDeviceData(
  database: SqliteDatabase,
  deviceData: ReadonlyMap<Platform, DeviceDataTable>,
  platform: Platform,
  id: string,
): unknown {
  const table = deviceData.get(platform);
  if (table === undefined) {
    throw new RegistryLoadError(`Invalid devices row ${id}: no device-data table for ${platform}`);
  }
  try {
    return table.read(database, id);
  } catch (error: unknown) {
    throw new RegistryLoadError(
      `Invalid devices row ${id}: no row in ${table.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function leaseFromRow(table: string, key: string, row: Row, idColumn: string): LeaseRecord {
  const reader = new RowReader(table, key, row);
  return {
    deviceId: reader.text("device_id"),
    grantedAt: reader.int("granted_at"),
    id: reader.text(idColumn),
    idChosenByRequester: reader.flag("id_chosen_by_requester"),
    lastRenewedAt: reader.int("last_renewed_at"),
    ownerId: reader.text("owner_id"),
    requesterId: reader.text("requester_id"),
    ttlDeadline: reader.int("ttl_deadline"),
    ttlMs: reader.int("ttl_ms"),
  };
}

function loadLeaseRequests(
  database: SqliteDatabase,
  devices: ReadonlyMap<string, DeviceRecord>,
): LeaseRequestRecord[] {
  const environments = new Map<string, Record<string, string>>();
  for (const row of database.prepare("SELECT * FROM lease_grant_environment").all()) {
    const reader = new RowReader("lease_grant_environment", String(row.request_id), row);
    const environment = environments.get(reader.text("request_id")) ?? {};
    environment[reader.text("name")] = reader.text("value");
    environments.set(reader.text("request_id"), environment);
  }
  const grants = new Map<string, Row>();
  for (const row of database.prepare("SELECT * FROM lease_grants").all()) {
    grants.set(String(row.request_id), row);
  }
  return database
    .prepare("SELECT * FROM lease_requests ORDER BY rowid")
    .all()
    .map((row) => {
      const reader = new RowReader("lease_requests", String(row.id), row);
      const id = reader.text("id");
      const state = reader.oneOf("state", LEASE_REQUEST_STATES);
      const grantRow = grants.get(id);
      if ((state === "granted") !== (grantRow !== undefined)) {
        throw new RegistryLoadError(
          `Invalid lease_requests row ${id}: state ${state} and its grant disagree`,
        );
      }
      const failureCode = reader.optText("failure_code");
      return {
        createdAt: reader.int("created_at"),
        id,
        ...present("idempotencyKey", reader.optText("idempotency_key")),
        ...present("leaseId", reader.optText("lease_id")),
        ...present("fleetRequestId", reader.optText("fleet_request_id")),
        ownerId: reader.text("owner_id"),
        request: requestFromRow(reader),
        requesterId: reader.text("requester_id"),
        state,
        ...present("settledAt", reader.optInt("settled_at")),
        ...(failureCode === undefined
          ? {}
          : { failure: { code: failureCode, message: reader.text("failure_message") } }),
        ...(grantRow === undefined
          ? {}
          : { grant: grantFromRow(id, grantRow, devices, environments.get(id) ?? {}) }),
      };
    });
}

function requestFromRow(reader: RowReader): DeviceRequest {
  return {
    platform: reader.oneOf("platform", PLATFORMS),
    ...present("model", reader.optText("model")),
    ...present("osVersion", reader.optText("os_version")),
    ...present("mode", reader.optOneOf("mode", DEVICE_MODES)),
    ...present("imageTag", reader.optText("image_tag")),
    ...present("class", reader.optOneOf<DeviceClass>("class", DEVICE_CLASSES)),
    ...present("physical", reader.optFlag("physical")),
  };
}

function grantFromRow(
  requestId: string,
  row: Row,
  devices: ReadonlyMap<string, DeviceRecord>,
  environment: Record<string, string>,
): LeaseGrant {
  const reader = new RowReader("lease_grants", requestId, row);
  const device = devices.get(reader.text("device_id"));
  if (device === undefined) {
    throw new RegistryLoadError(
      `Invalid lease_grants row ${requestId}: no device ${reader.text("device_id")}`,
    );
  }
  const timing: LeaseTiming = {
    estimatedBootMs: reader.int("estimated_boot_ms"),
    estimatedProvisionMs: reader.int("estimated_provision_ms"),
    estimatedReadyMs: reader.int("estimated_ready_ms"),
    estimatedReclaimMs: reader.int("estimated_reclaim_ms"),
  };
  return {
    device,
    environment,
    lease: leaseFromRow("lease_grants", requestId, { ...row, id: row.lease_id }, "id"),
    timing,
  };
}

function loadComponents(database: SqliteDatabase): ComponentRecord[] {
  const receipts = new Map<string, Record<string, string>>();
  for (const row of database.prepare("SELECT * FROM component_receipt").all()) {
    const reader = new RowReader(
      "component_receipt",
      `${String(row.platform)}/${String(row.version)}`,
      row,
    );
    const identity = `${reader.text("platform")}\0${reader.text("version")}`;
    const receipt = receipts.get(identity) ?? {};
    receipt[reader.text("key")] = reader.text("value");
    receipts.set(identity, receipt);
  }
  return database
    .prepare("SELECT * FROM components ORDER BY rowid")
    .all()
    .map((row) => {
      const reader = new RowReader(
        "components",
        `${String(row.platform)}/${String(row.version)}`,
        row,
      );
      const platform = reader.oneOf("platform", PLATFORMS);
      const version = reader.text("version");
      return {
        installedAt: reader.int("installed_at"),
        platform,
        receipt: receipts.get(`${platform}\0${version}`) ?? {},
        version,
      };
    });
}
