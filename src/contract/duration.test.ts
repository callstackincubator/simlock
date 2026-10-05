import { describe, expect, it } from "vitest";

import { parseDurationMs } from "./duration.js";

describe("the shared duration parser", () => {
  it("accepts 7d as seven days and rejects 7w", () => {
    expect(parseDurationMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDurationMs("7w")).toBeUndefined();
  });

  it("accepts ms, s, m, h and a bare number of milliseconds", () => {
    expect(parseDurationMs("500")).toBe(500);
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("2s")).toBe(2_000);
    expect(parseDurationMs("3m")).toBe(180_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
  });

  it("rejects garbage and an amount too large to be a safe integer of milliseconds", () => {
    expect(parseDurationMs("banana")).toBeUndefined();
    expect(parseDurationMs("")).toBeUndefined();
    expect(parseDurationMs("-1d")).toBeUndefined();
    expect(parseDurationMs(`${Number.MAX_SAFE_INTEGER}d`)).toBeUndefined();
  });
});
