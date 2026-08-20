import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolvePitlaneHome } from "./paths.js";

describe("resolvePitlaneHome", () => {
  it("defaults to ~/.pitlane when PITLANE_HOME is unset", () => {
    expect(resolvePitlaneHome({})).toBe(join(homedir(), ".pitlane"));
  });

  it("uses PITLANE_HOME when set", () => {
    expect(resolvePitlaneHome({ PITLANE_HOME: "/tmp/custom-home" })).toBe("/tmp/custom-home");
  });
});
