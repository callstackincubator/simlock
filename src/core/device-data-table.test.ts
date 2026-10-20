import { fakeDeviceDataTable, describeDeviceDataTable } from "./testing.js";

describeDeviceDataTable("fakeDeviceDataTable", fakeDeviceDataTable, [
  { fakeDeviceId: "fake-ios-1" },
  { fakeDeviceId: "fake-android-2" },
]);
