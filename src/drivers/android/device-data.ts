import type { DeviceDataTable } from "../../core/index.js";
import type { AndroidDriverData } from "./data.js";

interface AndroidDeviceDataRow {
  readonly avd_name: string;
  readonly config_hash: string;
  readonly image_identity: string | null;
  readonly port: number;
  readonly serial: string;
}

const STRING_KEYS = ["avdName", "configHash", "serial"] as const;
const KNOWN_KEYS = new Set<string>([...STRING_KEYS, "imageIdentity", "port"]);

function isAndroidDeviceData(value: unknown): value is AndroidDriverData {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => KNOWN_KEYS.has(key)) &&
    STRING_KEYS.every((key) => typeof record[key] === "string") &&
    Number.isInteger(record.port) &&
    (record.imageIdentity === undefined || typeof record.imageIdentity === "string")
  );
}

export const androidDeviceDataTable: DeviceDataTable = {
  migrations: [
    `CREATE TABLE android_device_data (
       device_id TEXT PRIMARY KEY,
       avd_name TEXT NOT NULL,
       config_hash TEXT NOT NULL,
       image_identity TEXT,
       port INTEGER NOT NULL,
       serial TEXT NOT NULL
     ) STRICT`,
  ],
  name: "android-device-data",
  read(database, deviceId) {
    const row = database
      .prepare(
        "SELECT avd_name, config_hash, image_identity, port, serial FROM android_device_data WHERE device_id = ?",
      )
      .get(deviceId) as AndroidDeviceDataRow | undefined;
    if (row === undefined) throw new Error(`No android driver data for device ${deviceId}`);
    return {
      avdName: row.avd_name,
      configHash: row.config_hash,
      ...(row.image_identity === null ? {} : { imageIdentity: row.image_identity }),
      port: row.port,
      serial: row.serial,
    };
  },
  version: 1,
  write(database, deviceId, driverData) {
    if (!isAndroidDeviceData(driverData)) {
      throw new Error(`Invalid android driver data for device ${deviceId}`);
    }
    const data = driverData;
    database
      .prepare(
        `INSERT INTO android_device_data (device_id, avd_name, config_hash, image_identity, port, serial)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET avd_name = excluded.avd_name,
           config_hash = excluded.config_hash, image_identity = excluded.image_identity,
           port = excluded.port, serial = excluded.serial`,
      )
      .run(
        deviceId,
        data.avdName,
        data.configHash,
        data.imageIdentity ?? null,
        data.port,
        data.serial,
      );
  },
};
