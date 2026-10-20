import type { DeviceDataTable } from "../../core/index.js";

interface IosDeviceDataRow {
  readonly udid: string;
  readonly name: string;
  readonly device_type_id: string;
  readonly runtime_id: string;
  readonly slim_signature: string | null;
  readonly slim_mark_token: string | null;
}

interface IosDriverData {
  readonly deviceTypeId: string;
  readonly name: string;
  readonly runtimeId: string;
  readonly slimMarkToken?: string;
  readonly slimSignature?: string;
  readonly udid: string;
}

const REQUIRED_KEYS = ["deviceTypeId", "name", "runtimeId", "udid"] as const;
const OPTIONAL_KEYS = ["slimMarkToken", "slimSignature"] as const;

function isIosDriverData(value: unknown): value is IosDriverData {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const known = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
  return (
    Object.keys(record).every((key) => known.has(key)) &&
    REQUIRED_KEYS.every((key) => typeof record[key] === "string") &&
    OPTIONAL_KEYS.every((key) => record[key] === undefined || typeof record[key] === "string")
  );
}

export const iosDeviceDataTable: DeviceDataTable = {
  migrations: [
    `CREATE TABLE ios_device_data (
       device_id TEXT PRIMARY KEY,
       udid TEXT NOT NULL,
       name TEXT NOT NULL,
       device_type_id TEXT NOT NULL,
       runtime_id TEXT NOT NULL,
       slim_signature TEXT,
       slim_mark_token TEXT
     ) STRICT`,
  ],
  name: "ios-device-data",
  read(database, deviceId) {
    const row = database
      .prepare(
        "SELECT udid, name, device_type_id, runtime_id, slim_signature, slim_mark_token FROM ios_device_data WHERE device_id = ?",
      )
      .get(deviceId) as IosDeviceDataRow | undefined;
    if (row === undefined) throw new Error(`No ios driver data for device ${deviceId}`);
    return {
      deviceTypeId: row.device_type_id,
      name: row.name,
      runtimeId: row.runtime_id,
      ...(row.slim_mark_token === null ? {} : { slimMarkToken: row.slim_mark_token }),
      ...(row.slim_signature === null ? {} : { slimSignature: row.slim_signature }),
      udid: row.udid,
    };
  },
  version: 1,
  write(database, deviceId, driverData) {
    if (!isIosDriverData(driverData)) {
      throw new Error(`Invalid ios driver data for device ${deviceId}`);
    }
    const data = driverData;
    database
      .prepare(
        `INSERT INTO ios_device_data (device_id, udid, name, device_type_id, runtime_id, slim_signature, slim_mark_token)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET udid = excluded.udid, name = excluded.name,
           device_type_id = excluded.device_type_id, runtime_id = excluded.runtime_id,
           slim_signature = excluded.slim_signature, slim_mark_token = excluded.slim_mark_token`,
      )
      .run(
        deviceId,
        data.udid,
        data.name,
        data.deviceTypeId,
        data.runtimeId,
        data.slimSignature ?? null,
        data.slimMarkToken ?? null,
      );
  },
};
