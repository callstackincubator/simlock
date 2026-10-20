import { describe, expect, it } from "vitest";
import { describeDeviceDataTable, openMemoryState } from "../../core/testing.js";
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

describe("iosDeviceDataTable write", () => {
  it("refuses, naming the platform and the device, a missing required key, a required key of the wrong type, an optional key of the wrong type and an extra key", async () => {
    const { udid: _udid, ...missing } = base;
    const cases: Record<string, unknown> = {
      "missing required key": missing,
      "required key of the wrong type": { ...base, udid: 5 },
      "optional key of the wrong type": { ...base, slimSignature: 5 },
      "extra key": { ...base, extra: "x" },
    };
    const state = await openMemoryState([iosDeviceDataTable]);
    for (const [label, value] of Object.entries(cases)) {
      expect(() => iosDeviceDataTable.write(state.database, "dev_1", value), label).toThrow(
        "Invalid ios driver data for device dev_1",
      );
    }
    state.close();
  });
});
