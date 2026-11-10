import type { DeviceDataTable } from "../../../core/index.js";
import type { SqliteDatabase } from "../../../ports/index.js";
import type { CloudLease } from "./api.js";

export interface CloudDriverData {
  readonly allocationId: string;
}

export interface CloudAllocation {
  readonly id: string;
  readonly activationId: string | undefined;
  readonly leaseId: string | undefined;
  readonly adbPort: number | undefined;
}

export function cloudData(value: unknown): CloudDriverData {
  if (typeof value !== "object" || value === null || !("allocationId" in value)) {
    throw new Error("Invalid AgentDeviceCloud device data");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 1 ||
    typeof value.allocationId !== "string" ||
    value.allocationId.length === 0
  ) {
    throw new Error("Invalid AgentDeviceCloud allocation ID");
  }
  return { allocationId: value.allocationId };
}

export const cloudDeviceDataTable: DeviceDataTable = {
  name: "android-adc-device-data",
  version: 1,
  migrations: [
    `CREATE TABLE adc_allocations (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      activation_id TEXT,
      lease_id TEXT,
      adb_port INTEGER
    ) STRICT;
    CREATE TABLE adc_device_data (
      device_id TEXT PRIMARY KEY,
      allocation_id TEXT NOT NULL
    ) STRICT`,
  ],
  write(database, deviceId, value) {
    const data = cloudData(value);
    const statement =
      database.prepare(`INSERT INTO adc_device_data (device_id, allocation_id) VALUES (?, ?)
      ON CONFLICT(device_id) DO UPDATE SET allocation_id=excluded.allocation_id`);
    statement.run(deviceId, data.allocationId);
  },
  read(database, deviceId) {
    const statement = database.prepare(
      "SELECT allocation_id FROM adc_device_data WHERE device_id=?",
    );
    const row = statement.get(deviceId);
    if (row === undefined) throw new Error(`No AgentDeviceCloud data for device ${deviceId}`);
    return cloudData({ allocationId: row.allocation_id });
  },
};

export class CloudAllocations {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly origin: string,
  ) {}

  conflictingOrigin(): string | undefined {
    const statement = this.database.prepare(
      "SELECT origin FROM adc_allocations WHERE origin<>? LIMIT 1",
    );
    const row = statement.get(this.origin);
    if (row === undefined) return undefined;
    if (typeof row.origin !== "string") throw new Error("Invalid recorded AgentDeviceCloud origin");
    return row.origin;
  }

  reserve(id: string): void {
    const statement = this.database.prepare(
      "INSERT INTO adc_allocations (id, origin) VALUES (?, ?)",
    );
    statement.run(id, this.origin);
  }

  beginActivation(id: string, activationId: string): void {
    const statement = this.database.prepare(
      "UPDATE adc_allocations SET activation_id=? WHERE id=? AND origin=? AND activation_id IS NULL",
    );
    statement.run(activationId, id, this.origin);
  }

  update(id: string, lease: CloudLease): void {
    const statement = this.database.prepare(
      "UPDATE adc_allocations SET lease_id=? WHERE id=? AND origin=?",
    );
    statement.run(lease.id, id, this.origin);
  }

  find(id: string): CloudAllocation | undefined {
    const statement = this.database.prepare(
      "SELECT * FROM adc_allocations WHERE id=? AND origin=?",
    );
    const row = statement.get(id, this.origin);
    return row === undefined ? undefined : allocationOf(row);
  }

  get(id: string): CloudAllocation {
    const allocation = this.find(id);
    if (allocation === undefined)
      throw new Error(`AgentDeviceCloud allocation ${id} is not owned by this worker`);
    return allocation;
  }

  all(): readonly CloudAllocation[] {
    const statement = this.database.prepare("SELECT * FROM adc_allocations WHERE origin=?");
    const rows = statement.all(this.origin);
    return rows.map(allocationOf);
  }

  endActivation(id: string): void {
    const statement = this.database.prepare(
      "UPDATE adc_allocations SET activation_id=NULL,lease_id=NULL WHERE id=? AND origin=?",
    );
    statement.run(id, this.origin);
  }

  forget(id: string): void {
    const statement = this.database.prepare("DELETE FROM adc_allocations WHERE id=? AND origin=?");
    statement.run(id, this.origin);
  }

  setPort(id: string, port: number): void {
    const statement = this.database.prepare(
      "UPDATE adc_allocations SET adb_port=? WHERE id=? AND origin=?",
    );
    statement.run(port, id, this.origin);
  }
}

function allocationOf(row: Record<string, unknown>): CloudAllocation {
  if (typeof row.id !== "string") throw new Error("Invalid stored AgentDeviceCloud allocation");
  return {
    id: row.id,
    activationId: typeof row.activation_id === "string" ? row.activation_id : undefined,
    leaseId: typeof row.lease_id === "string" ? row.lease_id : undefined,
    adbPort: typeof row.adb_port === "number" ? row.adb_port : undefined,
  };
}
