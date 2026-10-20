import { describeDeviceDataTable } from "../../core/testing.js";
import { iosDeviceDataTable } from "./device-data.js";

const base = {
  deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  name: "simlock-ios-1",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
  udid: "9F2C0000-0000-0000-0000-000000000001",
};

describeDeviceDataTable("iosDeviceDataTable", iosDeviceDataTable, [
  base,
  { ...base, slimMarkToken: "tok-1", slimSignature: "sig-1" },
  { ...base, slimSignature: "sig-2" },
]);
