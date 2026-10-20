import { describeDeviceDataTable } from "../../core/testing.js";
import { androidDeviceDataTable } from "./device-data.js";

const base = {
  avdName: "simlock_1",
  configHash: "ab12",
  port: 5554,
  serial: "emulator-5554",
};

describeDeviceDataTable("androidDeviceDataTable", androidDeviceDataTable, [
  { ...base, imageIdentity: "system-images;android-35;google_apis;arm64-v8a@3" },
  base,
]);
