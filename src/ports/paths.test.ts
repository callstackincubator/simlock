import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MemoryFilesystem } from "./filesystem.js";
import {
  resolveDaemonHome,
  resolveDaemonSocketPath,
  resolveSimlockHome,
  SocketPathTooLongError,
} from "./paths.js";

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

describe("resolveDaemonHome", () => {
  const root = "/home/me/.simlock";

  it.each([
    ["gateway", "gateway", `${root}/gateway`],
    [undefined, "worker", root],
  ] as const)(
    "sends the gateway flag to <root>/gateway and everything else to <root> (flag %s)",
    async (flag, role, dataDirectory) => {
      const home = await resolveDaemonHome({ root, flag, filesystem: new MemoryFilesystem() });

      expect(home).toMatchObject({ role, dataDirectory });
    },
  );

  async function present(files: readonly string[], extraDirectories: readonly string[] = []) {
    const filesystem = new MemoryFilesystem();
    for (const directory of extraDirectories) await filesystem.mkdirp(directory);
    for (const file of files) {
      await filesystem.mkdirp(join(file, ".."));
      await filesystem.writeFileAtomic(file, "{}");
    }
    return (await resolveDaemonHome({ root, flag: "gateway", filesystem })).gatewayPresent;
  }

  it.each([
    ["neither file", [], false],
    ["instance.json only", [`${root}/gateway/instance.json`], true],
    ["config.json only", [`${root}/gateway/config.json`], true],
    ["both files", [`${root}/gateway/instance.json`, `${root}/gateway/config.json`], true],
  ] as const)(
    "reports a gateway present when gateway/instance.json or gateway/config.json exists (%s)",
    async (_name, files, expected) => {
      expect(await present(files)).toBe(expected);
    },
  );

  it("does not report a gateway present for an empty gateway folder", async () => {
    expect(await present([], [`${root}/gateway`])).toBe(false);
  });

  it("counts a path under a file (ENOTDIR) as absent and rethrows any other exists error", async () => {
    const failing = (code: string) => ({
      exists: () => Promise.reject(Object.assign(new Error(code), { code })),
    });

    await expect(
      resolveDaemonHome({ root, flag: "gateway", filesystem: failing("ENOTDIR") }),
    ).resolves.toMatchObject({ gatewayPresent: false });
    await expect(
      resolveDaemonHome({ root, flag: "gateway", filesystem: failing("EACCES") }),
    ).rejects.toThrow("EACCES");
  });

  async function chosen(
    files: readonly string[],
    flag: "gateway" | "local" | undefined,
    extraDirectories: readonly string[] = [],
  ) {
    const filesystem = new MemoryFilesystem();
    for (const directory of extraDirectories) await filesystem.mkdirp(directory);
    for (const file of files) {
      await filesystem.mkdirp(join(file, ".."));
      await filesystem.writeFileAtomic(file, "{}");
    }
    return (await resolveDaemonHome({ root, flag, filesystem })).role;
  }

  it.each([
    ["neither", [], [], "worker"],
    ["worker instance only", [`${root}/instance.json`], [], "worker"],
    ["gateway config only", [`${root}/gateway/config.json`], [], "gateway"],
    ["gateway instance only", [`${root}/gateway/instance.json`], [], "gateway"],
    [
      "worker instance and gateway config",
      [`${root}/instance.json`, `${root}/gateway/config.json`],
      [],
      "worker",
    ],
    [
      "root config and gateway config, no root instance",
      [`${root}/config.json`, `${root}/gateway/config.json`],
      [],
      "gateway",
    ],
    ["empty gateway folder", [], [`${root}/gateway`], "worker"],
  ] as const)(
    "resolveDaemonHome without a flag picks the gateway only when a gateway is present and instance.json does not exist (%s)",
    async (_name, files, directories, role) => {
      expect(await chosen(files, undefined, directories)).toBe(role);
    },
  );

  it.each([
    ["local", "worker"],
    ["gateway", "gateway"],
  ] as const)(
    "resolveDaemonHome with --local picks the worker and with --gateway the gateway, whatever the folders hold (%s)",
    async (flag, role) => {
      const gatewayOnly = [`${root}/gateway/config.json`];
      const both = [`${root}/gateway/config.json`, `${root}/instance.json`];

      expect(await chosen(gatewayOnly, flag)).toBe(role);
      expect(await chosen(both, flag)).toBe(role);
      expect(await chosen([], flag)).toBe(role);
    },
  );

  it("resolveDaemonHome rethrows an error reading instance.json and chooses nothing", async () => {
    const inner = new MemoryFilesystem();
    await inner.mkdirp(`${root}/gateway`);
    await inner.writeFileAtomic(`${root}/gateway/config.json`, "{}");
    const filesystem = {
      exists: (path: string) =>
        path === `${root}/instance.json`
          ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
          : inner.exists(path),
    };

    await expect(resolveDaemonHome({ root, flag: undefined, filesystem })).rejects.toThrow(
      "EACCES",
    );
  });
});
