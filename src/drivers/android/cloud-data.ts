import type { DeviceDataTable } from "../../core/index.js";
import type { SqliteDatabase } from "../../ports/index.js";
import type { CloudLease } from "./cloud-api.js";

export interface CloudDriverData {
  readonly allocationId: string;
}

export interface CloudAllocation {
  readonly id: string;
  readonly leaseId: string | undefined;
  readonly startedAtMs: number | undefined;
  readonly expiresAtMs: number | undefined;
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
  name: "android-cloud-device-data",
  version: 1,
  migrations: [
    `CREATE TABLE adc_allocations (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      lease_id TEXT,
      started_at_ms INTEGER,
      expires_at_ms INTEGER,
      adb_port INTEGER,
      released INTEGER NOT NULL DEFAULT 0
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

  reserve(id: string): void {
    const statement = this.database.prepare(
      "INSERT INTO adc_allocations (id, origin) VALUES (?, ?)",
    );
    statement.run(id, this.origin);
  }

  update(id: string, lease: CloudLease): void {
    const statement = this.database
      .prepare(`UPDATE adc_allocations SET lease_id=?, started_at_ms=?, expires_at_ms=?
      WHERE id=? AND origin=?`);
    statement.run(lease.id, lease.startedAtMs ?? null, lease.expiresAtMs ?? null, id, this.origin);
  }

  get(id: string): CloudAllocation {
    const statement = this.database.prepare(
      "SELECT * FROM adc_allocations WHERE id=? AND origin=?",
    );
    const row = statement.get(id, this.origin);
    if (row === undefined)
      throw new Error(`AgentDeviceCloud allocation ${id} is not owned by this worker`);
    return allocationOf(row);
  }

  active(): readonly CloudAllocation[] {
    const statement = this.database.prepare(
      "SELECT * FROM adc_allocations WHERE origin=? AND released=0 AND lease_id IS NOT NULL",
    );
    const rows = statement.all(this.origin);
    return rows.map(allocationOf);
  }

  release(id: string): void {
    const statement = this.database.prepare(
      "UPDATE adc_allocations SET released=1 WHERE id=? AND origin=?",
    );
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
    leaseId: typeof row.lease_id === "string" ? row.lease_id : undefined,
    startedAtMs: typeof row.started_at_ms === "number" ? row.started_at_ms : undefined,
    expiresAtMs: typeof row.expires_at_ms === "number" ? row.expires_at_ms : undefined,
    adbPort: typeof row.adb_port === "number" ? row.adb_port : undefined,
  };
}
