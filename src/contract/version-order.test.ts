import { describe, expect, it } from "vitest";

import { isNewerVersion } from "./version-order.js";

// why: pure logic with many cases, and every update surface shares this one rule.
describe("isNewerVersion", () => {
  it("orders versions by semver: numbers first, a release beats its prereleases, prerelease parts compare numbers as numbers and a number sorts below a word, equal is not newer", () => {
    const cases: readonly [candidate: string, running: string, newer: boolean][] = [
      ["0.10.0", "0.9.0", true],
      ["0.9.0", "0.10.0", false],
      ["1.0.0", "0.99.99", true],
      ["0.4.0", "0.4.0-rc.2", true],
      ["0.4.0-rc.2", "0.4.0", false],
      ["0.4.0-rc.10", "0.4.0-rc.2", true],
      ["0.4.0-rc.2", "0.4.0-rc.10", false],
      ["0.4.0-rc.2.1", "0.4.0-rc.2", true],
      ["0.4.0-rc.2", "0.4.0-beta.9", true],
      ["0.4.0-rc.1", "0.4.0-1", true],
      ["0.4.0-1", "0.4.0-rc.1", false],
      ["0.4.0-rc.9", "0.4.0-rc.10", false],
      ["0.4.0-rc.1", "0.4.0-rc.1", false],
      ["0.4.0", "0.4.0", false],
    ];
    for (const [candidate, running, newer] of cases) {
      expect({ candidate, running, newer: isNewerVersion(candidate, running) }).toEqual({
        candidate,
        running,
        newer,
      });
    }
  });
});
