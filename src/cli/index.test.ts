import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type Socket } from "node:net";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { testComponentWiring, testStateOf } from "../core/testing.js";

import { EventBus } from "../bus/index.js";
import { ringEventHistory, seedHistory } from "../history/testing.js";
import { CleanupReaper, type Config } from "../core/index.js";
import { FakeDriver, loadTestRegistry } from "../core/testing.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeDaemonLauncher,
  FakeParentWatch,
  FakeServiceManager,
  IpcError,
  launcherFor,
  LaunchdServiceManager,
  ScriptedProcessRunner,
  MemoryFilesystem,
  MemoryIpcTransport,
  resolveDaemonSocketPath,
  FakeKeySetFetcher,
  NodeFilesystem,
  NodeIpcTransport,
  NoopLogger,
  serviceDefinition,
  type ServiceManager,
  type ServiceState,
  type Filesystem,
  type IdGenerator,
  type IpcConnection,
  type IpcConnector,
} from "../ports/index.js";
import { FakeSystemStats } from "../ports/index.js";
import { type Auth, createAuth, tokensOwner } from "../auth/index.js";
import { openMemoryStateDatabase } from "../auth/testing.js";
import { DaemonEndpointHost } from "../daemon/connection-host.js";
import { DaemonServer } from "../daemon/server.js";
import {
  PROTOCOL_VERSION_RANGE,
  fromWireError,
  SimlockError,
  waitingRequestSchema,
  type AnySimlockError,
  type UsageOutput,
} from "../contract/index.js";
import type {
  CatalogGetOutput,
  DeviceRecoveredPush,
  DeviceUnhealthyPush,
  DoctorReport,
  EventPush,
  LeaseGrant,
  LeaseListOutput,
  LeaseRecord,
  ListGetOutput,
  SimlockAdminClient,
  SimlockConfig,
  StatusGetOutput,
  TokenListOutput,
} from "../simlock-client/client.js";
import { connectSimlockAdmin, type WorkerView } from "../admin/index.js";
import { RELEASE_TIMEOUT_MS } from "../lease-policy/index.js";
import { runCli, type CliEnvironment, type CliEnvironmentPorts } from "./index.js";
import { buildCliEnvironment } from "./environment.js";
import { readLogFile } from "./log-file.js";
import { readPipedStdin } from "./stdio.js";
import { parseDuration } from "./duration.js";
import { createTestEngine } from "../leasing/testing.js";

const gibibyte = 1024 ** 3;

/**
 * why: Yields to the macrotask queue, so `runLease` gets past `requestLease` and reaches its wait
 * point -- its push listeners registered and its renew timer armed -- before a test fires a
 * push or advances the clock.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const detachedGrant: LeaseGrant = {
  device: {
    physical: false,
    id: "device-1",
    driverDeviceId: "ABCD",
    spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    mode: "full",
  },
  environment: {},
  lease: {
    id: "lse_env",
    deviceId: "device-1",
    requesterId: "test-requester",
    ownerId: "test-requester",
    grantedAt: 0,
    lastRenewedAt: 0,
    idChosenByRequester: false,
    ttlMs: 60_000,
    ttlDeadline: 61_000,
  },
  timing: {
    estimatedBootMs: 0,
    estimatedProvisionMs: 0,
    estimatedReclaimMs: 0,
    estimatedReadyMs: 0,
  },
};
const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

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

    await expect(readLogFile(filesystem, "/simlock/daemon.log")).rejects.toThrow();
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

  /**
   * why: ADR 0005 §19c's other half. Same command, same refusals, same exit code -- the only thing
   * that changes is where the process runs and how its output gets here. `runPassthrough` is
   * deliberately wired in each of these: a remote invocation that quietly spawned locally
   * would pass every assertion about output and exit code while doing the wrong thing.
   *
   * The switch is the daemon's own `mode` (§19c): a `gateway` owns no devices, so a command
   * it resolved could not run here anyway. Nothing about the CLI's transport decides it.
   */
  describe("remote passthrough (ADR 0005 device.exec)", () => {
    const gatewayStatus = {
      ...EMPTY_STATUS,
      daemon: {
        health: "running" as const,
        mode: "gateway" as const,
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
    };
    const ownLease = {
      deviceId: "dev_1",
      grantedAt: 0,
      id: "lse_mine",
      lastRenewedAt: 0,
      idChosenByRequester: false,
      ownerId: "some-other-principal",
      requesterId: "test-requester",
      ttlDeadline: 60_000,
      ttlMs: 60_000,
    };

    it("runs the command on the daemon, prints the streamed output, and exits with its code", async () => {
      const output = outputCapture();
      const seen: unknown[] = [];
      let ranLocally = false;

      await expect(
        runCli(
          ["adb", "shell", "getprop"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.resolve({ leases: [ownLease] }),
                exec: (input, options) => {
                  seen.push(input);
                  options?.onOutput?.({ chunk: "ro.build", stream: "stdout" });
                  options?.onOutput?.({ chunk: "a warning\n", stream: "stderr" });
                  options?.onOutput?.({ chunk: ".version=15\n", stream: "stdout" });
                  return Promise.resolve({ exitCode: 9 });
                },
              }),
            runPassthrough: async () => {
              ranLocally = true;
              return 0;
            },
          }),
        ),
      ).resolves.toBe(9);

      expect(ranLocally).toBe(false);
      // why: `requesterId` rides along because this connection resolved to the admin role, where
      // the operation reads it (and requires it to match the lease). See the agent-role case
      // below for the other half.
      expect(seen).toEqual([
        {
          args: ["shell", "getprop"],
          leaseId: "lse_mine",
          requesterId: "test-requester",
          tool: "adb",
        },
      ]);
      // why: Chunks land on the stream they were written to, unjoined and in order -- a caller
      // piping this sees what it would have seen locally.
      expect(output.stdout).toBe("ro.build.version=15\n");
      // why: The agent-fallback notice this fixture's credential-less connection writes is the only
      // other thing on stderr; the command's own chunk lands there verbatim.
      expect(output.stderr).toContain("a warning\n");
    });

    it("names the lease from the requester id rather than from a flag of its own", async () => {
      // why: Every argument after the tool name belongs to the tool, so identity is
      // the only thing left to select a lease with -- and `--agent-id`/`SIMLOCK_AGENT_ID`
      // already is that identity. A requester holding no lease is a usage error naming it.
      const output = outputCapture();

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () =>
                  Promise.resolve({
                    leases: [{ ...ownLease, id: "lse_theirs", requesterId: "someone-else" }],
                  }),
              }),
          }),
        ),
      ).resolves.toBe(2);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "USAGE", message: expect.stringContaining("test-requester") },
      });
    });

    it("exits 10 when the daemon killed the command for outrunning exec.timeoutMs", async () => {
      // why: The exit code comes from `ERROR_TABLE`'s own column (ADR 0003 §7): 10, the same code
      // the other "you ran out of time" outcome (`QUEUE_TIMEOUT`) uses, rather than the
      // generic 1 a command that merely failed would get.
      const output = outputCapture();

      await expect(
        runCli(
          ["adb", "logcat"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.resolve({ leases: [ownLease] }),
                exec: () =>
                  Promise.reject(
                    new SimlockError(
                      "EXEC_TIMEOUT",
                      "domain",
                      "`adb logcat` exceeded exec.timeoutMs (600000ms) and was killed",
                      {},
                    ),
                  ),
              }),
          }),
        ),
      ).resolves.toBe(10);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "EXEC_TIMEOUT", message: expect.stringContaining("exec.timeoutMs") },
      });
    });

    it("without --lease, for a requester holding two leases, fails with a usage error naming both leases and --lease", async () => {
      const output = outputCapture();

      await expect(
        runCli(
          ["simctl", "list"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () =>
                  Promise.resolve({
                    leases: [ownLease, { ...ownLease, deviceId: "dev_2", id: "lse_other" }],
                  }),
                exec: () => Promise.reject(new Error("must not run")),
              }),
          }),
        ),
      ).resolves.toBe(2);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: {
          code: "USAGE",
          message: expect.stringMatching(/lse_mine.*lse_other.*--lease <id>/s),
        },
      });
    });

    it("takes `--lease <id>` out of the arguments and runs against that lease", async () => {
      // why: The flag exists only on this path, so it is stripped here rather than parsed with the
      // CLI's own flags: locally every argument after the tool name belongs to the tool.
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "--lease", "lse_named", "shell", "getprop"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.reject(new Error("must not need the lease list")),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        {
          args: ["shell", "getprop"],
          leaseId: "lse_named",
          requesterId: "test-requester",
          tool: "adb",
        },
      ]);
    });

    it("sends whatever readStdin resolves with as the command's one-shot stdin", async () => {
      // why: `readStdin` is a `CliEnvironmentPorts` seam this test injects directly -- it exercises
      // the wiring from that port's result to `device.exec`'s `stdin`, not the default
      // `readPipedStdin` implementation that reads a real pipe to EOF; that one is tested on
      // its own below, since a fake here would not exercise it at all.
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "shell", "cat"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.resolve({ leases: [ownLease] }),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
            readStdin: async () => "piped payload\n",
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        {
          args: ["shell", "cat"],
          leaseId: "lse_mine",
          requesterId: "test-requester",
          stdin: "piped payload\n",
          tool: "adb",
        },
      ]);
    });

    it("sends no requesterId when the connection fell back to the agent role", async () => {
      // why: An agent session is gated on the lease it owns and its `requesterId` is ignored
      // entirely, so sending one would be noise that reads like authorization.
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                role: "agent",
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.resolve({ leases: [ownLease] }),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([{ args: ["devices"], leaseId: "lse_mine", tool: "adb" }]);
    });

    it("spawns locally against a worker, accepting and ignoring --lease", async () => {
      // why: The other half of the same switch, and the reason `--lease` is accepted on both: one
      // command line has to work against either kind of daemon. A worker takes
      // the flag, drops it, and passes the rest to the tool untouched.
      const output = outputCapture();
      const ran: unknown[] = [];
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "--lease", "lse_ignored", "shell", "getprop"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                exec: () => Promise.reject(new Error("must not exec remotely")),
                resolvePassthrough: (input) => {
                  seen.push(input);
                  return Promise.resolve({ args: ["-P", "5038"], command: "adb", env: {} });
                },
              }),
            runPassthrough: async (command) => {
              ran.push(command);
              return 0;
            },
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([{ args: ["shell", "getprop"], tool: "adb" }]);
      expect(ran).toHaveLength(1);
    });

    it("relabels an unknown passthrough tool as USAGE, like a refusal", async () => {
      // why: ADR 0005 §19c: the CLI keeps no copy of the refusal list and relabels whatever the
      // daemon answers. `UNKNOWN_PASSTHROUGH_TOOL` is the other half of that answer, and it
      // has to read the same as a refused verb does -- exit 2, one `USAGE` line.
      const output = outputCapture();

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.resolve({ leases: [ownLease] }),
                exec: () =>
                  Promise.reject(
                    new SimlockError(
                      "UNKNOWN_PASSTHROUGH_TOOL",
                      "domain",
                      "No driver provides a adb passthrough",
                      { tool: "adb" },
                    ),
                  ),
              }),
          }),
        ),
      ).resolves.toBe(2);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "USAGE", message: expect.stringContaining("No driver provides") },
      });
    });

    it("takes --lease as the last argument, and refuses an empty one", async () => {
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "--lease", "lse_only"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        { args: [], leaseId: "lse_only", requesterId: "test-requester", tool: "adb" },
      ]);

      const missingValue = outputCapture();
      await expect(
        runCli(
          ["adb", "--lease"],
          missingValue.environmentWith({
            connectAdmin: async () =>
              fakeClient({ getStatus: () => Promise.resolve(gatewayStatus) }),
          }),
        ),
      ).resolves.toBe(2);

      const emptyValue = outputCapture();
      await expect(
        runCli(
          ["adb", "--lease=", "devices"],
          emptyValue.environmentWith({
            connectAdmin: async () =>
              fakeClient({ getStatus: () => Promise.resolve(gatewayStatus) }),
          }),
        ),
      ).resolves.toBe(2);
    });

    it("fails a local passthrough with the status.get error when the daemon cannot answer", async () => {
      // why: The switch reads `mode` off `status.get`, so an unreachable daemon fails there rather
      // than at the passthrough -- and the CLI reports that call's own error rather than
      // dressing it up as a passthrough failure.
      const output = outputCapture();
      let ranLocally = false;

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () =>
                  Promise.reject(
                    new SimlockError(
                      "DAEMON_CONNECTION_LOST",
                      "transport",
                      "Daemon connection closed",
                      {},
                    ),
                  ),
              }),
            runPassthrough: async () => {
              ranLocally = true;
              return 0;
            },
          }),
        ),
      ).resolves.toBe(1);
      expect(ranLocally).toBe(false);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "DAEMON_CONNECTION_LOST", message: "Daemon connection closed" },
      });
    });

    it("uses an agent connection's own lease list without filtering it by requester", async () => {
      // why: `lease.list` already answers per role: an agent sees only what it owns. Filtering that
      // by `requesterId` as well would drop a lease it demonstrably owns whenever the two
      // differ -- an `--agent-id` used on the lease but not on this invocation.
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                role: "agent",
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () =>
                  Promise.resolve({
                    leases: [{ ...ownLease, id: "lse_owned", requesterId: "another-agent-id" }],
                  }),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([{ args: ["devices"], leaseId: "lse_owned", tool: "adb" }]);
    });

    it("stops scanning for --lease at the tool's own first argument", async () => {
      // why: Everything from the tool's subcommand onwards is the tool's, so a `--lease` there is
      // an argument to *it* -- typed text, a filter, an operand -- and travels through.
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "--lease", "lse_mine", "shell", "input", "text", "--lease"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.reject(new Error("must not need the lease list")),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        {
          args: ["shell", "input", "text", "--lease"],
          leaseId: "lse_mine",
          requesterId: "test-requester",
          tool: "adb",
        },
      ]);
    });
  });

  it("lists both tool passthroughs in root help", async () => {
    const output = outputCapture();

    await expect(runCli([], output.environmentWith())).resolves.toBe(0);
    expect(output.stdout).toContain("simctl <args...>");
    expect(output.stdout).toContain("adb <args...>");
  });

  it("releases and exits when the watched parent process dies, via the same path as a signal", async () => {
    const output = outputCapture();
    const parentWatch = new FakeParentWatch();
    const heldGrant: LeaseGrant = {
      ...detachedGrant,
      lease: { ...detachedGrant.lease, id: "lse_parent_death" },
    };
    const released: unknown[] = [];

    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            requestLease: (_input, _options) => Promise.resolve(heldGrant),
            releaseLease: (input) => {
              released.push(input);
              return Promise.resolve({ leaseId: input.leaseId });
            },
          }),
        parentPid: 4321,
        parentWatch,
        signals: new EventEmitter() as unknown as CliEnvironment["signals"],
      }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    parentWatch.exit(4321);

    await expect(run).resolves.toBe(0);
    expect(released).toEqual([{ leaseId: "lse_parent_death" }]);
  });

  it("--bind-pid overrides which pid the CLI watches for parent death", async () => {
    const output = outputCapture();
    const parentWatch = new FakeParentWatch();
    const heldGrant: LeaseGrant = {
      ...detachedGrant,
      lease: { ...detachedGrant.lease, id: "lse_bind_pid" },
    };
    const released: unknown[] = [];

    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--bind-pid", "9876"],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            requestLease: (_input, _options) => Promise.resolve(heldGrant),
            releaseLease: (input) => {
              released.push(input);
              return Promise.resolve({ leaseId: input.leaseId });
            },
          }),
        parentPid: 4321,
        parentWatch,
        signals: new EventEmitter() as unknown as CliEnvironment["signals"],
      }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    // why: The captured parent is not the one being watched any more, so its death is ignored.
    parentWatch.exit(4321);
    expect(released).toEqual([]);
    parentWatch.exit(9876);

    await expect(run).resolves.toBe(0);
    expect(released).toEqual([{ leaseId: "lse_bind_pid" }]);
  });

  it("rejects a non-numeric --bind-pid as a structured USAGE error", async () => {
    const output = outputCapture();

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--bind-pid", "nope"],
        output.environmentWith(),
      ),
    ).resolves.toBe(2);
    expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: "USAGE" } });
  });

  // why: the CLI reference promises a missing required argument ends with the `simlock --help`
  // pointer, and guards reach it two ways -- an explicit `withHelpHint` call or
  // `requiredPositional` -- either of which can be dropped silently, so a sample of both
  // paths (a command guard and the router's unknown command) is pinned here.
  it("points a missing required argument at simlock --help", async () => {
    const output = outputCapture();
    await expect(runCli(["lease"], output.environmentWith())).resolves.toBe(2);
    expect(JSON.parse(output.stderr).error).toMatchObject({
      code: "USAGE",
      message: "lease requires --platform <ios|android> (run `simlock --help` for usage)",
    });
  });

  it("points an unknown command at simlock --help", async () => {
    const output = outputCapture();
    await expect(runCli(["nope"], output.environmentWith())).resolves.toBe(2);
    expect(JSON.parse(output.stderr).error).toMatchObject({
      code: "USAGE",
      message: "Unknown command: nope (run `simlock --help` for usage)",
    });
  });
});

describe("CLI: admin credential resolution (ADR 0003 §5)", () => {
  it("prefers --token over SIMLOCK_ADMIN_TOKEN and the admin.token file", async () => {
    const output = outputCapture();
    let seen: string | undefined;
    await runCli(
      ["--token", "from-flag", "status"],
      output.environmentWith({
        adminTokenFromEnv: "from-env",
        readAdminTokenFile: async () => "from-file",
        connectAdmin: async (resolveCredential) => {
          seen = await resolveCredential();
          return fakeClient();
        },
      }),
    );
    expect(seen).toBe("from-flag");
    expect(output.stderr).toBe("");
  });

  it("prefers SIMLOCK_ADMIN_TOKEN over the admin.token file when --token is absent", async () => {
    const output = outputCapture();
    let seen: string | undefined;
    await runCli(
      ["status"],
      output.environmentWith({
        adminTokenFromEnv: "from-env",
        readAdminTokenFile: async () => "from-file",
        connectAdmin: async (resolveCredential) => {
          seen = await resolveCredential();
          return fakeClient();
        },
      }),
    );
    expect(seen).toBe("from-env");
  });

  it("falls back to the admin.token file when neither --token nor the env var is set", async () => {
    const output = outputCapture();
    let seen: string | undefined;
    await runCli(
      ["status"],
      output.environmentWith({
        readAdminTokenFile: async () => "from-file",
        connectAdmin: async (resolveCredential) => {
          seen = await resolveCredential();
          return fakeClient();
        },
      }),
    );
    expect(seen).toBe("from-file");
    expect(output.stderr).toBe("");
  });

  it("retries a briefly-missing admin.token file before giving up", async () => {
    const output = outputCapture();
    let reads = 0;
    let seen: string | undefined;
    await runCli(
      ["status"],
      output.environmentWith({
        readAdminTokenFile: async () => {
          reads += 1;
          return reads < 3 ? undefined : "from-file-after-retry";
        },
        connectAdmin: async (resolveCredential) => {
          seen = await resolveCredential();
          return fakeClient();
        },
      }),
    );
    expect(reads).toBe(3);
    expect(seen).toBe("from-file-after-retry");
    expect(output.stderr).toBe("");
  });

  it("connects with no credential and writes a stderr notice when every source is empty", async () => {
    const output = outputCapture();
    let seen: string | undefined | "unset" = "unset";
    await runCli(
      ["status"],
      output.environmentWith({
        readAdminTokenFile: async () => undefined,
        connectAdmin: async (resolveCredential) => {
          seen = await resolveCredential();
          return fakeClient();
        },
      }),
    );
    expect(seen).toBeUndefined();
    expect(output.stderr.trim().split("\n")).toHaveLength(1);
    const notice: unknown = JSON.parse(output.stderr);
    expect((notice as { notice: string }).notice).toMatch(/agent/i);
  });

  it("does not read the admin.token file at all when --token is given (B2 ordering)", async () => {
    // why: The file source must never be consulted -- let alone before the connection exists -- when
    // a higher-priority source already answered. Also guards against a regression back to
    // resolving credentials before `connectAdmin` is even called.
    const output = outputCapture();
    let fileReads = 0;
    await runCli(
      ["--token", "from-flag", "status"],
      output.environmentWith({
        readAdminTokenFile: async () => {
          fileReads += 1;
          return "from-file";
        },
        connectAdmin: async (resolveCredential) => {
          await resolveCredential();
          return fakeClient();
        },
      }),
    );
    expect(fileReads).toBe(0);
  });

  it("B1: degrades to an agent session with a stderr notice when the daemon rejects the credential", async () => {
    const output = outputCapture();
    let attempt = 0;
    let seenOnRetry: string | undefined | "unset" = "unset";
    await runCli(
      ["status"],
      output.environmentWith({
        readAdminTokenFile: async () => "stale-secret",
        connectAdmin: async (resolveCredential) => {
          attempt += 1;
          if (attempt === 1) {
            const credential = await resolveCredential();
            expect(credential).toBe("stale-secret");
            throw simlockError("ADMIN_AUTHENTICATION_FAILED");
          }
          seenOnRetry = await resolveCredential();
          return fakeClient();
        },
      }),
    );
    expect(attempt).toBe(2);
    expect(seenOnRetry).toBeUndefined();
    expect(output.stderr.trim().split("\n")).toHaveLength(1);
    const notice = JSON.parse(output.stderr) as { notice: string };
    expect(notice.notice).toMatch(/admin\.token/i);
    expect(notice.notice).toMatch(/agent/i);
  });

  it("B1: does not retry, and propagates the error, when the connection already had no credential", async () => {
    const output = outputCapture();
    let attempts = 0;
    const exitCode = await runCli(
      ["status"],
      output.environmentWith({
        readAdminTokenFile: async () => undefined,
        connectAdmin: async (resolveCredential) => {
          attempts += 1;
          await resolveCredential();
          throw simlockError("ADMIN_AUTHENTICATION_FAILED");
        },
      }),
    );
    expect(attempts).toBe(1);
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(output.stderr).error.code).toBe("ADMIN_AUTHENTICATION_FAILED");
  });

  it("B1: an explicit but wrong --token also degrades to agent, with a generic (not file-specific) notice", async () => {
    const output = outputCapture();
    let attempt = 0;
    await runCli(
      ["--token", "wrong", "status"],
      output.environmentWith({
        connectAdmin: async (resolveCredential) => {
          attempt += 1;
          const credential = await resolveCredential();
          if (attempt === 1) {
            expect(credential).toBe("wrong");
            throw simlockError("ADMIN_AUTHENTICATION_FAILED");
          }
          expect(credential).toBeUndefined();
          return fakeClient();
        },
      }),
    );
    expect(attempt).toBe(2);
    const notice = JSON.parse(output.stderr) as { notice: string };
    expect(notice.notice).not.toMatch(/admin\.token/i);
    expect(notice.notice).toMatch(/agent/i);
  });

  it("B2: reaches admin on a cold start, on the very first invocation, no daemon running yet", async () => {
    const filesystem = new MemoryFilesystem();
    const ipcTransport = new MemoryIpcTransport();
    const socketPath = "/simlock/daemon.sock";
    const adminTokenPath = "/simlock/admin.token";
    const launcher = new FakeDaemonLauncher(async () => {
      await startInMemoryDaemon({ adminTokenPath, filesystem, ipcTransport, socketPath });
    });
    const output = outputCapture({
      filesystem,
      clock: new FakeClock(0),
      systemStats: new FakeSystemStats({
        cpuCount: 8,
        totalRamBytes: 32 * gibibyte,
      }),
      ipc: ipcTransport,
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
    });
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith(),
    );
    expect(exitCode).toBe(0);
    expect(launcher.launches).toBe(1);
    const grant = JSON.parse(output.stdout) as LeaseGrant & { role: string };
    expect(grant.role).toBe("admin");
    // why: Provisioning progress pushes are expected noise on stderr; the agent-fallback notice is
    // the thing that must be absent.
    expect(output.stderr).not.toContain("notice");
  });

  it("daemon start reports the config error and launches nothing when config.json is invalid", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(
      "/simlock/config.json",
      JSON.stringify({ capacity: { config: { limits: { android: { maxDevices: 0 } } } } }),
    );
    const launcher = new FakeDaemonLauncher();
    const output = outputCapture({
      filesystem,
      clock: new FakeClock(0),
      systemStats: new FakeSystemStats({
        cpuCount: 8,
        totalRamBytes: 32 * gibibyte,
      }),
      ipc: new MemoryIpcTransport(),
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
    });
    const exitCode = await runCli(["daemon", "start"], output.environmentWith());
    expect(exitCode).toBe(1);
    expect(launcher.launches).toBe(0);
    expect(output.stderr).toContain("limits.android.maxDevices");
    expect(output.stderr).not.toContain("Timed out");
  });

  it("B1: a stale admin.token degrades to an agent session instead of bricking the invocation", async () => {
    const filesystem = new MemoryFilesystem();
    const ipcTransport = new MemoryIpcTransport();
    const socketPath = "/simlock/daemon.sock";
    const adminTokenPath = "/simlock/admin.token";
    // why: A daemon actually runs and persists its own secret first, then the file is overwritten
    // with a value that hashes to nothing the running daemon recognizes -- exactly what a
    // `kill -9`'d daemon's leftover `admin.token` looks like to the *next* daemon incarnation,
    // which never touches a file it did not itself just persist.
    await startInMemoryDaemon({ adminTokenPath, filesystem, ipcTransport, socketPath });
    await filesystem.writeFileAtomic(adminTokenPath, "stale-secret-from-a-killed-daemon\n");
    const launcher = new FakeDaemonLauncher();
    const output = outputCapture({
      filesystem,
      clock: new FakeClock(0),
      systemStats: new FakeSystemStats({
        cpuCount: 8,
        totalRamBytes: 32 * gibibyte,
      }),
      ipc: ipcTransport,
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
    });
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith(),
    );
    expect(exitCode).toBe(0);
    expect(launcher.launches).toBe(0);
    const grant = JSON.parse(output.stdout) as LeaseGrant & { role: string };
    expect(grant.role).toBe("agent");
    expect(output.stderr).toContain("admin.token");
  });
});

describe("CLI: auto-launch's startup deadline (#663)", () => {
  /**
   * why: the launcher hands back a daemon that claims its socket only `bootMs` later, the way
   * `NodeDaemonLauncher` returns while the detached process it spawned is still booting; what
   * the CLI can see is how long the socket stays absent, not how long `launch` itself blocks.
   */
  function slowBootPorts(bootMs: number): {
    readonly ports: CliEnvironmentPorts;
    readonly clock: FakeClock;
  } {
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock(0);
    const ipcTransport = new MemoryIpcTransport();
    const ports: CliEnvironmentPorts = {
      filesystem,
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: ipcTransport,
      launcher: new FakeDaemonLauncher(() => {
        clock.setTimer(bootMs, () => {
          void startInMemoryDaemon({
            adminTokenPath: "/simlock/admin.token",
            filesystem,
            ipcTransport,
            socketPath: "/simlock/daemon.sock",
          });
        });
      }),
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
    };
    return { clock, ports };
  }

  /**
   * why: turns the clock at the auto-launch poll's own 50 ms step, with room to run past the
   * startup deadline and keep pumping the boot the CLI abandoned; the clock is fake, so the
   * extra ticks cost nothing. The `settled` guard makes a hang fail on a named assertion
   * instead of on a test timeout.
   */
  async function runWithTicks(
    command: readonly string[],
    ports: CliEnvironmentPorts,
    clock: FakeClock,
    runOnMs: number,
  ): Promise<{ readonly exitCode: number; readonly output: ReturnType<typeof outputCapture> }> {
    const output = outputCapture(ports);
    let settled = false;
    const exitCode = runCli(command, output.environmentWith()).then((code) => {
      settled = true;
      return code;
    });
    for (let tick = 0; tick < 500 && (!settled || clock.now() < runOnMs); tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(
      settled,
      `simlock ${command.join(" ")} still had not settled at ${String(clock.now())}ms`,
    ).toBe(true);
    return { exitCode: await exitCode, output };
  }

  it("waits 20 s for a daemon it auto-launched: within the deadline it reports as running, past it the command reports a failed start", async () => {
    const cases = [
      { bootMs: 19_900, label: "19.9 s" },
      { bootMs: 20_100, label: "20.1 s" },
    ];

    // why: every case runs before anything is asserted, so the case that passes cannot hide
    // what the case that fails did to the daemon it launched.
    const outcomes = await Promise.all(
      cases.map(async (testCase) => {
        const { clock, ports } = slowBootPorts(testCase.bootMs);
        const { exitCode, output } = await runWithTicks(
          ["daemon", "start", "--json"],
          ports,
          clock,
          testCase.bootMs + 1_000,
        );
        const after = outputCapture(ports);
        const statusExit = await runCli(["daemon", "status", "--json"], after.environmentWith());
        const status = JSON.parse(after.stdout || "{}") as { daemon?: { health?: string } };
        return {
          exitCode,
          label: testCase.label,
          timedOutStarting: output.stderr.includes("Timed out starting simlock daemon"),
          stdout: output.stdout,
          statusHealth: status.daemon?.health ?? after.stdout,
          statusExit,
        };
      }),
    );

    expect(
      outcomes.map((outcome) => ({
        exitCode: outcome.exitCode,
        label: outcome.label,
        // why: the failed start is asserted as the timeout's wording, not the whole line or
        // its error code, so what the code reports can change without moving this test.
        timedOutStarting: outcome.timedOutStarting,
        stdout: outcome.stdout,
      })),
    ).toEqual([
      {
        exitCode: 0,
        label: "19.9 s",
        timedOutStarting: false,
        stdout: '{"status":"running"}\n',
      },
      {
        exitCode: 1,
        label: "20.1 s",
        timedOutStarting: true,
        stdout: "",
      },
    ]);

    // why: asserted apart from the exit code so a fix that only softens the timeout message
    // fails here -- `daemon status` never launches one, so what it reaches is the daemon this
    // command launched and then gave up on.
    for (const outcome of outcomes) {
      expect(outcome.statusExit, `${outcome.label}: status stderr`).toBe(0);
      expect(
        ["starting", "running"].includes(outcome.statusHealth as string),
        `${outcome.label}: status says ${JSON.stringify(outcome.statusHealth)}`,
      ).toBe(true);
    }
  });
});

describe("CLI: auto-launch's failed start (#672)", () => {
  it("reports a daemon it launched but never reached as DAEMON_STARTUP_FAILED, exit 1", async () => {
    // why: nothing ever claims the socket, which is what a daemon still booting past the
    // deadline looks like to the CLI. The run goes well past any deadline the loop could hold,
    // so the code asserted here is the one the CLI chose for giving up, never one a clock reached.
    const clock = new FakeClock(0);
    const launcher = new FakeDaemonLauncher();
    const output = outputCapture({
      filesystem: new MemoryFilesystem(),
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: new MemoryIpcTransport(),
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
    });
    let settled = false;
    const exitCode = runCli(["daemon", "start", "--json"], output.environmentWith()).then(
      (code) => {
        settled = true;
        return code;
      },
    );
    for (let tick = 0; tick < 700 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(settled, `simlock daemon start still had not settled at ${String(clock.now())}ms`).toBe(
      true,
    );
    expect(await exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(JSON.parse(output.stderr)).toMatchObject({
      error: {
        code: "DAEMON_STARTUP_FAILED",
        message: expect.stringContaining("Timed out starting simlock daemon"),
      },
    });
    expect(launcher.launches).toBe(1);
  });
});

describe("CLI: auto-launch's daemon that exits while starting (#760)", () => {
  it("status fails at once with the daemon's start error when the launched daemon exits with a fatal line", async () => {
    const clock = new FakeClock(0);
    const fatal = JSON.stringify({
      message: "Daemon failed to start",
      fields: { message: "Found /simlock/state.json, remove it" },
    });
    const launcher = new FakeDaemonLauncher(undefined, {
      exit: { code: 1, signal: null },
      output: `older line\n${fatal}\n`,
    });
    const output = outputCapture({
      filesystem: new MemoryFilesystem(),
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: new MemoryIpcTransport(),
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
    });
    let settled = false;
    const exitCode = runCli(["status"], output.environmentWith()).then((code) => {
      settled = true;
      return code;
    });
    for (let tick = 0; tick < 100 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(settled, "status had not settled by 5 s").toBe(true);
    expect(clock.now()).toBeLessThan(20_000);
    expect(await exitCode).toBe(1);
    expect(JSON.parse(output.stderr)).toEqual({
      error: {
        code: "DAEMON_STARTUP_FAILED",
        message: "The daemon could not start: Found /simlock/state.json, remove it",
      },
    });
  });

  it("status names the exit code when the launched daemon's output cannot be read", async () => {
    const clock = new FakeClock(0);
    const launcher = {
      launch: async () => ({
        exited: Promise.resolve({ code: 3, signal: null }),
        readOutput: async (): Promise<string> => {
          throw new Error("daemon.log was replaced");
        },
      }),
    };
    const output = outputCapture({
      filesystem: new MemoryFilesystem(),
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: new MemoryIpcTransport(),
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
    });
    let settled = false;
    const exitCode = runCli(["status"], output.environmentWith()).then((code) => {
      settled = true;
      return code;
    });
    for (let tick = 0; tick < 100 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(settled, "status had not settled by 5 s").toBe(true);
    expect(await exitCode).toBe(1);
    expect(JSON.parse(output.stderr).error.message).toBe(
      "The daemon exited with code 3 while starting; see `simlock daemon logs`",
    );
  });
});

describe("CLI: auto-launch's daemon that lost the socket to another daemon (#760)", () => {
  it("status goes on with the daemon that holds the socket when the launched daemon exits already running", async () => {
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock(0);
    // why: the winner is not listening yet at the first poll after the launch, so the loop reaches
    // the launched daemon's exit before it finds the winner.
    class LateWinnerTransport extends MemoryIpcTransport {
      connects = 0;
      override async connect(endpoint: string): ReturnType<MemoryIpcTransport["connect"]> {
        this.connects += 1;
        if (this.connects === 2) {
          throw new IpcError("endpoint-not-found", `No IPC endpoint at ${endpoint}`, undefined);
        }
        return super.connect(endpoint);
      }
    }
    const ipcTransport = new LateWinnerTransport();
    const launcher = new FakeDaemonLauncher(
      async () => {
        await startInMemoryDaemon({
          adminTokenPath: "/simlock/admin.token",
          filesystem,
          ipcTransport,
          socketPath: "/simlock/daemon.sock",
        });
      },
      {
        exit: { code: 1, signal: null },
        output: `${JSON.stringify({
          message: "Daemon failed to start",
          fields: { message: "Simlock daemon is already running at /simlock/daemon.sock" },
        })}\n`,
      },
    );
    const output = outputCapture({
      filesystem,
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: ipcTransport,
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
    });
    let settled = false;
    const exitCode = runCli(["status"], output.environmentWith()).then((code) => {
      settled = true;
      return code;
    });
    for (let tick = 0; tick < 100 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(settled, "status had not settled by 5 s").toBe(true);
    expect(await exitCode).toBe(0);
    expect(output.stderr).not.toContain("DAEMON_STARTUP_FAILED");
    expect(ipcTransport.connects).toBeGreaterThanOrEqual(3);
  });
});

describe("CLI: auto-launch's handshake cut short by the launched daemon (#684)", () => {
  it.each([
    { closeAfter: "hello", rejectedCredential: false },
    { closeAfter: "request", rejectedCredential: false },
    { closeAfter: "hello", rejectedCredential: true },
    { closeAfter: "request", rejectedCredential: true },
  ] as const)(
    "reports a daemon it launched that answers hello then dies during that start as a failed start, not a lost connection (after $closeAfter, credential rejected: $rejectedCredential)",
    async ({ closeAfter, rejectedCredential }) => {
      // why: this stages the daemon that loses its HTTP port race exactly as the socket shows it
      // to the CLI: absent before the launch, then listening, answering `hello`, and closing on
      // its own `http-start-failed` stop before the command's first real request is answered.
      const dyingDaemon = new HelloThenDeathIpc(closeAfter, rejectedCredential);
      const clock = new FakeClock(0);
      const launcher = new FakeDaemonLauncher(() => {
        dyingDaemon.startListening();
      });
      const output = outputCapture({
        filesystem: new MemoryFilesystem(),
        clock,
        systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
        ipc: dyingDaemon,
        launcher,
        daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
      });
      let settled = false;
      const exitCode = runCli(
        ["daemon", "start", "--json", "--token", "probe"],
        output.environmentWith(),
      ).then((code) => {
        settled = true;
        return code;
      });
      // why: the tick bound is generous because #671 made every module a command loads lazy, so
      // one `daemon start` now passes through several more import turns than when this repro was
      // first staged; the clock is fake and the loop stops the moment the command settles, so the
      // extra headroom pins nothing -- it only keeps a hung command failing on this named
      // assertion instead of on a test timeout.
      for (let tick = 0; tick < 100 && !settled; tick += 1) {
        clock.advance(50);
        await settle();
        await settle();
      }
      expect(
        settled,
        `simlock daemon start still had not settled at ${String(clock.now())}ms`,
      ).toBe(true);

      // why: the staging itself, proven from the fake's side -- the socket was absent until this
      // command launched the daemon and answered `hello` before it closed the connection. Without
      // these the assertion below could be
      // reached by a connection that never saw a daemon at all.
      expect(launcher.launches).toBe(1);
      expect(dyingDaemon.helloReplies).toBe(1);
      expect(dyingDaemon.deaths).toBe(1);
      expect(dyingDaemon.rejectedCredentials).toBe(rejectedCredential ? 1 : 0);

      expect(await exitCode).toBe(1);
      expect(output.stdout).toBe("");
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1)!)).toMatchObject({
        error: {
          code: "DAEMON_STARTUP_FAILED",
          message: expect.stringContaining("daemon"),
        },
      });
    },
  );

  it.each([false, true])(
    "keeps a pre-existing daemon's hello-then-close as DAEMON_CONNECTION_LOST (credential rejected: %s)",
    async (rejectedCredential) => {
      const dyingDaemon = new HelloThenDeathIpc("hello", rejectedCredential);
      dyingDaemon.startListening();
      const launcher = new FakeDaemonLauncher();
      const output = outputCapture({
        ...realCliEnvironmentPorts(),
        ipc: dyingDaemon,
        launcher,
      });

      expect(
        await runCli(["daemon", "start", "--json", "--token", "probe"], output.environmentWith()),
      ).toBe(1);
      expect(launcher.launches).toBe(0);
      expect(dyingDaemon.helloReplies).toBe(1);
      expect(dyingDaemon.deaths).toBe(1);
      expect(output.stdout).toBe("");
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1)!)).toEqual({
        error: { code: "DAEMON_CONNECTION_LOST", message: "Daemon connection closed" },
      });
    },
  );

  it("preserves DAEMON_STOPPING from the startup status probe and closes its client", async () => {
    const daemon = new HelloThenDeathIpc("stopping");
    const launcher = new FakeDaemonLauncher(() => daemon.startListening());
    const output = outputCapture({ ...realCliEnvironmentPorts(), ipc: daemon, launcher });
    expect(await runCli(["daemon", "start", "--token", "probe"], output.environmentWith())).toBe(1);
    expect(launcher.launches).toBe(1);
    expect(daemon.helloReplies).toBe(1);
    expect(daemon.clientCloses).toBe(1);
    expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: "DAEMON_STOPPING" } });
  });

  it("bounds the startup status probe by the original launch deadline and closes its client", async () => {
    const daemon = new HelloThenDeathIpc("silent");
    const clock = new FakeClock(0);
    const launcher = new FakeDaemonLauncher(() => {
      clock.setTimer(19_000, () => daemon.startListening());
    });
    const output = outputCapture({ ...realCliEnvironmentPorts(), ipc: daemon, clock, launcher });
    let settled = false;
    const run = runCli(["daemon", "start", "--token", "probe"], output.environmentWith()).then(
      (code) => {
        settled = true;
        return code;
      },
    );
    for (let tick = 0; tick < 500 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
    }
    expect(settled, "silent startup probe must settle within the launch budget").toBe(true);
    expect(
      clock.now(),
      "probe must use the budget left after the socket appeared",
    ).toBeLessThanOrEqual(20_050);
    expect(clock.now(), "probe must wait out the launch deadline").toBeGreaterThanOrEqual(20_000);
    expect(await run).toBe(1);
    expect(launcher.launches).toBe(1);
    expect(daemon.helloReplies).toBe(1);
    expect(daemon.clientCloses).toBe(1);
    expect(JSON.parse(output.stderr)).toMatchObject({
      error: {
        code: "DAEMON_STARTUP_FAILED",
        message: expect.stringContaining("Timed out starting"),
      },
    });
  });

  it("fails a start with DAEMON_STARTUP_FAILED when the daemon stops reading after hello, without waiting for its side of the close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-wedged-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "daemon.sock");
    const sockets: Socket[] = [];
    let hellos = 0;
    const server = createServer((socket) => {
      sockets.push(socket);
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        for (const line of buffered.split("\n").slice(0, -1)) {
          const frame = JSON.parse(line) as { id: number; type: string };
          if (frame.type !== "hello") continue;
          hellos += 1;
          socket.write(
            `${JSON.stringify({
              id: frame.id,
              ok: true,
              payload: {
                protocolVersion: PROTOCOL_VERSION_RANGE.max,
                daemonProtocolRange: PROTOCOL_VERSION_RANGE,
                version: "0.0.0-test",
                role: "admin",
                principal: "test-requester",
              },
            })}\n`,
          );
          // why: a daemon wedged after `hello` neither answers nor ends its side of the socket.
          socket.pause();
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const real = new NodeIpcTransport();
      let launched = false;
      const clock = new FakeClock(0);
      const launcher = new FakeDaemonLauncher(() => {
        launched = true;
      });
      let probeSent = false;
      const ipc: IpcConnector = {
        connect: async () => {
          if (!launched) throw new IpcError("endpoint-not-found", "not yet", undefined);
          const connection = await real.connect(socketPath);
          const write = connection.write.bind(connection);
          connection.write = async (contents) => {
            await write(contents);
            if ((JSON.parse(contents.trim()) as { type: string }).type === "status.get") {
              probeSent = true;
            }
          };
          return connection;
        },
      };
      const output = outputCapture({ ...realCliEnvironmentPorts(), ipc, clock, launcher });
      let settled = false;
      const run = runCli(["daemon", "start", "--token", "probe"], output.environmentWith()).then(
        (code) => {
          settled = true;
          return code;
        },
      );
      for (let tick = 0; tick < 200 && hellos === 0; tick += 1) {
        clock.advance(50);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(hellos).toBe(1);
      // why: the server observing hello does not mean the client has read its reply and armed
      // the probe deadline; advance the fake clock only after the client sends that probe.
      await expect.poll(() => probeSent).toBe(true);
      clock.advance(20_000);
      await expect.poll(() => settled, { timeout: 2_000 }).toBe(true);
      expect(await run).toBe(1);
      expect(JSON.parse(output.stderr)).toMatchObject({
        error: { code: "DAEMON_STARTUP_FAILED" },
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exits 1 for a socket closed before hello and reports DAEMON_STARTUP_FAILED only after launch", async () => {
    for (const scenario of [
      { launch: false, afterExit: false, code: "DAEMON_CONNECTION_LOST", connects: 1 },
      { launch: true, afterExit: false, code: "DAEMON_STARTUP_FAILED", connects: 2 },
      { launch: true, afterExit: true, code: "DAEMON_STARTUP_FAILED", connects: 3 },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "simlock-closed-"));
      temporaryDirectories.push(directory);
      const socketPath = join(directory, "daemon.sock");
      let accepted = 0;
      // why: the daemon that refuses its history accepts the CLI's connection, then stops and
      // closes it; the CLI is still reading `admin.token` then, so the close lands before `hello`.
      const server = createServer((socket) => {
        accepted += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        const real = new NodeIpcTransport();
        let launched = !scenario.launch;
        const clock = new FakeClock(0);
        const launcher = new FakeDaemonLauncher(
          () => {
            launched = true;
          },
          { exit: { code: 1, signal: null } },
        );
        let connects = 0;
        const ipc: IpcConnector = {
          connect: async () => {
            connects += 1;
            if (!launched || (scenario.afterExit && connects === 2)) {
              throw new IpcError("endpoint-not-found", "not yet", undefined);
            }
            const connection = await real.connect(socketPath);
            await expect.poll(() => connection.closed).toBe(true);
            return connection;
          },
        };
        const output = outputCapture({ ...realCliEnvironmentPorts(), ipc, clock, launcher });
        let settled = false;
        const run = runCli(["daemon", "start", "--token", "probe"], output.environmentWith()).then(
          (code) => {
            settled = true;
            return code;
          },
        );
        for (let tick = 0; tick < 100 && !settled; tick += 1) {
          clock.advance(50);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(launcher.launches).toBe(scenario.launch ? 1 : 0);
        expect(accepted).toBe(1);
        expect(connects).toBe(scenario.connects);
        expect(
          settled,
          `simlock daemon start still had not settled at ${String(clock.now())}ms`,
        ).toBe(true);
        expect(await run).toBe(1);
        expect(output.stdout).toBe("");
        expect(JSON.parse(output.stderr.trim().split("\n").at(-1)!)).toMatchObject({
          error: { code: scenario.code },
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it.each([
    { operation: "pending lease", health: "running" },
    { operation: "pending lease", health: "starting" },
    { operation: "held lease", health: "running" },
    { operation: "in-flight request", health: "running" },
  ] as const)(
    "keeps an auto-launched daemon's death after its startup status probe as DAEMON_CONNECTION_LOST during $operation (status: $health)",
    async ({ operation, health }) => {
      const ipc = new MemoryIpcTransport();
      const clock = new FakeClock(0);
      const requests: string[] = [];
      const replies: string[] = [];
      const connections: IpcConnection[] = [];
      const launcher = new FakeDaemonLauncher(async () => {
        await ipc.listen("/simlock/daemon.sock", (connection) => {
          connections.push(connection);
          connection.onData((contents) => {
            const frame = JSON.parse(contents) as { id: number; type: string };
            requests.push(frame.type);
            const payload =
              frame.type === "hello"
                ? {
                    protocolVersion: PROTOCOL_VERSION_RANGE.max,
                    daemonProtocolRange: PROTOCOL_VERSION_RANGE,
                    version: "0.0.0-test",
                    role: "admin",
                    principal: "test-requester",
                  }
                : frame.type === "lease.request" && operation !== "pending lease"
                  ? detachedGrant
                  : frame.type === "status.get"
                    ? { ...EMPTY_STATUS, daemon: { ...EMPTY_STATUS.daemon, health } }
                    : undefined;
            if (payload === undefined) return;
            replies.push(frame.type);
            void connection.write(`${JSON.stringify({ id: frame.id, ok: true, payload })}\n`);
          });
        });
      });
      const output = outputCapture({
        ...realCliEnvironmentPorts(),
        ipc,
        clock,
        launcher,
      });
      let settled = false;
      const runPromise = runCli(
        operation !== "in-flight request"
          ? ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--token", "probe"]
          : ["simctl", "list", "--token", "probe"],
        output.environmentWith(),
      ).then((code) => {
        settled = true;
        return code;
      });
      const ready = (): boolean =>
        operation === "held lease"
          ? output.stdout !== ""
          : requests.includes(
              operation === "pending lease" ? "lease.request" : "driver.passthrough",
            );
      for (let tick = 0; tick < 100 && !ready() && !settled; tick += 1) {
        clock.advance(50);
        await settle();
        await settle();
      }
      expect(ready()).toBe(true);
      expect(settled).toBe(false);
      expect(launcher.launches).toBe(1);
      expect(connections).toHaveLength(1);
      expect(requests).toContain(
        operation === "in-flight request" ? "driver.passthrough" : "lease.request",
      );
      if (operation === "pending lease") expect(replies).not.toContain("lease.request");
      await connections[0]!.close();
      expect(await runPromise).toBe(1);
      expect(JSON.parse(output.stderr)).toMatchObject({
        error: { code: "DAEMON_CONNECTION_LOST" },
      });
      expect(replies).toContain("status.get");
      if (operation === "held lease") {
        expect(JSON.parse(output.stdout)).toMatchObject({ lease: detachedGrant.lease });
        expect(JSON.parse(output.stderr).error.message).toContain(detachedGrant.lease.id);
        expect(requests).toContain("lease.request");
      } else {
        expect(output.stdout).toBe("");
      }
    },
  );

  it("preserves the daemon's refusal of the first auto-launched request", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const launcher = new FakeDaemonLauncher(async () => {
      await startInMemoryDaemon({
        filesystem,
        ipcTransport: ipc,
        socketPath: "/simlock/daemon.sock",
        adminTokenPath: "/simlock/admin.token",
      });
    });
    const output = outputCapture({
      ...realCliEnvironmentPorts(),
      filesystem,
      ipc,
      launcher,
    });

    expect(
      await runCli(["lease", "--platform", "android", "--detach"], output.environmentWith()),
    ).toBe(12);
    expect(launcher.launches).toBe(1);
    expect(output.stdout).toBe("");
    expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: "NO_DRIVER" } });
  });
});

async function runDaemonStatus(
  testCase: {
    readonly role: "worker" | "gateway";
    readonly running: boolean;
    readonly state: ServiceState | undefined;
  },
  json: boolean,
): Promise<{ readonly stdout: string }> {
  const home = "/Users/me";
  const output = outputCapture();
  const manager =
    testCase.state === undefined ? undefined : new FakeServiceManager({ state: testCase.state });
  const environment = output.environmentWith({
    daemonHome: { role: testCase.role, dataDirectory: "/simlock", gatewayPresent: false },
    connectExistingAdmin: async () => {
      if (!testCase.running) throw new Error("connect ECONNREFUSED");
      return fakeClient();
    },
    service: {
      manager,
      platform: manager === undefined ? "linux" : "darwin",
      user: () => "me",
      definition: async () =>
        serviceDefinition({
          role: testCase.role,
          root: `${home}/.simlock`,
          dataDirectory: "/simlock",
          home,
          nodePath: "/Users/me/.nvm/versions/node/v22.13.0/bin/node",
          mainPath: "/Users/me/simlock/dist/daemon/main.js",
          env: {},
        }),
    },
  });
  await expect(
    runCli(["daemon", "status", ...(json ? ["--json"] : [])], environment),
  ).resolves.toBe(0);
  return output;
}

describe("CLI: daemon status (ADR 0003 §11)", () => {
  it.each([
    { name: "the socket cannot be reached at all", error: () => new Error("connect ECONNREFUSED") },
    {
      name: "a transport-kind SimlockError (connection lost)",
      error: () => simlockError("DAEMON_CONNECTION_LOST"),
    },
  ])("reports stopped when $name", async ({ error }) => {
    const output = outputCapture();
    await expect(
      runCli(
        ["daemon", "status", "--json"],
        output.environmentWith({
          connectExistingAdmin: async () => {
            throw error();
          },
        }),
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({ status: "stopped" });
  });

  it("distinguishes a refused handshake (socket reachable) from an absent socket", async () => {
    const output = outputCapture();
    await expect(
      runCli(
        ["daemon", "status", "--json"],
        output.environmentWith({
          connectExistingAdmin: async () => {
            throw simlockError("ADMIN_AUTHENTICATION_FAILED");
          },
        }),
      ),
    ).resolves.toBe(1);
    const parsed = JSON.parse(output.stdout) as { status: string; error: { code: string } };
    expect(parsed.status).toBe("handshake-refused");
    expect(parsed.error.code).toBe("ADMIN_AUTHENTICATION_FAILED");
  });

  it("never auto-launches the daemon for daemon status", async () => {
    const output = outputCapture();
    let launched = false;
    await runCli(
      ["daemon", "status"],
      output.environmentWith({
        connectAdmin: async () => {
          launched = true;
          return fakeClient();
        },
        connectExistingAdmin: async () => fakeClient(),
      }),
    );
    expect(launched).toBe(false);
  });

  it("prints the human view for daemon status when --json is absent", async () => {
    const output = outputCapture();

    await expect(
      runCli(
        ["daemon", "status"],
        output.environmentWith({ connectExistingAdmin: async () => fakeClient() }),
      ),
    ).resolves.toBe(0);

    expect(output.stdout.split("\n")[0]).toBe("Daemon: running (worker)");
  });

  it("daemon status prints the Service: line and the service field in --json, for a worker or a gateway, running or stopped, and none on an unsupported platform", async () => {
    const home = "/Users/me";
    const node = "/Users/me/.nvm/versions/node/v22.13.0/bin/node";
    const main = "/Users/me/simlock/dist/daemon/main.js";
    const worker = "com.callstack.simlock.worker";
    const gateway = "com.callstack.simlock.gateway";
    const plist = (name: string) => `${home}/Library/LaunchAgents/${name}.plist`;
    const cases: readonly {
      readonly label: string;
      readonly role: "worker" | "gateway";
      readonly running: boolean;
      readonly state: ServiceState | undefined;
      readonly line: string | undefined;
      readonly service: Record<string, unknown> | undefined;
    }[] = [
      {
        label: "not installed, stopped",
        role: "worker",
        running: false,
        state: { state: "not-installed" },
        line: "Service: not installed",
        service: { state: "not-installed", manager: "launchd", name: worker },
      },
      {
        label: "installed, running",
        role: "worker",
        running: true,
        state: { state: "installed", path: plist(worker) },
        line: `Service: installed (launchd, ${worker})`,
        service: { state: "installed", manager: "launchd", name: worker, path: plist(worker) },
      },
      {
        label: "not loaded, running",
        role: "worker",
        running: true,
        state: { state: "not-loaded", path: plist(worker) },
        line: `Service: not loaded (launchd, ${worker}): commands start the daemon without it`,
        service: { state: "not-loaded", manager: "launchd", name: worker, path: plist(worker) },
      },
      {
        label: "Node path gone, stopped",
        role: "worker",
        running: false,
        state: { state: "broken", path: plist(worker), missing: [node] },
        line: `Service: broken (launchd, ${worker}): ${node} is gone; run simlock daemon install`,
        service: {
          state: "broken",
          manager: "launchd",
          name: worker,
          path: plist(worker),
          missing: [node],
        },
      },
      {
        label: "both paths gone, stopped",
        role: "worker",
        running: false,
        state: { state: "broken", path: plist(worker), missing: [node, main] },
        line: `Service: broken (launchd, ${worker}): ${node}, ${main} are gone; run simlock daemon install`,
        service: {
          state: "broken",
          manager: "launchd",
          name: worker,
          path: plist(worker),
          missing: [node, main],
        },
      },
      {
        label: "gateway, running",
        role: "gateway",
        running: true,
        state: { state: "installed", path: plist(gateway) },
        line: `Service: installed (launchd, ${gateway})`,
        service: { state: "installed", manager: "launchd", name: gateway, path: plist(gateway) },
      },
      {
        label: "unsupported platform",
        role: "worker",
        running: true,
        state: undefined,
        line: undefined,
        service: undefined,
      },
    ];
    for (const testCase of cases) {
      const human = await runDaemonStatus(testCase, false);
      const lines = human.stdout.trimEnd().split("\n");
      expect(
        [lines[0], ...lines.filter((line) => line.startsWith("Service:"))],
        testCase.label,
      ).toEqual([
        testCase.running ? "Daemon: running (worker)" : "Daemon stopped",
        ...(testCase.line === undefined ? [] : [testCase.line]),
      ]);
      if (testCase.line !== undefined)
        expect(lines.at(-1), `${testCase.label} last line`).toBe(testCase.line);
      const json = JSON.parse((await runDaemonStatus(testCase, true)).stdout) as {
        readonly service?: unknown;
      };
      expect(json.service, `${testCase.label} --json`).toEqual(testCase.service);
    }
  });

  it("daemon status fails with the service manager's error instead of printing Daemon stopped", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
      connectExistingAdmin: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      service: {
        manager: {
          manager: "launchd",
          state: async () => {
            throw new Error("launchctl timed out");
          },
        } as unknown as ServiceManager,
        platform: "darwin",
        user: () => "me",
        definition: async () =>
          serviceDefinition({
            role: "worker",
            root: "/Users/me/.simlock",
            dataDirectory: "/simlock",
            home: "/Users/me",
            nodePath: "/n",
            mainPath: "/m.js",
            env: {},
          }),
      },
    });

    await expect(runCli(["daemon", "status"], environment)).resolves.not.toBe(0);

    expect(output.stdout).not.toContain("Daemon stopped");
    expect(output.stderr).toContain("launchctl timed out");
  });

  it("asks the daemon to purge orphans only once the operator has confirmed", async () => {
    const output = outputCapture();
    const seen: unknown[] = [];

    await expect(
      runCli(
        ["doctor", "--purge-orphans"],
        output.environmentWith({
          confirm: async () => true,
          connectAdmin: async () =>
            fakeClient({
              runDoctor: (input) => {
                seen.push(input);
                return Promise.resolve({ findings: [] });
              },
            }),
        }),
      ),
    ).resolves.toBe(0);

    expect(seen).toEqual([{ fix: false, purgeOrphans: true }]);
  });

  it("prints one stderr line per prerequisite finding, keeps the JSON report on stdout, and exits 0", async () => {
    const output = outputCapture();
    const findings = [
      {
        kind: "prerequisite-missing" as const,
        message: "The Android emulator package is not installed.",
        platform: "android" as const,
        prerequisite: "android-emulator",
        remedy: "Run `sdkmanager --install emulator`.",
      },
      {
        kind: "prerequisite-missing" as const,
        message: "Xcode is not installed.",
        platform: "ios" as const,
        prerequisite: "xcode",
        remedy: "Run `xcode-select`.",
      },
      { deviceId: "d-1", kind: "expired-live-lease" as const, leaseId: "l-1" },
    ];

    await expect(
      runCli(
        ["doctor"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ runDoctor: () => Promise.resolve({ findings }) }),
        }),
      ),
    ).resolves.toBe(0);

    // why: The harness has no admin credential, so a connection notice precedes these lines.
    expect(output.stderr.split("\n").filter((line) => line.startsWith("Missing"))).toEqual([
      "Missing [android] android-emulator: The Android emulator package is not installed. " +
        "Run `sdkmanager --install emulator`.",
      "Missing [ios] xcode: Xcode is not installed. Run `xcode-select`.",
    ]);
    expect(JSON.parse(output.stdout)).toEqual({ findings });
  });

  it("simlock doctor prints a service-broken finding to stderr, naming each missing path, and keeps the finding in the JSON report", async () => {
    const node = "/Users/me/.nvm/versions/node/v22.13.0/bin/node";
    const main = "/Users/me/simlock/dist/daemon/main.js";
    for (const testCase of [
      {
        missing: [node],
        line: `Service broken: com.callstack.simlock.worker (launchd) names missing ${node}. Run \`simlock daemon install\` again.`,
      },
      {
        missing: [node, main],
        line: `Service broken: com.callstack.simlock.worker (launchd) names missing ${node}, ${main}. Run \`simlock daemon install\` again.`,
      },
    ]) {
      const output = outputCapture();
      const findings = [
        {
          kind: "service-broken" as const,
          manager: "launchd" as const,
          name: "com.callstack.simlock.worker",
          missing: testCase.missing,
          remedy: "Run `simlock daemon install` again.",
        },
      ];

      await expect(
        runCli(
          ["doctor"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({ runDoctor: () => Promise.resolve({ findings }) }),
          }),
        ),
      ).resolves.toBe(0);

      expect(output.stderr.split("\n").filter((line) => line.startsWith("Service broken"))).toEqual(
        [testCase.line],
      );
      expect(JSON.parse(output.stdout)).toEqual({ findings });
    }
  });

  it("simlock doctor prints a driver-advisory finding to stderr as `Warning [<platform>] <code>: <message>`", async () => {
    const output = outputCapture();
    const findings = [
      {
        code: "device-profile-hidden",
        kind: "driver-advisory" as const,
        message: '"Pixel 9" in devices.xml is not used',
        platform: "android" as const,
      },
    ];

    await expect(
      runCli(
        ["doctor"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({ runDoctor: () => Promise.resolve({ findings } as never) }),
        }),
      ),
    ).resolves.toBe(0);

    expect(output.stderr.split("\n")).toContain(
      'Warning [android] device-profile-hidden: "Pixel 9" in devices.xml is not used',
    );
  });

  it("simlock doctor writes agent-device  fail  <message>; <remedy> on stderr for a module-unavailable finding, one line of at most 500 characters per part, after the advisory, prerequisite and warm-pool lines, prints the report on stdout unchanged, and exits 0", async () => {
    const output = outputCapture();
    const findings = [
      {
        kind: "module-unavailable" as const,
        module: "agent-device",
        message: `found 0.20.3,\n  need ${"x".repeat(600)}`,
        remedy: `install agent-device 0.21.28 or later,\nthen ${"y".repeat(600)}`,
      },
      {
        kind: "warm-pool-target-unreachable" as const,
        message: "iOS 27.0 is not installed",
        platform: "ios" as const,
        reason: "runtime-missing" as const,
        remedy: "run simlock component install ios 27.0",
        target: "iPhone 17 / 27.0 / full",
      },
      {
        kind: "prerequisite-missing" as const,
        message: "Xcode is not installed.",
        platform: "ios" as const,
        prerequisite: "xcode",
        remedy: "Run `xcode-select`.",
      },
      {
        code: "slim-runtime-unsupported",
        kind: "driver-advisory" as const,
        message: "detail",
        platform: "ios" as const,
      },
    ];

    await expect(
      runCli(
        ["doctor"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({ runDoctor: () => Promise.resolve({ findings } as never) }),
        }),
      ),
    ).resolves.toBe(0);

    const lines = output.stderr.split("\n");
    const index = lines.findIndex((line) => line.startsWith("agent-device  fail  "));
    expect(index).toBeGreaterThan(-1);
    expect(lines[index]).toBe(
      `agent-device  fail  found 0.20.3, need ${"x".repeat(500 - "found 0.20.3, need ".length)}; ${("install agent-device 0.21.28 or later, then " + "y".repeat(600)).slice(0, 500)}`,
    );
    expect(lines.filter((line) => line.startsWith("agent-device"))).toHaveLength(1);
    for (const earlier of ["Warning [ios]", "Missing [ios]", "warm-pool-target-unreachable"]) {
      expect(lines.findIndex((line) => line.startsWith(earlier))).toBeLessThan(index);
      expect(lines.findIndex((line) => line.startsWith(earlier))).toBeGreaterThan(-1);
    }
    expect(JSON.parse(output.stdout)).toEqual({ findings });
  });

  it("simlock doctor writes <module>  fail  … for a finding of another module", async () => {
    const output = outputCapture();
    const findings = [
      {
        kind: "module-unavailable" as const,
        message: "needs\n  tmux",
        module: "other-mod",
        remedy: "install tmux",
      },
    ];

    await runCli(
      ["doctor"],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({ runDoctor: () => Promise.resolve({ findings } as never) }),
      }),
    );

    expect(output.stderr.split("\n")).toContain("other-mod  fail  needs tmux; install tmux");
    expect(output.stderr).not.toContain("agent-device");
  });

  it("simlock doctor writes no agent-device line when the report has no such finding", async () => {
    const output = outputCapture();
    const findings = [{ deviceId: "d-1", kind: "expired-live-lease" as const, leaseId: "l-1" }];

    await runCli(
      ["doctor"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ runDoctor: () => Promise.resolve({ findings }) }),
      }),
    );

    expect(output.stderr).not.toContain("agent-device");
  });

  it("keeps --purge-orphans off the wire when --fix is all that was asked for", async () => {
    const output = outputCapture();
    const seen: unknown[] = [];

    await expect(
      runCli(
        ["doctor", "--fix"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              runDoctor: (input) => {
                seen.push(input);
                return Promise.resolve({ findings: [] });
              },
            }),
        }),
      ),
    ).resolves.toBe(0);

    // why: The upgrade contract: `doctor --fix` running unattended in CI never becomes
    // destructive on its own (ADR 0001, decision 6).
    expect(seen).toEqual([{ fix: true, purgeOrphans: false }]);
  });

  it.each([
    ["declined", async () => false],
    // why: Explicitly absent: the shared harness defaults `confirm` to an auto-yes, so leaving it
    // out would test the default rather than the no-terminal case.
    ["unavailable", undefined],
  ] as const)(
    "refuses --purge-orphans and contacts nobody when confirmation is %s",
    async (_case, confirm) => {
      const output = outputCapture();
      let connected = false;

      await expect(
        runCli(
          ["doctor", "--purge-orphans"],
          output.environmentWith({
            // why: `exactOptionalPropertyTypes`: an explicitly-absent confirm has to be spread in,
            // not passed as `undefined`.
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

  it("takes --yes as the confirmation, so an unattended purge needs no terminal", async () => {
    const output = outputCapture();
    const seen: unknown[] = [];

    await expect(
      runCli(
        ["doctor", "--purge-orphans", "--yes"],
        output.environmentWith({
          confirm: async () => {
            throw new Error("--yes must not ask");
          },
          connectAdmin: async () =>
            fakeClient({
              runDoctor: (input) => {
                seen.push(input);
                return Promise.resolve({ findings: [] });
              },
            }),
        }),
      ),
    ).resolves.toBe(0);

    expect(seen).toEqual([{ fix: false, purgeOrphans: true }]);
  });
});

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

  it("device --help prints both forms", async () => {
    const result = await runDevice(["device", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("simlock device add --platform <ios|android> <id> [--json]");
    expect(result.stdout).toContain("simlock device remove <id> [--json]");
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
    await messages(["device", "remove", "--platform", "ios", "X"]);
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

describe("CLI: config set validates before writing (ADR 0003 §11)", () => {
  it("rejects an invalid merged config without writing the file", async () => {
    const output = outputCapture();
    let wrote = false;
    await expect(
      runCli(
        ["config", "set", "lease.defaultTtlMs", "not-a-number"],
        output.environmentWith({
          readConfigFile: async () => ({}),
          writeConfigFile: async () => {
            wrote = true;
          },
          validateConfig: async () => {
            throw new Error("lease.defaultTtlMs must be a number");
          },
        }),
      ),
    ).resolves.toBe(2);
    expect(wrote).toBe(false);
    expect(JSON.parse(output.stderr).error.code).toBe("USAGE");
  });

  it("writes the file once validation passes", async () => {
    const output = outputCapture();
    let written: Record<string, unknown> | undefined;
    await expect(
      runCli(
        ["config", "set", "downloads.policy", "never"],
        output.environmentWith({
          readConfigFile: async () => ({}),
          writeConfigFile: async (contents) => {
            written = contents;
          },
          validateConfig: async () => {},
        }),
      ),
    ).resolves.toBe(0);
    expect(written).toEqual({ downloads: { policy: "never" } });
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

  it("starting a gateway refuses to launch when its config.json fails gateway validation", async () => {
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
    expect(exitCode).not.toBe(0);
    expect(launcher.launches).toBe(0);
    expect(output.stderr).toContain("http.enabled");
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

    it("--local daemon start with no daemon listening refuses a joined worker's HTTP conflict before any launch", async () => {
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
      expect(exitCode).not.toBe(0);
      expect(launcher.launches).toBe(0);
      expect(JSON.parse(output.stderr).error.message).toBe(
        'Invalid config value for "http.enabled": expected false when gateway.url is set (joined workers are reached through the gateway)',
      );
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

describe("CLI: token operations go through the daemon", () => {
  it("token create/list/revoke all go through the client, not a local TokenStore", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      createToken: (input) => {
        calls.push("create");
        return Promise.resolve({
          secret: "sec_1",
          token: { id: "tok_1", role: input.role, createdAt: 0 },
        });
      },
      listTokens: () => {
        calls.push("list");
        return Promise.resolve({ tokens: [{ id: "tok_1", role: "operator", createdAt: 0 }] });
      },
      revokeToken: () => {
        calls.push("revoke");
        return Promise.resolve({ revoked: true });
      },
    });
    const environment = outputCapture().environmentWith({ connectAdmin: async () => client });
    await runCli(["token", "create", "--role", "operator"], environment);
    await runCli(["token", "list"], environment);
    await runCli(["token", "revoke", "tok_1"], environment);
    expect(calls).toEqual(["create", "list", "revoke"]);
  });
});

describe("CLI: catalog", () => {
  it("prints a model named after an Object.prototype member with no paired runtime", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  modelAliases: {},
                  classDefaults: {},
                  modelClasses: {},
                  modelRuntimes: {},
                  models: ["constructor"],
                  platform: "ios",
                  runtimes: [],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toContain("    (no class):\n      constructor: (no paired runtime)\n");
  });

  it("prints (none) for a platform with no models", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  modelAliases: {},
                  classDefaults: {},
                  modelClasses: {},
                  modelRuntimes: {},
                  models: [],
                  platform: "android",
                  runtimes: ["35"],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      ["Platform: android", "  Runtimes: 35 (default: (none))", "  Models: (none)", ""].join("\n"),
    );
  });

  it("prints each model with the runtimes it pairs with", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  defaultRuntime: "26.0",
                  modelAliases: {},
                  classDefaults: {},
                  modelClasses: {},
                  modelRuntimes: {
                    "iPhone 16": ["18.4", "26.0"],
                    "iPhone 8": [],
                    "iPhone XS": ["18.4"],
                  },
                  models: ["iPhone 16", "iPhone XS", "iPhone 8"],
                  platform: "ios",
                  runtimes: ["18.4", "26.0"],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      [
        "Platform: ios",
        "  Runtimes: 18.4, 26.0 (default: 26.0)",
        "  Models:",
        "    (no class):",
        "      iPhone 16: 18.4, 26.0",
        "      iPhone XS: 18.4",
        "      iPhone 8: (no paired runtime)",
        "",
      ].join("\n"),
    );
  });

  it("prints each model under its class in the order of the enum, and an unclassed model under (no class)", async () => {
    const catalog = {
      defaultRuntime: "26.0",
      classDefaults: { phone: "iPhone 17", tablet: "iPad Pro" },
      modelAliases: { "iPhone 17": ["iphone-17", "i17"] },
      modelClasses: {
        "Apple TV 4K": "tv" as const,
        "Apple Watch Series 11 (46mm)": "watch" as const,
        "iPad Pro": "tablet" as const,
        "iPhone 17": "phone" as const,
        "iPhone 16": "phone" as const,
      },
      modelRuntimes: {
        "Apple TV 4K": ["26.0"],
        "Apple Watch Series 11 (46mm)": ["26.0"],
        "iPad Pro": ["26.0"],
        "iPhone 16": ["26.0"],
        "iPhone 17": ["26.0"],
        Mystery: [],
      },
      models: [
        "Mystery",
        "Apple Watch Series 11 (46mm)",
        "iPhone 17",
        "Apple TV 4K",
        "iPad Pro",
        "iPhone 16",
      ],
      platform: "ios" as const,
      runtimes: ["26.0"],
      customModels: ["iPhone 16"],
    };
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ getCatalog: () => Promise.resolve({ platforms: [catalog] }) }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      [
        "Platform: ios",
        "  Runtimes: 26.0 (default: 26.0)",
        "  Models:",
        "    phone (default: iPhone 17):",
        "      iPhone 17: 26.0",
        "        Other names: iphone-17, i17",
        "      iPhone 16 (custom): 26.0",
        "    tablet (default: iPad Pro):",
        "      iPad Pro: 26.0",
        "    watch (default: none):",
        "      Apple Watch Series 11 (46mm): 26.0",
        "    tv (default: none):",
        "      Apple TV 4K: 26.0",
        "    (no class):",
        "      Mystery: (no paired runtime)",
        "",
      ].join("\n"),
    );
  });

  it.each([
    {
      field: "classDefaults",
      catalog: {
        classDefaults: { phone: "Pixel 9", tv: "Not Even Listed" },
        modelAliases: {},
        modelClasses: {},
        modelRuntimes: {},
        models: [],
        platform: "android" as const,
        runtimes: [],
      },
    },
    {
      field: "modelClasses",
      catalog: {
        modelAliases: {},
        classDefaults: {},
        modelClasses: { "Pixel 8": "phone" as const, "Odd One": "tv" as const },
        modelRuntimes: {},
        models: ["Pixel 8"],
        platform: "android" as const,
        runtimes: [],
      },
    },
  ])("carries $field in --json as received", async ({ catalog }) => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ getCatalog: () => Promise.resolve({ platforms: [catalog] }) }),
    });

    await expect(runCli(["catalog", "--json"], environment)).resolves.toBe(0);

    expect(JSON.parse(output.stdout)).toEqual({ platforms: [catalog] });
  });

  it("prints (none) for a platform that has images but none installed", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  images: [],
                  modelAliases: {},
                  classDefaults: {},
                  modelClasses: {},
                  modelRuntimes: {},
                  models: [],
                  platform: "android",
                  runtimes: [],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      [
        "Platform: android",
        "  Runtimes: (none) (default: (none))",
        "  Models: (none)",
        "  Images: (none)",
        "",
      ].join("\n"),
    );
  });

  it("prints a model's other names and each image", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  defaultRuntime: "35",
                  images: [
                    { abi: "x86_64", runtime: "34", tag: "default" },
                    { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
                  ],
                  modelAliases: { "Pixel 8": ["pixel_8"] },
                  classDefaults: {},
                  modelClasses: { "Pixel 8": "phone" },
                  modelRuntimes: { "My Tablet": ["34", "35"], "Pixel 8": ["34", "35"] },
                  models: ["My Tablet", "Pixel 8"],
                  platform: "android",
                  runtimes: ["34", "35"],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      [
        "Platform: android",
        "  Runtimes: 34, 35 (default: 35)",
        "  Models:",
        "    phone (default: none):",
        "      Pixel 8: 34, 35",
        "        Other names: pixel_8",
        "    (no class):",
        "      My Tablet: 34, 35",
        "  Images (runtime, tag, ABI):",
        "    34 default x86_64",
        "    35 google_apis arm64-v8a",
        "",
      ].join("\n"),
    );
  });

  it("exits 12 when the daemon refuses with DOWNLOADS_DISABLED", async () => {
    const output = outputCapture();
    const client = fakeClient({
      installComponent: () =>
        Promise.reject(
          new SimlockError("DOWNLOADS_DISABLED", "domain", "downloads.policy is never", {
            policy: "never",
          }),
        ),
    });

    await expect(
      runCli(
        ["component", "install", "ios", "26.4"],
        output.environmentWith({ connectAdmin: async () => client }),
      ),
    ).resolves.toBe(12);
    expect(output.stdout).toBe("");
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
      error: { code: "DOWNLOADS_DISABLED", message: expect.any(String) },
    });
  });

  it.each([
    ["a missing version", ["component", "install", "ios"]],
    ["an extra argument", ["component", "install", "ios", "26.4", "26.5"]],
    ["an unknown platform", ["component", "install", "tvos", "26.4"]],
    ["--json", ["component", "install", "ios", "26.4", "--json"]],
    ["an unknown subcommand", ["component", "uninstall", "ios", "26.4"]],
  ])("exits 2 with USAGE for %s, without asking the daemon", async (_label, argv) => {
    const output = outputCapture();
    let installs = 0;
    const client = fakeClient({
      installComponent: (input) => {
        installs += 1;
        return Promise.resolve({ ...input, component: input.version, outcome: "installed" });
      },
    });

    await expect(
      runCli(argv, output.environmentWith({ connectAdmin: async () => client })),
    ).resolves.toBe(2);
    expect(installs).toBe(0);
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
      error: { code: "USAGE" },
    });
  });

  it.each([[["component"]], [["component", "--help"]], [["component", "install", "--help"]]])(
    "prints the command's usage for %j without connecting to the daemon",
    async (argv) => {
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
      expect(output.stdout).toBe(
        "Usage: simlock component install <ios|android> <version> [--worker <id>... | --all-workers]\n" +
          "       simlock component list [--platform <ios|android>]\n" +
          "       simlock component remove <ios|android> <version> [--dry-run] [--yes]\n",
      );
      expect(connected).toBe(false);
    },
  );
});

describe("CLI: component install on a gateway's workers (ADR 0010 §7)", () => {
  function progressLines(stderr: string): unknown[] {
    return stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown)
      .filter((line) => !Object.hasOwn(line as object, "notice"));
  }

  it("--all-workers prints progress with each worker's id, one result line, and exits 15 when one worker is refused", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const results = [
      { outcome: "installed" as const, version: "35", workerId: "wrk_a" },
      {
        error: { code: "DOWNLOADS_DISABLED", message: "Downloads are disabled" },
        outcome: "refused" as const,
        workerId: "wrk_b",
      },
    ];
    const client = fakeClient({
      installComponentOnWorkers: async (input, options) => {
        asked.push(input);
        options?.onProgress?.({ stage: "waiting", workerId: "wrk_a" });
        options?.onProgress?.({ fraction: 0.5, stage: "downloading", workerId: "wrk_b" });
        return { results };
      },
    });

    await expect(
      runCli(
        ["component", "install", "android", "35", "--all-workers"],
        output.environmentWith({ connectAdmin: async () => client }),
      ),
    ).resolves.toBe(15);

    expect(asked).toEqual([{ platform: "android", version: "35", workers: "all" }]);
    expect(progressLines(output.stderr)).toEqual([
      { stage: "waiting", workerId: "wrk_a" },
      { fraction: 0.5, stage: "downloading", workerId: "wrk_b" },
    ]);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toEqual({ results });
  });

  it("exits 0 when every named worker ends installed or already-installed, and names each --worker given", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const client = fakeClient({
      installComponentOnWorkers: async (input) => {
        asked.push(input);
        return {
          results: [
            { outcome: "installed", version: "26.4", workerId: "wrk_a" },
            { outcome: "already-installed", version: "26.4", workerId: "wrk_b" },
          ],
        };
      },
    });

    await expect(
      runCli(
        ["component", "install", "ios", "26.4", "--worker", "wrk_a", "--worker", "wrk_b"],
        output.environmentWith({ connectAdmin: async () => client }),
      ),
    ).resolves.toBe(0);

    expect(asked).toEqual([{ platform: "ios", version: "26.4", workers: ["wrk_a", "wrk_b"] }]);
  });

  it.each(["skipped", "failed", "unknown"] as const)(
    "exits 15 when a worker ends %s",
    async (outcome) => {
      const output = outputCapture();
      const client = fakeClient({
        installComponentOnWorkers: async () => ({
          results: [
            { outcome: "installed", version: "35", workerId: "wrk_a" },
            { error: { code: "WORKER_UNREACHABLE", message: "gone" }, outcome, workerId: "wrk_b" },
          ],
        }),
      });

      await expect(
        runCli(
          ["component", "install", "android", "35", "--all-workers"],
          output.environmentWith({ connectAdmin: async () => client }),
        ),
      ).resolves.toBe(15);
    },
  );

  it("refuses --worker together with --all-workers as USAGE, without connecting", async () => {
    const output = outputCapture();
    let connected = false;

    await expect(
      runCli(
        ["component", "install", "android", "35", "--worker", "wrk_a", "--all-workers"],
        output.environmentWith({
          connectAdmin: async () => {
            connected = true;
            return fakeClient();
          },
        }),
      ),
    ).resolves.toBe(2);
    expect(connected).toBe(false);
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
      error: { code: "USAGE" },
    });
  });

  it.each([
    "component install <ios|android> <version>",
    "events, stats,",
    "component list [--platform <ios|android>]",
  ])("lists the command in the usage banner: %s", async (fragment) => {
    const output = outputCapture();
    await runCli(["--help"], output.environmentWith({}));
    expect(output.stdout).toContain(fragment);
  });
});

describe("CLI: component list (ADR 0010 §8)", () => {
  const listing = {
    components: [
      {
        devices: 2,
        foreignDevices: 1,
        installedAt: 1_790_864_071_200,
        installedBySimlock: true,
        platform: "android" as const,
        sizeBytes: 4_200_000_000,
        variant: "google_apis/arm64-v8a",
        version: "35",
      },
    ],
  };

  it("prints the daemon's component.list answer as one JSON object on stdout, and exits 0", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const client = fakeClient({
      listComponents: async (input) => {
        asked.push(input);
        return listing;
      },
    });

    await expect(
      runCli(["component", "list"], output.environmentWith({ connectAdmin: async () => client })),
    ).resolves.toBe(0);

    expect(asked).toEqual([{}]);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toEqual(listing);
  });

  it("asks for one platform with --platform", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const client = fakeClient({
      listComponents: async (input) => {
        asked.push(input);
        return { components: [] };
      },
    });

    await expect(
      runCli(
        ["component", "list", "--platform", "ios"],
        output.environmentWith({ connectAdmin: async () => client }),
      ),
    ).resolves.toBe(0);

    expect(asked).toEqual([{ platform: "ios" }]);
  });

  it.each([
    ["an unknown platform", ["component", "list", "--platform", "tvos"]],
    ["a positional argument", ["component", "list", "ios"]],
    ["an unknown flag", ["component", "list", "--json"]],
  ])("exits 2 with USAGE for %s, without asking the daemon", async (_label, argv) => {
    const output = outputCapture();
    let listed = 0;
    const client = fakeClient({
      listComponents: () => {
        listed += 1;
        return Promise.resolve({ components: [] });
      },
    });

    await expect(
      runCli(argv, output.environmentWith({ connectAdmin: async () => client })),
    ).resolves.toBe(2);
    expect(listed).toBe(0);
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
      error: { code: "USAGE" },
    });
  });
});

describe("CLI: worker commands (ADR 0005 §8/§23)", () => {
  const connectedWorker = {
    capacity: {
      android: {
        atRamBudget: false,
        limit: 2,
        maxRunning: 2,
        overLimit: false,
        reserved: 0,
        running: 0,
        used: 0,
        warm: 0,
      },
      global: { maxRunning: 4, overLimit: false, reserved: 0, running: 1, warm: 1 },
      ios: {
        atRamBudget: false,
        limit: 2,
        maxRunning: 2,
        overLimit: false,
        reserved: 0,
        running: 1,
        used: 1,
        warm: 1,
      },
    },
    catalog: [],
    connection: "connected" as const,
    devices: [],
    drained: false,
    id: "wrk_1",
    label: "mac-mini-1",
    lastSeenAt: 1_000,
    leases: [
      {
        deviceId: "dev_1",
        grantedAt: 1,
        id: "lease_1",
        lastRenewedAt: 1,
        idChosenByRequester: false,
        ownerId: "agent-1",
        requesterId: "agent-1",
        ttlDeadline: 2,
        ttlMs: 1,
      },
    ],
  };

  it("renders each worker's state, capacity and lease count", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ listWorkers: () => Promise.resolve({ workers: [connectedWorker] }) }),
    });

    await expect(runCli(["worker", "list"], environment)).resolves.toBe(0);

    expect(output.stdout).toContain("wrk_1 (mac-mini-1): connected -- ios 1/2");
    // why: No host facts on this view yet, so the line ends at the lease count.
    expect(output.stdout).toContain("1 lease(s)\n");
  });

  it("prints each worker's operating system, architecture, and tool versions", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          listWorkers: () =>
            Promise.resolve({
              workers: [
                {
                  ...connectedWorker,
                  host: {
                    arch: "arm64",
                    os: "macOS",
                    osVersion: "15.5",
                    tools: [
                      { build: "16F6", name: "xcode", platform: "ios" as const, version: "16.4" },
                      { name: "emulator", platform: "android" as const, version: "35.4.9" },
                    ],
                  },
                },
              ],
            }),
        }),
    });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toContain(
      "1 lease(s) -- macOS 15.5 arm64; xcode 16.4 (16F6), emulator 35.4.9",
    );
  });

  describe("a worker's Load line", () => {
    const GIB = 2 ** 30;
    const PARTS = {
      cpu: { busyPercent: 34.2, cores: 10, limited: false },
      disk: { freeBytes: 120_688_581_018, totalBytes: 530_857_957_786 },
      memory: {
        availableBytes: 10_522_669_875,
        limited: false,
        pressure: "normal" as const,
        swapUsedBytes: 1_288_490_189,
        totalBytes: 32 * GIB,
      },
    };
    const READING =
      "CPU 34% busy (10 cores) · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk 112.4 GiB of 494.4 GiB free";
    const NOW = 61_000;
    const install = {
      component: "26.4",
      platform: "ios" as const,
      since: 1_000,
      state: "downloading" as const,
      waiters: 2,
    };
    const printWorkers = async (workers: unknown[]) => {
      const output = outputCapture();
      await runCli(
        ["worker", "list"],
        output.environmentWith({
          clock: new FakeClock(NOW),
          connectAdmin: async () =>
            fakeClient({ listWorkers: () => Promise.resolve({ workers } as never) }),
        }),
      );
      return output.stdout;
    };

    it("simlock worker list prints a connected or starting worker's Load line after its own line and before its install lines", async () => {
      const stdout = await printWorkers([
        {
          ...connectedWorker,
          installs: [install],
          load: { ...PARTS, readAt: NOW - 12_000 },
        },
        {
          connection: "connected",
          drained: false,
          health: "starting",
          id: "wrk_2",
          lastSeenAt: 1,
          load: { memory: PARTS.memory, readAt: NOW - 3_000 },
        },
      ]);

      const lines = stdout.trimEnd().split("\n");
      expect(lines[0]).toMatch(/^wrk_1 \(mac-mini-1\): connected -- /);
      expect(lines[1]).toBe(`  Load: ${READING} · read 12s ago`);
      expect(lines[2]).toMatch(/^ {2}Install ios 26\.4: downloading for 60s, 2 waiters$/);
      expect(lines[3]).toMatch(/^wrk_2: connected, starting/);
      expect(lines[4]).toBe(
        "  Load: CPU unavailable · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk unavailable · read 3s ago",
      );
    });

    it("simlock worker list prints `no reading while disconnected` for a disconnected worker, and no Load line for an incompatible one or one that sent none", async () => {
      const stdout = await printWorkers([
        { ...connectedWorker, connection: "disconnected", drained: true, id: "wrk_a" },
        {
          connection: "incompatible",
          drained: false,
          id: "wrk_b",
          lastSeenAt: 1,
          protocol: { gateway: { max: 35, min: 35 }, worker: { max: 4, min: 4 } },
        },
        { ...connectedWorker, id: "wrk_c" },
        { ...connectedWorker, id: "wrk_d", load: { ...PARTS, readAt: NOW - 1_000 } },
      ]);

      const lines = stdout.trimEnd().split("\n");
      const loadAfter = (id: string) => {
        const index = lines.findIndex(
          (line) => line.startsWith(`${id}:`) || line.startsWith(`${id} (`),
        );
        const next = lines[index + 1];
        return next?.startsWith("  Load:") === true ? next : undefined;
      };
      expect(loadAfter("wrk_d")).toBe(`  Load: ${READING} · read 1s ago`);
      expect(loadAfter("wrk_a")).toBe("  Load: no reading while disconnected");
      expect(loadAfter("wrk_b")).toBeUndefined();
      expect(loadAfter("wrk_c")).toBeUndefined();
    });

    it("simlock worker list prints `read 0s ago` for a readAt ahead of its clock", async () => {
      const stdout = await printWorkers([
        { ...connectedWorker, load: { ...PARTS, readAt: NOW + 9_000 } },
      ]);

      expect(stdout).toContain(`  Load: ${READING} · read 0s ago\n`);
    });

    it("simlock worker list rounds a reading's age up to whole seconds", async () => {
      const stdout = await printWorkers([
        { ...connectedWorker, load: { ...PARTS, readAt: NOW - 1_001 } },
      ]);

      expect(stdout).toContain(`  Load: ${READING} · read 2s ago\n`);
    });

    it("simlock status against a gateway prints the gateway's own Load line, and each worker's Load line aged from the status time", async () => {
      const output = outputCapture();
      const status: StatusGetOutput = {
        ...EMPTY_STATUS,
        daemon: {
          health: "running",
          mode: "gateway",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        load: { ageMs: 4_000, ...PARTS },
        workers: [
          {
            catalog: [],
            connection: "connected",
            devices: [],
            drained: false,
            id: "wrk_1",
            lastSeenAt: 1,
            leases: [],
            load: { ...PARTS, readAt: NOW - 12_000 },
          },
        ],
      };

      await runCli(
        ["status"],
        output.environmentWith({
          clock: new FakeClock(NOW),
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );

      expect(output.stdout).toContain(`\nLoad: ${READING} · read 4s ago\n`);
      expect(output.stdout).toContain(`\n  Load: ${READING} · read 12s ago\n`);
    });
  });

  it("prints a starting worker as starting, with its leases unknown rather than none", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          listWorkers: () =>
            Promise.resolve({
              workers: [
                {
                  connection: "connected" as const,
                  drained: true,
                  health: "starting" as const,
                  id: "wrk_1",
                  lastSeenAt: 1,
                },
              ],
            }),
        }),
    });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toBe(
      "wrk_1: connected, starting, drained -- capacity unknown, leases unknown\n",
    );
  });

  it("prints each worker's installs in progress under it", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      clock: new FakeClock(61_000),
      connectAdmin: async () =>
        fakeClient({
          listWorkers: () =>
            Promise.resolve({
              workers: [
                {
                  ...connectedWorker,
                  installs: [
                    {
                      component: "26.4",
                      platform: "ios" as const,
                      since: 1_000,
                      state: "downloading" as const,
                      waiters: 2,
                    },
                  ],
                },
                {
                  ...connectedWorker,
                  id: "wrk_2",
                  installs: [
                    {
                      component: "35",
                      platform: "android" as const,
                      since: 31_000,
                      state: "waiting" as const,
                      waiters: 1,
                    },
                  ],
                },
                { ...connectedWorker, id: "wrk_3", installs: [] },
              ],
            }),
        }),
    });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toContain(
      "1 lease(s)\n  Install ios 26.4: downloading for 60s, 2 waiters\nwrk_2 (mac-mini-1): connected",
    );
    expect(output.stdout).toContain(
      "1 lease(s)\n  Install android 35: waiting for 30s, 1 waiter\nwrk_3 (mac-mini-1): connected",
    );
    expect(output.stdout.match(/Install /g)).toHaveLength(2);
  });

  it("says so plainly when no worker has ever connected", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({ connectAdmin: async () => fakeClient() });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toContain("No workers have connected");
  });

  it("names the protocol skew on an incompatible worker", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          listWorkers: () =>
            Promise.resolve({
              workers: [
                {
                  ...connectedWorker,
                  connection: "incompatible" as const,
                  leases: [],
                  protocol: { gateway: { max: 5, min: 5 }, worker: { max: 4, min: 4 } },
                },
              ],
            }),
        }),
    });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toContain("incompatible");
    expect(output.stdout).toContain("protocol 4-4 vs gateway 5-5");
  });

  it("worker list shows a worker's version, the latest only when newer, and its update stage", async () => {
    const waiting = {
      forced: false,
      from: "0.3.0",
      leases: 2,
      stage: "waiting",
      startedAt: 1_000,
      to: "0.4.0",
    } as const;
    const cases: readonly {
      expected: string;
      latestVersion: string | null;
      update: WorkerView["update"];
      version: string | undefined;
    }[] = [
      {
        expected: " -- simlock 0.3.0 (0.4.0 available) -- updating to 0.4.0: waiting for 2 leases",
        latestVersion: "0.4.0",
        update: waiting,
        version: "0.3.0",
      },
      {
        expected: " -- simlock 0.3.0 (0.4.0 available) -- updating to 0.4.0: installing",
        latestVersion: "0.4.0",
        update: {
          forced: false,
          from: "0.3.0",
          stage: "installing",
          startedAt: 1_000,
          to: "0.4.0",
        },
        version: "0.3.0",
      },
      {
        expected: " -- updating to 0.4.0: waiting for 1 lease",
        latestVersion: null,
        update: { ...waiting, leases: 1 },
        version: undefined,
      },
      { expected: " -- simlock 0.4.0", latestVersion: "0.4.0", update: null, version: "0.4.0" },
      { expected: " -- simlock 0.5.0", latestVersion: "0.4.0", update: null, version: "0.5.0" },
      { expected: " -- simlock 0.4.0", latestVersion: null, update: null, version: "0.4.0" },
    ];
    for (const { expected, latestVersion, update, version } of cases) {
      const output = outputCapture();
      const worker = {
        ...connectedWorker,
        latestVersion,
        update,
        ...(version === undefined ? {} : { version }),
      };
      const environment = output.environmentWith({
        connectAdmin: async () =>
          fakeClient({ listWorkers: () => Promise.resolve({ workers: [worker] }) }),
      });

      await runCli(["worker", "list"], environment);

      expect(output.stdout.trimEnd().slice(-expected.length)).toBe(expected);
      if (!expected.includes("available")) expect(output.stdout).not.toContain("available");
      if (update === null) expect(output.stdout).not.toContain("updating");
    }
  });

  it("emits the raw contract value under --json", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ listWorkers: () => Promise.resolve({ workers: [connectedWorker] }) }),
    });

    await runCli(["worker", "list", "--json"], environment);

    expect(JSON.parse(output.stdout)).toMatchObject({ workers: [{ id: "wrk_1" }] });
  });

  it("drains, undrains and removes by id", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      drainWorker: (input) => {
        calls.push(`drain:${input.workerId}`);
        return Promise.resolve({ drained: true as const, workerId: input.workerId });
      },
      removeWorker: (input) => {
        calls.push(`remove:${input.workerId}`);
        return Promise.resolve({ removed: true, workerId: input.workerId });
      },
      undrainWorker: (input) => {
        calls.push(`undrain:${input.workerId}`);
        return Promise.resolve({ drained: false as const, workerId: input.workerId });
      },
    });
    const environment = outputCapture().environmentWith({ connectAdmin: async () => client });

    await expect(runCli(["worker", "drain", "wrk_1"], environment)).resolves.toBe(0);
    await expect(runCli(["worker", "undrain", "wrk_1"], environment)).resolves.toBe(0);
    await expect(runCli(["worker", "remove", "wrk_2"], environment)).resolves.toBe(0);

    expect(calls).toEqual(["drain:wrk_1", "undrain:wrk_1", "remove:wrk_2"]);
  });

  it("requires a worker id, and rejects an unknown subcommand", async () => {
    const environment = outputCapture().environmentWith({
      connectAdmin: async () => fakeClient(),
    });

    await expect(runCli(["worker", "drain"], environment)).resolves.toBe(2);
    await expect(runCli(["worker", "explode"], environment)).resolves.toBe(2);
  });

  it("prints usage without connecting to anything", async () => {
    const output = outputCapture();
    let connected = false;
    const environment = output.environmentWith({
      connectAdmin: async () => {
        connected = true;
        return fakeClient();
      },
    });

    await expect(runCli(["worker"], environment)).resolves.toBe(0);

    expect(output.stdout).toContain("simlock worker list");
    expect(connected).toBe(false);
  });

  it("mints a worker join token (ADR 0005 §8)", async () => {
    const roles: string[] = [];
    const client = fakeClient({
      createToken: (input) => {
        roles.push(input.role);
        return Promise.resolve({
          secret: "sec_join",
          token: { createdAt: 0, id: "tok_1", role: input.role },
        });
      },
    });
    const output = outputCapture();
    const environment = output.environmentWith({ connectAdmin: async () => client });

    await expect(runCli(["token", "create", "--role", "worker"], environment)).resolves.toBe(0);

    expect(roles).toEqual(["worker"]);
    expect(JSON.parse(output.stdout)).toMatchObject({ token: { role: "worker" } });
  });

  it("still rejects a role that is not one of the three", async () => {
    const environment = outputCapture().environmentWith({
      connectAdmin: async () => fakeClient(),
    });

    await expect(runCli(["token", "create", "--role", "root"], environment)).resolves.toBe(2);
  });
});

describe("CLI: alerts test (ADR 0035 §1)", () => {
  const USAGE = "Usage: simlock alerts test <destination> [--json]\n";
  const errorLine = (stderr: string): unknown => JSON.parse(stderr.trim().split("\n").at(-1) ?? "");

  async function runAlerts(argv: string[], overrides: Partial<SimlockAdminClient> = {}) {
    const output = outputCapture();
    const inputs: unknown[] = [];
    let connected = false;
    const code = await runCli(
      argv,
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient({
            testAlertDestination: (input) => {
              inputs.push(input);
              return Promise.resolve({ destination: input.destination, status: 204 });
            },
            ...overrides,
          });
        },
      }),
    );
    return { code, connected, inputs, stderr: output.stderr, stdout: output.stdout };
  }

  it("simlock alerts test prints the sent line, --json prints the output, a missing name prints the Expected line, simlock alerts and --help print the usage, and an unknown subcommand is a usage error", async () => {
    const sent = await runAlerts(["alerts", "test", "ops-slack"]);
    expect([sent.code, sent.stdout, sent.inputs]).toEqual([
      0,
      "Sent a test message to ops-slack: HTTP 204\n",
      [{ destination: "ops-slack" }],
    ]);

    const json = await runAlerts(["alerts", "test", "ops-slack", "--json"]);
    expect([json.code, json.stdout]).toEqual([0, '{"destination":"ops-slack","status":204}\n']);

    for (const argv of [["alerts"], ["alerts", "--help"], ["alerts", "test", "--help"]]) {
      const usage = await runAlerts(argv);
      expect([usage.code, usage.stdout, usage.stderr, usage.connected]).toEqual([
        0,
        USAGE,
        "",
        false,
      ]);
    }

    for (const [argv, message] of [
      [["alerts", "test"], "Expected destination (run `simlock --help` for usage)"],
      [["alerts", "foo"], "Unknown alerts command: foo (run `simlock --help` for usage)"],
    ] as const) {
      const refused = await runAlerts([...argv]);
      expect(refused.code).toBe(2);
      expect(refused.connected).toBe(false);
      expect(JSON.parse(refused.stderr)).toEqual({ error: { code: "USAGE", message } });
    }
  });

  it("simlock alerts test exits 1 on ALERT_SEND_FAILED and 12 on UNKNOWN_ALERT_DESTINATION with the error line", async () => {
    const failed = await runAlerts(["alerts", "test", "ops-slack"], {
      testAlertDestination: () =>
        Promise.reject(
          new SimlockError("ALERT_SEND_FAILED", "transport", "ops-slack answered HTTP 404", {
            destination: "ops-slack",
            status: 404,
          }),
        ),
    });
    expect([failed.code, failed.stdout, errorLine(failed.stderr)]).toEqual([
      1,
      "",
      { error: { code: "ALERT_SEND_FAILED", message: "ops-slack answered HTTP 404" } },
    ]);

    const unknown = await runAlerts(["alerts", "test", "nope"], {
      testAlertDestination: () =>
        Promise.reject(
          new SimlockError("UNKNOWN_ALERT_DESTINATION", "domain", "No alert destination named", {
            destination: "nope",
          }),
        ),
    });
    expect([unknown.code, errorLine(unknown.stderr)]).toEqual([
      12,
      { error: { code: "UNKNOWN_ALERT_DESTINATION", message: "No alert destination named" } },
    ]);
  });
});

describe("CLI: status renders the fleet a gateway reports (ADR 0005 §20)", () => {
  it("names the mode, each worker, and which worker a device and a lease live on", async () => {
    const output = outputCapture();
    const status = {
      capacity: {
        android: {
          atRamBudget: false,
          limit: 0,
          maxRunning: 0,
          overLimit: false,
          reserved: 0,
          running: 0,
          used: 0,
          warm: 0,
        },
        global: { maxRunning: 2, overLimit: false, reserved: 0, running: 1, warm: 0 },
        ios: {
          atRamBudget: false,
          limit: 2,
          maxRunning: 2,
          overLimit: false,
          reserved: 0,
          running: 1,
          used: 1,
          warm: 0,
        },
      },
      daemon: {
        health: "running" as const,
        mode: "gateway" as const,
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: { arch: "x64", os: "Linux", osVersion: "6.8.0", tools: [] },
      devices: [
        {
          physical: false,
          id: "dev_1",
          spec: {
            physical: false,
            model: "iPhone 17",
            osVersion: "26.0",
            platform: "ios" as const,
          },
          mode: "full" as const,
          servesDefaultMode: true,
          state: "leased" as const,
          workerId: "wrk_1",
        },
      ],
      leases: [
        {
          deviceId: "dev_1",
          grantedAt: 1,
          id: "lease_1",
          lastRenewedAt: 1,
          idChosenByRequester: false,
          ownerId: "agent-1",
          requesterId: "agent-1",
          ttlDeadline: 2,
          ttlMs: 1,
          workerId: "wrk_1",
        },
      ],
      queueDepth: 0,
      workers: [
        {
          capacity: undefined,
          catalog: [],
          connection: "connected" as const,
          devices: [],
          drained: true,
          id: "wrk_1",
          lastSeenAt: 1,
          leases: [],
        },
      ],
    };
    const environment = output.environmentWith({
      connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
    });

    await runCli(["status"], environment);

    expect(output.stdout).toContain("Daemon: running (gateway)");
    // why: A gateway runs no drivers: its host line names the machine and nothing after it.
    expect(output.stdout).toContain("Host: Linux 6.8.0 x64\n");
    expect(output.stdout).toContain("wrk_1: connected, drained");
    expect(output.stdout).toContain(
      "Device dev_1 on wrk_1: leased, mode full, serves default mode: yes",
    );
    expect(output.stdout).toContain("Lease lease_1: agent-1 on wrk_1");
  });

  describe("the warm pool block", () => {
    const warmPool = {
      enabled: true,
      reserveRunning: { android: 0, ios: 1 },
      targets: [
        {
          booting: 1,
          count: 2,
          mode: "full" as const,
          model: "iPhone 17",
          origin: "configured" as const,
          osVersion: "26.0",
          platform: "ios" as const,
          ready: 1,
        },
        {
          booting: 0,
          count: 1,
          mode: "full" as const,
          model: "iPhone 17",
          origin: "learned" as const,
          osVersion: "27.0",
          platform: "ios" as const,
          ready: 0,
          short: "runtime-missing" as const,
        },
        {
          booting: 0,
          count: 1,
          imageTag: "google_apis_playstore",
          mode: "full" as const,
          model: "Pixel 8",
          origin: "learned" as const,
          osVersion: "35",
          platform: "android" as const,
          ready: 1,
        },
      ],
    };
    const statusWith = (block: StatusGetOutput["warmPool"]) =>
      fakeClient({ getStatus: () => Promise.resolve({ ...EMPTY_STATUS, warmPool: block }) });

    it("simlock status prints the origin word on every warm pool line, learned lines included, the tag in the name, and a learned line's short:", async () => {
      const output = outputCapture();

      await runCli(
        ["status"],
        output.environmentWith({ connectAdmin: async () => statusWith(warmPool) }),
      );

      expect(output.stdout).toContain(
        "warm pool: enabled, reserve ios 1 android 0\n" +
          "  iPhone 17 / 26.0 / full   configured   wanted 2  ready 1  booting 1\n" +
          "  iPhone 17 / 27.0 / full   learned   wanted 1  ready 0  booting 0  short: runtime-missing\n" +
          "  Pixel 8 / 35 / full / google_apis_playstore   learned   wanted 1  ready 1  booting 0\n",
      );
    });

    it("simlock status leaves the runtime out of a target that names none", async () => {
      const output = outputCapture();
      const unversioned = {
        enabled: true,
        reserveRunning: { android: 0, ios: 0 },
        targets: [
          {
            booting: 0,
            count: 1,
            mode: "slim" as const,
            model: "iPhone 17",
            origin: "configured" as const,
            platform: "ios" as const,
            ready: 0,
          },
        ],
      };

      await runCli(
        ["status"],
        output.environmentWith({ connectAdmin: async () => statusWith(unversioned) }),
      );

      expect(output.stdout).toContain(
        "warm pool: enabled, reserve ios 0 android 0\n" +
          "  iPhone 17 / slim   configured   wanted 1  ready 0  booting 0\n",
      );
    });

    it("simlock status prints a pool that is off as disabled, with every target short disabled", async () => {
      const output = outputCapture();
      const off = {
        enabled: false,
        reserveRunning: { android: 0, ios: 0 },
        targets: warmPool.targets.slice(0, 1).map((target) => ({
          ...target,
          booting: 0,
          ready: 0,
          short: "disabled" as const,
        })),
      };

      await runCli(
        ["status"],
        output.environmentWith({ connectAdmin: async () => statusWith(off) }),
      );

      expect(output.stdout).toContain(
        "warm pool: disabled, reserve ios 0 android 0\n" +
          "  iPhone 17 / 26.0 / full   configured   wanted 2  ready 0  booting 0  short: disabled\n",
      );
    });

    it.each([
      {
        name: "worker whose answer has no block",
        mode: "worker" as const,
        warmPool: undefined,
      },
      {
        name: "gateway whose own block is empty",
        mode: "gateway" as const,
        warmPool: { enabled: false, reserveRunning: { android: 0, ios: 0 }, targets: [] },
      },
    ])("simlock status prints no warm pool line for a $name", async ({ mode, warmPool }) => {
      const output = outputCapture();

      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              getStatus: () =>
                Promise.resolve({
                  ...EMPTY_STATUS,
                  daemon: {
                    health: "running" as const,
                    mode,
                    version: "0.0.0-test",
                    update: null,
                    lastUpdateFailure: null,
                    latestVersion: null,
                  },
                  warmPool,
                }),
            }),
        }),
      );

      expect(output.stdout).toBe(
        `Daemon: running (${mode})\n` +
          "Simlock: 0.0.0-test\n" +
          "Host: macOS 15.5 arm64\n" +
          "Running global: 0 + 0 reserved/2, warm 0\n" +
          "Capacity ios: managed 0/1, running 0 + 0 reserved/1, warm 0\n" +
          "Capacity android: managed 0/1, running 0 + 0 reserved/1, warm 0\n" +
          "Queue depth: 0\n",
      );
    });

    it.each(["worker", "gateway"] as const)(
      "simlock status of a %s with queueDepth 2 and physicalQueueDepth 1 prints Queue depth: 2",
      async (mode) => {
        const output = outputCapture();
        const answer = {
          ...EMPTY_STATUS,
          daemon: { ...EMPTY_STATUS.daemon, mode },
          physicalQueueDepth: 1,
          queueDepth: 2,
        } as unknown as StatusGetOutput;

        await runCli(
          ["status"],
          output.environmentWith({
            connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(answer) }),
          }),
        );

        expect(output.stdout).toBe(
          `Daemon: running (${mode})\n` +
            "Simlock: 0.0.0-test\n" +
            "Host: macOS 15.5 arm64\n" +
            "Running global: 0 + 0 reserved/2, warm 0\n" +
            "Capacity ios: managed 0/1, running 0 + 0 reserved/1, warm 0\n" +
            "Capacity android: managed 0/1, running 0 + 0 reserved/1, warm 0\n" +
            "Queue depth: 2\n",
        );
      },
    );

    it("simlock status --json carries the block as the daemon sent it", async () => {
      const output = outputCapture();

      await runCli(
        ["status", "--json"],
        output.environmentWith({ connectAdmin: async () => statusWith(warmPool) }),
      );

      expect(JSON.parse(output.stdout).warmPool).toEqual(warmPool);
    });

    it("simlock doctor prints one stderr line per unreachable warm pool target, keeps the JSON report on stdout, and exits 0", async () => {
      const output = outputCapture();
      const findings = [
        {
          kind: "warm-pool-target-unreachable" as const,
          message: "iOS 27.0 is not installed",
          platform: "ios" as const,
          reason: "runtime-missing" as const,
          remedy: "run simlock component install ios 27.0",
          target: "iPhone 17 / 27.0 / full",
        },
        {
          kind: "warm-pool-target-unreachable" as const,
          message: "the targets want 4 running devices, and the running limit leaves room for 3",
          reason: "over-limit" as const,
          remedy: "lower the counts of the warmPool.targets, or raise the running limit",
          target: "all targets",
        },
        { deviceId: "d-1", kind: "expired-live-lease" as const, leaseId: "l-1" },
      ];

      await expect(
        runCli(
          ["doctor"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({ runDoctor: () => Promise.resolve({ findings }) }),
          }),
        ),
      ).resolves.toBe(0);

      expect(
        output.stderr
          .split("\n")
          .filter((line) => line.includes("warm-pool-target-unreachable") || line.includes("d-1")),
      ).toEqual([
        "warm-pool-target-unreachable  iPhone 17 / 27.0 / full: iOS 27.0 is not installed; run simlock component install ios 27.0",
        "warm-pool-target-unreachable  all targets: the targets want 4 running devices, and the running limit leaves room for 3; lower the counts of the warmPool.targets, or raise the running limit",
      ]);
      expect(output.stderr).not.toContain("undefined");
      expect(JSON.parse(output.stdout)).toEqual({ findings });
    });
  });

  describe("against a starting daemon", () => {
    const STARTING: StatusGetOutput = {
      daemon: {
        health: "starting",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
    };

    it("simlock status prints the starting line and no device, lease or capacity line", async () => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(STARTING) }),
        }),
      );

      expect(output.stdout).toBe(
        "Daemon: starting (worker)\n" +
          "Simlock: 0.0.0-test\n" +
          "Host: macOS 15.5 arm64\n" +
          "Devices, leases and capacity appear once startup finishes.\n",
      );
    });

    it.each(["capacity", "devices", "leases", "queueDepth"] as const)(
      "simlock status prints the starting line for an answer with no %s, though the rest is there",
      async (missing) => {
        const output = outputCapture();
        const { [missing]: _left, ...answer } = EMPTY_STATUS;
        await runCli(
          ["status"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({ getStatus: () => Promise.resolve(answer as StatusGetOutput) }),
          }),
        );

        expect(output.stdout).toContain(
          "Devices, leases and capacity appear once startup finishes.\n",
        );
        expect(output.stdout).not.toContain("Queue depth");
      },
    );

    it("simlock status --json prints the answer with those fields absent", async () => {
      const output = outputCapture();
      await runCli(
        ["status", "--json"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(STARTING) }),
        }),
      );

      expect(JSON.parse(output.stdout)).toEqual(STARTING);
    });
  });

  it("prints the host line", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getStatus: () =>
            Promise.resolve({
              ...EMPTY_STATUS,
              host: {
                arch: "arm64",
                os: "macOS",
                osVersion: "15.5",
                tools: [
                  { build: "16F6", name: "xcode", platform: "ios" as const, version: "16.4" },
                ],
              },
            }),
        }),
    });

    await runCli(["status"], environment);

    expect(output.stdout).toContain("Host: macOS 15.5 arm64; xcode 16.4 (16F6)\n");
  });

  describe("the Load line", () => {
    const GIB = 2 ** 30;
    const MIB = 2 ** 20;
    const LOAD = {
      ageMs: 4_000,
      cpu: { busyPercent: 34.2, cores: 10, limited: false },
      disk: { freeBytes: 120_688_581_018, totalBytes: 530_857_957_786 },
      memory: {
        availableBytes: 10_522_669_875,
        limited: false,
        pressure: "normal" as const,
        swapUsedBytes: 1_288_490_189,
        totalBytes: 32 * GIB,
      },
    };
    const FULL_LINE =
      "Load: CPU 34% busy (10 cores) · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk 112.4 GiB of 494.4 GiB free · read 4s ago\n";
    const STARTING = {
      daemon: {
        health: "starting" as const,
        mode: "worker" as const,
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
    };

    const print = async (status: StatusGetOutput): Promise<string> => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );
      return output.stdout;
    };
    const loadLine = async (load: StatusGetOutput["load"]): Promise<string> => {
      const stdout = await print({ ...EMPTY_STATUS, load });
      return stdout.split("\n").find((line) => line.startsWith("Load:")) ?? "";
    };

    it("simlock status prints the Load line after the Host line, on a starting daemon and a running one", async () => {
      expect(await print({ ...STARTING, load: LOAD })).toBe(
        "Daemon: starting (worker)\n" +
          "Simlock: 0.0.0-test\n" +
          "Host: macOS 15.5 arm64\n" +
          FULL_LINE +
          "Devices, leases and capacity appear once startup finishes.\n",
      );

      expect(await print({ ...EMPTY_STATUS, load: LOAD })).toContain(
        `Host: macOS 15.5 arm64\n${FULL_LINE}`,
      );
    });

    it("simlock status prints CPU unavailable, memory unavailable or disk unavailable for an absent part, and no swap or pressure part when memory is absent", async () => {
      const { cpu: _cpu, ...withoutCpu } = LOAD;
      const { memory: _memory, ...withoutMemory } = LOAD;
      const { disk: _disk, ...withoutDisk } = LOAD;

      expect(await loadLine(withoutCpu)).toBe(
        "Load: CPU unavailable · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk 112.4 GiB of 494.4 GiB free · read 4s ago",
      );
      expect(await loadLine(withoutMemory)).toBe(
        "Load: CPU 34% busy (10 cores) · memory unavailable · disk 112.4 GiB of 494.4 GiB free · read 4s ago",
      );
      expect(await loadLine(withoutDisk)).toBe(
        "Load: CPU 34% busy (10 cores) · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk unavailable · read 4s ago",
      );
    });

    it("simlock status prints no pressure part when the reading has none, and limit on a limited CPU or memory", async () => {
      const { pressure: _pressure, ...noPressure } = LOAD.memory;

      expect(await loadLine({ ...LOAD, memory: noPressure })).toBe(
        "Load: CPU 34% busy (10 cores) · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · disk 112.4 GiB of 494.4 GiB free · read 4s ago",
      );
      expect(
        await loadLine({
          ...LOAD,
          cpu: { busyPercent: 34.2, cores: 2, limited: true },
          memory: { ...LOAD.memory, availableBytes: 3 * GIB, limited: true, totalBytes: 8 * GIB },
        }),
      ).toBe(
        "Load: CPU 34% busy (2 cores, limit) · memory 3.0 GiB of 8.0 GiB available (limit) · swap 1.2 GiB used · pressure normal · disk 112.4 GiB of 494.4 GiB free · read 4s ago",
      );
    });

    it.each([
      ["swap 0 B", { memory: { ...LOAD.memory, swapUsedBytes: 0 } }, "swap 0 B used"],
      [
        "swap 300 MiB",
        { memory: { ...LOAD.memory, swapUsedBytes: 300 * MIB } },
        "swap 300 MiB used",
      ],
      [
        "swap 1023.6 MiB",
        { memory: { ...LOAD.memory, swapUsedBytes: 1_073_322_394 } },
        "swap 1.0 GiB used",
      ],
      ["busy 34.5", { cpu: { ...LOAD.cpu, busyPercent: 34.5 } }, "CPU 35% busy"],
      ["cores 1", { cpu: { ...LOAD.cpu, cores: 1 } }, "(1 core)"],
      ["cores 0.5", { cpu: { ...LOAD.cpu, cores: 0.5 } }, "(0.5 cores)"],
      ["cores 10", { cpu: { ...LOAD.cpu, cores: 10 } }, "(10 cores)"],
      ["cores 0.01", { cpu: { ...LOAD.cpu, cores: 0.01 } }, "(0.01 cores)"],
      ["cores 0.001", { cpu: { ...LOAD.cpu, cores: 0.001 } }, "(<0.01 cores)"],
      ["ageMs 4001", { ageMs: 4_001 }, "read 5s ago"],
      ["ageMs 0", { ageMs: 0 }, "read 0s ago"],
    ])("simlock status formats %s as in the inputs table", async (_row, change, fragment) => {
      expect(await loadLine(LOAD)).toContain("CPU 34% busy (10 cores)");

      expect(await loadLine({ ...LOAD, ...change })).toContain(fragment);
    });

    it("simlock status prints no Load line when the answer has no load block", async () => {
      expect(await print({ ...EMPTY_STATUS, load: LOAD })).toContain("Load: ");

      expect(await print(EMPTY_STATUS)).not.toContain("Load:");
      expect(await print(STARTING)).not.toContain("Load:");
    });
  });

  it("simlock status prints the console address when HTTP is enabled", async () => {
    const print = async (status: StatusGetOutput) => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );
      return output.stdout;
    };
    const daemon = { ...EMPTY_STATUS.daemon, consoleUrl: "http://127.0.0.1:4700/" };

    expect(await print({ ...EMPTY_STATUS, daemon })).toContain(
      "Daemon: running (worker)\nSimlock: 0.0.0-test\nConsole: http://127.0.0.1:4700/\nHost: ",
    );
    expect(await print(EMPTY_STATUS)).not.toContain("Console:");
  });

  it("simlock daemon start prints the console address when HTTP is enabled", async () => {
    const start = async (status: StatusGetOutput) => {
      const output = outputCapture();
      await runCli(
        ["daemon", "start"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );
      return output.stdout;
    };
    const daemon = { ...EMPTY_STATUS.daemon, consoleUrl: "http://127.0.0.1:4700/" };

    expect(await start({ ...EMPTY_STATUS, daemon })).toBe(
      "Daemon running\nConsole: http://127.0.0.1:4700/\n",
    );
    expect(await start(EMPTY_STATUS)).toBe("Daemon running\n");
  });

  describe("the history lines of simlock status", () => {
    const NOT_WRITTEN = "History: the event history is not being written; see daemon.log.";
    const SET_ASIDE_AT = Date.UTC(2026, 9, 16, 9, 12, 30);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const local = new Date(SET_ASIDE_AT);
    const setAside = `History: the event history was damaged and set aside at ${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}; a fresh one was started.`;

    const statusLines = async (history: StatusGetOutput["history"]): Promise<string[]> => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              getStatus: () =>
                Promise.resolve({
                  ...EMPTY_STATUS,
                  ...(history === undefined ? {} : { history }),
                } as StatusGetOutput),
            }),
        }),
      );
      return output.stdout.trimEnd().split("\n");
    };

    it("prints the not-written line when writing is false, the set-aside line with the local time when setAsideAt is set, both when both hold, and neither otherwise", async () => {
      const healthy = await statusLines({ opened: true, writing: true });
      const notWritten = await statusLines({ opened: false, writing: false });
      const aside = await statusLines({ opened: true, setAsideAt: SET_ASIDE_AT, writing: true });
      const both = await statusLines({ opened: true, setAsideAt: SET_ASIDE_AT, writing: false });

      expect(healthy.filter((line) => line.startsWith("History:"))).toEqual([]);
      expect(notWritten.filter((line) => line.startsWith("History:"))).toEqual([NOT_WRITTEN]);
      expect(aside.filter((line) => line.startsWith("History:"))).toEqual([setAside]);
      expect(both.filter((line) => line.startsWith("History:")).sort()).toEqual(
        [NOT_WRITTEN, setAside].sort(),
      );
    });

    it("prints the rebuilt line with the local time when rebuiltAt is set and the could-not-rebuild line when rebuildFailed is set, and neither otherwise", async () => {
      const rebuiltLine = `History: figures were rebuilt from the event history at ${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}.`;
      const failedLine = "History: figures could not be rebuilt; see daemon.log.";
      const plain = await statusLines({ opened: true, writing: true });
      const rebuilt = await statusLines({ opened: true, rebuiltAt: SET_ASIDE_AT, writing: true });
      const failed = await statusLines({ opened: true, rebuildFailed: true, writing: true });

      expect(plain.filter((line) => line.startsWith("History:"))).toEqual([]);
      expect(rebuilt.filter((line) => line.startsWith("History:"))).toEqual([rebuiltLine]);
      expect(failed.filter((line) => line.startsWith("History:"))).toEqual([failedLine]);
    });
  });

  it("prints an install line while one runs and none after", async () => {
    const install = {
      component: "26.4",
      platform: "ios" as const,
      since: 1_000,
      state: "downloading" as const,
      waiters: 1,
    };
    const print = async (installs: StatusGetOutput["installs"]) => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          clock: new FakeClock(43_000),
          connectAdmin: async () =>
            fakeClient({ getStatus: () => Promise.resolve({ ...EMPTY_STATUS, installs }) }),
        }),
      );
      return output.stdout;
    };

    expect(await print([install])).toContain("Install ios 26.4: downloading for 42s, 1 waiter\n");
    expect(await print([])).not.toContain("Install ");
  });

  it("prints an install whose start is ahead of this machine's clock as 0s old, not a negative age", async () => {
    const output = outputCapture();
    const install = {
      component: "26.4",
      platform: "ios" as const,
      since: 5_000,
      state: "waiting" as const,
      waiters: 1,
    };
    await runCli(
      ["status"],
      output.environmentWith({
        clock: new FakeClock(1_000),
        connectAdmin: async () =>
          fakeClient({
            getStatus: () => Promise.resolve({ ...EMPTY_STATUS, installs: [install] }),
          }),
      }),
    );

    expect(output.stdout).toContain("Install ios 26.4: waiting for 0s, 1 waiter\n");
  });

  it("prints a gateway's installs once each, naming the worker, not again under the worker", async () => {
    const output = outputCapture();
    const install = {
      component: "35",
      platform: "android" as const,
      since: 0,
      state: "waiting" as const,
      waiters: 3,
    };
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      daemon: {
        health: "running",
        mode: "gateway",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      installs: [{ ...install, workerId: "wrk_1" }],
      workers: [
        {
          catalog: [],
          connection: "connected",
          devices: [],
          drained: false,
          id: "wrk_1",
          installs: [install],
          lastSeenAt: 1,
          leases: [],
        },
      ],
    };
    const environment = output.environmentWith({
      connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
    });

    await runCli(["status"], environment);

    expect(output.stdout.match(/Install /g)).toHaveLength(1);
    expect(output.stdout).toContain("Install android 35 on wrk_1: waiting for 0s, 3 waiters\n");
  });

  it("prints each device's mode and whether it serves a request naming no mode", async () => {
    const output = outputCapture();
    const spec = {
      physical: false,
      model: "iPhone 17",
      osVersion: "26.0",
      platform: "ios" as const,
    };
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      devices: [
        {
          physical: false,
          id: "dev_slim",
          mode: "slim",
          servesDefaultMode: false,
          spec,
          state: "ready",
        },
        {
          physical: false,
          id: "dev_full",
          mode: "full",
          servesDefaultMode: true,
          spec,
          state: "leased",
        },
      ],
    };
    const environment = output.environmentWith({
      connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
    });

    await runCli(["status"], environment);

    expect(output.stdout).toContain("Device dev_slim: ready, mode slim, serves default mode: no\n");
    expect(output.stdout).toContain(
      "Device dev_full: leased, mode full, serves default mode: yes\n",
    );
  });

  it("prints the RAM budget, marked over limit when over, and no RAM line when the daemon reports none", async () => {
    type RamBudget = NonNullable<NonNullable<StatusGetOutput["capacity"]>["ramBudget"]>;
    const statusWith = (ramBudget?: RamBudget) => {
      const status: StatusGetOutput = {
        ...EMPTY_STATUS,
        capacity: { ...EMPTY_STATUS.capacity, ...(ramBudget === undefined ? {} : { ramBudget }) },
      };
      return status;
    };
    const print = async (status: StatusGetOutput) => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );
      return output.stdout;
    };
    const gib = 1024 ** 3;

    expect(
      await print(statusWith({ limitBytes: 12 * gib, overLimit: false, usedBytes: 4.5 * gib })),
    ).toContain("RAM budget: 4.50 GiB/12.00 GiB used\n");
    expect(
      await print(statusWith({ limitBytes: 12 * gib, overLimit: true, usedBytes: 13 * gib })),
    ).toContain("RAM budget: 13.00 GiB/12.00 GiB used (over limit)\n");
    expect(await print(statusWith())).not.toContain("RAM");
  });

  it("prints, per platform, whether the worker is at its RAM budget, after any over-limit mark", async () => {
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      capacity: {
        ...EMPTY_STATUS.capacity,
        android: { ...EMPTY_STATUS.capacity.android, atRamBudget: false },
        ios: { ...EMPTY_STATUS.capacity.ios, atRamBudget: true, overLimit: true },
      },
    };
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    expect(lines).toContain(
      "Capacity ios: managed 0/1, running 0 + 0 reserved/1, warm 0 (over limit) (at RAM budget)",
    );
    expect(lines).toContain("Capacity android: managed 0/1, running 0 + 0 reserved/1, warm 0");
  });

  it("simlock status prints a physical device as physical and its class, with today's markers, and a simulator's line as before", async () => {
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      devices: [
        {
          class: "phone",
          id: "dev_p1",
          physical: true,
          servesDefaultMode: false,
          spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
          state: "ready",
        },
        {
          class: "tablet",
          id: "dev_p2",
          physical: true,
          servesDefaultMode: false,
          spec: { model: "iPad Pro", osVersion: "18.4", physical: true, platform: "ios" },
          state: "quarantined",
          quarantineAttempts: 1,
          workerId: "wrk_1",
        },
        {
          id: "dev_v1",
          mode: "full",
          physical: false,
          servesDefaultMode: true,
          spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
          state: "ready",
        },
      ],
    };
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    expect(lines).toContain("Device dev_p1: ready, physical phone");
    expect(lines).toContain("Device dev_p2 on wrk_1: quarantined, physical tablet (purge retry 1)");
    expect(lines).toContain("Device dev_v1: ready, mode full, serves default mode: yes");
  });

  it("status ends a quarantined device's marker with ; and the cause for each kind, and prints today's marker when there is no cause", async () => {
    const quarantined = (
      id: string,
      quarantineCause?: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id,
      mode: "full",
      physical: false,
      quarantineAttempts: 1,
      quarantineNextRetryAt: 1_760_619_150_000,
      servesDefaultMode: true,
      spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
      state: "quarantined",
      ...(quarantineCause === undefined ? {} : { quarantineCause }),
    });
    const status = {
      ...EMPTY_STATUS,
      devices: [
        quarantined("dev_purge", {
          kind: "purge-failed",
          message: "DriverCrashError: simctl erase exited 164, then stalled",
        }),
        quarantined("dev_shutdown", {
          kind: "shutdown-failed",
          message: "Error: shutdown exploded",
        }),
        quarantined("dev_delete", { kind: "delete-failed", message: "Error: delete exploded" }),
        quarantined("dev_prov", { kind: "stalled", stalledState: "provisioning" }),
        quarantined("dev_recl", { kind: "stalled", stalledState: "reclaiming" }),
        quarantined("dev_none"),
      ],
    } as unknown as StatusGetOutput;
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    const head =
      "quarantined, mode full, serves default mode: yes (purge retry 1, next retry at 1760619150000";
    expect(lines).toContain(
      `Device dev_purge: ${head}; purge failed: DriverCrashError: simctl erase exited 164, then stalled)`,
    );
    expect(lines).toContain(
      `Device dev_shutdown: ${head}; shutdown failed: Error: shutdown exploded)`,
    );
    expect(lines).toContain(`Device dev_delete: ${head}; delete failed: Error: delete exploded)`);
    expect(lines).toContain(`Device dev_prov: ${head}; stalled while provisioning)`);
    expect(lines).toContain(`Device dev_recl: ${head}; stalled while reclaiming)`);
    expect(lines).toContain(`Device dev_none: ${head})`);
  });

  it("status prints absent (<reason>) as the state of an absent device", async () => {
    const physical = (id: string, state: string, absentReason?: string) => ({
      class: "phone",
      id,
      physical: true,
      servesDefaultMode: false,
      spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
      state,
      ...(absentReason === undefined ? {} : { absentReason }),
    });
    const status = {
      ...EMPTY_STATUS,
      devices: [
        physical("dev_ready", "ready"),
        physical("dev_locked", "absent", "locked"),
        physical("dev_untrusted", "absent", "untrusted"),
        physical("dev_gone", "absent", "not-present"),
      ],
    } as unknown as StatusGetOutput;
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    expect(lines).toContain("Device dev_ready: ready, physical phone");
    expect(lines).toContain("Device dev_locked: absent (locked), physical phone");
    expect(lines).toContain("Device dev_untrusted: absent (untrusted), physical phone");
    expect(lines).toContain("Device dev_gone: absent (not-present), physical phone");
  });

  it("status prints a bare state for an absent device with no reason and for a device that is not absent", async () => {
    const physical = (id: string, state: string, absentReason?: string) => ({
      class: "phone",
      id,
      physical: true,
      servesDefaultMode: false,
      spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
      state,
      ...(absentReason === undefined ? {} : { absentReason }),
    });
    const status = {
      ...EMPTY_STATUS,
      devices: [physical("dev_bare", "absent"), physical("dev_stray", "ready", "locked")],
    } as unknown as StatusGetOutput;
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    expect(lines).toContain("Device dev_bare: absent, physical phone");
    expect(lines).toContain("Device dev_stray: ready, physical phone");
  });

  it("simlock status marks a stalled device", async () => {
    const device = (id: string, extra: object) => ({
      physical: false,
      id,
      mode: "full" as const,
      servesDefaultMode: true,
      spec: { physical: false, model: "iPhone 16", osVersion: "18.4", platform: "ios" as const },
      state: "provisioning" as const,
      ...extra,
    });
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      devices: [
        device("dev_stuck", { stalled: true, transitionAgeMs: 120_000 }),
        device("dev_fresh", { transitionAgeMs: 2_000 }),
      ],
    };
    const output = outputCapture();
    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    expect(output.stdout).toContain(
      "Device dev_stuck: provisioning, mode full, serves default mode: yes (mid-transition 120000ms, stalled)\n",
    );
    expect(output.stdout).toContain(
      "Device dev_fresh: provisioning, mode full, serves default mode: yes (mid-transition 2000ms)\n",
    );
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

  it("writes {push:...} stderr lines for progress, device-unhealthy, and device-recovered as contract values", async () => {
    const output = outputCapture();
    let unhealthyListener: ((push: DeviceUnhealthyPush) => void) | undefined;
    let recoveredListener: ((push: DeviceRecoveredPush) => void) | undefined;
    const client = fakeClient({
      onDeviceUnhealthy: (listener) => {
        unhealthyListener = listener;
        return () => {};
      },
      onDeviceRecovered: (listener) => {
        recoveredListener = listener;
        return () => {};
      },
      requestLease: (_input, options) => {
        options?.onProgress?.({ stage: "provisioning", etaMs: 1_500 });
        unhealthyListener?.({ leaseId: "lse_1", deviceId: "dev_1" });
        recoveredListener?.({ leaseId: "lse_1", deviceId: "dev_1", attempts: 2 });
        return Promise.resolve({
          device: {
            physical: false,
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { physical: false, platform: "ios", model: "x", osVersion: "26.5" },
            mode: "full",
          },
          environment: {},
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            grantedAt: 0,
            lastRenewedAt: 0,
            idChosenByRequester: false,
            ttlMs: 60_000,
            ttlDeadline: 60_000,
          },
          timing: {
            estimatedProvisionMs: 0,
            estimatedBootMs: 0,
            estimatedReclaimMs: 0,
            estimatedReadyMs: 0,
          },
        });
      },
    });
    await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    const lines = output.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual({ push: "progress", stage: "provisioning", etaMs: 1_500 });
    expect(lines).toContainEqual({
      push: "device-unhealthy",
      leaseId: "lse_1",
      deviceId: "dev_1",
    });
    expect(lines).toContainEqual({
      push: "device-recovered",
      leaseId: "lse_1",
      deviceId: "dev_1",
      attempts: 2,
    });
  });

  it("maps --mode and --no-wait onto the contract's mode/noWait input fields", async () => {
    const output = outputCapture();
    let capturedInput: Record<string, unknown> | undefined;
    const client = fakeClient({
      requestLease: (input) => {
        capturedInput = input as unknown as Record<string, unknown>;
        return Promise.resolve({
          device: {
            physical: false,
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { physical: false, platform: "ios", model: "x", osVersion: "26.5" },
            mode: "full",
          },
          environment: {},
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            grantedAt: 0,
            lastRenewedAt: 0,
            idChosenByRequester: false,
            ttlMs: 60_000,
            ttlDeadline: 60_000,
          },
          timing: {
            estimatedProvisionMs: 0,
            estimatedBootMs: 0,
            estimatedReclaimMs: 0,
            estimatedReadyMs: 0,
          },
        });
      },
    });
    await runCli(
      [
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 17 Pro",
        "--detach",
        "--mode",
        "slim",
        "--no-wait",
      ],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    expect(capturedInput?.mode).toBe("slim");
    expect(capturedInput?.noWait).toBe(true);
  });

  it.each([
    {
      flag: "--image-tag",
      field: "imageTag",
      value: "google_apis_playstore",
      lease: ["lease", "--platform", "android", "--device", "Pixel 8", "--detach"],
      flagArgs: ["--image-tag", "google_apis_playstore"],
    },
    {
      flag: "--physical",
      field: "physical",
      value: true,
      lease: ["lease", "--platform", "ios", "--detach"],
      flagArgs: ["--physical"],
    },
  ])(
    "maps $flag onto the contract's $field input field, and sends none without it",
    async ({ field, value, lease, flagArgs }) => {
      const inputs: Record<string, unknown>[] = [];
      const client = fakeClient({
        requestLease: (input) => {
          inputs.push(input as unknown as Record<string, unknown>);
          return Promise.resolve({
            device: {
              class: "phone",
              driverDeviceId: "00008110-001A2B3C4D5E",
              id: "dev_1",
              physical: true,
              spec: {
                class: "phone",
                model: "iPhone 15 Pro",
                osVersion: "18.4",
                physical: true,
                platform: "ios",
              },
            },
            environment: {},
            lease: {
              id: "lse_1",
              deviceId: "dev_1",
              requesterId: "test-requester",
              ownerId: "test-requester",
              grantedAt: 0,
              lastRenewedAt: 0,
              idChosenByRequester: false,
              ttlMs: 60_000,
              ttlDeadline: 60_000,
            },
            timing: {
              estimatedProvisionMs: 0,
              estimatedBootMs: 0,
              estimatedReclaimMs: 0,
              estimatedReadyMs: 0,
            },
          });
        },
      });

      await runCli(
        [...lease, ...flagArgs],
        outputCapture().environmentWith({ connectAdmin: async () => client }),
      );
      await runCli(lease, outputCapture().environmentWith({ connectAdmin: async () => client }));

      expect(inputs[0]?.[field]).toBe(value);
      expect(inputs[1]).not.toHaveProperty(field);
    },
  );

  it("fails the removed full flag as an unknown option, before connecting", async () => {
    const output = outputCapture();
    let connected = false;
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--full"],
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient({});
        },
      }),
    );
    expect(exitCode).toBe(2);
    expect(connected).toBe(false);
    expect(output.stderr).toContain("--full");
  });

  it("omits mode and reports noWait: false when neither flag is given", async () => {
    const output = outputCapture();
    let capturedInput: Record<string, unknown> | undefined;
    const client = fakeClient({
      requestLease: (input) => {
        capturedInput = input as unknown as Record<string, unknown>;
        return Promise.resolve({
          device: {
            physical: false,
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { physical: false, platform: "ios", model: "x", osVersion: "26.5" },
            mode: "full",
          },
          environment: {},
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            grantedAt: 0,
            lastRenewedAt: 0,
            idChosenByRequester: false,
            ttlMs: 60_000,
            ttlDeadline: 60_000,
          },
          timing: {
            estimatedProvisionMs: 0,
            estimatedBootMs: 0,
            estimatedReclaimMs: 0,
            estimatedReadyMs: 0,
          },
        });
      },
    });
    await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    expect(capturedInput).not.toHaveProperty("mode");
    expect(capturedInput?.noWait).toBe(false);
  });
});

describe("CLI: holder renew and release (ADR 0004 §2)", () => {
  it("renews at a third of the TTL the daemon returned, re-deriving the cadence from each renewal", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    const signals = new EventEmitter();
    const renewals: Array<{ leaseId: string; at: number }> = [];
    let released: string | undefined;
    const client = fakeClient({
      renewLease: (input) => {
        renewals.push({ at: clock.now(), leaseId: input.leaseId });
        // why: Half the grant's TTL comes back, so the next renewal must be half as far out too.
        return Promise.resolve({
          deviceId: "dev_1",
          grantedAt: 0,
          id: input.leaseId,
          ownerId: "test-requester",
          requesterId: "test-requester",
          lastRenewedAt: 0,
          idChosenByRequester: false,
          ttlMs: 60_000,
          ttlDeadline: clock.now() + 30_000,
        });
      },
      releaseLease: (input) => {
        released = input.leaseId;
        return Promise.resolve({ leaseId: input.leaseId });
      },
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({
        clock,
        connectAdmin: async () => client,
        signals: signals as unknown as CliEnvironment["signals"],
      }),
    );
    await settle();

    // why: The grant's deadline is 60_000, so the first renewal is due at 20_000 -- and not before.
    clock.advance(19_999);
    await settle();
    expect(renewals).toEqual([]);
    clock.advance(1);
    await settle();
    expect(renewals).toEqual([{ at: 20_000, leaseId: "lse_1" }]);

    // why: 30_000ms of TTL came back at 20_000, so the next renewal is at 30_000, not at 40_000.
    clock.advance(10_000);
    await settle();
    expect(renewals).toEqual([
      { at: 20_000, leaseId: "lse_1" },
      { at: 30_000, leaseId: "lse_1" },
    ]);

    signals.emit("SIGINT");
    expect(await runPromise).toBe(0);
    // why: The release is the CLI's own call, not a side effect of the socket closing.
    expect(released).toBe("lse_1");
    // why: And the timer is gone with it: no renewal can race the release, and nothing keeps the
    // process alive after the command returns.
    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    expect(renewals).toHaveLength(2);
  });

  it("exits 1 on a dead connection, naming the lease that outlived it, and releases nothing", async () => {
    // why: ADR 0004 §3: the daemon released nothing when the socket died, so the lease is still
    // granted -- the holder says so, says until when, and does not pretend to release it.
    const output = outputCapture();
    let connectionLostListener: ((error: AnySimlockError) => void) | undefined;
    let released = false;
    const client = fakeClient({
      onConnectionLost: (listener) => {
        connectionLostListener = listener;
        return () => {};
      },
      releaseLease: () => {
        released = true;
        return Promise.resolve({ leaseId: "lse_1" });
      },
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    // why: Let `requestLease` resolve and `runLease` reach its wait point, so the listener exists.
    await settle();
    connectionLostListener?.(
      new SimlockError("DAEMON_CONNECTION_LOST", "transport", "socket closed", {}),
    );

    expect(await runPromise).toBe(1);
    const line = JSON.parse(output.stderr.trim().split("\n").at(-1) as string) as {
      error: { code: string; message: string };
    };
    expect(line.error.code).toBe("DAEMON_CONNECTION_LOST");
    expect(line.error.message).toContain("lse_1");
    expect(line.error.message).toContain("60000");
    expect(released).toBe(false);
  });

  it("names the latest deadline in that line, not the one the grant carried", async () => {
    // why: The deadline moves on every renewal, and this line is the only place a holder reports
    // it. Quoting the grant-time one would, after about a TTL of uptime, name a moment in the
    // past on a lease that is perfectly alive.
    const clock = new FakeClock(0);
    const output = outputCapture();
    let connectionLostListener: ((error: AnySimlockError) => void) | undefined;
    const client = fakeClient({
      onConnectionLost: (listener) => {
        connectionLostListener = listener;
        return () => {};
      },
      renewLease: (input) =>
        Promise.resolve({
          deviceId: "dev_1",
          grantedAt: 0,
          id: input.leaseId,
          ownerId: "test-requester",
          requesterId: "test-requester",
          lastRenewedAt: clock.now(),
          idChosenByRequester: false,
          ttlMs: 60_000,
          ttlDeadline: clock.now() + 60_000,
        }),
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({ clock, connectAdmin: async () => client }),
    );
    await settle();

    // why: Two renewals: the grant's deadline was 60_000, so they land at 20_000 and 40_000, each
    // answering with a deadline a full TTL further out.
    clock.advance(20_000);
    await settle();
    clock.advance(20_000);
    await settle();

    connectionLostListener?.(
      new SimlockError("DAEMON_CONNECTION_LOST", "transport", "socket closed", {}),
    );
    expect(await runPromise).toBe(1);

    const line = JSON.parse(output.stderr.trim().split("\n").at(-1) as string) as {
      error: { message: string };
    };
    expect(line.error.message).toContain("100000");
    expect(line.error.message).not.toContain("60000");
  });

  it("writes one line for a lost connection, even with a renewal in flight when it dies", async () => {
    // why: The same socket carries both: the connection-lost listener writes the line that names
    // the lease and its deadline, and the `lease.renew` that was in flight rejects with
    // `DAEMON_CONNECTION_LOST`. That rejection is a retryable failure as far as
    // `startLeaseRenewal` knows -- not a `lease-lost` -- so the holder must not answer it with
    // a second line saying the daemon is gone, this one without the lease id a reader needs.
    // Two things stop that, and this pins the outcome rather than either mechanism: the
    // `finally` stops renewal (nothing is reported after `stop()`), and `onError` checks
    // `connectionLost` so the answer does not depend on which of the two microtask chains
    // wins.
    const clock = new FakeClock(0);
    const output = outputCapture();
    let connectionLostListener: ((error: AnySimlockError) => void) | undefined;
    let rejectRenew: ((error: unknown) => void) | undefined;
    const client = fakeClient({
      onConnectionLost: (listener) => {
        connectionLostListener = listener;
        return () => {};
      },
      renewLease: () =>
        new Promise((_resolve, reject) => {
          rejectRenew = reject;
        }),
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({ clock, connectAdmin: async () => client }),
    );
    await settle();

    // why: The grant's deadline is 60_000: the first renewal starts at 20_000 and never answers.
    clock.advance(20_000);
    await settle();
    expect(rejectRenew).toBeDefined();

    // why: The socket dies. In that order, deliberately: `SimlockClient.onConnectionLost` promises
    // that "every in-flight call has already rejected `DAEMON_CONNECTION_LOST` by the time
    // this listener runs", so the renewal's rejection is queued first and its handler runs
    // after the listener has had its say.
    rejectRenew?.(new SimlockError("DAEMON_CONNECTION_LOST", "transport", "socket closed", {}));
    connectionLostListener?.(
      new SimlockError("DAEMON_CONNECTION_LOST", "transport", "socket closed", {}),
    );

    expect(await runPromise).toBe(1);
    const errorLines = output.stderr
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { error?: { code: string; message: string } })
      .filter((line) => line.error !== undefined);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]?.error?.code).toBe("DAEMON_CONNECTION_LOST");
    expect(errorLines[0]?.error?.message).toContain("lse_1");
  });

  it("sends --ttl as the request's own ttlMs, and nothing when it is not given", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const requested: Array<number | undefined> = [];
    const environment = output.environmentWith({
      clock: new FakeClock(0),
      connectAdmin: async () =>
        fakeClient({
          requestLease: (input) => {
            requested.push(input.ttlMs);
            return Promise.resolve(detachedGrant);
          },
        }),
      signals: signals as unknown as CliEnvironment["signals"],
    });
    await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach", "--ttl", "30m"],
      environment,
    );
    await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      environment,
    );

    // why: ADR 0004 §4: `--ttl` replaces `lease.defaultTtlMs` for this lease; omitting it sends no
    // TTL at all, so the daemon's own default applies rather than a number the CLI invented.
    expect(requested).toEqual([30 * 60_000, undefined]);
  });

  it("the CLI --lease-id flag sends leaseId and exits 13 on LEASE_ID_TAKEN", async () => {
    const output = outputCapture();
    const requested: unknown[] = [];
    let answer: "grant" | "taken" = "grant";
    const environment = output.environmentWith({
      clock: new FakeClock(0),
      connectAdmin: async () =>
        fakeClient({
          requestLease: (input) => {
            requested.push("leaseId" in input ? input.leaseId : "absent");
            return answer === "grant"
              ? Promise.resolve(detachedGrant)
              : Promise.reject(
                  fromWireError("LEASE_ID_TAKEN", "lease ID ad-7f3a is already in use", {
                    leaseId: "ad-7f3a",
                  }),
                );
          },
        }),
    });
    const lease = ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"];

    await runCli([...lease, "--lease-id", "ad-7f3a"], environment);
    await runCli(lease, environment);
    answer = "taken";
    const exitCode = await runCli([...lease, "--lease-id", "ad-7f3a"], environment);

    // why: The flag's value goes out as typed and an omitted flag sends none: the contract decides
    // what an ID may look like.
    expect(requested).toEqual(["ad-7f3a", "absent", "ad-7f3a"]);
    expect(exitCode).toBe(13);
    expect(output.stderr).toContain('"code":"LEASE_ID_TAKEN"');
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "releases explicitly on %s (ADR 0004 §2's catchable signals)",
    async (signal) => {
      const output = outputCapture();
      const signals = new EventEmitter();
      let released: string | undefined;
      const client = fakeClient({
        releaseLease: (input) => {
          released = input.leaseId;
          return Promise.resolve({ leaseId: input.leaseId });
        },
      });
      const runPromise = runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
        output.environmentWith({
          clock: new FakeClock(0),
          connectAdmin: async () => client,
          signals: signals as unknown as CliEnvironment["signals"],
        }),
      );
      await settle();
      signals.emit(signal);

      expect(await runPromise).toBe(0);
      expect(released).toBe("lse_1");
    },
  );

  it("reports a failed renewal on stderr and keeps holding the lease", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    const signals = new EventEmitter();
    let released: string | undefined;
    const client = fakeClient({
      renewLease: () =>
        Promise.reject(new SimlockError("INTERNAL", "domain", "could not persist the lease", {})),
      releaseLease: (input) => {
        released = input.leaseId;
        return Promise.resolve({ leaseId: input.leaseId });
      },
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({
        clock,
        connectAdmin: async () => client,
        signals: signals as unknown as CliEnvironment["signals"],
      }),
    );
    await settle();
    clock.advance(20_000);
    await settle();

    const errorLines = output.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.error !== undefined);
    expect(errorLines).toContainEqual({
      error: { code: "INTERNAL", message: "could not persist the lease" },
    });

    // why: A failed renewal is not an exit condition: the holder still holds, and still releases.
    signals.emit("SIGINT");
    expect(await runPromise).toBe(0);
    expect(released).toBe("lse_1");
  });

  it("still closes the connection when stderr cannot take the failed release's error line", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    let closed = false;
    const client = fakeClient({
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      releaseLease: () => Promise.reject(new Error("release failed")),
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({
        clock: new FakeClock(0),
        connectAdmin: async () => client,
        signals: signals as unknown as CliEnvironment["signals"],
        stderr: {
          write: (value: string) => {
            if (value.includes("release failed")) throw new Error("EPIPE");
            return undefined;
          },
        },
      }),
    );
    await vi.waitFor(() => expect(output.stdout).not.toBe(""));

    signals.emit("SIGINT");

    // why: a closed stderr pipe must not skip the dispose and the close that follow the release.
    expect(await runPromise).toBe(0);
    expect(closed).toBe(true);
  });

  it("exits 14 without a farewell release when a renewal is answered UNKNOWN_LEASE", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    let released = false;
    let renewals = 0;
    const client = fakeClient({
      renewLease: () => {
        renewals += 1;
        return Promise.reject(
          new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", { leaseId: "lse_1" }),
        );
      },
      releaseLease: () => {
        released = true;
        return Promise.resolve({ leaseId: "lse_1" });
      },
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({ clock, connectAdmin: async () => client }),
    );
    await settle();
    clock.advance(20_000);

    // why: The daemon's answer is final: this ends the same way the lease-lost push does, rather
    // than repeating the rejection until the deadline and then sitting alive.
    expect(await runPromise).toBe(14);
    expect(released, "asking again would only raise UNKNOWN_LEASE").toBe(false);
    expect(renewals).toBe(1);
    expect(clock.pendingTimerCount).toBe(0);

    // why: The same stderr line the push path writes, so a script tailing for `push: "lease-lost"`
    // sees this way of losing a lease too, with the error line after it as the detail.
    const lines = output.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual({
      push: "lease-lost",
      deviceId: "dev_1",
      leaseId: "lse_1",
      reason: "renew-rejected",
    });
    expect(lines.at(-1)).toEqual({
      error: { code: "UNKNOWN_LEASE", message: "no such lease" },
    });
  });

  it("exits 14 when renewal gives up, rather than holding a lease it cannot keep", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    let released = false;
    const client = fakeClient({
      // why: Never terminal, never successful: the ladder retries until the lease's own deadline
      // passes, and then there is nothing left to hold.
      renewLease: () =>
        Promise.reject(new SimlockError("INTERNAL", "domain", "could not persist", {})),
      releaseLease: () => {
        released = true;
        return Promise.resolve({ leaseId: "lse_1" });
      },
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({ clock, connectAdmin: async () => client }),
    );
    await settle();
    clock.advance(20_000); // first attempt, fails, retries
    await settle();
    clock.advance(60_000); // the retry lands past the lease's 60_000 deadline

    expect(await runPromise).toBe(14);
    expect(released, "a lease that expired is not this process's to release").toBe(false);
    const lines = output.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual({
      push: "lease-lost",
      deviceId: "dev_1",
      leaseId: "lse_1",
      reason: "renew-failed",
    });
  });

  it("writes one lease-lost line when a rejected renewal and the daemon's push both arrive", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    let leaseLostListener:
      | ((push: { leaseId: string; deviceId: string; reason: string }) => void)
      | undefined;
    const client = fakeClient({
      onLeaseLost: (listener) => {
        leaseLostListener = listener;
        return () => {};
      },
      renewLease: () =>
        Promise.reject(
          new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", { leaseId: "lse_1" }),
        ),
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({ clock, connectAdmin: async () => client }),
    );
    await settle();
    clock.advance(20_000);
    await settle();
    // why: The daemon's own push for the same lease follows the renewal's answer. One ending, one
    // line: a script tailing stderr must not read this as two devices lost.
    leaseLostListener?.({ deviceId: "dev_1", leaseId: "lse_1", reason: "expired" });

    expect(await runPromise).toBe(14);
    const leaseLostLines = output.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.push === "lease-lost");
    expect(leaseLostLines).toEqual([
      { push: "lease-lost", deviceId: "dev_1", leaseId: "lse_1", reason: "renew-rejected" },
    ]);
  });

  it("gives up on a farewell release the daemon never answers, instead of hanging", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    const signals = new EventEmitter();
    const client = fakeClient({ releaseLease: () => new Promise(() => {}) });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({
        clock,
        connectAdmin: async () => client,
        signals: signals as unknown as CliEnvironment["signals"],
      }),
    );
    await settle();
    signals.emit("SIGINT");
    await settle();

    clock.advance(RELEASE_TIMEOUT_MS);

    expect(await runPromise).toBe(0);
    expect(output.stderr).toContain("Timed out releasing lease lse_1");
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("still releases the lease when printing the grant throws (--export-env with a bad key)", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    let released: string | undefined;
    const client = fakeClient({
      requestLease: () =>
        Promise.resolve({
          device: {
            physical: false,
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { physical: false, platform: "ios", model: "x", osVersion: "26.5" },
            mode: "full",
          },
          // why: A driver-supplied key that is not a shell identifier fails the command rather than
          // being silently dropped -- and that throw must not cost the device.
          environment: { "NOT A KEY": "value" },
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            grantedAt: 0,
            lastRenewedAt: 0,
            idChosenByRequester: false,
            ttlMs: 60_000,
            ttlDeadline: 60_000,
          },
          timing: {
            estimatedProvisionMs: 0,
            estimatedBootMs: 0,
            estimatedReclaimMs: 0,
            estimatedReadyMs: 0,
          },
        }),
      releaseLease: (input) => {
        released = input.leaseId;
        return Promise.resolve({ leaseId: input.leaseId });
      },
    });
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--export-env"],
      output.environmentWith({ clock, connectAdmin: async () => client }),
    );

    expect(exitCode).toBe(1);
    expect(released, "an exit through a throw is still an exit, and still owes a release").toBe(
      "lse_1",
    );
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("arms no renew timer for --detach: it prints and exits, exactly as before", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    let renewed = 0;
    const client = fakeClient({
      renewLease: () => {
        renewed += 1;
        return Promise.reject(new Error("--detach must not renew"));
      },
    });
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith({ clock, connectAdmin: async () => client }),
    );

    expect(exitCode).toBe(0);
    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    expect(renewed).toBe(0);
  });

  it("stops renewing when the lease is lost, and still does not re-release it", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    let leaseLostListener:
      | ((push: { leaseId: string; deviceId: string; reason: string }) => void)
      | undefined;
    let renewed = 0;
    let released = false;
    const client = fakeClient({
      onLeaseLost: (listener) => {
        leaseLostListener = listener;
        return () => {};
      },
      renewLease: (input) => {
        renewed += 1;
        return Promise.resolve({
          deviceId: "dev_1",
          grantedAt: 0,
          id: input.leaseId,
          ownerId: "test-requester",
          requesterId: "test-requester",
          lastRenewedAt: 0,
          idChosenByRequester: false,
          ttlMs: 60_000,
          ttlDeadline: clock.now() + 60_000,
        });
      },
      releaseLease: () => {
        released = true;
        return Promise.resolve({ leaseId: "lse_1" });
      },
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({ clock, connectAdmin: async () => client }),
    );
    await settle();
    leaseLostListener?.({ deviceId: "dev_1", leaseId: "lse_1", reason: "ttl-backstop" });

    expect(await runPromise).toBe(14);
    expect(released).toBe(false);
    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    expect(renewed).toBe(0);
  });
});

describe("CLI: mcp command (ADR 0003 §11 -- lazy module load)", () => {
  it.each([
    [["--gateway", "mcp"], 0, "gateway"],
    [["mcp", "--gateway"], 0, "gateway"],
    [["mcp"], 0, "none"],
    [["--gateway=yes", "mcp"], 2, undefined],
  ] as const)(
    "--gateway is taken from anywhere in the argv and reaches the command as context.daemonFlag; --gateway=<x> is a usage error (%j)",
    async (argv, exitCode, gateway) => {
      const output = outputCapture();
      const seen: string[] = [];

      const code = await runCli(
        argv,
        output.environmentWith({
          runMcpStdio: async (options) => {
            seen.push(options.daemonFlag ?? "none");
          },
        }),
      );

      expect(code).toBe(exitCode);
      if (gateway === undefined) {
        expect(JSON.parse(output.stderr)).toMatchObject({
          error: { code: "USAGE", message: expect.stringContaining("--gateway takes no value") },
        });
        expect(seen).toEqual([]);
      } else {
        expect(seen).toEqual([gateway]);
      }
    },
  );

  it.each([
    [["--local", "mcp"], 0, "local"],
    [["mcp", "--local"], 0, "local"],
    [["--local=yes", "mcp"], 2, "--local takes no value"],
    [["--local", "--gateway", "mcp"], 2, "--gateway and --local cannot be used together"],
    [["mcp", "--gateway", "--local"], 2, "--gateway and --local cannot be used together"],
  ] as const)(
    "--local is taken from anywhere in the argv; --local=<x> and --local with --gateway are usage errors (%j)",
    async (argv, exitCode, expected) => {
      const output = outputCapture();
      const seen: string[] = [];

      const code = await runCli(
        argv,
        output.environmentWith({
          runMcpStdio: async (options) => {
            seen.push(options.daemonFlag ?? "none");
          },
        }),
      );

      expect(code).toBe(exitCode);
      if (exitCode === 0) {
        expect(seen).toEqual([expected]);
      } else {
        expect(JSON.parse(output.stderr)).toEqual({ error: { code: "USAGE", message: expected } });
        expect(seen).toEqual([]);
      }
    },
  );

  it("does not load the MCP stdio module unless the mcp command runs", async () => {
    const output = outputCapture();
    let loaded = false;
    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient(),
        loadMcpStdio: async () => {
          loaded = true;
          return async () => {};
        },
      }),
    );
    expect(loaded).toBe(false);
  });

  it("loads and runs the stdio runner when the mcp command is dispatched", async () => {
    const output = outputCapture();
    let ran = false;
    const exitCode = await runCli(
      ["mcp"],
      output.environmentWith({
        loadMcpStdio: async () => async () => {
          ran = true;
        },
      }),
    );
    expect(exitCode).toBe(0);
    expect(ran).toBe(true);
  });

  it("reports a startup failure as a structured error instead of throwing raw", async () => {
    const output = outputCapture();
    const exitCode = await runCli(
      ["mcp"],
      output.environmentWith({
        loadMcpStdio: async () => {
          throw new Error("cannot bind mcp stdio transport");
        },
      }),
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(output.stderr)).toEqual({
      error: { code: "INTERNAL", message: "cannot bind mcp stdio transport" },
    });
  });
});

describe("CLI: events history", () => {
  const hour = 3_600_000;

  function envelope(seq: number, timestamp: number, id = `evt_${seq}`) {
    return { id, seq, timestamp, event: "lease.granted", payload: { seq }, module: "leases" };
  }

  function printed(stdout: string): unknown[] {
    if (stdout.trim() === "") return [];
    return stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
  }

  async function historyDirectory(
    prepare: (directory: string) => Promise<void>,
  ): Promise<CliEnvironmentPorts> {
    const directory = await mkdtemp(join(tmpdir(), "simlock-cli-history-"));
    temporaryDirectories.push(directory);
    await prepare(directory);
    return {
      ...realCliEnvironmentPorts(new NodeFilesystem()),
      clock: new FakeClock(2 * hour),
      daemonHome: { role: "worker", dataDirectory: directory, gatewayPresent: false },
    };
  }

  const stopped = (seq: number, timestamp: number) => ({
    event: "daemon.stopping",
    id: `evt_${seq}`,
    module: "daemon",
    payload: { reason: `r${seq}` },
    seq,
    timestamp,
  });

  it("events --since with nothing listening reads history.db and launches no daemon", async () => {
    const ports = await historyDirectory((directory) => seedHistory(directory, [500, hour + 500]));
    const launcher = new FakeDaemonLauncher(() => {
      throw new Error("a daemon was launched");
    });
    const output = outputCapture({ ...ports, launcher });

    const exitCode = await runCli(["events", "--since", "1h"], output.environmentWith());

    expect(launcher.launches).toBe(0);
    expect(exitCode).toBe(0);
    expect(printed(output.stdout)).toEqual([stopped(2, hour + 500)]);
  });

  it("events --since with nothing listening and no history.db prints nothing, exit 0, even beside an old events.jsonl", async () => {
    const bare = outputCapture(await historyDirectory(async () => {}));
    const withOldFile = outputCapture(
      await historyDirectory((directory) =>
        writeFile(join(directory, "events.jsonl"), `${JSON.stringify(envelope(1, hour + 500))}\n`),
      ),
    );

    const codes = [
      await runCli(["events", "--since", "1h"], bare.environmentWith()),
      await runCli(["events", "--since", "1h"], withOldFile.environmentWith()),
    ];

    expect(codes).toEqual([0, 0]);
    expect([bare.stdout, withOldFile.stdout]).toEqual(["", ""]);
  });

  it("events --since with nothing listening and an unreadable history.db prints one JSON error and exits 1", async () => {
    const output = outputCapture(
      await historyDirectory((directory) =>
        writeFile(join(directory, "history.db"), "this is not a sqlite database ".repeat(20)),
      ),
    );

    const exitCode = await runCli(["events", "--since", "1h"], output.environmentWith());

    expect(exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr.trimEnd().split("\n")).toHaveLength(1);
    const printedError = JSON.parse(output.stderr) as { error: { code: string; message: string } };
    expect(printedError.error.code).toBe("INTERNAL");
    expect(printedError.error.message).toMatch(/not a database/);
  });

  it("events --since reports a daemon that refuses the handshake rather than reading the file", async () => {
    const output = outputCapture();
    let fileRead = false;
    const exitCode = await runCli(
      ["events", "--since", "1h"],
      output.environmentWith({
        connectExistingAdmin: async () => {
          throw new SimlockError("PROTOCOL_VERSION_UNSUPPORTED", "protocol", "no overlap", {
            client: { min: 5, max: 5 },
            daemon: { min: 4, max: 4 },
            daemonVersion: "0.9.0",
          });
        },
        readEventHistory: async () => {
          fileRead = true;
          return [];
        },
      }),
    );

    expect(exitCode).not.toBe(0);
    expect(fileRead).toBe(false);
    expect(output.stderr).toContain("PROTOCOL_VERSION_UNSUPPORTED");
  });

  it("events --since with a daemon listening replays through the daemon", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    let fileRead = false;
    const exitCode = await runCli(
      ["events", "--since", "1h"],
      output.environmentWith({
        clock: new FakeClock(2 * hour),
        connectExistingAdmin: async () =>
          fakeClient({
            replayEvents: async (input) => {
              asked.push(input);
              return [envelope(7, hour + 1)];
            },
          }),
        readEventHistory: async () => {
          fileRead = true;
          return [];
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(asked).toEqual([{ sinceTs: hour }]);
    expect(printed(output.stdout)).toEqual([envelope(7, hour + 1)]);
    expect(fileRead).toBe(false);
  });

  it("simlock events --follow prints an event pushed during the replay once", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    let listener: ((push: EventPush) => void) | undefined;
    const push = (seq: number): EventPush => ({
      subscriptionId: "sub_1",
      event: envelope(seq, seq),
    });
    const runPromise = runCli(
      ["events", "--follow"],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            subscribeEvents: async (onEvent) => {
              listener = onEvent;
              return async () => {};
            },
            replayEvents: async () => {
              // why: Emitted after the subscribe and before the replay answers: the replay holds
              // seq 2, and seq 3 lands just after its snapshot.
              listener?.(push(2));
              listener?.(push(3));
              // why: Same seq and timestamp as the replayed event 2, another id: another event.
              listener?.({ subscriptionId: "sub_1", event: envelope(2, 2, "evt_other") });
              return [envelope(1, 1), envelope(2, 2)];
            },
          }),
        signals: signals as unknown as CliEnvironment["signals"],
      }),
    );
    await settle();
    listener?.(push(4));
    signals.emit("SIGINT");

    expect(await runPromise).toBe(0);
    expect(printed(output.stdout)).toEqual([
      envelope(1, 1),
      envelope(2, 2),
      push(3),
      { subscriptionId: "sub_1", event: envelope(2, 2, "evt_other") },
      push(4),
    ]);
  });

  it("events --since --follow prints the history once and then the live events", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const asked: unknown[] = [];
    let listener: ((push: EventPush) => void) | undefined;
    const push = (seq: number): EventPush => ({
      subscriptionId: "sub_1",
      event: envelope(seq, seq),
    });
    const runPromise = runCli(
      ["events", "--since", "1h", "--follow"],
      output.environmentWith({
        clock: new FakeClock(2 * hour),
        connectAdmin: async () =>
          fakeClient({
            subscribeEvents: async (onEvent) => {
              listener = onEvent;
              return async () => {};
            },
            replayEvents: async (input) => {
              asked.push(input);
              listener?.(push(2));
              return [envelope(1, 1), envelope(2, 2)];
            },
          }),
        signals: signals as unknown as CliEnvironment["signals"],
      }),
    );
    await settle();
    listener?.(push(3));
    signals.emit("SIGINT");

    expect(await runPromise).toBe(0);
    expect(asked).toEqual([{ sinceTs: hour }]);
    expect(printed(output.stdout)).toEqual([envelope(1, 1), envelope(2, 2), push(3)]);
  });

  it("events --follow without --since asks for no sinceTs", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const asked: unknown[] = [];
    const runPromise = runCli(
      ["events", "--follow"],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            replayEvents: async (input) => {
              asked.push(input);
              return [];
            },
          }),
        signals: signals as unknown as CliEnvironment["signals"],
      }),
    );
    await settle();
    signals.emit("SIGINT");

    expect(await runPromise).toBe(0);
    expect(asked).toEqual([{}]);
  });
});

describe("CLI: daemon logs (ADR 0003 §11 -- must work when the daemon is dead)", () => {
  it("reads the log file without connecting to the daemon at all", async () => {
    const output = outputCapture();
    let connected = false;
    const exitCode = await runCli(
      ["daemon", "logs"],
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient();
        },
        connectExistingAdmin: async () => {
          connected = true;
          return fakeClient();
        },
        readLogFile: async () => "line one\nline two\n",
      }),
    );
    expect(exitCode).toBe(0);
    expect(connected).toBe(false);
    expect(output.stdout).toBe("line one\nline two\n");
  });

  it("--json wraps the log tail under a logs key, still with no connection attempted", async () => {
    const output = outputCapture();
    let connected = false;
    const exitCode = await runCli(
      ["daemon", "logs", "--json"],
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient();
        },
        connectExistingAdmin: async () => {
          connected = true;
          return fakeClient();
        },
        readLogFile: async () => "only line\n",
      }),
    );
    expect(exitCode).toBe(0);
    expect(connected).toBe(false);
    expect(JSON.parse(output.stdout)).toEqual({ logs: "only line" });
  });
});

describe("CLI: daemon logs --follow", () => {
  async function follow(filesystem: MemoryFilesystem) {
    const clock = new FakeClock(0);
    const signals = new EventEmitter();
    const ports = {
      ...realCliEnvironmentPorts(filesystem),
      clock,
      signals: signals as unknown as NonNullable<CliEnvironmentPorts["signals"]>,
    };
    const output = outputCapture(ports);
    const exit = runCli(["daemon", "logs", "--follow"], output.environmentWith());
    // why: `followLogFile` loads its follower module on first use, so settling once is no
    // longer enough for the tail read to have started; this yields to the event loop until the
    // poll timer is armed, which is the point the old single settle proved the follower was
    // live. The wait is a real timer: the lazy import resolves through I/O callbacks, which
    // `setImmediate` turns alone would not drain.
    const settle = async (): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (clock.pendingTimerCount > 0) return;
      }
      throw new Error("the follower never armed its poll timer -- lazy load of the module hung");
    };
    await settle();
    /** why: unlike the first settle this cannot require a timer -- after a signal the follower
     * is meant to leave none armed -- and the lazy import is resolved by now, so immediate
     * turns are enough to drain the poll's reads. */
    const settleTick = async (): Promise<void> => {
      for (let attempt = 0; attempt < 20; attempt += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
    };
    return {
      clock,
      exit,
      output,
      signals,
      settle,
      tick: async () => {
        clock.advance(250);
        await settleTick();
      },
    };
  }

  const LOG = "/simlock/daemon.log";

  it("daemon logs --follow prints the existing tail, then a line appended later", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(LOG, "old one\nold two\n");
    const run = await follow(filesystem);

    expect(run.output.stdout).toBe("old one\nold two\n");
    await filesystem.writeFileAtomic(LOG, "old one\nold two\nnew three\n");
    await run.tick();

    expect(run.output.stdout).toBe("old one\nold two\nnew three\n");
    run.signals.emit("SIGINT");
    await expect(run.exit).resolves.toBe(0);
  });

  it("it prints lines written after a rotation, when the new file is already larger than the old offset at the next poll", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(LOG, "a\n");
    const run = await follow(filesystem);

    // why: Between two polls: one more line in the old file, a rotation, and a new file already
    // longer than everything the follower had read of the old one.
    await filesystem.writeFileAtomic(LOG, "a\nb\n");
    await filesystem.rename(LOG, `${LOG}.1`);
    await filesystem.writeFileAtomic(LOG, "after rotation 1\nafter rotation 2\n");
    await run.tick();

    expect(run.output.stdout).toBe("a\nb\nafter rotation 1\nafter rotation 2\n");
    run.signals.emit("SIGTERM");
    await expect(run.exit).resolves.toBe(0);
  });

  it("it waits while the log file is missing and prints lines once it appears", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    const run = await follow(filesystem);
    await run.tick();
    expect(run.output.stdout).toBe("");
    expect(run.output.stderr).toBe("");

    await filesystem.writeFileAtomic(LOG, "first line\n");
    await run.tick();

    expect(run.output.stdout).toBe("first line\n");
    run.signals.emit("SIGINT");
    await expect(run.exit).resolves.toBe(0);
  });

  it("daemon logs --follow --json fails with USAGE, exit 2", async () => {
    const output = outputCapture();

    await expect(
      runCli(["daemon", "logs", "--follow", "--json"], output.environmentWith()),
    ).resolves.toBe(2);
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
      error: { code: "USAGE", message: expect.stringContaining("--follow") },
    });
  });

  it("--follow on any daemon subcommand but logs fails with USAGE, exit 2", async () => {
    for (const command of ["start", "stop", "status"]) {
      const output = outputCapture();
      await expect(runCli(["daemon", command, "--follow"], output.environmentWith())).resolves.toBe(
        2,
      );
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "USAGE", message: expect.stringContaining("--follow") },
      });
    }
  });

  it("an interrupt ends the follow with exit 0 and leaves no timer armed", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(LOG, "line\n");
    const run = await follow(filesystem);
    expect(run.clock.pendingTimerCount).toBe(1);

    run.signals.emit("SIGINT");

    await expect(run.exit).resolves.toBe(0);
    expect(run.clock.pendingTimerCount).toBe(0);
    expect(run.signals.listenerCount("SIGINT")).toBe(0);
    expect(run.signals.listenerCount("SIGTERM")).toBe(0);
    await filesystem.writeFileAtomic(LOG, "line\nafter exit\n");
    await run.tick();
    expect(run.output.stdout).toBe("line\n");
  });
});

describe("CLI smoke test (ADR 0003 §12: one per frontend)", () => {
  it("lease --detach, status, release, and token create round-trip through a real daemon", async () => {
    const { socketPath } = await startTestDaemon();
    const ipc = new NodeIpcTransport();
    const environment = outputCapture().environmentWith({
      connectAdmin: async (resolveCredential) => {
        const credential = await resolveCredential();
        return connectSimlockAdmin({
          ipc,
          endpoint: socketPath,
          principal: "smoke-test",
          ...(credential === undefined ? {} : { credential }),
        });
      },
    });

    const leaseOut = outputCapture();
    const leaseExit = await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      leaseOut.environmentWith({ connectAdmin: environment.connectAdmin }),
    );
    expect(leaseExit).toBe(0);
    const grant = JSON.parse(leaseOut.stdout) as LeaseGrant;
    // why: ADR 0004: one kind of lease -- what `--detach` changes is this process, not the grant.
    expect(grant.lease).toMatchObject({ ttlMs: expect.any(Number) });

    const statusOut = outputCapture();
    await runCli(
      ["status", "--json"],
      statusOut.environmentWith({ connectAdmin: environment.connectAdmin }),
    );
    const status = JSON.parse(statusOut.stdout) as StatusGetOutput;
    expect(status.leases?.map((lease) => lease.id)).toContain(grant.lease.id);

    const releaseOut = outputCapture();
    const releaseExit = await runCli(
      ["release", grant.lease.id],
      releaseOut.environmentWith({ connectAdmin: environment.connectAdmin }),
    );
    expect(releaseExit).toBe(0);

    const tokenOut = outputCapture();
    const tokenExit = await runCli(
      ["token", "create", "--role", "operator", "--label", "ci"],
      tokenOut.environmentWith({ connectAdmin: environment.connectAdmin }),
    );
    expect(tokenExit).toBe(0);
    const created = JSON.parse(tokenOut.stdout) as { secret: string; token: { id: string } };
    expect(typeof created.secret).toBe("string");
    expect((created as unknown as Record<string, unknown>).token).not.toHaveProperty("hash");
  });
});

/**
 * why: the CLI reference promises exactly one structured error line per failure, and binds `USAGE` to
 * exit 2. A `SIMLOCK_HOME` whose socket path exceeds the platform limit had neither: the path
 * was resolved while *building* the environment, and `runCli` takes its environment as a
 * default parameter -- whose initializer runs before the function body, and therefore before
 * the try/catch. The error escaped as an uncaught rejection with a raw stack trace, and took
 * `simlock --help` down with it.
 */
describe("CLI: a SIMLOCK_HOME the kernel could not bind", () => {
  const tooDeep = `/tmp/${"d".repeat(120)}`;
  const ports = (): CliEnvironmentPorts => ({
    ...realCliEnvironmentPorts(),
    daemonHome: { role: "worker", dataDirectory: tooDeep, gatewayPresent: false },
  });

  it("still prints help, which needs no socket at all", async () => {
    const output = outputCapture(ports());

    await expect(runCli(["--help"], output.environmentWith())).resolves.toBe(0);

    expect(output.stdout).toContain("Usage: simlock");
    expect(output.stderr).toBe("");
  });

  it("reports a command that does need one as a single USAGE line, exit 2", async () => {
    const output = outputCapture(ports());

    await expect(runCli(["status"], output.environmentWith())).resolves.toBe(2);

    const lines = output.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const reported = JSON.parse(lines[0] ?? "") as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(reported.error.code).toBe("USAGE");
    expect(reported.error.message).toContain("SIMLOCK_HOME");
  });
});

describe("CLI: the daemon endpoint check", () => {
  it("buildCliEnvironment reports the daemon endpoint present only while its socket file exists", async () => {
    const filesystem = new MemoryFilesystem();
    const environment = buildCliEnvironment(realCliEnvironmentPorts(filesystem), {});
    const socketPath = resolveDaemonSocketPath("/simlock");

    expect(await environment.daemonEndpointPresent()).toBe(false);
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(socketPath, "");
    expect(await environment.daemonEndpointPresent()).toBe(true);
    await filesystem.rm(socketPath);
    expect(await environment.daemonEndpointPresent()).toBe(false);
  });
});

describe("CLI: requester id from the agent session", () => {
  const sessionEnv = { CLAUDE_CODE_SESSION_ID: "abc" };

  it("buildCliEnvironment falls back to the pid when no agent id or session id is set", () => {
    expect(buildCliEnvironment(realCliEnvironmentPorts(), {}).requesterId).toBe(
      String(process.pid),
    );
  });

  it("simlock lease --agent-id overrides a session-derived id", async () => {
    const requested: string[] = [];
    const client = fakeClient({
      requestLease: (input, _options) => {
        requested.push(input.requesterId ?? "<none>");
        return fakeClient().requestLease(input);
      },
    });
    const output = outputCapture();
    const environment = {
      ...buildCliEnvironment(realCliEnvironmentPorts(), sessionEnv),
      connectAdmin: async () => client,
      stderr: { write: (value: string) => (output.stderr += value) },
      stdout: { write: (value: string) => (output.stdout += value) },
    };

    await expect(
      runCli(["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"], environment),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "lease",
          "--platform",
          "ios",
          "--device",
          "iPhone 17 Pro",
          "--detach",
          "--agent-id",
          "explicit-agent",
        ],
        environment,
      ),
    ).resolves.toBe(0);

    expect(requested).toEqual(["claude-code:abc", "explicit-agent"]);
  });
});

describe("CLI: pure helpers", () => {
  it("parseDuration parses units and rejects garbage", () => {
    expect(parseDuration("500")).toBe(500);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("2s")).toBe(2_000);
    expect(parseDuration("3m")).toBe(180_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(() => parseDuration("banana")).toThrow("Invalid duration");
  });

  it("parseDuration accepts the d unit and rejects an unknown one", () => {
    expect(parseDuration("2d")).toBe(2 * 24 * 60 * 60 * 1000);
    expect(() => parseDuration("2w")).toThrow("Invalid duration");
  });
});

describe("readPipedStdin", () => {
  function fakeStdin(chunks: readonly string[], isTTY: boolean): typeof process.stdin {
    const stream = Readable.from(chunks);
    return Object.assign(stream, { isTTY }) as unknown as typeof process.stdin;
  }

  it("returns undefined without reading anything when stdin is a terminal", async () => {
    const stdin = fakeStdin(["should never be read"], true);
    const stdinGetter = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin);

    try {
      await expect(readPipedStdin()).resolves.toBeUndefined();
    } finally {
      stdinGetter.mockRestore();
    }
  });

  it("reads a piped stdin to EOF, concatenating every chunk in order", async () => {
    const stdin = fakeStdin(["piped ", "pay", "load\n"], false);
    const stdinGetter = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin);

    try {
      await expect(readPipedStdin()).resolves.toBe("piped payload\n");
    } finally {
      stdinGetter.mockRestore();
    }
  });

  it("returns an empty string, not undefined, for a piped stdin that carries nothing", async () => {
    // why: `undefined` means "a terminal, do not read"; an empty pipe is a real EOF and a real
    // (empty) answer -- the two must stay distinguishable to a caller.
    const stdin = fakeStdin([], false);
    const stdinGetter = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin);

    try {
      await expect(readPipedStdin()).resolves.toBe("");
    } finally {
      stdinGetter.mockRestore();
    }
  });
});

function simlockError(code: AnySimlockError["code"]): AnySimlockError {
  const messages: Partial<Record<string, string>> = {
    NO_CAPACITY: "No capacity available",
  };
  const kind =
    code === "DAEMON_CONNECTION_LOST" ||
    code === "DAEMON_STOPPING" ||
    code === "DAEMON_STARTUP_FAILED"
      ? "transport"
      : (
            [
              "BAD_FRAME",
              "HANDSHAKE_REQUIRED",
              "BAD_REQUEST",
              "UNKNOWN_REQUEST",
              "PROTOCOL_VERSION_UNSUPPORTED",
              "ADMIN_AUTHENTICATION_FAILED",
              "FORBIDDEN",
              "UNKNOWN_DAEMON_ERROR",
            ] as const
          ).includes(code as never)
        ? "protocol"
        : "domain";
  return new SimlockError(
    code,
    kind,
    messages[code] ?? `${code} failed`,
    {} as never,
  ) as unknown as AnySimlockError;
}

/** why: Hoisted out of `fakeClient` so a test can hand back the same status with a different
 * `mode` -- which is what the passthrough path branches on (ADR 0005 §19c). */
const EMPTY_STATUS = {
  devices: [],
  host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
  leases: [],
  capacity: {
    ios: {
      atRamBudget: false,
      limit: 1,
      running: 0,
      maxRunning: 1,
      reserved: 0,
      overLimit: false,
      warm: 0,
      used: 0,
    },
    android: {
      atRamBudget: false,
      limit: 1,
      running: 0,
      maxRunning: 1,
      reserved: 0,
      overLimit: false,
      warm: 0,
      used: 0,
    },
    global: { running: 0, maxRunning: 2, reserved: 0, overLimit: false, warm: 0 },
  },
  daemon: {
    health: "running",
    mode: "worker",
    version: "0.0.0-test",
    update: null,
    lastUpdateFailure: null,
    latestVersion: null,
  },
  queueDepth: 0,
} satisfies StatusGetOutput;

describe("simlock update and simlock status", () => {
  type UpdateAnswer = Awaited<ReturnType<SimlockAdminClient["updateDaemon"]>>;
  type Step = UpdateAnswer | SimlockError;
  const lost = () =>
    new SimlockError("DAEMON_CONNECTION_LOST", "transport", "The daemon connection was lost", {});
  const answer = (overrides: Partial<UpdateAnswer> = {}): UpdateAnswer => ({
    started: false,
    upToDate: false,
    resolved: null,
    version: "0.3.0",
    health: "running",
    update: null,
    lastUpdateFailure: null,
    latestVersion: null,
    ...overrides,
  });
  const state = (
    stage: "waiting" | "installing" | "restarting",
    leases = 0,
  ): NonNullable<UpdateAnswer["update"]> => {
    const base = { from: "0.3.0", to: "0.4.0", forced: false, startedAt: 1_000 };
    return stage === "waiting" ? { stage, leases, ...base } : { stage, ...base };
  };
  const failure = (stage: "installing" | "restarting", message: string) => ({
    stage,
    from: "0.3.0",
    to: "0.4.0",
    message,
    at: 2_000,
  });
  const started = (update = state("installing")) =>
    answer({ started: true, resolved: "0.4.0", update });
  const running = (version = "0.4.0", overrides: Partial<UpdateAnswer> = {}) =>
    answer({ version, ...overrides });

  async function runUpdate(
    argv: readonly string[],
    script: {
      readonly first: UpdateAnswer | SimlockError;
      readonly polls?: readonly Step[];
      readonly after?: readonly (Step | Error)[];
      readonly onPoll?: (index: number, interrupt: () => void) => void;
      readonly onReconnect?: (interrupt: () => void) => void;
    },
  ) {
    const output = outputCapture();
    const clock = new FakeClock(0);
    const calls: unknown[] = [];
    const polls = [...(script.polls ?? [])];
    const after = [...(script.after ?? [])];
    let pollCount = 0;
    const signals = new EventEmitter();
    let opened = 0;
    const closedClients = new Set<number>();
    const clientOver = (steps: Step[], first?: UpdateAnswer | SimlockError) => {
      const id = opened++;
      return fakeClient({
        close: async () => {
          closedClients.add(id);
        },
        updateDaemon: async (input) => {
          calls.push(input);
          const isFirst = first !== undefined && calls.length === 1;
          if (!isFirst) script.onPoll?.(pollCount++, () => signals.emit("SIGINT"));
          const step = isFirst ? first : steps.length > 1 ? steps.shift() : steps[0];
          if (step === undefined) throw new Error("no scripted answer");
          if (step instanceof Error) throw step;
          return step;
        },
      });
    };
    const environment = output.environmentWith({
      clock,
      connectAdmin: async () => clientOver(polls, script.first),
      connectExistingAdmin: async () => {
        script.onReconnect?.(() => signals.emit("SIGINT"));
        const step = after.length > 1 ? after.shift() : after[0];
        if (step === undefined || step instanceof Error) throw step ?? new Error("refused");
        return clientOver([step]);
      },
      sleep: async (milliseconds) => clock.advance(milliseconds),
      signals: signals as unknown as CliEnvironment["signals"],
    });
    const code = await runCli(argv, environment);
    return {
      code,
      calls,
      stdout: output.stdout,
      stderr: output.stderr,
      opened,
      closed: closedClients.size,
    };
  }

  it("follows an update to simlock <v> is running, reports a failure and a rollback, says when nothing is needed, stops following on Ctrl-C only, prints --json, refuses bad input, and shows the version, the update and the last failure in simlock status", async () => {
    let reconnects = 0;
    // why: the follower reconnects every second and gives up when 15 minutes have passed since the last answer, so the last attempt is at 14:59 on the fake clock.
    const RECONNECTS_IN_15_MINUTES = 899;
    const header = "Updating simlock 0.3.0 → 0.4.0\n";
    const wait =
      "Waiting for 2 leases to end. Ctrl-C stops following; simlock update --force stops waiting.\n";
    const cases: readonly {
      readonly name: string;
      readonly argv: readonly string[];
      readonly script: Parameters<typeof runUpdate>[1];
      readonly code: number;
      readonly stdout: string;
      readonly calls?: readonly unknown[];
      readonly reconnects?: number;
    }[] = [
      {
        name: "follows to running",
        argv: ["update"],
        script: {
          first: started(state("waiting", 2)),
          polls: [
            answer({ update: state("waiting", 2) }),
            answer({ update: state("waiting", 1) }),
            answer({ update: state("installing") }),
            answer({ update: state("restarting") }),
            lost(),
          ],
          after: [new Error("refused"), running()],
        },
        code: 0,
        stdout: `${header}${wait}Waiting for 1 lease to end.\nInstalling simlock@0.4.0\nRestarting the daemon\nsimlock 0.4.0 is running\n`,
        calls: [{}, ...Array.from({ length: 6 }, () => ({ query: true }))],
      },
      {
        name: "follows an update that already runs, whatever version it names",
        argv: ["update", "--version", "0.9.9"],
        script: {
          first: answer({ update: state("installing") }),
          polls: [lost()],
          after: [running()],
        },
        code: 0,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nsimlock 0.4.0 is running\n`,
      },
      {
        name: "reports a failed install",
        argv: ["update"],
        script: {
          first: started(),
          polls: [answer({ lastUpdateFailure: failure("installing", "npm error code EACCES") })],
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\nUpdate failed (installing): npm error code EACCES\nsimlock 0.3.0 is still running and takes leases again.\n`,
      },
      {
        name: "reports a version that did not start and the rollback",
        argv: ["update"],
        script: {
          first: started(),
          polls: [answer({ update: state("restarting") }), lost()],
          after: [
            answer({
              lastUpdateFailure: failure("restarting", "0.4.0 did not start: health failed"),
            }),
          ],
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nUpdate failed (restarting): 0.4.0 did not start: health failed. Rolled back to 0.3.0.\n`,
      },
      {
        name: "waits through a daemon that answers while it is still starting",
        argv: ["update"],
        script: {
          first: started(),
          polls: [lost()],
          after: [
            answer({ health: "starting" }),
            answer({ health: "starting" }),
            answer({ health: "starting" }),
            answer({
              lastUpdateFailure: failure("restarting", "0.4.0 did not start: health failed"),
            }),
          ],
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nUpdate failed (restarting): 0.4.0 did not start: health failed. Rolled back to 0.3.0.\n`,
      },
      {
        name: "gives up when the daemon does not come back in 15 minutes",
        argv: ["update"],
        script: {
          first: started(),
          polls: [answer({ update: state("restarting") }), lost()],
          after: [new Error("refused")],
          onReconnect: () => {
            reconnects += 1;
          },
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nThe daemon did not come back; run simlock status.\n`,
        reconnects: RECONNECTS_IN_15_MINUTES,
      },
      {
        name: "stops with the daemon's own error when a poll is refused for a reason other than a lost connection",
        argv: ["update"],
        script: {
          first: started(),
          polls: [new SimlockError("UPDATE_RESOLVE_FAILED", "domain", "npm is down", {})],
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\n`,
      },
      {
        name: "prints its usage for --help and asks the daemon nothing",
        argv: ["update", "--help"],
        script: { first: answer() },
        code: 0,
        stdout: "Usage: simlock update [--version <version>] [--force] [--json]\n",
        calls: [],
      },
      {
        name: "the latest version is the running one",
        argv: ["update"],
        script: { first: answer({ upToDate: true, resolved: "0.3.0" }) },
        code: 0,
        stdout: "simlock 0.3.0 is already the latest\n",
        calls: [{}],
      },
      {
        name: "the named version is the running one",
        argv: ["update", "--version", "0.3.0"],
        script: { first: answer({ upToDate: true, resolved: "0.3.0" }) },
        code: 0,
        stdout: "simlock 0.3.0 is already running\n",
        calls: [{ version: "0.3.0" }],
      },
      {
        name: "the running version is newer than the latest",
        argv: ["update"],
        script: { first: answer({ upToDate: true, resolved: "0.4.0", version: "0.5.0-rc.1" }) },
        code: 0,
        stdout:
          "simlock 0.5.0-rc.1 is newer than the latest (0.4.0). Use --version to install another version.\n",
      },
      {
        name: "sends force and the version",
        argv: ["update", "--force", "--version", "0.4.0-rc.1"],
        script: { first: answer({ upToDate: true, resolved: "0.3.0" }) },
        code: 0,
        stdout: "simlock 0.3.0 is already running\n",
        calls: [{ force: true, version: "0.4.0-rc.1" }],
      },
      {
        name: "--json prints the final answer only",
        argv: ["update", "--json"],
        script: { first: started(state("waiting", 1)), polls: [lost()], after: [running()] },
        code: 0,
        stdout: `${JSON.stringify(running())}\n`,
      },
      {
        name: "--json with nothing to do prints the answer at once",
        argv: ["update", "--json"],
        script: { first: answer({ upToDate: true, resolved: "0.3.0" }) },
        code: 0,
        stdout: `${JSON.stringify(answer({ upToDate: true, resolved: "0.3.0" }))}\n`,
        calls: [{}],
      },
      {
        name: "Ctrl-C stops following and sends nothing more",
        argv: ["update"],
        script: {
          first: started(state("waiting", 2)),
          polls: [answer({ update: state("waiting", 2) })],
          onPoll: (_index, interrupt) => interrupt(),
        },
        code: 0,
        stdout: `${header}${wait}Stopped following. The update goes on; run simlock status to see it.\n`,
        calls: [{}, { query: true }],
      },
      {
        name: "Ctrl-C while the daemon restarts stops following",
        argv: ["update"],
        script: {
          first: started(),
          polls: [lost()],
          after: [new Error("refused")],
          onReconnect: (interrupt) => interrupt(),
        },
        code: 0,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nStopped following. The update goes on; run simlock status to see it.\n`,
        calls: [{}, { query: true }],
      },
    ];
    for (const { name, argv, script, code, stdout, calls, reconnects: expected } of cases) {
      reconnects = 0;
      const result = await runUpdate(argv, script);
      if (expected !== undefined) expect(reconnects, name).toBe(expected);
      expect({ name, code: result.code, stdout: result.stdout }, name).toEqual({
        name,
        code,
        stdout,
      });
      if (calls !== undefined) expect(result.calls, name).toEqual(calls);
      expect(result.closed, `${name}: every client opened is closed`).toBe(result.opened);
    }

    const refusals: readonly [readonly string[], number, string][] = [
      [["update", "--version", "latest"], 2, "--version takes a version, e.g. 0.4.0"],
      [["update", "--version", "../x"], 2, "--version takes a version, e.g. 0.4.0"],
      [["update", "--version", `1.0.0-${"a".repeat(59)}`], 2, "--version takes a version"],
    ];
    for (const [argv, code, message] of refusals) {
      const result = await runUpdate(argv, { first: answer() });
      expect({ argv, code, stderr: result.stderr.includes(message), calls: result.calls }).toEqual({
        argv,
        code,
        stderr: true,
        calls: [],
      });
    }

    const refused = [
      ["UPDATE_RESOLVE_FAILED", 1, "could not resolve simlock@9.9.9: No match found"],
      ["UPDATE_UNSUPPORTED_INSTALL", 2, "simlock was not installed with npm i -g"],
    ] as const;
    for (const [codeName, exit, message] of refused) {
      const result = await runUpdate(["update"], {
        first: new SimlockError(codeName, "domain", message, {}),
      });
      expect({ code: result.code, stdout: result.stdout }).toEqual({ code: exit, stdout: "" });
      expect(JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: codeName, message },
      });
    }

    const next = "Host: macOS 15.5 arm64";
    expect(await statusLines({ version: "0.3.0" })).toEqual([
      "Daemon: running (worker)",
      "Simlock: 0.3.0",
      next,
      expect.stringMatching(/^Running global/),
    ]);
    for (const [update, line] of [
      [state("waiting", 2), "Updating to 0.4.0: waiting for 2 leases"],
      [state("waiting", 1), "Updating to 0.4.0: waiting for 1 lease"],
      [state("installing"), "Updating to 0.4.0: installing"],
      [state("restarting"), "Updating to 0.4.0: restarting"],
    ] as const) {
      expect((await statusLines({ version: "0.3.0", update })).slice(0, 3)).toEqual([
        "Daemon: running (worker)",
        "Simlock: 0.3.0",
        line,
      ]);
    }
    expect(
      (
        await statusLines({
          version: "0.3.0",
          lastUpdateFailure: failure("installing", "npm error code EACCES"),
        })
      ).slice(0, 3),
    ).toEqual([
      "Daemon: running (worker)",
      "Simlock: 0.3.0",
      "Last update failed (installing): npm error code EACCES",
    ]);
  });

  it("simlock status says when the daemon has seen a newer Simlock version on npm", async () => {
    for (const [version, latestVersion, line] of [
      ["0.3.0", "0.4.0", "Simlock: 0.3.0 (0.4.0 available)"],
      ["0.9.0", "0.10.0", "Simlock: 0.9.0 (0.10.0 available)"],
      ["0.4.0-rc.2", "0.4.0", "Simlock: 0.4.0-rc.2 (0.4.0 available)"],
      ["0.4.0", "0.4.0", "Simlock: 0.4.0"],
      ["0.5.0-rc.1", "0.4.0", "Simlock: 0.5.0-rc.1"],
      ["0.3.0", null, "Simlock: 0.3.0"],
    ] as const) {
      expect((await statusLines({ version, latestVersion }))[1]).toBe(line);
    }
  });
});

async function statusLines(daemon: Partial<StatusGetOutput["daemon"]>) {
  const output = outputCapture();
  await runCli(
    ["status"],
    output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getStatus: () =>
            Promise.resolve({ ...EMPTY_STATUS, daemon: { ...EMPTY_STATUS.daemon, ...daemon } }),
        }),
    }),
  );
  return output.stdout.split("\n").slice(0, 4);
}

function fakeClient(overrides: Partial<SimlockAdminClient> = {}): SimlockAdminClient {
  const emptyCatalog: CatalogGetOutput = { platforms: [] };
  const emptyDoctor: DoctorReport = { findings: [] };
  const emptyLeaseList: LeaseListOutput = { leases: [] };
  const emptyListGet: ListGetOutput = [];
  const emptyTokenList: TokenListOutput = { tokens: [] };
  const grant: LeaseGrant = {
    environment: {},
    device: {
      physical: false,
      id: "dev_1",
      driverDeviceId: "dev_1",
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      mode: "full",
    },
    lease: {
      id: "lse_1",
      deviceId: "dev_1",
      requesterId: "test-requester",
      ownerId: "test-requester",
      grantedAt: 0,
      lastRenewedAt: 0,
      idChosenByRequester: false,
      ttlMs: 60_000,
      ttlDeadline: 60_000,
    },
    timing: {
      estimatedProvisionMs: 0,
      estimatedBootMs: 0,
      estimatedReclaimMs: 0,
      estimatedReadyMs: 0,
    },
  };
  const base: SimlockAdminClient = {
    principal: "test-requester",
    role: "admin",
    daemonVersion: "test",
    getCatalog: () => Promise.resolve(emptyCatalog),
    getStatus: () => Promise.resolve(EMPTY_STATUS),
    identity: () =>
      Promise.resolve({
        name: "test-requester",
        principal: "test-requester",
        role: "admin",
        via: "socket",
      }),
    listComponents: () => Promise.resolve({ components: [] }),
    requestLease: (_input, _options) => Promise.resolve(grant),
    resolvePassthrough: () => Promise.resolve({ args: [], command: "adb", env: {} }),
    exec: () => Promise.resolve({ exitCode: 0 }),
    cancelLease: () => Promise.resolve({ result: "not-found" }),
    renewLease: () => Promise.resolve(grant.lease as LeaseRecord),
    releaseLease: (input) => Promise.resolve({ leaseId: input.leaseId }),
    listLeases: () => Promise.resolve(emptyLeaseList),
    runDoctor: () => Promise.resolve(emptyDoctor),
    onLeaseLost: () => () => {},
    onDeviceUnhealthy: () => () => {},
    onDeviceRecovered: () => () => {},
    onConnectionLost: () => () => {},
    close: () => Promise.resolve(),
    releaseAllLeases: () => Promise.resolve({ leaseIds: [] }),
    list: () => Promise.resolve(emptyListGet),
    runCleanup: () => Promise.resolve([]),
    runNuke: () => Promise.resolve({ deletedDevices: [], releasedLeaseIds: [] }),
    getConfig: () => Promise.resolve({} as SimlockConfig),
    stopDaemon: () => Promise.resolve({ stopping: true }),
    updateDaemon: () =>
      Promise.resolve({
        started: false,
        upToDate: true,
        resolved: null,
        version: "test",
        health: "running" as const,
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      }),
    replayEvents: () => Promise.resolve([]),
    usage: (window) => Promise.resolve(usageAnswer(window)),
    subscribeEvents: () => Promise.resolve(() => Promise.resolve()),
    createToken: (input) =>
      Promise.resolve({
        secret: "sec_1",
        token: { id: "tok_1", role: input.role, createdAt: 0 },
      }),
    listTokens: () => Promise.resolve(emptyTokenList),
    revokeToken: () => Promise.resolve({ revoked: true }),
    listWorkers: () => Promise.resolve({ workers: [] }),
    drainWorker: (input) => Promise.resolve({ drained: true as const, workerId: input.workerId }),
    undrainWorker: (input) =>
      Promise.resolve({ drained: false as const, workerId: input.workerId }),
    removeWorker: (input) => Promise.resolve({ removed: true, workerId: input.workerId }),
    updateWorker: (input) =>
      Promise.resolve({
        health: "running" as const,
        lastUpdateFailure: null,
        latestVersion: null,
        resolved: null,
        started: false,
        update: null,
        upToDate: false,
        version: "0.3.0",
        workerId: input.workerId,
      }),
    testAlertDestination: (input) =>
      Promise.resolve({ destination: input.destination, status: 200 }),
    installComponent: (input) =>
      Promise.resolve({
        component: input.version,
        outcome: "installed" as const,
        platform: input.platform,
        version: input.version,
      }),
    installComponentOnWorkers: () => Promise.resolve({ results: [] }),
    removeComponent: (input) =>
      Promise.resolve({
        outcome: input.dryRun === true ? ("would-remove" as const) : ("removed" as const),
        platform: input.platform,
        version: input.version,
      }),
    addDevice: (input) =>
      Promise.resolve({
        appCount: 2,
        class: "phone" as const,
        driverDeviceId: input.id,
        id: "dev_9",
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        platform: input.platform,
        reenrolled: false,
      }),
    removeDevice: (input) => Promise.resolve({ driverDeviceId: input.id, id: input.id }),
    ...overrides,
  };
  return base;
}

interface OutputCapture {
  stdout: string;
  stderr: string;
  environmentWith(overrides?: Partial<CliEnvironment>): CliEnvironment;
}

function outputCapture(ports?: CliEnvironmentPorts, env: NodeJS.ProcessEnv = {}): OutputCapture {
  const capture: OutputCapture = {
    stdout: "",
    stderr: "",
    environmentWith(overrides = {}) {
      const stderrOut = { write: (value: string) => (capture.stderr += value) };
      const stdoutOut = { write: (value: string) => (capture.stdout += value) };
      if (ports === undefined) {
        return {
          clock: new FakeClock(0),
          configPath: "/simlock/config.json",
          daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
          requesterId: "test-requester",
          connectAdmin: async () => fakeClient(),
          connectExistingAdmin: async () => fakeClient(),
          daemonEndpointPresent: async () => false,
          readAdminTokenFile: async () => undefined,
          sleep: async () => {},
          readConfigFile: async () => ({}),
          writeConfigFile: async () => {},
          validateConfig: async () => {},
          readLogFile: async () => "",
          readEventHistory: async () => [],
          signals: new EventEmitter() as unknown as CliEnvironment["signals"],
          parentWatch: new FakeParentWatch(),
          stderr: stderrOut,
          stdout: stdoutOut,
          confirm: async () => true,
          ...overrides,
        };
      }
      const base = buildCliEnvironment(
        {
          ...ports,
          signals:
            ports.signals ??
            (new EventEmitter() as unknown as NonNullable<CliEnvironmentPorts["signals"]>),
          parentWatch: ports.parentWatch ?? new FakeParentWatch(),
          confirm: ports.confirm ?? (async () => true),
          stderr: stderrOut,
          stdout: stdoutOut,
        },
        env,
      );
      return { ...base, ...overrides };
    },
  };
  return capture;
}

class HelloThenDeathIpc implements IpcConnector {
  helloReplies = 0;
  deaths = 0;
  #listening = false;

  rejectedCredentials = 0;
  clientCloses = 0;

  constructor(
    readonly closeAfter: "hello" | "request" | "silent" | "stopping" = "hello",
    readonly rejectCredential = false,
  ) {}

  startListening(): void {
    this.#listening = true;
  }

  async connect(): Promise<IpcConnection> {
    if (!this.#listening) {
      throw new IpcError("endpoint-not-found", "No IPC endpoint yet", undefined);
    }
    return new HelloThenDeathConnection(this);
  }
}

class HelloThenDeathConnection implements IpcConnection {
  readonly #dataListeners = new Set<(chunk: string) => void>();
  readonly #closeListeners = new Set<() => void>();
  #closed = false;

  constructor(private readonly daemon: HelloThenDeathIpc) {}

  get closed(): boolean {
    return this.#closed;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onError(): () => void {
    return () => {};
  }

  async write(contents: string): Promise<void> {
    if (this.#closed) return;
    let answeredHello = false;
    for (const line of contents.split("\n")) {
      answeredHello = this.#receiveFrame(line) || answeredHello;
      if (this.#closed) return;
    }
    if (
      this.daemon.closeAfter === "hello" ||
      (!answeredHello && this.daemon.closeAfter === "request")
    )
      this.#shutDown(true);
  }

  #receiveFrame(line: string): boolean {
    if (line.trim() === "") return false;
    const frame = JSON.parse(line) as {
      id?: unknown;
      type?: unknown;
      payload?: { credential?: string };
    };
    if (frame.type === "status.get" && this.daemon.closeAfter === "stopping") {
      const reply = {
        id: frame.id,
        ok: false,
        error: {
          code: "DAEMON_STOPPING",
          message: "Daemon is stopping",
          details: {},
        },
      };
      for (const listener of this.#dataListeners) listener(`${JSON.stringify(reply)}\n`);
    }
    if (frame.type !== "hello" || typeof frame.id !== "number") return false;
    this.#answerHello(frame.id, frame.payload?.credential);
    return true;
  }

  #answerHello(id: number, credential: string | undefined): void {
    if (this.daemon.rejectCredential && credential !== undefined) {
      this.daemon.rejectedCredentials += 1;
      const reply = {
        id: id,
        ok: false,
        error: {
          code: "ADMIN_AUTHENTICATION_FAILED",
          message: "Rejected credential",
          details: {},
        },
      };
      for (const listener of this.#dataListeners) listener(`${JSON.stringify(reply)}\n`);
      this.#shutDown(false);
      return;
    }
    this.daemon.helloReplies += 1;
    const reply = {
      id: id,
      ok: true,
      payload: {
        protocolVersion: PROTOCOL_VERSION_RANGE.max,
        daemonProtocolRange: PROTOCOL_VERSION_RANGE,
        version: "0.0.0-test",
        role: "admin",
        principal: "test-requester",
      },
    };
    for (const listener of this.#dataListeners) listener(`${JSON.stringify(reply)}\n`);
  }

  async close(): Promise<void> {
    this.daemon.clientCloses += 1;
    this.#shutDown(false);
  }

  #shutDown(killedByDaemon: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    if (killedByDaemon) this.daemon.deaths += 1;
    for (const listener of this.#closeListeners) listener();
  }
}

function sequence(): IdGenerator {
  let next = 0;
  return { generate: () => `id${next++}` };
}

async function startTestDaemon(): Promise<{ socketPath: string; daemon: DaemonServer }> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-cli-smoke-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "daemon.sock");
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const filesystem = new MemoryFilesystem();
  const registry = await loadTestRegistry({
    clock,
    eventBus,
    idGenerator: sequence(),
  });
  const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  const config = testConfig();
  const wiring = testComponentWiring({
    clock: clock,
    drivers: [driver],
    eventBus: eventBus,
    registry: registry,
  });
  const engine = createTestEngine({
    ...wiring,
    clock,
    config,
    drivers: [driver],
    eventBus,
    idGenerator: sequence(),
    registry,
    state: testStateOf(registry),
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      totalRamBytes: 32 * gibibyte,
    }),
  });
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: engine.cleanup,
    filesystem,
    registry,
  });
  const auth = createAuth({
    clock,
    config: { enabled: false, host: "127.0.0.1", port: 4700 },
    dataDirectory: "/",
    database: (await openMemoryStateDatabase([tokensOwner])).database,
    filesystem,
    idGenerator: sequence(),
    logger: new NoopLogger(),
    keySetFetcher: new FakeKeySetFetcher(),
    secrets: new CryptoTokenSecrets(),
  });
  const daemon = new DaemonServer({
    capacity: engine,
    warmPool: engine,
    deviceModes: engine,
    catalog: engine,
    instanceId: "instance-test",
    clock,
    components: wiring.components,
    config,
    defaultRequesterId: "test-process",
    eventBus,
    eventHistory: ringEventHistory(eventBus),
    host: new DaemonEndpointHost({
      connector: new NodeIpcTransport(),
      endpoint: socketPath,
      filesystem: new NodeFilesystem(),
      listenerFactory: new NodeIpcTransport(),
    }),
    hostFacts: () => ({ arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] }),
    leases: engine,
    queue: engine,
    reaper,
    registry,
    resolveRole: { resolve: () => "admin" },
    tokens: auth.tokens,
    version: "test",
  });
  runningDaemons.push(daemon);
  await daemon.start();
  return { socketPath, daemon };
}

/** why: Bare-minimum ports for exercising `buildCliEnvironment`'s real `validateConfig` (B9) without
 * a daemon connection -- `config set` never calls `connectAdmin`, so `ipc`/`launcher` are inert
 * placeholders. */
function realCliEnvironmentPorts(
  filesystem: Filesystem = new MemoryFilesystem(),
): CliEnvironmentPorts {
  return {
    filesystem,
    clock: new FakeClock(0),
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      totalRamBytes: 32 * gibibyte,
    }),
    ipc: new MemoryIpcTransport(),
    launcher: new FakeDaemonLauncher(),
    daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
  };
}

/**
 * why: A real `DaemonServer` wired against in-memory ports (`MemoryFilesystem` + `MemoryIpcTransport`
 * shared with the CLI environment under test), with the genuine credential handshake
 * (`createAuth`) instead of `startTestDaemon`'s
 * `resolveRole: { resolve: () => "admin" }` shortcut -- B1 and B2 both hinge on that handshake
 * actually running.
 */
async function startInMemoryDaemon(options: {
  readonly filesystem: MemoryFilesystem;
  readonly ipcTransport: MemoryIpcTransport;
  readonly socketPath: string;
  readonly adminTokenPath: string;
}): Promise<{ daemon: DaemonServer; adminSecret: Auth["adminSecret"] }> {
  const { adminTokenPath, filesystem, ipcTransport, socketPath } = options;
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const registry = await loadTestRegistry({
    clock,
    eventBus,
    idGenerator: sequence(),
  });
  const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  const config = testConfig();
  const wiring = testComponentWiring({
    clock: clock,
    drivers: [driver],
    eventBus: eventBus,
    registry: registry,
  });
  const engine = createTestEngine({
    ...wiring,
    clock,
    config,
    drivers: [driver],
    eventBus,
    idGenerator: sequence(),
    registry,
    state: testStateOf(registry),
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      totalRamBytes: 32 * gibibyte,
    }),
  });
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: engine.cleanup,
    filesystem,
    registry,
  });
  const auth = createAuth({
    clock,
    config: { enabled: false, host: "127.0.0.1", port: 4700 },
    dataDirectory: dirname(adminTokenPath),
    database: (await openMemoryStateDatabase([tokensOwner])).database,
    filesystem,
    idGenerator: sequence(),
    logger: new NoopLogger(),
    keySetFetcher: new FakeKeySetFetcher(),
    secrets: new CryptoTokenSecrets(),
  });
  const daemon = new DaemonServer({
    adminSecret: auth.adminSecret,
    capacity: engine,
    warmPool: engine,
    deviceModes: engine,
    catalog: engine,
    instanceId: "instance-test",
    clock,
    components: wiring.components,
    config,
    defaultRequesterId: "test-process",
    eventBus,
    eventHistory: ringEventHistory(eventBus),
    host: new DaemonEndpointHost({
      connector: ipcTransport,
      endpoint: socketPath,
      filesystem,
      listenerFactory: ipcTransport,
    }),
    hostFacts: () => ({ arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] }),
    leases: engine,
    queue: engine,
    reaper,
    registry,
    resolveRole: { resolve: (hello) => auth.resolveHelloRole(hello) },
    tokens: auth.tokens,
    version: "test",
  });
  runningDaemons.push(daemon);
  await daemon.start();
  return { daemon, adminSecret: auth.adminSecret };
}

function testConfig(): Config {
  return {
    capabilities: {},
    mode: "worker",
    exec: { timeoutMs: 600_000 },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    gateway: {
      disconnectedRetentionMs: 24 * 60 * 60_000,
      execTimeoutMs: 11 * 60_000,
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: "warm-then-free" as const,
      alerts: { destinations: [] },
    },
    drivers: {},
    eventBuffer: { capacity: 100 },
    health: {
      enabled: false,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { defaultMode: "full", defaultModels: {}, slim: { bootTimeoutMs: 600_000 } },
    android: {
      defaultModels: {},
      emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
    },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    update: { check: true },
    lease: {
      defaultTtlMs: 60_000,
      maxTtlMs: 3_600_000,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
      maxPerRequester: 1,
      endWaitMs: 600_000,
    },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 2,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    eventLog: {
      retention: 7 * 24 * 60 * 60 * 1000,
      maxBytes: 256 * 1024 * 1024,
    },
    metrics: { retention: 90 * 24 * 60 * 60 * 1000 },
    warmPool: {
      enabled: true,
      maxConcurrentBoots: 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}

describe("simlock list --requests", () => {
  it("prints a starting request without a place in the queue, one on a worker with that worker, and a future timestamp as waiting 0s", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const client = fakeClient({
      list: async (input) => {
        asked.push(input);
        return [
          {
            createdAt: -12_000,
            id: "req_1",
            requesterId: "agent-b",
            spec: { imageTag: "google_apis", model: "Pixel 8", platform: "android" },
            stage: "starting",
          },
          {
            createdAt: -3_400,
            id: "req_2",
            queuePosition: 2,
            requesterId: "local-agent",
            spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
            stage: "queued",
            workerId: "wrk_1",
          },
          {
            // why: Stamped by a worker whose clock runs ahead of this one.
            createdAt: 5_000,
            id: "req_3",
            queuePosition: 1,
            requesterId: "skewed-agent",
            spec: { model: "iPhone 16", platform: "ios" },
            stage: "queued",
            workerId: "wrk_2",
          },
        ];
      },
    });

    await expect(
      runCli(["list", "--requests"], output.environmentWith({ connectAdmin: async () => client })),
    ).resolves.toBe(0);

    expect(asked).toEqual([{ kind: "requests" }]);
    expect(output.stdout).toBe(
      "Request req_1: agent-b, android Pixel 8 image tag google_apis, starting, waiting 12s\n" +
        "Request req_2: local-agent on wrk_1, ios iPhone 16 18.4, queued at 2, waiting 3s\n" +
        "Request req_3: skewed-agent on wrk_2, ios iPhone 16, queued at 1, waiting 0s\n",
    );
  });

  describe("the reason a queued request waits", () => {
    const queued = (
      reason: string | undefined,
      platform: "ios" | "android" = "ios",
    ): Record<string, unknown> => ({
      createdAt: 0,
      id: "req_1",
      queuePosition: 1,
      requesterId: "agent",
      spec: { model: "Device", platform },
      stage: "queued",
      ...(reason === undefined ? {} : { reason }),
    });

    async function printed(entry: Record<string, unknown>): Promise<string> {
      const output = outputCapture();
      const client = fakeClient({ list: async () => [entry] as never });
      await runCli(
        ["list", "--requests"],
        output.environmentWith({ connectAdmin: async () => client }),
      );
      return output.stdout.trimEnd();
    }

    it.each([
      ["behind-earlier-request", "ios", "behind an earlier request"],
      ["device-limit", "ios", "full: device limit"],
      ["ram-budget", "ios", "full: RAM budget"],
      ["global-running-limit", "ios", "full: running limit"],
      ["platform-running-limit", "ios", "full: running limit for iOS"],
      ["platform-running-limit", "android", "full: running limit for Android"],
      ["waiting-for-device", "ios", "a matching device is starting"],
      ["no-free-physical", "ios", "every matching device is leased or absent"],
    ] as const)(
      "ends the line of a queued request with %s on %s as ' — %s'",
      async (reason, platform, text) => {
        expect(await printed(queued(reason, platform))).toBe(
          `Request req_1: agent, ${platform} Device, queued at 1, waiting 0s — ${text}`,
        );
      },
    );

    it("ends the line of a queued request with no reason as it ended before", async () => {
      expect(await printed(queued(undefined))).toBe(
        "Request req_1: agent, ios Device, queued at 1, waiting 0s",
      );
    });

    it("has a text for every reason the contract's enum lists", async () => {
      const field = (waitingRequestSchema.shape as Record<string, unknown>)["reason"];
      expect(field).toBeDefined();
      const listed = (field as { unwrap(): { options: readonly string[] } }).unwrap().options;

      expect(listed.length).toBeGreaterThan(0);
      for (const reason of listed) {
        const line = await printed(queued(reason));
        expect(line).toMatch(/ — [a-z]/);
        expect(line).not.toContain(reason);
      }
    });
  });

  describe("the reason each worker cannot take a request on a gateway", () => {
    const gatewayEntry = (
      workers: readonly Record<string, unknown>[],
      platform: "ios" | "android" = "ios",
    ): Record<string, unknown> => ({
      createdAt: 0,
      id: "req_1",
      queuePosition: 1,
      requesterId: "ci",
      spec: { model: "Device", platform },
      stage: "queued",
      workers,
    });

    async function printedGateway(
      entries: readonly Record<string, unknown>[],
      known: readonly { id: string; label?: string }[] = [],
    ): Promise<{ stdout: string; listed: number }> {
      const output = outputCapture();
      let listed = 0;
      const client = fakeClient({
        list: async () => entries as never,
        listWorkers: () => {
          listed += 1;
          return Promise.resolve({
            workers: known.map((worker) => ({
              catalog: [],
              connection: "connected" as const,
              devices: [],
              drained: false,
              lastSeenAt: 1,
              leases: [],
              ...worker,
            })),
          } as never);
        },
      });
      await runCli(
        ["list", "--requests"],
        output.environmentWith({ connectAdmin: async () => client }),
      );
      return { listed, stdout: output.stdout };
    }

    it("prints one indented line per worker under the request, named by its label, else its id", async () => {
      const { stdout } = await printedGateway(
        [
          gatewayEntry([
            { reason: "drained", workerId: "wrk_a" },
            { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_b" },
            { reason: "runtime-missing", workerId: "wrk_c" },
            { reason: "busy", workerId: "wrk_d" },
          ]),
        ],
        [{ id: "wrk_a", label: "mac-mini-1" }, { id: "wrk_b" }, { id: "wrk_c", label: "lab" }],
      );

      expect(stdout).toBe(
        "Request req_1: ci, ios Device, queued at 1, waiting 0s\n" +
          "  mac-mini-1: drained\n" +
          "  wrk_b: full: running limit for iOS\n" +
          "  lab: oS not installed\n" +
          "  wrk_d: busy with its own queue\n",
      );
    });

    it.each([
      ["disconnected", "ios", undefined, "not connected"],
      ["incompatible", "ios", undefined, "protocol mismatch"],
      ["not-ready", "ios", undefined, "not ready yet"],
      ["unhealthy", "ios", undefined, "not running"],
      ["updating", "ios", undefined, "updating"],
      ["drained", "ios", undefined, "drained"],
      ["busy", "ios", undefined, "busy with its own queue"],
      ["no-driver", "ios", undefined, "no iOS support"],
      ["no-driver", "android", undefined, "no Android support"],
      ["unknown-model", "ios", undefined, "model not offered"],
      ["runtime-missing", "ios", undefined, "oS not installed"],
      ["capability-missing", "ios", undefined, "missing capability"],
      ["full", "ios", undefined, "full"],
      ["full", "ios", "device-limit", "full: device limit"],
      ["full", "ios", "ram-budget", "full: RAM budget"],
      ["full", "ios", "global-running-limit", "full: running limit"],
      ["full", "ios", "platform-running-limit", "full: running limit for iOS"],
      ["full", "android", "platform-running-limit", "full: running limit for Android"],
      ["no-free-physical", "ios", undefined, "every matching device is leased or absent"],
      ["not-chosen", "ios", undefined, "not chosen this time"],
    ] as const)(
      "prints %s on %s with capacity reason %s as '  wrk_a: %s'",
      async (reason, platform, capacityReason, text) => {
        const { stdout } = await printedGateway([
          gatewayEntry(
            [
              {
                ...(capacityReason === undefined ? {} : { capacityReason }),
                reason,
                workerId: "wrk_a",
              },
            ],
            platform,
          ),
        ]);

        expect(stdout.split("\n")[1]).toBe(`  wrk_a: ${text}`);
      },
    );

    it("asks worker.list once for names, and not at all when no entry has workers", async () => {
      const gateway = await printedGateway([
        gatewayEntry([{ reason: "drained", workerId: "wrk_a" }]),
        { ...gatewayEntry([{ reason: "busy", workerId: "wrk_a" }]), id: "req_2" },
      ]);
      const plain = await printedGateway([{ ...gatewayEntry([]), workers: undefined }]);

      expect(gateway.listed).toBe(1);
      expect(plain.listed).toBe(0);
    });

    it("prints a worker's own entry with its reason after ' — ' and no indented lines", async () => {
      const { stdout } = await printedGateway([
        {
          ...gatewayEntry([]),
          reason: "ram-budget",
          workers: undefined,
          workerId: "wrk_1",
        },
      ]);

      expect(stdout).toBe(
        "Request req_1: ci on wrk_1, ios Device, queued at 1, waiting 0s — full: RAM budget\n",
      );
    });

    it("has a text for every gateway reason the contract's enum lists", async () => {
      const field = (waitingRequestSchema.shape as Record<string, unknown>)["workers"];
      expect(field).toBeDefined();
      const element = (
        field as { unwrap(): { element: { shape: { reason: { options: readonly string[] } } } } }
      ).unwrap().element;
      const listed = element.shape.reason.options;

      expect(listed.length).toBeGreaterThan(0);
      for (const reason of listed) {
        const { stdout } = await printedGateway([gatewayEntry([{ reason, workerId: "wrk_a" }])]);
        const line = stdout.split("\n")[1] ?? "";
        expect(line).toMatch(/^ {2}wrk_a: [a-zA-Z]/);
        expect(line).not.toContain("-");
      }
    });
  });

  it.each([["--devices"], ["--leases"], ["--rules"]])(
    "exits 2 with USAGE for --requests beside %s, without asking the daemon",
    async (other) => {
      const output = outputCapture();
      let listed = 0;
      const client = fakeClient({
        list: () => {
          listed += 1;
          return Promise.resolve([]);
        },
      });

      await expect(
        runCli(
          ["list", "--requests", other],
          output.environmentWith({ connectAdmin: async () => client }),
        ),
      ).resolves.toBe(2);
      expect(listed).toBe(0);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
        error: { code: "USAGE" },
      });
    },
  );
});

describe("simlock lease: a request names a model, a class, or nothing", () => {
  const grant = {
    device: {
      physical: false,
      driverDeviceId: "dev_1",
      id: "dev_1",
      mode: "full" as const,
      spec: { physical: false, model: "iPhone 17", osVersion: "26.5", platform: "ios" as const },
    },
    environment: {},
    lease: {
      deviceId: "dev_1",
      grantedAt: 0,
      id: "lse_1",
      lastRenewedAt: 0,
      idChosenByRequester: false,
      ownerId: "test-requester",
      requesterId: "test-requester",
      ttlDeadline: 60_000,
      ttlMs: 60_000,
    },
    timing: {
      estimatedBootMs: 0,
      estimatedProvisionMs: 0,
      estimatedReadyMs: 0,
      estimatedReclaimMs: 0,
    },
  };

  async function sentFor(args: readonly string[]): Promise<Record<string, unknown> | undefined> {
    let sent: Record<string, unknown> | undefined;
    const client = fakeClient({
      requestLease: (input) => {
        sent = input as unknown as Record<string, unknown>;
        return Promise.resolve(grant);
      },
    });
    const output = outputCapture();
    await runCli(
      ["lease", ...args, "--detach"],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    return sent;
  }

  it.each([
    {
      name: "neither model nor class for a lease with only a platform",
      args: ["--platform", "ios"],
      present: { platform: "ios" },
      absent: ["model", "class"],
    },
    {
      name: "the class for --class, and no model",
      args: ["--platform", "ios", "--class", "phone"],
      present: { class: "phone", platform: "ios" },
      absent: ["model"],
    },
    {
      name: "both fields for --class beside --device, leaving the refusal to the daemon",
      args: ["--platform", "ios", "--class", "phone", "--device", "iPhone 16"],
      present: { class: "phone", model: "iPhone 16", platform: "ios" },
      absent: [],
    },
  ])("sends $name", async ({ args, present, absent }) => {
    const sent = await sentFor(args);

    expect(sent).toMatchObject(present);
    for (const key of absent) expect(sent).not.toHaveProperty(key);
  });

  it("names --class in the lease usage text, with --device optional", async () => {
    const output = outputCapture();

    await runCli(["lease", "--help"], output.environmentWith({}));

    expect(output.stdout).toBe(
      "Usage: simlock lease --platform <ios|android> [--device <model> | --class <class>]\n" +
        "                     [--os <version|range>] [--mode <slim|full>] [--image-tag <tag>] [--agent-id <id>]\n" +
        "                     [--timeout <duration>] [--lease-id <id>] [--physical]\n" +
        "                     [--no-wait] [--detach] [--ttl <duration>] [--allow-download]\n" +
        "                     [--export-env] [--bind-pid <pid>]\n",
    );
  });

  it.each([
    ["--device", "lease --device must not be empty"],
    ["--class", "lease --class must not be empty"],
  ])("exits 2 with USAGE for an empty %s, before connecting", async (flag, message) => {
    const output = outputCapture();
    let connected = false;

    const exitCode = await runCli(
      ["lease", "--platform", "ios", flag, ""],
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient({});
        },
      }),
    );

    expect(exitCode).toBe(2);
    expect(connected).toBe(false);
    expect(output.stderr).toContain(message);
  });

  it("prints the class of a waiting request that names no model, phone when it names none", async () => {
    const output = outputCapture();
    const client = fakeClient({
      list: async () => [
        {
          createdAt: 0,
          id: "req_1",
          queuePosition: 1,
          requesterId: "a",
          spec: { class: "watch", platform: "ios" },
          stage: "queued",
        },
        {
          createdAt: 0,
          id: "req_2",
          queuePosition: 2,
          requesterId: "b",
          spec: { platform: "android" },
          stage: "queued",
        },
      ],
    });

    await runCli(
      ["list", "--requests"],
      output.environmentWith({ connectAdmin: async () => client }),
    );

    expect(output.stdout).toBe(
      "Request req_1: a, ios class watch, queued at 1, waiting 0s\n" +
        "Request req_2: b, android class phone, queued at 2, waiting 0s\n",
    );
  });

  it("prints physical in a waiting physical request's line, and nothing for a simulator request", async () => {
    const output = outputCapture();
    const client = fakeClient({
      list: async () => [
        {
          createdAt: 0,
          id: "req_1",
          queuePosition: 1,
          requesterId: "a",
          spec: { model: "iPhone 15 Pro", physical: true, platform: "ios" },
          stage: "queued",
        },
        {
          createdAt: 0,
          id: "req_2",
          queuePosition: 1,
          requesterId: "b",
          spec: { model: "iPhone 16", platform: "ios" },
          stage: "queued",
        },
      ],
    });

    await runCli(
      ["list", "--requests"],
      output.environmentWith({ connectAdmin: async () => client }),
    );

    expect(output.stdout).toBe(
      "Request req_1: a, ios physical iPhone 15 Pro, queued at 1, waiting 0s\n" +
        "Request req_2: b, ios iPhone 16, queued at 1, waiting 0s\n",
    );
  });

  it("prints a waiting request's OS range as typed", async () => {
    const output = outputCapture();
    const client = fakeClient({
      list: async () => [
        {
          createdAt: 0,
          id: "req_1",
          queuePosition: 1,
          requesterId: "a",
          spec: { osVersion: ">=18 <26", platform: "ios" },
          stage: "queued",
        },
      ],
    });

    await runCli(
      ["list", "--requests"],
      output.environmentWith({ connectAdmin: async () => client }),
    );

    expect(output.stdout).toBe(
      "Request req_1: a, ios class phone >=18 <26, queued at 1, waiting 0s\n",
    );
  });
});

describe("CLI: a worker's capabilities", () => {
  const platform = {
    atRamBudget: false,
    limit: 2,
    maxRunning: 2,
    overLimit: false,
    reserved: 0,
    running: 0,
    used: 0,
    warm: 0,
  };
  const worker = (overrides: Record<string, unknown> = {}) => ({
    capacity: {
      android: platform,
      global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
      ios: platform,
    },
    catalog: [],
    connection: "connected" as const,
    devices: [],
    drained: false,
    id: "wrk_1",
    label: "mac-mini",
    lastSeenAt: 1_000,
    leases: [],
    ...overrides,
  });
  const listed = async (workers: unknown[]): Promise<string> => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ listWorkers: () => Promise.resolve({ workers } as never) }),
    });
    await runCli(["worker", "list"], environment);
    return output.stdout;
  };

  it("worker list prints ` -- agent-device available`, ` -- agent-device off` and ` -- agent-device unavailable: <reason>` on the worker's line", async () => {
    const shown = await listed([
      worker({ capabilities: [{ name: "agent-device", state: "available" }] }),
      worker({ capabilities: [{ name: "agent-device", state: "off" }], id: "wrk_2" }),
      worker({
        capabilities: [
          {
            name: "agent-device",
            reason: "found 0.20.1, need 0.21.28 or later",
            state: "unavailable",
          },
        ],
        id: "wrk_3",
      }),
      worker({
        capabilities: [{ name: "agent-device", reason: "starting", state: "unavailable" }],
        id: "wrk_4",
      }),
    ]);

    expect(shown).toContain("wrk_1 (mac-mini): connected -- ios 0/2, android 0/2, 0 lease(s)");
    expect(shown).toMatch(/^wrk_1 .* -- agent-device available$/m);
    expect(shown).toMatch(/^wrk_2 .* -- agent-device off$/m);
    expect(shown).toMatch(
      /^wrk_3 .* -- agent-device unavailable: found 0\.20\.1, need 0\.21\.28 or later$/m,
    );
    expect(shown).toMatch(/^wrk_4 .* -- agent-device unavailable: starting$/m);
  });

  it("worker list prints two entries in the order the worker sent them", async () => {
    const shown = await listed([
      worker({
        capabilities: [
          { name: "zeta", state: "off" },
          { name: "agent-device", state: "available" },
        ],
      }),
    ]);

    expect(shown).toMatch(/^wrk_1 .* -- zeta off -- agent-device available$/m);
  });

  it("worker list prints nothing for a worker whose list is absent", async () => {
    const shown = await listed([worker()]);

    expect(shown).toMatch(/^wrk_1 .* 0 lease\(s\)$/m);
  });

  it("worker list puts the suffix on the worker's line, before its install lines", async () => {
    const shown = await listed([
      worker({
        capabilities: [{ name: "agent-device", state: "available" }],
        installs: [
          { component: "26.4", platform: "ios", since: 1_000, state: "downloading", waiters: 2 },
        ],
      }),
    ]);

    expect(shown).toContain(
      "-- agent-device available\n  Install ios 26.4: downloading for 0s, 2 waiters",
    );
  });

  it("status against a gateway prints the same suffix in its workers block", async () => {
    const output = outputCapture();
    const status = {
      capacity: {
        android: platform,
        global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
        ios: platform,
      },
      daemon: {
        health: "running" as const,
        mode: "gateway" as const,
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      devices: [],
      host: { arch: "x64", os: "Linux", osVersion: "6.8.0", tools: [] },
      leases: [],
      queueDepth: 0,
      workers: [
        worker({
          capabilities: [{ name: "agent-device", reason: "starting", state: "unavailable" }],
        }),
      ],
    };
    const environment = output.environmentWith({
      connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status as never) }),
    });

    await runCli(["status"], environment);

    expect(output.stdout).toMatch(/^wrk_1 .* -- agent-device unavailable: starting$/m);
  });
});

function usageAnswer(
  window: { readonly from: number; readonly to: number },
  overrides: Partial<UsageOutput> = {},
): UsageOutput {
  const samples = { count: 0, max: null, p50: null, p95: null };
  const figures = {
    boot: samples,
    bySource: { booted: 0, provisioned: 0, warm: 0 },
    declined: 0,
    failures: { byEvent: {} },
    granted: 0,
    held: samples,
    incidents: { crashRecovered: 0, lost: 0, quarantineRecovered: 0, quarantined: 0 },
    provisioning: samples,
    queue: { meanDepth: null, peakDepth: null },
    rejected: { byReason: {}, total: 0 },
    requests: 0,
    turnaround: samples,
    utilisation: { slots: { max: null, mean: null, peak: null } },
    wait: samples,
  };
  return {
    bucketMs: 60_000,
    coversFrom: window.from,
    partial: false,
    platforms: { android: figures, ios: figures },
    requesters: [],
    series: [],
    totals: figures,
    window,
    workers: [],
    ...overrides,
  };
}

describe("CLI: stats", () => {
  const NOW = Date.parse("2026-10-05T12:00:00.000Z");
  const HOUR = 3_600_000;

  function statsRun(argv: readonly string[], usage: SimlockAdminClient["usage"]) {
    const output = outputCapture();
    const asked: { from: number; to: number; includeLedger?: boolean | undefined }[] = [];
    const run = runCli(
      ["stats", ...argv],
      output.environmentWith({
        adminTokenFromEnv: "admin-token",
        clock: new FakeClock(NOW),
        connectAdmin: async (resolveCredential) => {
          await resolveCredential();
          return fakeClient({
            usage: async (window) => {
              asked.push(window);
              return usage(window);
            },
          });
        },
      }),
    );
    return { asked, output, run };
  }

  it("simlock stats words each refusal as the Inputs table says, exits 2, and asks nothing of the daemon", async () => {
    for (const argv of [["--since", "1h"], ["--from", "2026-10-05T10:00:00Z"], ["--json"]]) {
      const { output, run } = statsRun(argv, async (window) => usageAnswer(window));
      await expect(run, argv.join(" ")).resolves.toBe(0);
      expect(output.stderr, argv.join(" ")).not.toContain("USAGE");
    }
    for (const [argv, message] of [
      [
        ["--since", "1h", "--from", "2026-10-05T10:00:00Z"],
        "stats takes --since or --from, not both",
      ],
      [["--to", "2026-10-04T10:00:00Z"], "--to needs --from"],
      [
        ["--from", "2026-10-04T10:00:00Z", "--to", "2026-10-03T10:00:00Z"],
        "--from must be earlier than --to, or than now when --to is left out",
      ],
      [
        ["--from", "2026-10-04T10:00:00Z", "--to", "2026-10-04T10:00:00Z"],
        "--from must be earlier than --to, or than now when --to is left out",
      ],
      [
        ["--from", "2026-10-05T13:00:00Z"],
        "--from must be earlier than --to, or than now when --to is left out",
      ],
      [["--since", "soon"], "Invalid duration: soon"],
      [["--from", "2026-10-15"], "Invalid time: 2026-10-15 (use ISO 8601 with Z or an offset)"],
      [
        ["--from", "2026-10-04T10:00:00Z", "--to", "10/15/2026"],
        "Invalid time: 10/15/2026 (use ISO 8601 with Z or an offset)",
      ],
    ] as const) {
      const { asked, output, run } = statsRun(argv, async (window) => usageAnswer(window));

      await expect(run, argv.join(" ")).resolves.toBe(2);
      expect(output.stderr, argv.join(" ")).toContain('"code":"USAGE"');
      expect(output.stderr, argv.join(" ")).toContain(`"message":"${message}"`);
      expect(asked, argv.join(" ")).toEqual([]);
      expect(output.stdout).toBe("");
    }
  });

  it("simlock stats --json prints the operation's output unchanged", async () => {
    const answer = usageAnswer(
      { from: NOW - HOUR, to: NOW },
      {
        partial: true,
        requesters: [
          { granted: 1, heldTotalMs: 5, id: "tok_a", label: "ci", rejected: 0, requests: 1 },
        ],
      },
    );
    const { output, run } = statsRun(["--since", "1h", "--json"], async () => answer);

    await expect(run).resolves.toBe(0);

    expect(JSON.parse(output.stdout)).toEqual(answer);
    expect(output.stdout.endsWith("\n")).toBe(true);
  });

  it("asks for the last 24 hours by default, and for --since up to now", async () => {
    const byDefault = statsRun([], async (window) => usageAnswer(window));
    const since = statsRun(["--since", "90m"], async (window) => usageAnswer(window));

    await byDefault.run;
    await since.run;

    expect(byDefault.asked).toEqual([{ from: NOW - 24 * HOUR, to: NOW }]);
    expect(since.asked).toEqual([{ from: NOW - 90 * 60_000, to: NOW }]);
  });

  it("asks for the ISO window --from and --to name, and for --from up to now", async () => {
    const both = statsRun(
      ["--from", "2026-10-04T10:00:00Z", "--to", "2026-10-04T12:00:00Z"],
      async (window) => usageAnswer(window),
    );
    const open = statsRun(["--from", "2026-10-05T10:00:00Z"], async (window) =>
      usageAnswer(window),
    );

    await both.run;
    await open.run;

    expect(both.asked).toEqual([
      { from: Date.parse("2026-10-04T10:00:00Z"), to: Date.parse("2026-10-04T12:00:00Z") },
    ]);
    expect(open.asked).toEqual([{ from: Date.parse("2026-10-05T10:00:00Z"), to: NOW }]);
  });

  it("prints the figures as a table, with the partial note above them", async () => {
    const { output, run } = statsRun(["--since", "30d"], async (window) =>
      usageAnswer(window, { coversFrom: NOW - 60_000, partial: true }),
    );

    await expect(run).resolves.toBe(0);

    const lines = output.stdout.split("\n");
    expect(lines[0]).toBe("Usage from 2026-09-05T12:00:00.000Z to 2026-10-05T12:00:00.000Z");
    expect(lines[1]).toContain("Figures cover from 2026-10-05T11:59:00.000Z");
    expect(lines).toContain("Totals");
  });

  it.each([
    ["", ["--since", "30d"]],
    [" with --csv", ["--since", "30d", "--csv"]],
  ])(
    "prints the HISTORY_NOT_KEPT message on stderr, nothing on stdout, and exits with its code when the window ends before the history%s",
    async (_name, args) => {
      const { output, run } = statsRun(args, async () => {
        throw fromWireError(
          "HISTORY_NOT_KEPT",
          "The history does not reach back to the end of that window; its figures start at 2026-10-05T11:59:00.000Z.",
          { oldestTs: NOW - 60_000 },
        );
      });

      await expect(run).resolves.toBe(12);

      expect(output.stdout).toBe("");
      expect(output.stderr).toContain('"code":"HISTORY_NOT_KEPT"');
      expect(output.stderr).toContain("its figures start at 2026-10-05T11:59:00.000Z");
    },
  );

  const LEDGER_HEADER =
    "requestId,requester,label,platform,model,workerId,source,requestedAt,grantedAt,rejectedAt,endedAt,waitMs,heldMs,turnaroundMs,outcome,probe,reason,endReason";
  const TRUNCATION_NOTICE =
    "The ledger holds the newest 100000 requests of the window; ask for a shorter window for the rest.";

  it("simlock stats --csv prints the header row and one row per ledger entry with times as ISO 8601, durations as whole milliseconds (400, not 400.0), probe as true or false, and asks usage.get with includeLedger: true", async () => {
    const requests = [
      {
        endReason: "explicit",
        endedAt: Date.parse("2026-10-05T11:09:30.000Z"),
        grantedAt: Date.parse("2026-10-05T11:01:02.400Z"),
        heldMs: 507_600.4,
        label: "ci-runner",
        model: "iPhone 16",
        outcome: "granted" as const,
        platform: "ios",
        probe: false,
        requestId: "req_8f2",
        requestedAt: Date.parse("2026-10-05T11:01:02.000Z"),
        requester: "tok_ci",
        source: "warm",
        turnaroundMs: 508_000,
        waitMs: 400,
      },
      {
        outcome: "open" as const,
        platform: "android",
        probe: true,
        requestId: "req_9",
        requestedAt: Date.parse("2026-10-05T11:02:00.000Z"),
        requester: "gw:gw-1:tok_a",
      },
    ];
    const { asked, output, run } = statsRun(["--since", "1h", "--csv"], async (window) =>
      usageAnswer(window, { requests }),
    );

    await expect(run).resolves.toBe(0);

    expect(asked[0]?.includeLedger).toBe(true);
    expect(output.stdout.split("\r\n")).toEqual([
      LEDGER_HEADER,
      "req_8f2,tok_ci,ci-runner,ios,iPhone 16,,warm,2026-10-05T11:01:02.000Z,2026-10-05T11:01:02.400Z,,2026-10-05T11:09:30.000Z,400,507600,508000,granted,false,,explicit",
      "req_9,gw:gw-1:tok_a,,android,,,,2026-10-05T11:02:00.000Z,,,,,,,open,true,,",
      "",
    ]);
  });

  it("simlock stats --csv writes the truncation notice on stderr and exits 0 when ledgerTruncated, and writes no notice otherwise", async () => {
    const truncated = statsRun(["--csv"], async (window) =>
      usageAnswer(window, { ledgerTruncated: true, requests: [] }),
    );
    const whole = statsRun(["--csv"], async (window) => usageAnswer(window, { requests: [] }));

    await expect(truncated.run).resolves.toBe(0);
    await expect(whole.run).resolves.toBe(0);

    expect(truncated.output.stderr).toBe(`${JSON.stringify({ notice: TRUNCATION_NOTICE })}\n`);
    expect(truncated.output.stdout.startsWith(LEDGER_HEADER)).toBe(true);
    expect(whole.output.stderr).toBe("");
    expect(whole.output.stdout.startsWith(LEDGER_HEADER)).toBe(true);
  });

  it("simlock stats refuses --csv with --json as a usage error, exit 2", async () => {
    const accepted = statsRun(["--csv"], async (window) => usageAnswer(window, { requests: [] }));
    const both = statsRun(["--csv", "--json"], async (window) => usageAnswer(window));

    await expect(accepted.run).resolves.toBe(0);
    await expect(both.run).resolves.toBe(2);

    expect(both.output.stderr).toContain('"code":"USAGE"');
    expect(both.output.stderr).toContain('"message":"stats takes --csv or --json, not both"');
    expect(both.asked).toEqual([]);
    expect(both.output.stdout).toBe("");
  });

  it("closes the connection after the answer, and after a failure", async () => {
    let closed = 0;
    const output = outputCapture();
    const connect = (usage: SimlockAdminClient["usage"]) => async () =>
      fakeClient({
        close: async () => {
          closed += 1;
        },
        usage,
      });

    await runCli(
      ["stats"],
      output.environmentWith({ connectAdmin: connect(async (window) => usageAnswer(window)) }),
    );
    await runCli(
      ["stats"],
      output.environmentWith({
        connectAdmin: connect(async () => {
          throw new Error("boom");
        }),
      }),
    );

    expect(closed).toBe(2);
  });

  it("prints its usage on --help without connecting", async () => {
    const output = outputCapture();
    let connected = false;

    const exitCode = await runCli(
      ["stats", "--help"],
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient();
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(connected).toBe(false);
    expect(output.stdout).toBe(
      "Usage: simlock stats [--since <duration> | --from <ISO> [--to <ISO>]] [--json | --csv]\n",
    );
  });
});

describe("CLI: daemon install (#830)", () => {
  const home = "/Users/me";
  const nodePath = "/opt/node/bin/node";
  const mainPath = "/opt/simlock/dist/daemon/main.js";

  async function install(options: {
    readonly argv: readonly string[];
    readonly role: "worker" | "gateway";
    readonly root: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly linux?: boolean;
    readonly user?: () => string;
  }): Promise<{
    readonly exitCode: number;
    readonly output: ReturnType<typeof outputCapture>;
    readonly serviceManager: FakeServiceManager;
  }> {
    const { root } = options;
    const dataDirectory = options.role === "gateway" ? join(root, "gateway") : root;
    const filesystem = new MemoryFilesystem();
    const ipcTransport = new MemoryIpcTransport();
    const serviceManager = new FakeServiceManager({
      ...(options.linux === true ? { manager: "systemd" as const } : {}),
      onInstall: async () => {
        await startInMemoryDaemon({
          adminTokenPath: join(dataDirectory, "admin.token"),
          filesystem,
          ipcTransport,
          socketPath: join(dataDirectory, "daemon.sock"),
        });
      },
    });
    const output = outputCapture(
      {
        filesystem,
        clock: new FakeClock(0),
        systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
        ipc: ipcTransport,
        launcher: new FakeDaemonLauncher(),
        daemonHome: { role: options.role, dataDirectory, gatewayPresent: false },
        service: {
          manager: serviceManager,
          platform: options.linux === true ? "linux" : "darwin",
          home: options.linux === true ? "/home/me" : home,
          user: options.user ?? (() => "me"),
          root,
          nodePath,
          mainPath,
        },
      },
      options.env,
    );
    const exitCode = await runCli(options.argv, output.environmentWith());
    return { exitCode, output, serviceManager };
  }

  it("an operator runs daemon install on macOS: the service is installed, the daemon answers, install prints the name, Daemon running and the hint, and --json prints the status and service", async () => {
    const cases = [
      {
        label: "worker, default home",
        argv: ["daemon", "install"],
        role: "worker" as const,
        root: join(home, ".simlock"),
        name: "com.callstack.simlock.worker",
        args: [mainPath],
        logPath: "/Users/me/.simlock/daemon.log",
      },
      {
        label: "gateway on a host with no gateway folder yet",
        argv: ["--gateway", "daemon", "install"],
        role: "gateway" as const,
        root: join(home, ".simlock"),
        name: "com.callstack.simlock.gateway",
        args: [mainPath, "--gateway"],
        logPath: "/Users/me/.simlock/gateway/daemon.log",
      },
      {
        label: "another SIMLOCK_HOME",
        argv: ["daemon", "install"],
        role: "worker" as const,
        root: "/tmp/x",
        name: "com.callstack.simlock.worker.2e56aa",
        args: [mainPath],
        logPath: "/tmp/x/daemon.log",
      },
    ];

    for (const testCase of cases) {
      const { exitCode, output, serviceManager } = await install(testCase);
      const label = testCase.label;
      expect(output.stderr, label).toBe("");
      expect(exitCode, label).toBe(0);
      expect(serviceManager.installs, label).toHaveLength(1);
      expect(serviceManager.installs[0], label).toMatchObject({
        name: testCase.name,
        path: `/Users/me/Library/LaunchAgents/${testCase.name}.plist`,
        command: nodePath,
        args: testCase.args,
        logPath: testCase.logPath,
      });
      expect(output.stdout.split("\n").slice(0, 2), label).toEqual([
        `Service installed: ${testCase.name} (launchd)`,
        "Daemon running",
      ]);
      expect(output.stdout.trimEnd().split("\n").at(-1), label).toBe(
        "To start after a reboot, turn on automatic login for this user.",
      );
    }

    const withShell = await install({
      argv: ["daemon", "install"],
      role: "worker",
      root: join(home, ".simlock"),
      env: { PATH: "/opt/bin:/usr/bin", JAVA_HOME: "/jdk", SIMLOCK_ADMIN_TOKEN: "secret" },
    });
    expect(withShell.exitCode, withShell.output.stderr).toBe(0);
    expect(withShell.serviceManager.installs[0]?.environment).toEqual({
      SIMLOCK_HOME: join(home, ".simlock"),
      PATH: "/opt/bin:/usr/bin",
      JAVA_HOME: "/jdk",
    });

    const json = await install({
      argv: ["daemon", "install", "--json"],
      role: "worker",
      root: join(home, ".simlock"),
    });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output.stdout)).toEqual({
      status: "installed",
      service: {
        state: "installed",
        manager: "launchd",
        name: "com.callstack.simlock.worker",
        path: "/Users/me/Library/LaunchAgents/com.callstack.simlock.worker.plist",
      },
    });
  });

  it("an operator on Linux runs daemon install: the unit lands in the user config directory, and install prints systemd and the linger hint", async () => {
    const cases = [
      {
        label: "default config directory",
        env: {},
        unit: "/home/me/.config/systemd/user/com.callstack.simlock.worker.service",
      },
      {
        label: "absolute XDG_CONFIG_HOME",
        env: { XDG_CONFIG_HOME: "/xdg" },
        unit: "/xdg/systemd/user/com.callstack.simlock.worker.service",
      },
    ];
    for (const { label, env, unit } of cases) {
      const { exitCode, output, serviceManager } = await install({
        argv: ["daemon", "install"],
        role: "worker",
        root: "/home/me/.simlock",
        env,
        linux: true,
      });

      expect(output.stderr, label).toBe("");
      expect(exitCode, label).toBe(0);
      expect(serviceManager.installs[0]?.path, label).toBe(unit);
      expect(output.stdout.split("\n").slice(0, 2), label).toEqual([
        "Service installed: com.callstack.simlock.worker (systemd)",
        "Daemon running",
      ]);
      expect(output.stdout.trimEnd().split("\n").at(-1), label).toBe(
        "To start after a reboot without logging in, run: loginctl enable-linger me",
      );
    }

    // why: a uid with no passwd entry makes the user lookup throw; install must still succeed.
    const unknownUser = (): string => {
      throw new Error("ENOENT: no passwd entry for uid 1234");
    };
    const lookupFails = await install({
      argv: ["daemon", "install"],
      role: "worker",
      root: "/home/me/.simlock",
      linux: true,
      user: unknownUser,
    });
    expect(lookupFails.output.stderr).toBe("");
    expect(lookupFails.exitCode).toBe(0);
    expect(lookupFails.output.stdout.trimEnd().split("\n").at(-1)).toBe(
      "To start after a reboot without logging in, run: loginctl enable-linger <user>",
    );
  });

  async function runWithService(options: {
    readonly argv: readonly string[];
    readonly running: boolean;
    readonly socketHeldPolls: number;
    readonly state?: ServiceState;
    readonly refuse?: boolean;
  }): Promise<{
    readonly exitCode: number;
    readonly output: ReturnType<typeof outputCapture>;
    readonly stops: number;
    readonly serviceManager: FakeServiceManager;
    readonly clock: FakeClock;
  }> {
    const root = join(home, ".simlock");
    const clock = new FakeClock(0);
    const serviceManager = new FakeServiceManager(
      options.state === undefined ? {} : { state: options.state },
    );
    let stops = 0;
    let polls = 0;
    const connectExistingAdmin: CliEnvironment["connectExistingAdmin"] = async (
      resolveCredential,
    ) => {
      await resolveCredential();
      if (!options.running)
        throw new IpcError("endpoint-not-found", "No IPC endpoint yet", undefined);
      if (options.refuse === true) {
        throw new SimlockError("FORBIDDEN", "protocol", "The admin token was rejected", {});
      }
      // why: a stopping daemon refuses new connections while it still holds its socket.
      if (stops > 0) throw new IpcError("connection-refused", "Connection refused", undefined);
      return fakeClient({
        stopDaemon: async () => {
          stops += 1;
          return { stopping: true };
        },
      });
    };
    const output = outputCapture();
    const environment = output.environmentWith({
      clock,
      daemonHome: { role: "worker", dataDirectory: root, gatewayPresent: false },
      connectExistingAdmin,
      daemonEndpointPresent: async () => {
        if (stops === 0) return options.running;
        polls += 1;
        return polls <= options.socketHeldPolls;
      },
      readAdminTokenFile: async () => "admin-token",
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
      },
      service: {
        manager: serviceManager,
        platform: "darwin",
        user: () => "me",
        definition: async () =>
          serviceDefinition({
            role: "worker",
            root,
            dataDirectory: root,
            home,
            nodePath,
            mainPath,
            env: {},
          }),
      },
    });
    const exitCode = await runCli(options.argv, environment);
    return { exitCode, output, stops, serviceManager, clock };
  }

  it("daemon uninstall removes the service", async () => {
    const installedState: ServiceState = {
      state: "installed",
      path: "/Users/me/Library/LaunchAgents/com.callstack.simlock.worker.plist",
    };
    const name = "com.callstack.simlock.worker";
    const cases = [
      {
        label: "installed",
        argv: ["daemon", "uninstall"],
        state: installedState,
        stdout: `Service removed: ${name} (launchd)\n`,
        removed: 1,
      },
      {
        label: "installed, --json",
        argv: ["daemon", "uninstall", "--json"],
        state: installedState,
        json: { status: "removed", service: { state: "not-installed", manager: "launchd", name } },
        removed: 1,
      },
      {
        label: "installed, a daemon running, --json",
        argv: ["daemon", "uninstall", "--json"],
        state: installedState,
        running: true,
        json: {
          status: "removed",
          stopped: true,
          service: { state: "not-installed", manager: "launchd", name },
        },
        removed: 1,
      },
      {
        label: "installed, gateway flag, no gateway folder",
        argv: ["--gateway", "daemon", "uninstall"],
        state: installedState,
        stdout: `Service removed: ${name} (launchd)\n`,
        removed: 1,
      },
      {
        label: "not installed",
        argv: ["daemon", "uninstall"],
        state: { state: "not-installed" } as ServiceState,
        stdout: `Service not installed: ${name}\n`,
        removed: 0,
      },
      {
        label: "not installed, --json",
        argv: ["daemon", "uninstall", "--json"],
        state: { state: "not-installed" } as ServiceState,
        json: {
          status: "not-installed",
          service: { state: "not-installed", manager: "launchd", name },
        },
        removed: 0,
      },
    ];
    for (const testCase of cases) {
      const result = await runWithService({
        argv: testCase.argv,
        running: testCase.running ?? false,
        socketHeldPolls: 0,
        state: testCase.state,
      });
      expect(result.output.stderr, testCase.label).toBe("");
      expect(result.exitCode, testCase.label).toBe(0);
      expect(result.serviceManager.uninstalls, testCase.label).toHaveLength(testCase.removed);
      if (testCase.json === undefined)
        expect(result.output.stdout, testCase.label).toBe(testCase.stdout);
      else expect(JSON.parse(result.output.stdout), testCase.label).toEqual(testCase.json);
    }
  });

  it("daemon install stops a running daemon first and waits until its socket is released, even while it refuses connections", async () => {
    const none = await runWithService({
      argv: ["daemon", "install"],
      running: false,
      socketHeldPolls: 0,
    });
    expect(none.exitCode).toBe(0);
    expect(none.stops).toBe(0);
    expect(none.output.stdout).not.toContain("Stopped");

    const running = await runWithService({
      argv: ["daemon", "install"],
      running: true,
      socketHeldPolls: 3,
    });
    expect(running.exitCode).toBe(0);
    expect(running.stops).toBe(1);
    expect(running.output.stdout.split("\n").slice(0, 2)).toEqual([
      "Stopped the running daemon; leases are kept.",
      "Service installed: com.callstack.simlock.worker (launchd)",
    ]);

    const json = await runWithService({
      argv: ["daemon", "install", "--json"],
      running: true,
      socketHeldPolls: 0,
    });
    expect(JSON.parse(json.output.stdout)).toMatchObject({ status: "installed", stopped: true });

    const stubborn = await runWithService({
      argv: ["daemon", "install"],
      running: true,
      socketHeldPolls: Number.POSITIVE_INFINITY,
    });
    expect(stubborn.exitCode).toBe(1);
    expect(JSON.parse(stubborn.output.stderr)).toEqual({
      error: {
        code: "SERVICE_FAILED",
        message: "The running daemon did not stop within 300 s; nothing was changed.",
      },
    });
    expect(stubborn.serviceManager.installs).toEqual([]);
    expect(stubborn.clock.now()).toBeGreaterThanOrEqual(300_000);
    expect(stubborn.clock.now()).toBeLessThan(301_000);

    const refused = await runWithService({
      argv: ["daemon", "install"],
      running: true,
      socketHeldPolls: 0,
      refuse: true,
    });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.output.stderr)).toEqual({
      error: { code: "FORBIDDEN", message: "The admin token was rejected" },
    });
    expect(refused.serviceManager.installs).toEqual([]);

    const uninstall = await runWithService({
      argv: ["daemon", "uninstall"],
      running: true,
      socketHeldPolls: 3,
      state: { state: "installed", path: "/Users/me/Library/LaunchAgents/x.plist" },
    });
    expect(uninstall.exitCode).toBe(0);
    expect(uninstall.stops).toBe(1);
    expect(uninstall.output.stdout.split("\n").slice(0, 2)).toEqual([
      "Daemon stopping",
      "Service removed: com.callstack.simlock.worker (launchd)",
    ]);
  });
});

describe("CLI: a start goes through the service (#830)", () => {
  it("daemon start and a command's auto-start ask a loaded service to start the daemon and spawn nothing", async () => {
    const home = "/Users/me";
    const root = join(home, ".simlock");
    const cases = [
      { label: "daemon start", argv: ["daemon", "start", "--json"] },
      { label: "a command's auto-start", argv: ["status", "--json"] },
    ];
    for (const testCase of cases) {
      const filesystem = new MemoryFilesystem();
      const ipcTransport = new MemoryIpcTransport();
      const serviceManager = new FakeServiceManager({
        state: { state: "installed", path: "/Users/me/Library/LaunchAgents/x.plist" },
        onStart: async () => {
          await startInMemoryDaemon({
            adminTokenPath: join(root, "admin.token"),
            filesystem,
            ipcTransport,
            socketPath: join(root, "daemon.sock"),
          });
        },
      });
      const spawner = new FakeDaemonLauncher(() => undefined, {
        exit: { code: 1, signal: null },
      });
      const notices: string[] = [];
      const output = outputCapture({
        filesystem,
        clock: new FakeClock(0),
        systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
        ipc: ipcTransport,
        launcher: launcherFor({
          role: "worker",
          root,
          dataDirectory: root,
          mainPath: "/opt/simlock/dist/daemon/main.js",
          nodePath: "/opt/node/bin/node",
          home,
          env: {},
          serviceManager,
          notify: (line) => notices.push(line),
          spawner,
        }),
        daemonHome: { role: "worker", dataDirectory: root, gatewayPresent: false },
      });

      const exitCode = await runCli(testCase.argv, output.environmentWith());

      expect(exitCode, testCase.label).toBe(0);
      expect(serviceManager.starts, testCase.label).toHaveLength(1);
      expect(serviceManager.starts[0]?.name, testCase.label).toBe("com.callstack.simlock.worker");
      expect(spawner.launches, testCase.label).toBe(0);
      expect(notices, testCase.label).toEqual([]);
    }
  });
});

describe("CLI: a start through a service that fails (#830)", () => {
  it("fails at the 20 s deadline with DAEMON_STARTUP_FAILED and the daemon.log lines written since the start", async () => {
    const startError =
      '{"message":"Daemon failed to start","fields":{"message":"EADDRINUSE: socket taken"}}\n';
    const cases = [
      { label: "the log holds the start error", written: startError, expected: "EADDRINUSE" },
      { label: "empty log", written: "", expected: undefined },
      {
        label: "25 lines: the last 20 are kept",
        written: Array.from({ length: 25 }, (_, index) => `line ${String(index + 1)}\n`).join(""),
        expected: "line 6\n",
        notExpected: "line 5\n",
      },
    ];
    for (const testCase of cases) {
      const directory = await mkdtemp(join(tmpdir(), "simlock-service-start-"));
      try {
        const logPath = join(directory, "daemon.log");
        await writeFile(logPath, "older line\n");
        const clock = new FakeClock(0);
        const serviceManager = new FakeServiceManager({
          state: { state: "installed", path: "/Users/me/Library/LaunchAgents/x.plist" },
          onStart: async () => {
            await appendFile(logPath, testCase.written);
          },
        });
        const output = outputCapture({
          filesystem: new MemoryFilesystem(),
          clock,
          systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
          ipc: new MemoryIpcTransport(),
          launcher: launcherFor({
            role: "worker",
            root: directory,
            dataDirectory: directory,
            mainPath: "/opt/simlock/dist/daemon/main.js",
            nodePath: "/opt/node/bin/node",
            home: "/Users/me",
            env: {},
            serviceManager,
            notify: () => undefined,
            spawner: new FakeDaemonLauncher(),
          }),
          daemonHome: { role: "worker", dataDirectory: directory, gatewayPresent: false },
        });
        let settled = false;
        const exitCode = runCli(["daemon", "start", "--json"], output.environmentWith()).then(
          (code) => {
            settled = true;
            return code;
          },
        );
        for (let tick = 0; tick < 500 && !settled; tick += 1) {
          clock.advance(50);
          await settle();
          await settle();
        }
        expect(settled, `${testCase.label}: not settled at ${String(clock.now())}ms`).toBe(true);
        expect(await exitCode, testCase.label).toBe(1);
        const error = (
          JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "") as {
            error: { code: string; message: string };
          }
        ).error;
        expect(error.code, testCase.label).toBe("DAEMON_STARTUP_FAILED");
        expect(error.message, testCase.label).toContain("Timed out starting simlock daemon");
        expect(error.message, testCase.label).not.toContain("older line");
        if (testCase.expected === undefined) {
          expect(error.message, testCase.label).not.toContain("\n");
        } else {
          expect(error.message, testCase.label).toContain(testCase.expected);
        }
        if (testCase.notExpected !== undefined) {
          expect(error.message, testCase.label).not.toContain(testCase.notExpected);
        }
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  });
});

describe("CLI: a service manager call fails, or the platform has none (#830)", () => {
  const home = "/Users/me";
  const root = join(home, ".simlock");
  const name = "com.callstack.simlock.worker";
  const plist = `${home}/Library/LaunchAgents/${name}.plist`;
  const nodePath = "/opt/node/bin/node";
  const mainPath = "/opt/simlock/dist/daemon/main.js";
  const done = (code: number | null, stderr = "") => ({ code, stdout: "", stderr });

  async function run(options: {
    readonly argv: readonly string[];
    readonly platform?: NodeJS.Platform;
    readonly script?: ConstructorParameters<typeof ScriptedProcessRunner>[0];
    readonly present?: readonly string[];
  }): Promise<{
    readonly exitCode: number;
    readonly stderr: string;
    readonly filesystem: MemoryFilesystem;
  }> {
    const filesystem = new MemoryFilesystem();
    for (const path of options.present ?? []) {
      await filesystem.mkdirp(dirname(path));
      await filesystem.writeFileAtomic(path, "");
    }
    const manager =
      options.script === undefined
        ? undefined
        : new LaunchdServiceManager({
            runner: new ScriptedProcessRunner(options.script),
            filesystem,
            uid: 501,
          });
    const ipc = new MemoryIpcTransport();
    const ports: CliEnvironmentPorts = {
      filesystem,
      clock: new FakeClock(0),
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc,
      launcher: launcherFor({
        role: "worker",
        root,
        dataDirectory: root,
        mainPath,
        nodePath,
        home,
        env: {},
        serviceManager: manager,
        notify: () => undefined,
        spawner: new FakeDaemonLauncher(() => undefined, { exit: { code: 1, signal: null } }),
      }),
      daemonHome: { role: "worker", dataDirectory: root, gatewayPresent: false },
      service: {
        manager,
        platform: options.platform ?? "darwin",
        user: () => "me",
        home,
        root,
        nodePath,
        mainPath,
      },
    };
    const output = outputCapture(ports);
    const exitCode = await runCli(options.argv, output.environmentWith());
    return { exitCode, stderr: output.stderr, filesystem };
  }

  const errorOf = (stderr: string): { code: string; message: string } =>
    (
      JSON.parse(stderr.trim().split("\n").at(-1) ?? "") as {
        error: { code: string; message: string };
      }
    ).error;

  it("a failed or stuck launchctl call is SERVICE_FAILED, a failed load removes the plist, and a platform without a service manager is a usage error", async () => {
    for (const command of ["install", "uninstall"]) {
      const result = await run({ argv: ["daemon", command], platform: "win32" });
      expect(result.exitCode, `win32 ${command}`).toBe(2);
      expect(errorOf(result.stderr), `win32 ${command}`).toEqual({
        code: "USAGE",
        message: `daemon ${command} is supported on macOS and Linux only`,
      });
    }

    const bootout = {
      match: { command: "launchctl", args: ["bootout", `gui/501/${name}`] },
      result: done(113),
    };
    const bootstrap = { command: "launchctl", args: ["bootstrap", "gui/501", plist] };
    const failedLoad = await run({
      argv: ["daemon", "install"],
      script: [
        bootout,
        {
          match: bootstrap,
          result: done(5, "Bootstrap failed: 5: Input/output error\nsecond line"),
        },
      ],
    });
    expect(failedLoad.exitCode).toBe(1);
    expect(errorOf(failedLoad.stderr)).toEqual({
      code: "SERVICE_FAILED",
      message: `launchctl bootstrap gui/501 ${plist} failed: Bootstrap failed: 5: Input/output error`,
    });
    expect(await failedLoad.filesystem.exists(plist)).toBe(false);

    const stuckLoad = await run({
      argv: ["daemon", "install"],
      script: [bootout, { match: bootstrap, result: done(null) }],
    });
    expect(stuckLoad.exitCode).toBe(1);
    expect(errorOf(stuckLoad.stderr)).toEqual({
      code: "SERVICE_FAILED",
      message: `launchctl bootstrap gui/501 ${plist} did not finish within 10 s`,
    });
    expect(await stuckLoad.filesystem.exists(plist)).toBe(false);

    const failedKickstart = await run({
      argv: ["daemon", "start"],
      present: [plist, nodePath, mainPath],
      script: [
        {
          match: { command: "plutil", args: ["-convert", "json", "-o", "-", plist] },
          result: {
            code: 0,
            stdout: JSON.stringify({ ProgramArguments: [nodePath, mainPath] }),
            stderr: "",
          },
        },
        { match: { command: "launchctl", args: ["print", `gui/501/${name}`] }, result: done(0) },
        {
          match: { command: "launchctl", args: ["kickstart", `gui/501/${name}`] },
          result: done(1, "Could not find service"),
        },
      ],
    });
    expect(failedKickstart.exitCode).toBe(1);
    expect(errorOf(failedKickstart.stderr)).toEqual({
      code: "SERVICE_FAILED",
      message: `launchctl kickstart gui/501/${name} failed: Could not find service`,
    });
  });
});

describe("simlock worker update", () => {
  type UpdateAnswer = Awaited<ReturnType<SimlockAdminClient["updateWorker"]>>;
  type View = Awaited<ReturnType<SimlockAdminClient["listWorkers"]>>["workers"][number];
  const view = (overrides: Partial<View> = {}): View => ({
    connection: "connected",
    drained: false,
    id: "3f81a2c4",
    label: "mac-studio-2",
    lastSeenAt: 1_000,
    version: "0.3.0",
    ...overrides,
  });
  const run = { forced: false, from: "0.3.0", startedAt: 1_000, to: "0.4.0" } as const;
  const answer = (overrides: Partial<UpdateAnswer> = {}): UpdateAnswer => ({
    health: "running",
    lastUpdateFailure: null,
    latestVersion: "0.4.0",
    resolved: "0.4.0",
    started: true,
    update: { ...run, stage: "installing" },
    upToDate: false,
    version: "0.3.0",
    workerId: "3f81a2c4",
    ...overrides,
  });

  it("follows the update to is running, reports a failure with exit 1, says why the worker is up to date, detaches, and refuses on a worker daemon", async () => {
    const failure = {
      at: 2_000,
      from: "0.3.0",
      message: "npm exited 1",
      stage: "installing",
      to: "0.4.0",
    } as const;
    const cases: readonly {
      readonly name: string;
      readonly argv: readonly string[];
      readonly answer: UpdateAnswer | SimlockError;
      readonly lists?: readonly View[];
      readonly code: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly polls?: number;
    }[] = [
      {
        name: "follows to running",
        argv: ["worker", "update", "3f81a2c4", "--version", "0.4.0", "--force"],
        answer: answer(),
        lists: [
          view({ update: { ...run, leases: 2, stage: "waiting" } }),
          view({ update: { ...run, stage: "installing" } }),
          view({ connection: "disconnected", update: { ...run, stage: "restarting" } }),
          view({ update: { ...run, stage: "restarting" }, version: "0.4.0" }),
          view({ update: null, version: "0.4.0" }),
        ],
        code: 0,
        stdout: "mac-studio-2 (3f81a2c4) is running 0.4.0\n",
        polls: 5,
      },
      {
        name: "fails with the stage and message",
        argv: ["worker", "update", "3f81a2c4"],
        answer: answer(),
        lists: [view({ lastUpdateFailure: failure, update: null })],
        code: 1,
        stdout: "Update failed (installing): npm exited 1\n",
        polls: 1,
      },
      {
        name: "already on the latest",
        argv: ["worker", "update", "3f81a2c4"],
        answer: answer({ started: false, update: null, upToDate: true, version: "0.4.0" }),
        code: 0,
        stdout: "mac-studio-2 (3f81a2c4) is already on the latest (0.4.0)\n",
        polls: 1,
      },
      {
        name: "already running the requested version",
        argv: ["worker", "update", "3f81a2c4", "--version", "0.4.0"],
        answer: answer({ started: false, update: null, upToDate: true, version: "0.4.0" }),
        code: 0,
        stdout: "mac-studio-2 (3f81a2c4) is already running 0.4.0\n",
        polls: 1,
      },
      {
        name: "newer than the latest",
        argv: ["worker", "update", "3f81a2c4"],
        answer: answer({
          resolved: "0.3.0",
          started: false,
          update: null,
          upToDate: true,
          version: "0.4.0",
        }),
        code: 0,
        stdout:
          "mac-studio-2 (3f81a2c4) is newer than the latest (0.3.0). Use --version to install another version.\n",
        polls: 1,
      },
      {
        name: "detach",
        argv: ["worker", "update", "3f81a2c4", "--detach"],
        answer: answer(),
        code: 0,
        stdout:
          "Updating mac-studio-2 (3f81a2c4) 0.3.0 → 0.4.0. Follow it with simlock worker list.\n",
        polls: 1,
      },
      {
        name: "worker daemon",
        argv: ["worker", "update", "3f81a2c4"],
        answer: new SimlockError(
          "UNSUPPORTED_IN_WORKER_MODE",
          "domain",
          "worker.update is a gateway operation",
          { operation: "worker.update" },
        ),
        code: 2,
        stderr: "worker.update is a gateway operation",
        polls: 0,
      },
    ];
    for (const spec of cases) {
      const output = outputCapture();
      const clock = new FakeClock(0);
      const sent: unknown[] = [];
      const lists = [...(spec.lists ?? [view()])];
      let polls = 0;
      const environment = output.environmentWith({
        clock,
        connectAdmin: async () =>
          fakeClient({
            listWorkers: async () => {
              polls += 1;
              const next = lists.length > 1 ? lists.shift() : lists[0];
              return { workers: next === undefined ? [] : [next] };
            },
            updateWorker: async (input) => {
              sent.push(input);
              if (spec.answer instanceof Error) throw spec.answer;
              return spec.answer;
            },
          }),
        // why: a follow that never reaches an outcome fails on this line, not by timing out.
        sleep: async (milliseconds) => {
          if (polls > (spec.lists ?? []).length + 2)
            throw new Error(`${spec.name}: the follow never ended`);
          clock.advance(milliseconds);
        },
      });

      const code = await runCli(spec.argv, environment);

      expect({ code, name: spec.name, stdout: output.stdout }).toEqual({
        code: spec.code,
        name: spec.name,
        stdout: spec.stdout ?? "",
      });
      if (spec.stderr !== undefined) expect(output.stderr).toContain(spec.stderr);
      expect({ name: spec.name, polls }).toEqual({ name: spec.name, polls: spec.polls ?? 0 });
      expect(sent).toEqual([
        {
          workerId: "3f81a2c4",
          ...(spec.argv.includes("--version") ? { version: "0.4.0" } : {}),
          ...(spec.argv.includes("--force") ? { force: true } : {}),
        },
      ]);
    }
  });
});
