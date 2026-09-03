import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveDaemonSocketPath, resolveSimlockHome, SocketPathTooLongError } from "./paths.js";

describe("resolveDaemonSocketPath", () => {
  it("places the socket under the data directory", () => {
    expect(resolveDaemonSocketPath("/tmp/simlock-home", "darwin")).toBe(
      "/tmp/simlock-home/daemon.sock",
    );
  });

  it("refuses a path the kernel could never bind, naming SIMLOCK_HOME as the fix", () => {
    const home = `/private/tmp/${"x".repeat(120)}`;

    expect(() => resolveDaemonSocketPath(home, "darwin")).toThrow(SocketPathTooLongError);
    expect(() => resolveDaemonSocketPath(home, "darwin")).toThrow(/SIMLOCK_HOME/);
  });

  it("allows Linux its longer sun_path", () => {
    const home = `/tmp/${"x".repeat(88)}`;

    expect(() => resolveDaemonSocketPath(home, "darwin")).toThrow(SocketPathTooLongError);
    expect(resolveDaemonSocketPath(home, "linux")).toBe(`${home}/daemon.sock`);
  });
});

describe("resolveSimlockHome", () => {
  it("defaults to ~/.simlock when SIMLOCK_HOME is unset", () => {
    expect(resolveSimlockHome({})).toBe(join(homedir(), ".simlock"));
  });

  it("uses SIMLOCK_HOME when set", () => {
    expect(resolveSimlockHome({ SIMLOCK_HOME: "/tmp/custom-home" })).toBe("/tmp/custom-home");
  });

  it("makes a relative SIMLOCK_HOME absolute, since device roots derived from it must be", () => {
    expect(resolveSimlockHome({ SIMLOCK_HOME: "custom-home" })).toBe(
      join(process.cwd(), "custom-home"),
    );
  });

  it("normalises a SIMLOCK_HOME that is absolute but not canonical", () => {
    expect(resolveSimlockHome({ SIMLOCK_HOME: "/tmp/custom-home/../other-home" })).toBe(
      "/tmp/other-home",
    );
  });
});
