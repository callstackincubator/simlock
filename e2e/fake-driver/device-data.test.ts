import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { e2eFakeDeviceDataTable } from "./device-data.js";

function openTable(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const statement of e2eFakeDeviceDataTable.migrations) database.exec(statement);
  return database;
}

describe("e2e fake device data table", () => {
  it("writes and reads back its one key", () => {
    const database = openTable();

    e2eFakeDeviceDataTable.write(database, "dev_1", { fakeDeviceId: "fk-1" });

    expect(e2eFakeDeviceDataTable.read(database, "dev_1")).toEqual({ fakeDeviceId: "fk-1" });
  });

  it("refuses data with a key besides fakeDeviceId, and stores nothing", () => {
    const database = openTable();

    expect(() =>
      e2eFakeDeviceDataTable.write(database, "dev_1", { extra: 1, fakeDeviceId: "fk-1" }),
    ).toThrow("Invalid fake driver data for device dev_1");
    expect(() => e2eFakeDeviceDataTable.read(database, "dev_1")).toThrow(
      "No fake driver data for device dev_1",
    );
  });
});
