import { describe, expect, it, vi } from "vitest";
import { MemoryFilesystem } from "../../ports/index.js";
import {
  home,
  stateDir,
  policyPath,
  nodePath,
  packageRoot,
  realCli,
  internalEntry,
  fallbackEntry,
  httpPort,
  token,
  restartCommand,
  arrange,
  run,
  isDaemonEntry,
  versionRun,
  daemonSpawn,
  advanceBy,
  advancing,
  stateOf,
  unavailable,
  running,
  commandsRun,
  daemonSpawns,
} from "./test-agent-device-supervisor.js";

describe("AgentDeviceSupervisor off and starting", () => {
  it("enabled, availability is starting before start() settles", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    expect(stateOf(harness)).toBe("starting");

    harness.begin();
    await advanceBy(harness, 1_000);

    expect(stateOf(harness)).toBe("starting");
    expect(harness.children).toHaveLength(1);
  });
});

describe("AgentDeviceSupervisor finding agent-device", () => {
  const pathLayout = async (filesystem: MemoryFilesystem) => {
    await filesystem.mkdirp("/dir-bin/agent-device");
    await filesystem.mkdirp("/noexec");
    await filesystem.writeFileAtomic("/noexec/agent-device", "not executable");
    filesystem.defineAttributes("/noexec/agent-device", { mode: 0o644 });
    await filesystem.mkdirp("/exec");
    filesystem.defineSymlink("/exec/agent-device", realCli);
    await filesystem.mkdirp("/later");
    await filesystem.writeFileAtomic("/later/agent-device", "later");
    filesystem.defineAttributes("/later/agent-device", { mode: 0o755 });
  };

  it("finds a name in the first PATH entry holding an executable file of that name, skipping an earlier directory, non-executable file and missing entry", async () => {
    const harness = await run({
      baseEnvironment: { PATH: "/missing:/dir-bin:/noexec:/exec:/later" },
      layout: pathLayout,
    });

    expect(commandsRun(harness)[0]).toEqual([nodePath, realCli, "--version"]);
    expect(stateOf(harness)).toBe("running");
  });

  it("uses a command with a slash as given and resolves its real path, with the package root two levels above", async () => {
    const harness = await run({
      command: "/opt/custom/agent-device",
      layout: async (filesystem) => {
        await filesystem.mkdirp("/opt/custom");
        filesystem.defineSymlink("/opt/custom/agent-device", realCli);
      },
    });

    expect(commandsRun(harness)[0]).toEqual([nodePath, realCli, "--version"]);
    expect(daemonSpawns(harness)[0]?.[1]).toBe(internalEntry);
  });

  // why: a pnpm global install puts a shell-script launcher in PNPM_HOME/bin, not a symlink into
  // the package; the launcher names its target on the exec line and in a cmd-shim-target comment.
  const pnpmLauncher = "/opt/pnpm/bin/agent-device";
  const pnpmLayout = async (filesystem: MemoryFilesystem) => {
    await filesystem.mkdirp("/opt/pnpm/bin");
    await filesystem.writeFileAtomic(
      pnpmLauncher,
      [
        "#!/bin/sh",
        'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
        'if [ -x "$basedir/node" ]; then',
        '  exec "$basedir/node"  "$basedir/../../ad/node_modules/agent-device/bin/agent-device.mjs" "$@"',
        "else",
        '  exec node  "$basedir/../../ad/node_modules/agent-device/bin/agent-device.mjs" "$@"',
        "fi",
        `# cmd-shim-target=${realCli}`,
        "",
      ].join("\n"),
    );
    filesystem.defineAttributes(pnpmLauncher, { mode: 0o755 });
  };

  it.each([
    ["found by name on PATH", { baseEnvironment: { PATH: "/opt/pnpm/bin" } }],
    ["configured as the command", { command: pnpmLauncher }],
  ])(
    "follows a pnpm global launcher %s to the agent-device package it runs",
    async (_case, options) => {
      const harness = await run({ ...options, layout: pnpmLayout });

      expect(harness.availability()).toEqual({
        baseUrl: `http://127.0.0.1:${httpPort}`,
        generation: 1,
        leaseMaxTtlMs: 24 * 60 * 60_000,
        platforms: ["ios", "android"],
        state: "running",
        token,
        version: "0.21.40",
      });
      expect(commandsRun(harness)[0]).toEqual([nodePath, realCli, "--version"]);
      expect(daemonSpawns(harness)[0]?.[1]).toBe(internalEntry);
    },
  );

  it("reports a command found nowhere as not-found with the PATH message, and runs nothing", async () => {
    const harness = await run({
      baseEnvironment: { PATH: "/nowhere" },
      expectations: [],
    });

    expect(unavailable(harness)).toMatchObject({
      message: 'agent-device not found: "agent-device" is not on PATH',
      reason: "not-found",
    });
    expect(unavailable(harness).remedy).toContain("capabilities.agent-device.command");
    expect(unavailable(harness).remedy).toContain("0.21.40 or later");
    for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
    expect(harness.runner.calls).toEqual([]);
  });

  it.each([
    ["a missing path", async () => undefined],
    [
      "a directory",
      async (filesystem: MemoryFilesystem) => {
        await filesystem.mkdirp("/opt/x/agent-device");
      },
    ],
    [
      "a file with no execute bit",
      async (filesystem: MemoryFilesystem) => {
        await filesystem.mkdirp("/opt/x");
        await filesystem.writeFileAtomic("/opt/x/agent-device", "plain");
        filesystem.defineAttributes("/opt/x/agent-device", { mode: 0o644 });
      },
    ],
  ])(
    "reports a command with a slash that is %s as not-found and runs nothing",
    async (_case, layout) => {
      const harness = await run({ command: "/opt/x/agent-device", expectations: [], layout });

      expect(unavailable(harness)).toMatchObject({
        message: "agent-device not found: /opt/x/agent-device is not an executable file",
        reason: "not-found",
      });
      expect(harness.runner.calls).toEqual([]);
    },
  );
});

describe("AgentDeviceSupervisor checking the install", () => {
  it.each([
    [
      "a missing package.json",
      async (filesystem: MemoryFilesystem) => filesystem.rm(`${packageRoot}/package.json`),
      "package.json",
    ],
    [
      "a package.json naming another package",
      async (filesystem: MemoryFilesystem) =>
        filesystem.writeFileAtomic(`${packageRoot}/package.json`, '{"name":"other-tool"}'),
      "package.json",
    ],
    [
      "neither daemon entry",
      async (filesystem: MemoryFilesystem) => filesystem.rm(internalEntry),
      "daemon",
    ],
  ])("treats %s as not-agent-device and spawns nothing", async (_case, layout, word) => {
    const harness = await run({ expectations: [versionRun()], layout });

    expect(unavailable(harness).reason).toBe("not-agent-device");
    expect(unavailable(harness).message).toContain(word);
    expect(unavailable(harness).remedy).toContain("capabilities.agent-device.command");
    for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
    expect(daemonSpawns(harness)).toEqual([]);
  });

  it("treats a --version that exits non-zero, prints nothing, or runs past 10 s as three distinct not-agent-device answers, and spawns nothing", async () => {
    const messages: string[] = [];
    for (const expectation of [
      versionRun("", { result: { code: 3, stderr: "boom", stdout: "" } }),
      versionRun(""),
      versionRun("", { hangs: true }),
    ]) {
      const harness = await arrange({ expectations: [expectation] });
      await advancing(harness, harness.begin());

      expect(unavailable(harness).reason).toBe("not-agent-device");
      expect(daemonSpawns(harness)).toEqual([]);
      messages.push(unavailable(harness).message);
      if (expectation.hangs === true) {
        expect(unavailable(harness).message).toContain("timed out");
        expect(harness.clock.now()).toBeGreaterThanOrEqual(1_000_000 + 10_000);
      }
    }
    expect(messages[0]).toContain("3");
    expect(new Set(messages).size).toBe(3);
  });

  it("reports 0.20.3 as wrong-version with the found-and-need message", async () => {
    const harness = await run({ expectations: [versionRun("0.20.3\n")] });

    expect(unavailable(harness)).toMatchObject({
      message: "found 0.20.3, need 0.21.40 or later",
      reason: "wrong-version",
    });
    expect(unavailable(harness).remedy).toContain("0.21.40 or later");
    for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
  });

  it.each(["abc", "0.21", "0.9.100", "0.21.39", "0.21.40-nightly.20261119.1"])(
    "reports %s as wrong-version",
    async (printed) => {
      const harness = await run({ expectations: [versionRun(`${printed}\n`)] });

      expect(unavailable(harness).reason).toBe("wrong-version");
      expect(daemonSpawns(harness)).toEqual([]);
    },
  );

  it.each(["0.21.40", "0.21.40+build.7", "0.21.41-dev", "0.22.0", "0.100.0", "1.0.0+build.7"])(
    "starts a daemon for the version %s",
    async (printed) => {
      const harness = await run({ expectations: [versionRun(`${printed}\n`), daemonSpawn()] });

      expect(daemonSpawns(harness)).toHaveLength(1);
      expect(stateOf(harness)).toBe("running");
    },
  );

  it("reports Node 22.3.0 as wrong-version naming both Node versions, and starts on Node 22.12.0", async () => {
    const old = await run({ expectations: [versionRun()], nodeVersion: "22.3.0" });

    expect(unavailable(old)).toMatchObject({
      message: "agent-device needs Node 22.12.0 or later, simlock runs on Node 22.3.0",
      reason: "wrong-version",
    });
    expect(unavailable(old).remedy).toContain("Node 22.12.0 or later");
    for (const phrase of restartCommand) expect(unavailable(old).remedy).toContain(phrase);
    expect(daemonSpawns(old)).toEqual([]);

    const exact = await run({ nodeVersion: "22.12.0" });
    expect(stateOf(exact)).toBe("running");
  });
});

describe("AgentDeviceSupervisor spawning", () => {
  it("runs --version then spawns the internal daemon entry with the home marker, stdio ignored and the handle unreffed", async () => {
    const harness = await run();

    expect(commandsRun(harness)).toEqual([
      [nodePath, realCli, "--version"],
      [nodePath, internalEntry, `--simlock-home=${home}`],
    ]);
    expect(harness.runner.calls[1]?.options.stdio).toBe("ignore");
    expect(harness.runner.handles[1]?.unreffed).toBe(true);
  });

  it("spawns dist/src/daemon.js when the internal entry does not exist", async () => {
    const harness = await run({
      expectations: [versionRun(), daemonSpawn(fallbackEntry)],
      layout: async (filesystem) => {
        await filesystem.rm(internalEntry);
        await filesystem.writeFileAtomic(fallbackEntry, "");
      },
    });

    expect(daemonSpawns(harness)).toEqual([[nodePath, fallbackEntry, `--simlock-home=${home}`]]);
  });

  it("gives the child no AGENT_DEVICE_ key from the base environment, keeps PATH and HOME, and sets the state, claims, mode, idle, policy and lease keys", async () => {
    const harness = await run({
      baseEnvironment: {
        AGENT_DEVICE_CLAIMS_DIR: "/operator/claims",
        AGENT_DEVICE_SESSION: "operator-session",
        AGENT_DEVICE_STATE_DIR: "/operator/state",
        HOME: "/home/operator",
        PATH: "/usr/local/bin:/usr/bin",
      },
    });

    expect(harness.runner.calls[1]?.options.env).toEqual({
      AGENT_DEVICE_CLAIMS_DIR: `${stateDir}/device-claims`,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_DAEMON_POLICY: policyPath,
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      AGENT_DEVICE_LEASE_MAX_TTL_MS: String(24 * 60 * 60_000),
      AGENT_DEVICE_STATE_DIR: stateDir,
      HOME: "/home/operator",
      PATH: "/usr/local/bin:/usr/bin",
    });
  });

  it.each([
    [4 * 60 * 60_000, 24 * 60 * 60_000],
    [12 * 60 * 60_000, 24 * 60 * 60_000],
    [20 * 60 * 60_000, 40 * 60 * 60_000],
  ])(
    "sets the lease ceiling for lease.maxTtlMs %i to %i and reports the same in running",
    async (maxTtlMs, ceiling) => {
      const harness = await run({ leaseMaxTtlMs: maxTtlMs });

      expect(harness.runner.calls[1]?.options.env?.["AGENT_DEVICE_LEASE_MAX_TTL_MS"]).toBe(
        String(ceiling),
      );
      expect(running(harness).leaseMaxTtlMs).toBe(ceiling);
    },
  );

  it("passes every key and value of the drivers' environment unchanged, copies the iOS device set to the agent-device key, and sets none when the lease environment has none", async () => {
    const harness = await run({
      driverEnvironment: {
        ANDROID_ADB_SERVER_PORT: "5199",
        CUSTOM_DRIVER_KEY: "custom value",
        SIMLOCK_IOS_DEVICE_SET: "/devices/ios",
      },
    });
    const env = harness.runner.calls[1]?.options.env ?? {};

    expect(env).toMatchObject({
      AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET: "/devices/ios",
      ANDROID_ADB_SERVER_PORT: "5199",
      CUSTOM_DRIVER_KEY: "custom value",
      SIMLOCK_IOS_DEVICE_SET: "/devices/ios",
    });
    expect(env["AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST"]).toBeUndefined();
    expect(running(harness).platforms).toEqual(["ios", "android"]);

    const xcodeSet = await run({ driverEnvironment: { ANDROID_ADB_SERVER_PORT: "5199" } });
    expect(running(xcodeSet).platforms).toEqual(["ios", "android"]);
    expect(xcodeSet.runner.calls[1]?.options.env).not.toHaveProperty(
      "AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET",
    );
  });

  it("points the daemon at an empty private directory when the iOS driver is off", async () => {
    const harness = await run({
      driverEnvironment: { ANDROID_ADB_SERVER_PORT: "5199" },
      platforms: ["android"],
    });

    expect(harness.runner.calls[1]?.options.env?.["AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET"]).toBe(
      `${stateDir}/no-ios-devices`,
    );
    await expect(harness.filesystem.readdir(`${stateDir}/no-ios-devices`)).resolves.toEqual([]);
    await expect(harness.filesystem.lstat(`${stateDir}/no-ios-devices`)).resolves.toMatchObject({
      kind: "directory",
      mode: 0o700,
    });
    expect(running(harness).platforms).toEqual(["android"]);
  });

  it("allows only a serial no device has when the Android driver is off", async () => {
    const harness = await run({
      driverEnvironment: { SIMLOCK_IOS_DEVICE_SET: "/devices/ios" },
      platforms: ["ios"],
    });

    expect(harness.runner.calls[1]?.options.env?.["AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST"]).toBe(
      "simlock-no-android-device",
    );
    expect(running(harness).platforms).toEqual(["ios"]);
  });

  it("writes exactly the policy file before the spawn", async () => {
    const harness = await arrange();
    const atSpawn: string[] = [];
    const arranged = vi.mocked(harness.runner.spawn).getMockImplementation();
    if (arranged === undefined) throw new Error("arrange installs the spawn spy");
    vi.mocked(harness.runner.spawn).mockImplementation((command, args, options) => {
      if (isDaemonEntry(args[0])) {
        void harness.filesystem.readFile(policyPath).then((contents) => atSpawn.push(contents));
      }
      return arranged(command, args, options);
    });

    await advancing(harness, harness.begin());

    const expected =
      '{"version":1,"commands":{"deny":["boot","shutdown"]},"capabilities":{"deny":["device-shutdown"]}}';
    expect(atSpawn).toEqual([expected]);
    await expect(harness.filesystem.readFile(policyPath)).resolves.toBe(expected);
  });
});
