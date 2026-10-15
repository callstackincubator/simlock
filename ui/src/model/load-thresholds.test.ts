import { describe, expect, it } from "vitest";

import { LOAD_THRESHOLDS, levelOf } from "./load-thresholds";

describe("the console's own load thresholds", () => {
  it("colours a figure at or over each threshold, and nothing below it", () => {
    expect(levelOf(LOAD_THRESHOLDS.errorPercent)).toBe("error");
    // why: one step under each edge, or a threshold moved down by one still colours the whole
    // range this file names and stays green.
    expect(levelOf(LOAD_THRESHOLDS.errorPercent - 1)).toBe("warn");
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

  it("keeps the numbers the console's docs promise, apart and in order", () => {
    // why: these two are printed to a person in the console's own manual, so a change here is a
    // change to what the docs say; the literals hold the pair to that promise.
    expect(LOAD_THRESHOLDS.warnPercent).toBe(85);
    expect(LOAD_THRESHOLDS.errorPercent).toBe(95);
    expect(LOAD_THRESHOLDS.warnPercent).toBeLessThan(LOAD_THRESHOLDS.errorPercent);
    expect(LOAD_THRESHOLDS.errorPercent).toBeLessThanOrEqual(100);
  });
});
