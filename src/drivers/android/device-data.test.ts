import { describe, expect, it } from "vitest";
import { describeDeviceDataTable, openMemoryState } from "../../core/testing.js";
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

describe("androidDeviceDataTable write", () => {
  it("refuses, naming the platform and the device, a missing required key, a required key of the wrong type, an optional key of the wrong type and an extra key", async () => {
    const { serial: _serial, ...missing } = base;
    const cases: Record<string, unknown> = {
      "missing required key": missing,
      "required key of the wrong type": { ...base, port: "5554" },
      "port that is not an integer": { ...base, port: 5554.5 },
      "port that is NaN": { ...base, port: Number.NaN },
      "optional key of the wrong type": { ...base, imageIdentity: 5 },
      "extra key": { ...base, extra: "x" },
    };
    const state = await openMemoryState([androidDeviceDataTable]);
    for (const [label, value] of Object.entries(cases)) {
      expect(() => androidDeviceDataTable.write(state.database, "dev_1", value), label).toThrow(
        "Invalid android driver data for device dev_1",
      );
    }
    state.close();
  });
});
