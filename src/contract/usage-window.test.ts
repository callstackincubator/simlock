import { describe, expect, it } from "vitest";

import { usageWindow } from "./usage-window.js";

const NOW = Date.parse("2026-10-16T13:04:12.345Z");
const HOUR = 3_600_000;

describe("usageWindow", () => {
  it("answers the last 24 hours with no field, since back from now, from to to, and from to now", () => {
    expect(usageWindow({}, NOW)).toEqual({ window: { from: NOW - 24 * HOUR, to: NOW } });
    expect(usageWindow({ since: "90m" }, NOW)).toEqual({
      window: { from: NOW - 90 * 60_000, to: NOW },
    });
    expect(usageWindow({ from: "2026-10-15T00:00Z", to: "2026-10-16T00:00Z" }, NOW)).toEqual({
      window: { from: Date.parse("2026-10-15T00:00:00Z"), to: Date.parse("2026-10-16T00:00:00Z") },
    });
    expect(usageWindow({ from: "2026-10-15T00:00:00.5+02:00" }, NOW)).toEqual({
      window: { from: Date.parse("2026-10-14T22:00:00.500Z"), to: NOW },
    });
  });

  it("refuses since with from, to without from, and from not before to, naming the parameter", () => {
    expect(usageWindow({ from: "2026-10-15T00:00Z" }, NOW)).toHaveProperty("window");

    expect(usageWindow({ since: "1h", from: "2026-10-15T00:00Z" }, NOW)).toEqual({
      refused: { parameter: "from", problem: "since-and-from" },
    });
    expect(usageWindow({ to: "2026-10-16T00:00Z" }, NOW)).toEqual({
      refused: { parameter: "to", problem: "to-without-from" },
    });
    expect(usageWindow({ from: "2026-10-16T00:00Z", to: "2026-10-15T00:00Z" }, NOW)).toEqual({
      refused: { parameter: "from", problem: "not-before-to" },
    });
    expect(usageWindow({ from: "2026-10-15T00:00Z", to: "2026-10-15T00:00Z" }, NOW)).toEqual({
      refused: { parameter: "from", problem: "not-before-to" },
    });
    expect(usageWindow({ from: "2026-10-17T00:00Z" }, NOW)).toEqual({
      refused: { parameter: "from", problem: "not-before-to" },
    });
  });

  it("refuses a bad duration, and the times 1, 2026, 10/15/2026, a time with no zone, a time with a space before the offset, a day the month lacks and the hour 24, naming the parameter and the value", () => {
    expect(usageWindow({ since: "1h" }, NOW)).toHaveProperty("window");
    expect(usageWindow({ since: "soon" }, NOW)).toEqual({
      refused: { parameter: "since", problem: "bad-duration", value: "soon" },
    });
    expect(usageWindow({ from: "2024-02-29T00:00Z", to: "2024-03-01T00:00Z" }, NOW)).toEqual({
      window: { from: Date.UTC(2024, 1, 29), to: Date.UTC(2024, 2, 1) },
    });
    for (const value of [
      "1",
      "2026",
      "10/15/2026",
      "2026-10-15T00:00",
      "2026-10-15T00:00 02:00",
      "2026-02-31T00:00Z",
      "2026-02-29T00:00Z",
      "2026-10-15T24:00Z",
    ]) {
      expect(usageWindow({ from: value }, NOW), value).toEqual({
        refused: { parameter: "from", problem: "bad-time", value },
      });
      expect(usageWindow({ from: "2026-10-15T00:00Z", to: value }, NOW), value).toEqual({
        refused: { parameter: "to", problem: "bad-time", value },
      });
    }
  });
});
