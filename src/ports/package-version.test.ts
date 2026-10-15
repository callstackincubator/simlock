import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readPackageVersion } from "./package-version.js";

describe("readPackageVersion", () => {
  it("returns the version package.json declares", () => {
    const declared = (
      JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
        version: string;
      }
    ).version;

    expect(readPackageVersion()).toBe(declared);
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
