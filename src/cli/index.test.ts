import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryFilesystem } from "../ports/index.js";
import { SimlockError } from "../contract/index.js";
import type { DoctorReport, LeaseGrant, SimlockAdminClient } from "../simlock-client/client.js";
import type { ToolOutcome } from "../instructions/index.js";
import { runCli, type CliEnvironment } from "./index.js";
import { readLogFile } from "./log-file.js";
import {
  PACKAGE_VERSION,
  detachedGrant,
  fakeClient,
  outputCapture,
  settle,
  simlockError,
} from "./test-index.js";

describe("readLogFile", () => {
  it("returns just the current log when there is no rotated generation", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic("/simlock/daemon.log", "current\n");

    await expect(readLogFile(filesystem, "/simlock/daemon.log")).resolves.toBe("current\n");
  });

  it("prepends the rotated generation so a pre-rotation crash is not lost", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic("/simlock/daemon.log.1", "rotated\n");
    await filesystem.writeFileAtomic("/simlock/daemon.log", "current\n");

    await expect(readLogFile(filesystem, "/simlock/daemon.log")).resolves.toBe(
      "rotated\ncurrent\n",
    );
  });

  it("propagates the read failure when neither file exists", async () => {
    const filesystem = new MemoryFilesystem();

    await expect(readLogFile(filesystem, "/simlock/daemon.log")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("CLI: exit codes", () => {
  it.each([
    ["QUEUE_TIMEOUT", 10],
    ["DOWNLOAD_TIMEOUT", 10],
    ["NO_CAPACITY", 11],
    ["RUNTIME_MISSING", 12],
    ["UNKNOWN_MODEL", 12],
    ["INSUFFICIENT_DISK_SPACE", 12],
    ["LICENSE_NOT_ACCEPTED", 12],
    ["BAD_REQUEST", 2],
    ["REQUESTER_ALREADY_LEASED", 13],
    ["UNKNOWN_LEASE", 1],
  ] as const)("maps %s to exit %d, from ERROR_TABLE not a second map", async (code, expected) => {
    const error = simlockError(code);
    const output = outputCapture();
    await expect(
      runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.reject(error) }),
        }),
      ),
    ).resolves.toBe(expected);
  });

  it("writes a single structured JSON error line to stderr for a daemon error", async () => {
    const output = outputCapture();
    await expect(
      runCli(
        ["status"],
        output.environmentWith({
          readAdminTokenFile: async () => "a-token",
          connectAdmin: async (resolveCredential) => {
            await resolveCredential();
            return fakeClient({ getStatus: () => Promise.reject(simlockError("NO_CAPACITY")) });
          },
        }),
      ),
    ).resolves.toBe(11);
    expect(output.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stderr.trim())).toEqual({
      error: { code: "NO_CAPACITY", message: expect.any(String) },
    });
  });

  const NO_GATEWAY_MESSAGE =
    "No gateway on this machine. Start one with: simlock --gateway daemon start";

  it("a CLI error with code GATEWAY_NOT_PRESENT prints that code and exits 2", async () => {
    const output = outputCapture();
    let connected = false;

    await expect(
      runCli(
        ["--gateway", "status"],
        output.environmentWith({
          connectAdmin: async () => {
            connected = true;
            return fakeClient();
          },
        }),
      ),
    ).resolves.toBe(2);
    expect(JSON.parse(output.stderr)).toEqual({
      error: { code: "GATEWAY_NOT_PRESENT", message: NO_GATEWAY_MESSAGE },
    });
    expect(connected).toBe(false);
  });

  it("simlock --version and -v print the package version and exit 0 with no environment built", async () => {
    for (const argv of [["--version"], ["-v"], ["--gateway", "--version"]]) {
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
      ).resolves.toBe(0);
      expect(output.stdout, argv.join(" ")).toBe(`${PACKAGE_VERSION}\n`);
      expect(output.stderr, argv.join(" ")).toBe("");
      expect(connected, argv.join(" ")).toBe(false);
    }
  });

  it("simlock --help lists --gateway", async () => {
    const output = outputCapture();

    await expect(runCli(["--help"], output.environmentWith())).resolves.toBe(0);
    expect(output.stdout).toContain(
      "Pass --gateway anywhere on the command line to reach this machine's gateway in place of its worker.",
    );
    const gatewayOutput = outputCapture();
    await runCli(["--gateway", "--help"], gatewayOutput.environmentWith());
    expect(gatewayOutput.stdout).toBe(output.stdout);
  });

  it("simlock instructions still prints the text under --gateway or --local on a machine with no gateway, and simlock --help lists it", async () => {
    const listing = outputCapture();
    await expect(runCli(["--help"], listing.environmentWith())).resolves.toBe(0);
    expect(listing.stdout).toContain("  instructions [--json]");

    for (const argv of [
      ["--gateway", "instructions"],
      ["instructions", "--gateway"],
      ["--local", "instructions"],
      ["instructions"],
    ]) {
      const output = outputCapture();
      await expect(
        runCli(
          argv,
          output.environmentWith({
            connectAdmin: async () => {
              throw new Error("instructions must not connect to a daemon");
            },
          }),
        ),
        argv.join(" "),
      ).resolves.toBe(0);
      expect(output.stdout, argv.join(" ")).toMatch(/^# Using Simlock/);
      expect(output.stderr, argv.join(" ")).toBe("");
    }
  });

  it("simlock setup ends its report with a machine summary line and puts doctor's act-on lines on stderr", async () => {
    const missingSdk: DoctorReport = {
      findings: [
        {
          kind: "prerequisite-missing",
          platform: "android",
          prerequisite: "android-sdk",
          message: "No Android SDK.",
          remedy: "Install it.",
        },
      ],
      sources: [],
    };
    const wrongOwner: DoctorReport = {
      findings: [
        {
          kind: "driver-unavailable",
          platform: "ios",
          reason: "wrong-owner",
          detail: "The device set belongs to another user.",
        },
      ],
      sources: [],
    };
    const cases: readonly (readonly [DoctorReport, string, string, NodeJS.Platform?])[] = [
      [{ findings: [], sources: [] }, "ios ok, android ok", ""],
      [{ findings: [], sources: [] }, "android ok", "", "linux"],
      [
        wrongOwner,
        "ios unavailable: wrong-owner, android ok",
        "Unavailable [ios] wrong-owner: The device set belongs to another user.\n",
      ],
      [
        missingSdk,
        "ios ok, android missing: android-sdk",
        "Missing [android] android-sdk: No Android SDK. Install it.\n",
      ],
    ];
    for (const [report, summary, stderr, hostPlatform = "darwin"] of cases) {
      const output = outputCapture();
      const doctorInputs: unknown[] = [];
      const code = await runCli(
        ["setup", "--user", "--tool", "claude-code", "--no-mcp"],
        output.environmentWith({
          hostPlatform,
          adminTokenFromEnv: "admin-token",
          connectAdmin: async (resolveCredential) => {
            await resolveCredential();
            return fakeClient({
              runDoctor: (input) => {
                doctorInputs.push(input);
                return Promise.resolve(report);
              },
            });
          },
        }),
      );
      expect(code, summary).toBe(0);
      expect(doctorInputs, summary).toEqual([{}]);
      expect(output.stdout, summary).toBe(
        `claude-code  skill  wrote      ${join("/home/operator", ".claude", "skills", "simlock")}\n` +
          `machine      ${summary}\n`,
      );
      expect(output.stderr, summary).toBe(stderr);
    }
  });

  it("simlock setup --json gains a machine object with the summary and the doctor findings", async () => {
    const missingSdk = {
      kind: "prerequisite-missing",
      platform: "android",
      prerequisite: "android-sdk",
      message: "No Android SDK.",
      remedy: "Install it.",
    } as const;
    const cases: readonly (readonly [DoctorReport, string])[] = [
      [{ findings: [], sources: [] }, "ios ok, android ok"],
      [{ findings: [missingSdk], sources: [] }, "ios ok, android missing: android-sdk"],
    ];
    for (const [report, summary] of cases) {
      const output = outputCapture();
      const code = await runCli(
        ["setup", "--user", "--tool", "claude-code", "--no-mcp", "--json"],
        output.environmentWith({
          hostPlatform: "darwin",
          adminTokenFromEnv: "admin-token",
          connectAdmin: async (resolveCredential) => {
            await resolveCredential();
            return fakeClient({ runDoctor: () => Promise.resolve(report) });
          },
        }),
      );
      expect(code, summary).toBe(0);
      expect(JSON.parse(output.stdout), summary).toEqual({
        scope: "user",
        tools: [
          {
            tool: "claude-code",
            skill: {
              status: "wrote",
              path: join("/home/operator", ".claude", "skills", "simlock"),
            },
          },
        ],
        machine: { summary, findings: report.findings },
      });
    }
  });

  it("simlock setup still installs the skill and says the machine was not checked when the check cannot run", async () => {
    const refusal = new Error("doctor.run is not available on a gateway");
    const cases: readonly (readonly [string, Partial<SimlockAdminClient> | Error, string])[] = [
      ["daemon fails to connect", new Error("daemon did not start"), "daemon did not start"],
      [
        "daemon refuses doctor.run",
        { runDoctor: () => Promise.reject(refusal) },
        "doctor.run is not available on a gateway",
      ],
    ];
    let gatewayConnects = 0;
    for (const [name, daemon, message, prefix, gatewayHome] of [
      ...cases.map(([n, d, m]) => [n, d, m, [], false] as const),
      [
        "--gateway never connects",
        new Error("a gateway was contacted"),
        "setup does not check a gateway",
        ["--gateway"],
        false,
      ] as const,
      [
        "plain setup on a gateway-only home never connects",
        new Error("a gateway was contacted"),
        "setup does not check a gateway",
        [],
        true,
      ] as const,
    ]) {
      const output = outputCapture();
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/operator/.claude");
      const code = await runCli(
        [...prefix, "setup", "--user", "--tool", "claude-code", "--no-mcp"],
        output.environmentWith({
          hostPlatform: "darwin",
          filesystem,
          ...(gatewayHome
            ? {
                daemonHome: {
                  role: "gateway",
                  dataDirectory: "/simlock/gateway",
                  gatewayPresent: true,
                } as const,
              }
            : {}),
          connectAdmin: async () => {
            if (prefix.length > 0 || gatewayHome) gatewayConnects += 1;
            if (daemon instanceof Error) throw daemon;
            return fakeClient(daemon);
          },
        }),
      );
      expect(code, name).toBe(0);
      expect(output.stdout, name).toBe(
        `claude-code  skill  wrote      ${join("/home/operator", ".claude", "skills", "simlock")}\n` +
          `machine      not checked: ${message}\n`,
      );
      expect(
        await filesystem.exists(join("/home/operator", ".claude", "skills", "simlock")),
        name,
      ).toBe(true);
    }
    expect(gatewayConnects).toBe(0);
  });

  it("simlock setup prints its report, fails the way the spec says, and runs without a gateway", async () => {
    const HOME = "/home/operator";
    const CWD = "/work/project";
    const MACHINE = "machine      ios ok, android ok\n";
    const SCOPE_PROMPT = "Install only for this project (not every project)? [y/N] ";
    const exited = (code: number, stderr = ""): ToolOutcome => ({
      outcome: "exited",
      code,
      stderr,
    });
    const setupRun = async (
      argv: readonly string[],
      options: {
        readonly outcome?: ToolOutcome;
        readonly prepare?: (filesystem: MemoryFilesystem) => Promise<void>;
      } = {},
    ): Promise<{
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly questions: string[];
      readonly filesystem: MemoryFilesystem;
    }> => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp(HOME);
      await filesystem.mkdirp(CWD);
      await filesystem.mkdirp(join(HOME, ".claude"));
      await options.prepare?.(filesystem);
      const questions: string[] = [];
      const output = outputCapture();
      const code = await runCli(
        argv,
        output.environmentWith({
          homeDirectory: HOME,
          workingDirectory: CWD,
          filesystem,
          confirm: async (question) => {
            questions.push(question);
            return false;
          },
          runTool: async () => options.outcome ?? exited(0),
          hostPlatform: "darwin",
          adminTokenFromEnv: "admin-token",
          connectAdmin: async (resolveCredential) => {
            await resolveCredential();
            return fakeClient();
          },
        }),
      );
      return { code, stdout: output.stdout, stderr: output.stderr, questions, filesystem };
    };

    const plain = await setupRun(["setup"]);
    expect(plain.code).toBe(0);
    expect(plain.stderr).toBe("");
    expect(plain.stdout).toBe(
      `claude-code  skill  wrote      ${join(HOME, ".claude", "skills", "simlock")}\n` +
        `codex        skill  skipped    ${join(HOME, ".agents", "skills", "simlock")}  (Codex not found here; pass --tool codex to install anyway)\n` +
        MACHINE,
    );
    expect(plain.questions[0]).toBe(SCOPE_PROMPT);

    const again = await setupRun(["setup", "--tool", "claude-code"], {
      prepare: async (filesystem) => filesystem.mkdirp(join(HOME, ".claude", "skills", "simlock")),
    });
    expect(again.stdout).toBe(
      `claude-code  skill  replaced   ${join(HOME, ".claude", "skills", "simlock")}\n${MACHINE}`,
    );

    for (const [outcome, line] of [
      [exited(0), "claude-code  mcp    connected\n"],
      [
        exited(1, "MCP server simlock already exists in user config\n"),
        "claude-code  mcp    already\n",
      ],
      [{ outcome: "not-found" }, "claude-code  mcp    skipped  (claude not found)\n"],
    ] as const) {
      const run = await setupRun(["setup", "--tool", "claude-code", "--mcp"], { outcome });
      expect(run.code, line).toBe(0);
      expect(run.stdout, line).toBe(
        `claude-code  skill  wrote      ${join(HOME, ".claude", "skills", "simlock")}\n${line}${MACHINE}`,
      );
    }

    const json = await setupRun(["setup", "--tool", "claude-code", "--mcp", "--json"]);
    expect(json.questions).toEqual([]);
    expect(JSON.parse(json.stdout)).toEqual({
      scope: "user",
      tools: [
        {
          tool: "claude-code",
          skill: { status: "wrote", path: join(HOME, ".claude", "skills", "simlock") },
          mcp: { status: "connected" },
        },
      ],
      machine: { summary: "ios ok, android ok", findings: [] },
    });
    const projectJson = await setupRun([
      "setup",
      "--project",
      "--tool",
      "codex",
      "--mcp",
      "--json",
    ]);
    expect(JSON.parse(projectJson.stdout)).toEqual({
      scope: "project",
      tools: [
        {
          tool: "codex",
          skill: { status: "wrote", path: join(CWD, ".agents", "skills", "simlock") },
          mcp: { status: "skipped", reason: "codex mcp add has no project scope" },
        },
      ],
      machine: { summary: "ios ok, android ok", findings: [] },
    });

    const failed = await setupRun(["setup", "--tool", "claude-code", "--mcp"], {
      outcome: exited(1, "boom\nmore"),
    });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe(
      `claude-code  skill  wrote      ${join(HOME, ".claude", "skills", "simlock")}\nclaude-code  mcp    failed  (boom)\n${MACHINE}`,
    );
    expect(JSON.parse(failed.stderr)).toEqual({
      error: { code: "SETUP_MCP_FAILED", message: "MCP not connected for claude-code: boom" },
    });

    const refused = await setupRun(["setup"], {
      prepare: async (filesystem) => {
        await filesystem.mkdirp(join(HOME, ".claude", "skills"));
        await filesystem.writeFileAtomic(join(HOME, ".claude", "skills", "simlock"), "mine");
      },
    });
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr)).toEqual({
      error: {
        code: "SETUP_REFUSED",
        message: `Refusing to install: ${join(HOME, ".claude", "skills", "simlock")} exists and is not a directory. Nothing was written. Move it aside and run setup again.`,
      },
    });

    for (const argv of [
      ["setup", "--tool", "cursor"],
      ["setup", "--tool", "codex", "--tool", "claude-code"],
      ["setup", "extra"],
      ["setup", "--mcp", "--no-mcp"],
      ["setup", "--user", "--project"],
    ]) {
      const refusedUsage = await setupRun(argv);
      expect(refusedUsage.code, argv.join(" ")).toBe(2);
      expect(refusedUsage.stdout, argv.join(" ")).toBe("");
      expect(JSON.parse(refusedUsage.stderr).error.code, argv.join(" ")).toBe("USAGE");
      expect(
        await refusedUsage.filesystem.exists(join(HOME, ".claude", "skills")),
        argv.join(" "),
      ).toBe(false);
    }

    for (const argv of [
      ["--gateway", "setup", "--json"],
      ["--local", "setup", "--json"],
    ]) {
      const run = await setupRun(argv);
      expect(run.code, argv.join(" ")).toBe(0);
    }
    const help = await setupRun(["setup", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toBe(
      "Usage: simlock setup [--user | --project] [--tool <claude-code|codex>] [--mcp | --no-mcp] [--json]\n",
    );
    const listing = outputCapture();
    await runCli(["--help"], listing.environmentWith());
    expect(listing.stdout).toContain("  setup [--user | --project]");
  });

  it("prints shell export lines instead of the JSON grant under --export-env", async () => {
    const output = outputCapture();
    const grant: LeaseGrant = {
      ...detachedGrant,
      // why: A device root is a user-configurable path, so it can hold a space or an apostrophe;
      // both have to survive `eval "$(...)"` byte for byte.
      environment: {
        SIMLOCK_IOS_DEVICE_SET: "/Users/o'brien/My Sims/devices/ios",
        ANDROID_ADB_SERVER_PORT: "5038",
      },
    };

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach", "--export-env"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({ requestLease: (_input, _options) => Promise.resolve(grant) }),
        }),
      ),
    ).resolves.toBe(0);
    expect(output.stdout).toBe(
      "export ANDROID_ADB_SERVER_PORT='5038'\n" +
        "export SIMLOCK_IOS_DEVICE_SET='/Users/o'\\''brien/My Sims/devices/ios'\n",
    );
  });

  it("names the lease on stderr when --export-env has no environment to export", async () => {
    const output = outputCapture();

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach", "--export-env"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({ requestLease: (_input, _options) => Promise.resolve(detachedGrant) }),
        }),
      ),
    ).resolves.toBe(0);
    // why: stdout stays empty so `eval "$(...)"` is unaffected, but the lease is committed and
    // TTL-bound: a caller told nothing at all could neither renew nor release it.
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain(detachedGrant.lease.id);
    expect(output.stderr).toContain("no environment");
  });

  it("fails loudly rather than exporting a key that would change what eval runs", async () => {
    const output = outputCapture();
    const grant: LeaseGrant = {
      ...detachedGrant,
      // why: Not reachable through the shipped drivers, whose keys are literals -- but
      // `SIMLOCK_DRIVERS_MODULE` and the wire both accept whatever a driver returns.
      environment: { "K=1; touch /tmp/probe/PWNED_KEY; X": "1" },
    };

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach", "--export-env"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({ requestLease: (_input, _options) => Promise.resolve(grant) }),
        }),
      ),
    ).resolves.toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("PWNED_KEY");
  });

  it.each([
    ["simctl", ["install", "booted", "./MyApp.app"]],
    ["adb", ["shell", "input", "tap", "100", "200"]],
  ])("asks the daemon to scope a %s passthrough and runs it locally", async (tool, args) => {
    const output = outputCapture();
    const resolved = {
      args: ["-P", "5038", ...args],
      command: "/sdk/adb",
      env: { ANDROID_ADB_SERVER_PORT: "5038" },
    };
    const seen: unknown[] = [];
    const ran: unknown[] = [];

    await expect(
      runCli(
        [tool, ...args],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              resolvePassthrough: (input) => {
                seen.push(input);
                return Promise.resolve(resolved);
              },
            }),
          runPassthrough: async (command) => {
            ran.push(command);
            return 0;
          },
        }),
      ),
    ).resolves.toBe(0);
    expect(seen).toEqual([{ args, tool }]);
    expect(ran).toEqual([resolved]);
    expect(output.stdout).toBe("");
  });

  it("propagates the passthrough's own exit code rather than reporting success", async () => {
    const output = outputCapture();

    await expect(
      runCli(
        ["adb", "devices"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              resolvePassthrough: () =>
                Promise.resolve({ args: ["devices"], command: "adb", env: {} }),
            }),
          runPassthrough: async () => 42,
        }),
      ),
    ).resolves.toBe(42);
  });

  it("renders a driver's refusal as a USAGE error, not as a daemon failure", async () => {
    const output = outputCapture();
    let ranPassthrough = false;

    await expect(
      runCli(
        ["simctl", "delete", "ABCD"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              resolvePassthrough: () =>
                Promise.reject(
                  new SimlockError(
                    "PASSTHROUGH_REFUSED",
                    "domain",
                    "Refusing `simlock simctl delete`: use `simlock release` or `simlock cleanup` instead.",
                    { tool: "simctl" },
                  ),
                ),
            }),
          runPassthrough: async () => {
            ranPassthrough = true;
            return 0;
          },
        }),
      ),
    ).resolves.toBe(2);
    expect(ranPassthrough).toBe(false);
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
      error: {
        code: "USAGE",
        message: expect.stringContaining("simlock release"),
      },
    });
  });

  it("passes a passthrough's own --help through to the tool rather than intercepting it", async () => {
    const output = outputCapture();
    const seen: unknown[] = [];

    await expect(
      runCli(
        ["adb", "--help"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              resolvePassthrough: (input) => {
                seen.push(input);
                return Promise.resolve({ args: ["--help"], command: "adb", env: {} });
              },
            }),
          runPassthrough: async () => 0,
        }),
      ),
    ).resolves.toBe(0);
    expect(seen).toEqual([{ args: ["--help"], tool: "adb" }]);
  });
});

describe("CLI: lease pushes and exit codes (own logic, not the dispatcher's)", () => {
  it("ignores a lease-lost push for a lease this connection does not hold (own-lease-id filter)", async () => {
    const output = outputCapture();
    let leaseLostListener:
      | ((push: { leaseId: string; deviceId: string; reason: string }) => void)
      | undefined;
    let released = false;
    const signals = new EventEmitter();
    const client = fakeClient({
      onLeaseLost: (listener) => {
        leaseLostListener = listener;
        return () => {};
      },
      releaseLease: () => {
        released = true;
        return Promise.resolve({ leaseId: "lse_1" });
      },
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({
        connectAdmin: async () => client,
        signals: signals as unknown as CliEnvironment["signals"],
      }),
    );
    await settle();
    leaseLostListener?.({ leaseId: "some-other-lease", deviceId: "dev_2", reason: "ttl-backstop" });
    await settle();
    signals.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
    expect(released).toBe(true);
    expect(output.stderr).not.toContain("lease-lost");
  });
});
