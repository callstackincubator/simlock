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

  /**
   * The boundary itself, because the three cases above pass against a limit of 104 or 108 as
   * readily as against the correct 103/107. `sun_path` holds the terminating NUL, so the
   * usable length is one less than the struct field -- an off-by-one here is a socket the
   * kernel refuses with `EINVAL` at bind time, which is the failure this check exists to
   * pre-empt.
   */
  it.each([
    ["darwin", 103],
    ["linux", 107],
  ] as const)("accepts exactly %s's limit and refuses one byte more", (platform, limit) => {
    const suffix = "/daemon.sock";
    const atLimit = `/${"x".repeat(limit - 1 - suffix.length)}`;
    expect(Buffer.byteLength(`${atLimit}${suffix}`)).toBe(limit);

    expect(resolveDaemonSocketPath(atLimit, platform)).toBe(`${atLimit}${suffix}`);
    expect(() => resolveDaemonSocketPath(`${atLimit}x`, platform)).toThrow(SocketPathTooLongError);
  });

  /** A multi-byte home is measured in bytes, not UTF-16 code units -- `sun_path` is bytes. */
  it("measures the limit in bytes, not characters", () => {
    // 60 two-byte characters plus "/daemon.sock" is 132 bytes but only 72 code units, so a
    // length-based check would wave it through on both platforms.
    const home = `/${"é".repeat(60)}`;
    expect(home.length).toBeLessThan(103);

    expect(() => resolveDaemonSocketPath(home, "darwin")).toThrow(SocketPathTooLongError);
    expect(() => resolveDaemonSocketPath(home, "linux")).toThrow(SocketPathTooLongError);
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
