import { describe, expect, it } from "vitest";
import { FakeDaemonLauncher, MemoryFilesystem } from "../ports/index.js";
import { SimlockError } from "../contract/index.js";
import type { LeaseGrant, StatusGetOutput } from "../simlock-client/client.js";
import { runCli } from "./index.js";
import { fakeClient, outputCapture, realCliEnvironmentPorts } from "./test-index.js";

describe("CLI: device add and device remove (ADR 0022 §2)", () => {
  async function runDevice(argv: string[]) {
    const output = outputCapture();
    let connected = false;
    const code = await runCli(
      argv,
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient();
        },
      }),
    );
    return { code, connected, stderr: output.stderr, stdout: output.stdout };
  }

  it.each([
    ["an unknown subcommand", ["device", "enroll", "X"]],
    ["two IDs", ["device", "add", "--platform", "ios", "A", "B"]],
    ["--yes, which remove does not take", ["device", "remove", "--yes", "X"]],
    ["no --platform", ["device", "add", "X"]],
  ])("exits 2 with USAGE and contacts nobody for %s", async (_case, argv) => {
    const result = await runDevice(argv);

    expect(result.code).toBe(2);
    expect(result.connected).toBe(false);
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "USAGE", message: expect.any(String) },
    });
  });

  it("prints one line for an enrollment, naming the platform's OS, and the JSON with --json", async () => {
    const line = await runDevice(["device", "add", "--platform", "ios", "UDID-1"]);
    const json = await runDevice(["device", "add", "--platform", "android", "SER-1", "--json"]);

    expect(line.stdout).toBe(
      "Enrolled iPhone 15 Pro (iOS 18.4) as UDID-1, 2 user apps recorded.\n",
    );
    expect(JSON.parse(json.stdout)).toMatchObject({ driverDeviceId: "SER-1", platform: "android" });
  });

  it.each([
    ["device", ["device"]],
    ["device --help", ["device", "--help"]],
    ["device -h", ["device", "-h"]],
    ["device add --help", ["device", "add", "--help"]],
    ["device remove -h", ["device", "remove", "-h"]],
  ])("prints the usage and contacts nobody for %s", async (_case, argv) => {
    const result = await runDevice(argv);

    expect(result.code).toBe(0);
    expect(result.connected).toBe(false);
    expect(result.stdout).toBe(
      "Usage: simlock device add --platform <ios|android> <id> [--json]\n" +
        "       simlock device remove <id> [--json]\n",
    );
  });

  it("says what is wrong with a usage error, and refuses --platform on remove", async () => {
    const messages = async (argv: string[]) => {
      const result = await runDevice(argv);
      expect(result.code).toBe(2);
      return (JSON.parse(result.stderr) as { error: { message: string } }).error.message;
    };

    expect(await messages(["device", "enroll", "X"])).toContain("Unknown device command: enroll");
    expect(await messages(["device", "add", "--platform", "ios"])).toContain(
      "device add takes exactly one <id>",
    );
    expect(await messages(["device", "remove", "A", "B"])).toContain(
      "device remove takes exactly one <id>",
    );
    expect(await messages(["device", "add", "--platform", "windows", "X"])).toContain(
      "device add needs --platform ios or --platform android",
    );
    expect(await messages(["device", "remove", "--platform", "ios", "X"])).toContain(
      "Unknown option '--platform'",
    );
  });

  it("closes the connection after an enrollment and after a removal", async () => {
    const closed: string[] = [];
    for (const argv of [
      ["device", "add", "--platform", "ios", "U"],
      ["device", "remove", "U"],
    ]) {
      const output = outputCapture();
      await runCli(
        argv,
        output.environmentWith({
          connectAdmin: async () => ({
            ...fakeClient(),
            close: () => {
              closed.push(argv[1] ?? "");
              return Promise.resolve();
            },
          }),
        }),
      );
    }

    expect(closed).toEqual(["add", "remove"]);
  });

  it("says again for a re-enrollment, one user app in the singular, and the Android OS name", async () => {
    const output = outputCapture();
    await runCli(
      ["device", "add", "--platform", "android", "SER-1"],
      output.environmentWith({
        connectAdmin: async () => ({
          ...fakeClient(),
          addDevice: () =>
            Promise.resolve({
              appCount: 1,
              class: "tablet" as const,
              driverDeviceId: "SER-1",
              id: "dev_1",
              model: "Pixel Tablet",
              osVersion: "15",
              platform: "android" as const,
              reenrolled: true,
            }),
        }),
      }),
    );

    expect(output.stdout).toBe(
      "Enrolled Pixel Tablet (Android 15) as SER-1 again, 1 user app recorded.\n",
    );
  });

  it("prints the operation's output for remove with --json", async () => {
    const result = await runDevice(["device", "remove", "UDID-1", "--json"]);

    expect(JSON.parse(result.stdout)).toEqual({ driverDeviceId: "UDID-1", id: "UDID-1" });
  });

  it("prints one line for a removal, with no confirmation", async () => {
    const result = await runDevice(["device", "remove", "UDID-1"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "Removed UDID-1. It is no longer enrolled; nothing on the device changed.\n",
    );
  });
});

describe("CLI: component remove (ADR 0010 §8)", () => {
  function removingClient(asked: unknown[]) {
    return fakeClient({
      removeComponent: async (input) => {
        asked.push(input);
        return {
          outcome: input.dryRun === true ? "would-remove" : "removed",
          platform: input.platform,
          sizeBytes: 7_000_000_000,
          version: input.version,
        };
      },
    });
  }

  it("removes with --yes and prints the daemon's answer as one JSON line on stdout", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];

    await expect(
      runCli(
        ["component", "remove", "ios", "26.4", "--yes"],
        output.environmentWith({
          confirm: async () => {
            throw new Error("--yes must not ask");
          },
          connectAdmin: async () => removingClient(asked),
        }),
      ),
    ).resolves.toBe(0);

    expect(asked).toEqual([{ platform: "ios", version: "26.4" }]);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toEqual({
      outcome: "removed",
      platform: "ios",
      sizeBytes: 7_000_000_000,
      version: "26.4",
    });
  });

  it("asks for confirmation without --yes, and removes once it is given", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const questions: string[] = [];

    await expect(
      runCli(
        ["component", "remove", "android", "35"],
        output.environmentWith({
          confirm: async (question) => {
            questions.push(question);
            return true;
          },
          connectAdmin: async () => removingClient(asked),
        }),
      ),
    ).resolves.toBe(0);

    expect(questions).toEqual(["Remove android 35? [y/N] "]);
    expect(asked).toEqual([{ platform: "android", version: "35" }]);
  });

  it.each([
    ["declined", async () => false],
    // why: No terminal to ask on: the CLI's own `confirmTerminal` is not installed, so this is the
    // no-terminal case rather than the default.
    ["unavailable", undefined],
  ] as const)(
    "refuses without --yes when confirmation is %s, and contacts nobody",
    async (_case, confirm) => {
      const output = outputCapture();
      let connected = false;

      await expect(
        runCli(
          ["component", "remove", "ios", "26.4"],
          output.environmentWith({
            ...(confirm === undefined ? { confirm: undefined } : { confirm }),
            connectAdmin: async () => {
              connected = true;
              return fakeClient();
            },
          }),
        ),
      ).resolves.toBe(2);

      expect(connected).toBe(false);
      expect(JSON.parse(output.stderr)).toEqual({
        error: { code: "USAGE", message: expect.stringContaining("--yes") },
      });
    },
  );

  it("does not ask under --dry-run, and asks the daemon for a dry run", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];

    await expect(
      runCli(
        ["component", "remove", "ios", "26.4", "--dry-run"],
        output.environmentWith({
          confirm: async () => {
            throw new Error("--dry-run must not ask");
          },
          connectAdmin: async () => removingClient(asked),
        }),
      ),
    ).resolves.toBe(0);

    expect(asked).toEqual([{ dryRun: true, platform: "ios", version: "26.4" }]);
    expect(JSON.parse(output.stdout)).toMatchObject({ outcome: "would-remove" });
  });

  it.each([
    ["COMPONENT_NOT_OWNED", {}, 12],
    ["COMPONENT_IN_USE", { devices: 1, foreignDevices: 2 }, 12],
    ["COMPONENT_BUSY", {}, 11],
  ] as const)(
    "exits with the table's code when the daemon refuses with %s",
    async (code, details, exit) => {
      const output = outputCapture();
      const client = fakeClient({
        removeComponent: () =>
          Promise.reject(new SimlockError(code, "domain", "refused", details as never)),
      });

      await expect(
        runCli(
          ["component", "remove", "ios", "26.4", "--yes"],
          output.environmentWith({ connectAdmin: async () => client }),
        ),
      ).resolves.toBe(exit);
      expect(output.stdout).toBe("");
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
        error: { code },
      });
    },
  );

  it.each([
    ["no version", ["component", "remove", "ios"]],
    ["an unknown platform", ["component", "remove", "tvos", "1.0", "--yes"]],
    ["an extra argument", ["component", "remove", "ios", "26.4", "extra", "--yes"]],
  ])("exits 2 with USAGE for %s, without asking the daemon", async (_label, argv) => {
    const output = outputCapture();
    let connected = false;

    await expect(
      runCli(
        argv,
        output.environmentWith({
          connectAdmin: async () => {
            connected = true;
            return fakeClient();
          },
        }),
      ),
    ).resolves.toBe(2);
    expect(connected).toBe(false);
  });
});

describe("CLI: config set validates with the real config loader (ADR 0003 §11, B9)", () => {
  it.each([
    ["an unknown key", "capacty.limits.ios.maxDevices", "2"],
    ["a key missing the Ms suffix", "lease.defaultTtl", "60000"],
  ])(
    "rejects %s instead of silently dropping it or validating clean",
    async (_name, key, value) => {
      const output = outputCapture(realCliEnvironmentPorts());
      let wrote = false;
      const exitCode = await runCli(
        ["config", "set", key, value],
        output.environmentWith({
          readConfigFile: async () => ({}),
          writeConfigFile: async () => {
            wrote = true;
          },
        }),
      );
      expect(exitCode).toBe(2);
      expect(wrote).toBe(false);
      expect(JSON.parse(output.stderr).error.code).toBe("USAGE");
    },
  );

  it.each([
    ["ios.simulator.audio", "false", "loud"],
    ["android.emulator.headless", "true", "yes"],
  ])(
    "writes a good value of %s, a key its driver declares, and refuses a bad one naming the key",
    async (key, good, bad) => {
      const run = async (value: string) => {
        const output = outputCapture(realCliEnvironmentPorts());
        let wrote = false;
        const exitCode = await runCli(
          ["config", "set", key, value],
          output.environmentWith({
            readConfigFile: async () => ({}),
            writeConfigFile: async () => {
              wrote = true;
            },
          }),
        );
        return { exitCode, stderr: output.stderr, wrote };
      };

      const accepted = await run(good);
      const refused = await run(bad);

      expect([accepted.exitCode, accepted.wrote]).toEqual([0, true]);
      expect([refused.exitCode, refused.wrote]).toEqual([2, false]);
      expect(refused.stderr).toContain(key);
    },
  );

  it("--gateway config set validates against the gateway's rules, not the worker's", async () => {
    const gatewayHome = {
      role: "gateway",
      dataDirectory: "/simlock/gateway",
      gatewayPresent: true,
    } as const;
    const output = outputCapture({ ...realCliEnvironmentPorts(), daemonHome: gatewayHome });
    let wrote = false;
    const exitCode = await runCli(
      ["--gateway", "config", "set", "http.enabled", "false"],
      output.environmentWith({
        readConfigFile: async () => ({}),
        writeConfigFile: async () => {
          wrote = true;
        },
      }),
    );
    expect(exitCode).toBe(2);
    expect(wrote).toBe(false);
    expect(output.stderr).toContain("http.enabled");
  });

  it("--gateway daemon start refuses a config.json that fails gateway validation with exit 2 and USAGE, before any launch", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock/gateway");
    await filesystem.writeFileAtomic(
      "/simlock/gateway/config.json",
      JSON.stringify({ http: { enabled: false } }),
    );
    const launcher = new FakeDaemonLauncher();
    const output = outputCapture({
      ...realCliEnvironmentPorts(filesystem),
      daemonHome: { role: "gateway", dataDirectory: "/simlock/gateway", gatewayPresent: true },
      launcher,
    });
    const exitCode = await runCli(
      ["--gateway", "daemon", "start", "--token", "probe"],
      output.environmentWith(),
    );
    expect(exitCode).toBe(2);
    expect(launcher.launches).toBe(0);
    expect(JSON.parse(output.stderr).error).toEqual({
      code: "USAGE",
      message:
        'Invalid config value for "http.enabled": expected true in gateway mode (a gateway is reached over HTTP)',
    });
  });

  describe("a joined worker's own HTTP listener (#811)", () => {
    const joined = { url: "wss://fleet.example", token: "join-secret" };
    const homeWithGateway = {
      role: "worker",
      dataDirectory: "/simlock",
      gatewayPresent: true,
    } as const;

    async function workerFiles(contents: unknown) {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/simlock");
      await filesystem.writeFileAtomic("/simlock/config.json", JSON.stringify(contents));
      return filesystem;
    }

    it.each([
      [
        "enabling HTTP on a joined worker",
        ["http.enabled", "true"],
        { gateway: joined },
        'Invalid config after setting http.enabled: Invalid config value for "http.enabled": expected false when gateway.url is set (joined workers are reached through the gateway)',
      ],
      [
        "adding the gateway object to a standalone worker with HTTP on",
        ["gateway", JSON.stringify(joined)],
        { http: { enabled: true } },
        'Invalid config after setting gateway: Invalid config value for "http.enabled": expected false when gateway.url is set (joined workers are reached through the gateway)',
      ],
    ] as const)(
      "refuses a config set that creates the conflict with exit 2, USAGE and the file untouched: %s",
      async (_name, [key, value], contents, message) => {
        const filesystem = await workerFiles(contents);
        const before = await filesystem.readFile("/simlock/config.json");
        const output = outputCapture({
          ...realCliEnvironmentPorts(filesystem),
          daemonHome: homeWithGateway,
        });
        const exitCode = await runCli(
          ["--local", "config", "set", key, value],
          output.environmentWith(),
        );
        expect(exitCode).toBe(2);
        expect(JSON.parse(output.stderr).error).toMatchObject({ code: "USAGE", message });
        expect(await filesystem.readFile("/simlock/config.json")).toBe(before);
      },
    );

    it("repairs a conflicting file with config set http.enabled false and prints the restart notice", async () => {
      const filesystem = await workerFiles({ gateway: joined, http: { enabled: true } });
      const output = outputCapture({
        ...realCliEnvironmentPorts(filesystem),
        daemonHome: homeWithGateway,
      });
      const exitCode = await runCli(
        ["--local", "config", "set", "http.enabled", "false"],
        output.environmentWith(),
      );
      expect(exitCode).toBe(0);
      expect(output.stdout).toBe(
        "Updated http.enabled in /simlock/config.json; takes effect on daemon restart.\n",
      );
      expect(JSON.parse(await filesystem.readFile("/simlock/config.json"))).toMatchObject({
        http: { enabled: false },
      });
    });

    it("--local daemon start with no daemon listening refuses a joined worker's HTTP conflict with exit 2 and USAGE, before any launch", async () => {
      const filesystem = await workerFiles({
        gateway: { url: "ws://127.0.0.1:1", token: "join-secret" },
        http: { enabled: true },
      });
      // why: a launcher that exits at once, so a start that wrongly launches fails the launches assertion instead of waiting out the test.
      const launcher = new FakeDaemonLauncher(undefined, { exit: { code: 1, signal: null } });
      const output = outputCapture({
        ...realCliEnvironmentPorts(filesystem),
        daemonHome: homeWithGateway,
        launcher,
      });
      const exitCode = await runCli(["--local", "daemon", "start"], output.environmentWith());
      expect(exitCode).toBe(2);
      expect(launcher.launches).toBe(0);
      expect(JSON.parse(output.stderr).error).toEqual({
        code: "USAGE",
        message:
          'Invalid config value for "http.enabled": expected false when gateway.url is set (joined workers are reached through the gateway)',
      });
    });
  });

  it("simlock config set eventLog.retention rejects a non-positive value, naming the key", async () => {
    for (const value of ["0", "1.5"]) {
      const output = outputCapture(realCliEnvironmentPorts());
      let wrote = false;
      const exitCode = await runCli(
        ["config", "set", "eventLog.retention", value],
        output.environmentWith({
          readConfigFile: async () => ({}),
          writeConfigFile: async () => {
            wrote = true;
          },
        }),
      );
      expect(exitCode).toBe(2);
      expect(wrote).toBe(false);
      expect(output.stderr).toContain("eventLog.retention");
    }
  });

  it("still writes a genuinely valid key", async () => {
    const output = outputCapture(realCliEnvironmentPorts());
    let written: Record<string, unknown> | undefined;
    const exitCode = await runCli(
      // why: Comfortably under the default `lease.maxTtlMs` (4h), so this doesn't also trip the
      // TTL pair rule -- this test is only about the key itself validating clean.
      ["config", "set", "lease.defaultTtlMs", "2400000"],
      output.environmentWith({
        readConfigFile: async () => ({}),
        writeConfigFile: async (contents) => {
          written = contents;
        },
      }),
    );
    expect(exitCode).toBe(0);
    expect(written).toEqual({ lease: { defaultTtlMs: 2400000 } });
  });

  it.each(["teamId", "bundleId", "provisioningProfile", "signingIdentity"])(
    "simlock config set capabilities.agent-device.ios.%s stores a non-empty string and refuses an empty string or a number with the usage error",
    async (key) => {
      const path = `capabilities.agent-device.ios.${key}`;
      const set = async (value: string) => {
        const output = outputCapture(realCliEnvironmentPorts());
        let written: Record<string, unknown> | undefined;
        const exitCode = await runCli(
          ["config", "set", path, value],
          output.environmentWith({
            readConfigFile: async () => ({}),
            writeConfigFile: async (contents) => {
              written = contents;
            },
          }),
        );
        return { exitCode, output, written };
      };

      const stored = await set("ABCDE12345");
      expect(stored.exitCode).toBe(0);
      expect(stored.output.stdout).toBe(
        `Updated ${path} in /simlock/config.json; takes effect on daemon restart.\n`,
      );
      expect(stored.written).toEqual({
        capabilities: { "agent-device": { ios: { [key]: "ABCDE12345" } } },
      });
      for (const value of ["", "42"]) {
        const refused = await set(value);
        expect(refused.exitCode).toBe(2);
        expect(JSON.parse(refused.output.stderr)).toEqual({
          error: {
            code: "USAGE",
            message: `Invalid config after setting ${path}: Invalid config value for "${path}": expected a non-empty string`,
          },
        });
        expect(refused.written).toBeUndefined();
      }
    },
  );

  it("does not let a stray file at the scratch validation path change the outcome", async () => {
    // why: Guards against B9's second bug: the validation scratch path must never be able to read a
    // real file, whether one happens to already exist there or not.
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/");
    await filesystem.writeFileAtomic(
      "/config-set-validation.json",
      `${JSON.stringify({ totally: { bogus: true } })}\n`,
    );
    const output = outputCapture(realCliEnvironmentPorts(filesystem));
    let wrote = false;
    const exitCode = await runCli(
      ["config", "set", "downloads.policy", "never"],
      output.environmentWith({
        readConfigFile: async () => ({}),
        writeConfigFile: async () => {
          wrote = true;
        },
      }),
    );
    expect(exitCode).toBe(0);
    expect(wrote).toBe(true);
  });
});

describe("CLI: config set and the retired eventLog.rotateBytes", () => {
  const configSet = async (file: Record<string, unknown>) => {
    const output = outputCapture(realCliEnvironmentPorts());
    let written: Record<string, unknown> | undefined;
    const environment = output.environmentWith({
      readConfigFile: async () => structuredClone(file),
      writeConfigFile: async (contents) => {
        written = contents;
      },
    });
    const exitCode = await runCli(["config", "set", "log.level", "debug"], environment);
    return { configPath: environment.configPath, exitCode, output, written };
  };

  it("simlock config set on a file holding eventLog.rotateBytes writes it without that key and prints the Removed line once; on a file without it, no such line", async () => {
    const holding = await configSet({
      eventLog: { retention: 86_400_000, rotateBytes: 1_048_576 },
      log: { level: "info" },
    });
    const without = await configSet({
      eventLog: { retention: 86_400_000 },
      log: { level: "info" },
    });

    expect(holding.exitCode).toBe(0);
    expect(holding.written).toEqual({
      eventLog: { retention: 86_400_000 },
      log: { level: "debug" },
    });
    expect(holding.output.stderr).toBe(
      `Removed eventLog.rotateBytes from ${holding.configPath}: it is no longer used.\n`,
    );
    expect(holding.output.stdout).toBe(
      `Updated log.level in ${holding.configPath}; takes effect on daemon restart.\n`,
    );
    expect(without.exitCode).toBe(0);
    expect(without.written).toEqual({
      eventLog: { retention: 86_400_000 },
      log: { level: "debug" },
    });
    expect(without.output.stderr).toBe("");
  });
});

describe("CLI: config set and the file mode of config.json (#252)", () => {
  it("writes the config.json holding gateway.token owner-only, whether it creates the file or replaces an owner-only one", async () => {
    // why: Two homes, one per way `config set` comes to write the join token. `MemoryFilesystem`
    // gives a file written without a `mode` Node's default (0644), so the assertion pins what
    // the CLI asks for, independent of the umask of whoever runs the suite.
    const fresh = new MemoryFilesystem();
    const freshExit = await runCli(
      ["config", "set", "gateway", '{"url":"wss://gw.example:4700","token":"slk_fresh"}'],
      outputCapture(realCliEnvironmentPorts(fresh)).environmentWith(),
    );

    const tightened = new MemoryFilesystem();
    await tightened.mkdirp("/simlock");
    await tightened.writeFileAtomic(
      "/simlock/config.json",
      `${JSON.stringify({ gateway: { url: "wss://gw.example:4700" } })}\n`,
      { mode: 0o600 },
    );
    const tightenedExit = await runCli(
      ["config", "set", "gateway.token", "slk_replaced"],
      outputCapture(realCliEnvironmentPorts(tightened)).environmentWith(),
    );

    expect([freshExit, tightenedExit]).toEqual([0, 0]);
    expect([
      JSON.parse(await fresh.readFile("/simlock/config.json")).gateway.token,
      JSON.parse(await tightened.readFile("/simlock/config.json")).gateway.token,
    ]).toEqual(["slk_fresh", "slk_replaced"]);
    expect({
      created: (await fresh.stat("/simlock/config.json")).mode?.toString(8),
      replaced: (await tightened.stat("/simlock/config.json")).mode?.toString(8),
    }).toEqual({ created: "600", replaced: "600" });
  });

  it("makes a config.json that others could read owner-only on the next config set", async () => {
    // why: A file written by hand or by an older simlock: readable by group and others. `config set`
    // must not carry that mode over to the file it writes in its place.
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(
      "/simlock/config.json",
      `${JSON.stringify({ gateway: { url: "wss://gw.example:4700", token: "slk_old" } })}\n`,
      { mode: 0o644 },
    );

    const exit = await runCli(
      ["config", "set", "gateway.label", "build-mac"],
      outputCapture(realCliEnvironmentPorts(filesystem)).environmentWith(),
    );

    expect(exit).toBe(0);
    expect(JSON.parse(await filesystem.readFile("/simlock/config.json")).gateway).toEqual({
      url: "wss://gw.example:4700",
      token: "slk_old",
      label: "build-mac",
    });
    expect((await filesystem.stat("/simlock/config.json")).mode?.toString(8)).toBe("600");
  });
});

describe("CLI: --json shape is the contract, as-is (ADR 0003 §11)", () => {
  it("status --json carries camelCase fields, not expires_at_ms, estimated_boot_ms, queue_position or device_unhealthy", async () => {
    const output = outputCapture();
    await runCli(
      ["status", "--json"],
      output.environmentWith({ connectAdmin: async () => fakeClient() }),
    );
    const text = output.stdout;
    expect(text).not.toMatch(/expires_at_ms|estimated_boot_ms|queue_position|device_unhealthy/);
    const parsed = JSON.parse(text) as StatusGetOutput;
    expect(parsed.queueDepth).toBe(0);
  });

  it("lease output is the contract's LeaseGrant plus the resolved role", async () => {
    const output = outputCapture();
    await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith({ connectAdmin: async () => fakeClient({ role: "admin" }) }),
    );
    const parsed = JSON.parse(output.stdout) as LeaseGrant & { role: string };
    expect(parsed.lease.id).toBe("lse_1");
    expect(parsed.role).toBe("admin");
    expect(output.stdout).not.toMatch(/expires_at_ms|estimated_boot_ms/);
  });
});

describe("CLI: --yes / confirm guards (safety rule 5)", () => {
  it("release --all without --yes and a confirm that declines refuses with exit 2 and releases nothing", async () => {
    const output = outputCapture();
    let released = false;
    await expect(
      runCli(
        ["release", "--all"],
        output.environmentWith({
          confirm: async () => false,
          connectAdmin: async () =>
            fakeClient({
              releaseAllLeases: () => {
                released = true;
                return Promise.resolve({ leaseIds: [] });
              },
            }),
        }),
      ),
    ).resolves.toBe(2);
    expect(released).toBe(false);
  });

  it("release --all --yes bypasses the interactive confirm", async () => {
    const output = outputCapture();
    let released = false;
    await expect(
      runCli(
        ["release", "--all", "--yes"],
        output.environmentWith({
          confirm: async () => false,
          connectAdmin: async () =>
            fakeClient({
              releaseAllLeases: () => {
                released = true;
                return Promise.resolve({ leaseIds: ["lse_1"] });
              },
            }),
        }),
      ),
    ).resolves.toBe(0);
    expect(released).toBe(true);
  });

  it("nuke without confirmation or --yes refuses before connecting", async () => {
    const output = outputCapture();
    let connected = false;
    await expect(
      runCli(
        ["nuke"],
        output.environmentWith({
          confirm: async () => false,
          connectAdmin: async () => {
            connected = true;
            return fakeClient();
          },
        }),
      ),
    ).resolves.toBe(2);
    expect(connected).toBe(false);
  });
});
