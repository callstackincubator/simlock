import { describe, expect, it } from "vitest";

import { LOAD_THRESHOLDS, levelOf } from "./load-thresholds";

describe("the console's own load thresholds", () => {
  it("colours a figure at or over each threshold, and nothing below it", () => {
    expect(levelOf(LOAD_THRESHOLDS.errorPercent)).toBe("error");
    expect(levelOf(LOAD_THRESHOLDS.warnPercent)).toBe("warn");
    expect(levelOf(LOAD_THRESHOLDS.warnPercent - 1)).toBe("idle");
  });

  it("reads each figure the same way round, however full", () => {
    expect(levelOf(0)).toBe("idle");
    expect(levelOf(84.9)).toBe("idle");
    expect(levelOf(90)).toBe("warn");
    expect(levelOf(100)).toBe("error");
  });

  it("stays neutral for a figure the reading does not carry", () => {
    expect(levelOf(undefined)).toBe("idle");
  });

  it("keeps the two thresholds apart and in order", () => {
    expect(LOAD_THRESHOLDS.warnPercent).toBeLessThan(LOAD_THRESHOLDS.errorPercent);
    expect(LOAD_THRESHOLDS.errorPercent).toBeLessThanOrEqual(100);
  });
});
