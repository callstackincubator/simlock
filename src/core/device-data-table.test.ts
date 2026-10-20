import { describe, expect, it } from "vitest";

import { describeDeviceDataTable, fakeDeviceDataTable, openTestState } from "./testing.js";

describeDeviceDataTable("fakeDeviceDataTable", fakeDeviceDataTable, [
  { fakeDeviceId: "fake-ios-1" },
  { fakeDeviceId: "fake-android-2" },
]);

describe("fakeDeviceDataTable", () => {
  it("refuses driver data that is not { fakeDeviceId: string }, naming the device", async () => {
    const state = await openTestState();
    for (const invalid of [
      {},
      { fakeDeviceId: 3 },
      { fakeDeviceId: "a", extra: 1 },
      null,
      undefined,
      "fk",
    ]) {
      expect(() => fakeDeviceDataTable.write(state.database, "dev_bad", invalid)).toThrow(
        "Invalid fake driver data for device dev_bad",
      );
    }
    expect(state.database.prepare("SELECT COUNT(*) AS n FROM fake_device_data").get()).toEqual({
      n: 0,
    });
    state.close();
  });
});
