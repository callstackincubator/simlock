import { describe, expect, it } from "vitest";

import { compareVersions, parseOsConstraint, satisfies } from "./os-range.js";

function parsed(text: string) {
  const result = parseOsConstraint(text);
  if (!result.ok) throw new Error(`expected ${text} to parse: ${result.message}`);
  return result.constraint;
}

describe("parseOsConstraint", () => {
  it.each([
    ["18.40"],
    [">=18.4.2 <19.10"],
    ["18.4 - 26.10.1"],
    ["18.4"],
    [">=18"],
    [">18"],
    ["<=26"],
    ["<26"],
    [">=18 <26"],
    ["18 - 26"],
  ])("accepts %s", (text) => {
    expect(parseOsConstraint(text).ok).toBe(true);
  });

  it.each([
    ["^18"],
    ["~18"],
    ["18.x"],
    ["*"],
    [">=18 || <17"],
    [">=18  <26"],
    [""],
    [">=x18"],
    [">=18x"],
    [">= 18"],
    ["x18 - 26"],
    ["18x - 26"],
    ["18 - x26"],
    ["18 - 26x"],
    ["18 - 26 - 30"],
    ["18 -  26"],
    [">=18 - 26"],
  ])("refuses %j with a message naming the accepted forms", (text) => {
    const result = parseOsConstraint(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(">=");
      expect(result.message).toContain("18 - 26");
      expect(result.message).toContain("exact version");
    }
  });
});

describe("a string that is not range-like", () => {
  it.each([["Baklava"], ["34-ext12"], ["26.5-beta"], ["x18"], ["18x"], [" 18"], ["18 "]])(
    "is a bare version and stays exact: %j",
    (text) => {
      expect(parsed(text)).toEqual({ kind: "exact", version: text });
    },
  );

  it("satisfies no range when the version is not dotted integers", () => {
    expect(satisfies("Baklava", parsed(">=18"))).toBe(false);
    expect(satisfies("34-ext12", parsed("<=40"))).toBe(false);
    expect(satisfies("Baklava", parsed("Baklava"))).toBe(true);
  });
});

describe("parseOsConstraint structure", () => {
  it("keeps the text as typed and one bound per comparator", () => {
    expect(parsed(">=18 <26")).toEqual({
      bounds: [{ from: [18] }, { before: [26] }],
      kind: "range",
      text: ">=18 <26",
    });
    expect(parsed("18 - 26")).toEqual({
      bounds: [{ from: [18] }, { before: [27] }],
      kind: "range",
      text: "18 - 26",
    });
  });
});

describe("satisfies", () => {
  it.each([
    [">=18", "18.0", true],
    [">=18", "18.4", true],
    [">=18", "17.5", false],
    ["<=26", "26.5", true],
    ["<=26", "27.0", false],
    [">26", "26.5", false],
    [">26", "27.0", true],
    ["<18", "18.0", false],
    ["<18", "17.9", true],
    ["18 - 26", "18.0", true],
    ["18 - 26", "26.5", true],
    ["18 - 26", "27.0", false],
    [">=18 <26", "26.0", false],
    [">=18 <26", "25.9", true],
    [">18.4", "18.4", false],
    [">18.4", "18.5", true],
  ])("reads %s against %s as %s, as node-semver does", (text, version, expected) => {
    expect(satisfies(version, parsed(text))).toBe(expected);
  });

  it("reads a bare version as exact: 18 does not satisfy a device on 18.4", () => {
    expect(satisfies("18.4", parsed("18"))).toBe(false);
    expect(satisfies("18", parsed("18"))).toBe(true);
    expect(satisfies("18.4", parsed("18.4"))).toBe(true);
  });
});

describe("compareVersions", () => {
  it("orders 9.3 before 18.4 before 26.5, and 34 before 35", () => {
    expect(compareVersions("9.3", "18.4")).toBeLessThan(0);
    expect(compareVersions("18.4", "26.5")).toBeLessThan(0);
    expect(compareVersions("34", "35")).toBeLessThan(0);
    expect(compareVersions("35", "34")).toBeGreaterThan(0);
    expect(compareVersions("26.5", "26.5")).toBe(0);
  });

  it("reads a missing segment as 0 and compares segments as numbers", () => {
    expect(compareVersions("26", "26.1")).toBeLessThan(0);
    expect(compareVersions("26.0.1", "26")).toBeGreaterThan(0);
    expect(compareVersions("26", "26.0")).toBe(0);
    expect(compareVersions("1.10", "1.9")).toBeGreaterThan(0);
  });
});
