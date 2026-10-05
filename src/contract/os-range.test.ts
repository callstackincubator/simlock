import { describe, expect, it } from "vitest";

import { compareVersions, parseOsConstraint, satisfies } from "./os-range.js";

function parsed(text: string) {
  const result = parseOsConstraint(text);
  if (!result.ok) throw new Error(`expected ${text} to parse: ${result.message}`);
  return result.constraint;
}

describe("parseOsConstraint", () => {
  it.each([["18.4"], [">=18"], [">18"], ["<=26"], ["<26"], [">=18 <26"], ["18 - 26"]])(
    "accepts %s",
    (text) => {
      expect(parseOsConstraint(text).ok).toBe(true);
    },
  );

  it.each([["^18"], ["~18"], ["18.x"], ["*"], [">=18 || <17"], [">=18  <26"], [""]])(
    "refuses %j with a message naming the accepted forms",
    (text) => {
      const result = parseOsConstraint(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain(">=");
        expect(result.message).toContain("18 - 26");
        expect(result.message).toContain("exact version");
      }
    },
  );
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
});
