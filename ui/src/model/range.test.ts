import { describe, expect, it } from "vitest";

import { readRange, statsPath, writeRange } from "./range";

describe("the console range", () => {
  it("reads 1h, 6h, 24h and 7d from ?range=, and a missing, empty or unknown value as 1h", () => {
    expect(
      ["?range=1h", "?range=6h", "?range=24h", "?range=7d"].map((search) => readRange(search)),
    ).toEqual(["1h", "6h", "24h", "7d"]);
    expect(["", "?page=2", "?range=", "?range=2d", "?range=7D"].map((s) => readRange(s))).toEqual([
      "1h",
      "1h",
      "1h",
      "1h",
      "1h",
    ]);
  });

  it("writes a range into the query, drops the key for 1h, and keeps page and size", () => {
    expect(writeRange("?page=2&size=50", "7d")).toBe("?page=2&size=50&range=7d");
    expect(writeRange("?range=7d&page=2&size=50", "1h")).toBe("?page=2&size=50");
    expect(writeRange("?range=7d", "1h")).toBe("");
    expect(writeRange("?range=6h", "24h")).toBe("?range=24h");
  });

  it("maps each range to its stats path", () => {
    expect((["1h", "6h", "24h", "7d"] as const).map((range) => statsPath(range))).toEqual([
      "/v1/stats?since=1h",
      "/v1/stats?since=6h",
      "/v1/stats?since=24h",
      "/v1/stats?since=7d",
    ]);
  });
});
