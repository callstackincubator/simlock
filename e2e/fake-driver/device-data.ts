import type { DeviceDataTable } from "../../dist/core/index.js";

// why: e2e may enter the project only through dist/<module>/index.js, so the e2e fake driver keeps its own table beside src/core's fakeDeviceDataTable.
export const e2eFakeDeviceDataTable: DeviceDataTable = {
  migrations: [
    "CREATE TABLE e2e_fake_device_data (device_id TEXT PRIMARY KEY, fake_device_id TEXT NOT NULL) STRICT",
  ],
  name: "e2e-fake-device-data",
  read(database, deviceId) {
    const row = database
      .prepare("SELECT fake_device_id FROM e2e_fake_device_data WHERE device_id = ?")
      .get(deviceId);
    if (row === undefined) throw new Error(`No fake driver data for device ${deviceId}`);
    return { fakeDeviceId: row["fake_device_id"] };
  },
  version: 1,
  write(database, deviceId, driverData) {
    const data = driverData as Record<string, unknown> | null | undefined;
    const fakeDeviceId = data?.["fakeDeviceId"];
    if (typeof fakeDeviceId !== "string" || Object.keys(data ?? {}).length !== 1) {
      throw new Error(`Invalid fake driver data for device ${deviceId}`);
    }
    database
      .prepare(
        `INSERT INTO e2e_fake_device_data (device_id, fake_device_id) VALUES (?, ?)
         ON CONFLICT (device_id) DO UPDATE SET fake_device_id = excluded.fake_device_id`,
      )
      .run(deviceId, fakeDeviceId);
  },
};
