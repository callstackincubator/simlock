import type { DeviceDataTable } from "../../core/index.js";

interface AndroidDeviceDataRow {
  readonly avd_name: string;
  readonly config_hash: string;
  readonly image_identity: string | null;
  readonly port: number;
  readonly serial: string;
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
    const data = driverData as Record<string, string | number | undefined>;
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
        (data.avdName as string | undefined) ?? null,
        (data.configHash as string | undefined) ?? null,
        (data.imageIdentity as string | undefined) ?? null,
        (data.port as number | undefined) ?? null,
        (data.serial as string | undefined) ?? null,
      );
  },
};
