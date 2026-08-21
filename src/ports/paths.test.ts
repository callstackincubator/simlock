import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveSimlockHome } from "./paths.js";

describe("resolveSimlockHome", () => {
  it("defaults to ~/.simlock when SIMLOCK_HOME is unset", () => {
    expect(resolveSimlockHome({})).toBe(join(homedir(), ".simlock"));
  });

  it("uses SIMLOCK_HOME when set", () => {
    expect(resolveSimlockHome({ SIMLOCK_HOME: "/tmp/custom-home" })).toBe("/tmp/custom-home");
  });
});
