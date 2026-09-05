import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { type Config, CleanupReaper, FakeDriver, LeaseEngine, Registry } from "../core/index.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeDaemonLauncher,
  FakeParentWatch,
  MemoryFilesystem,
  MemoryIpcTransport,
  NodeFilesystem,
  NodeIpcTransport,
  type Filesystem,
  type IdGenerator,
} from "../ports/index.js";
import { FakeSystemStats } from "../ports/index.js";
import { TokenStore } from "../http/token-store.js";
import { DaemonEndpointHost } from "../daemon/connection-host.js";
import { DaemonServer } from "../daemon/server.js";
import { AdminSecretManager } from "../daemon/admin-secret.js";
import { createCredentialRoleResolver } from "../daemon/session.js";
import { SimlockError, type AnySimlockError } from "../contract/index.js";
import type {
  CatalogGetOutput,
  DeviceRecoveredPush,
  DeviceUnhealthyPush,
  DoctorReport,
  LeaseGrant,
  LeaseListOutput,
  LeaseRecord,
  ListGetOutput,
  SimlockAdminClient,
  SimlockConfig,
  StatusGetOutput,
  TokenListOutput,
} from "../simlock-client/client.js";
import { connectSimlockAdmin } from "../admin/index.js";
import {
  buildCliEnvironment,
  errorExitCode,
  fallbackRequesterId,
  parseDuration,
  readLogFile,
  runCli,
  type CliEnvironment,
  type CliEnvironmentPorts,
} from "./index.js";

const gibibyte = 1024 ** 3;
/** A minimal daemon lease response, for the tests that only care what the CLI prints. */
const detachedGrant: LeaseGrant = {
  device: {
    id: "device-1",
    driverDeviceId: "ABCD",
    spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
  },
  environment: {},
  lease: {
    id: "lse_env",
    deviceId: "device-1",
    requesterId: "test-requester",
    ownerId: "test-requester",
    mode: "detached",
    grantedAt: 0,
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

/**
 * ADR 0003 §12: "one smoke test per frontend ... frontends are now serialization". This suite
 * -- the CLI's own -- keeps: exit-code mapping off `ERROR_TABLE` (not a second map), the
 * admin-credential resolution order and its agent-fallback notice (ADR §5), `daemon status`'s
 * absent-vs-refused distinction (ADR §11), `config set`'s validate-before-write, `--json` shape
 * (no snake_case renderings), the `--yes`/confirm guards on destructive commands (safety rule
 * 5), and (see "CLI: lease pushes and exit codes" / "CLI: mcp command" / "CLI: daemon logs"
 * below) the CLI's own process-lifecycle and stderr-rendering behaviour that no other suite
 * exercises: the lost-lease exit code and its non-re-release, the `{push:...}` stderr lines
 * including the own-lease-id filter, the `--full`/`--no-wait` flag mapping, the `mcp` command's
 * lazy module load and startup-failure reporting, and `daemon logs` working without a
 * connection. Deleted from the pre-ADR suite: every test that only re-walked a daemon
 * operation's request/response shape through the CLI (lease grant field-by-field, doctor
 * findings, cleanup/nuke proposals, catalog/list passthrough, events replay/follow wire format,
 * renew) -- that behaviour is the daemon's contract now, covered once at
 * `daemon/dispatcher.test.ts`, and `SimlockClientImpl`'s own suite in
 * `simlock-client/client.test.ts`; re-asserting it a third time through the CLI tested only that
 * this module still calls `client.foo()`, which the TypeScript compiler already guarantees
 * against `SimlockAdminClient`'s interface. `--bind-pid`/parent-watch termination races are not
 * covered by any suite in `pnpm run test` -- they survive only in the real-hardware e2e lanes.
 */
describe("CLI: exit codes", () => {
  it.each([
    ["QUEUE_TIMEOUT", 10],
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
    expect(errorExitCode(error)).toBe(expected);

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
    expect(output.stderr).not.toContain("already");
  });

  it("prints shell export lines instead of the JSON grant under --export-env", async () => {
    const output = outputCapture();
    const grant: LeaseGrant = {
      ...detachedGrant,
      // A device root is a user-configurable path, so it can hold a space or an apostrophe;
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
    // stdout stays empty so `eval "$(...)"` is unaffected, but the lease is committed and
    // TTL-bound: a caller told nothing at all could neither renew nor release it.
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain(detachedGrant.lease.id);
    expect(output.stderr).toContain("no environment");
  });

  it("fails loudly rather than exporting a key that would change what eval runs", async () => {
    const output = outputCapture();
    const grant: LeaseGrant = {
      ...detachedGrant,
      // Not reachable through the shipped drivers, whose keys are literals -- but
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
      lease: { ...detachedGrant.lease, id: "lse_parent_death", mode: "held" },
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
      lease: { ...detachedGrant.lease, id: "lse_bind_pid", mode: "held" },
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
    // The captured parent is not the one being watched any more, so its death is ignored.
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

  it("maps a usage error to exit 2 with code USAGE", async () => {
    const output = outputCapture();
    await expect(runCli(["nope"], output.environmentWith())).resolves.toBe(2);
    expect(JSON.parse(output.stderr).error.code).toBe("USAGE");
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
    // The file source must never be consulted -- let alone before the connection exists -- when
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
        freeRamBytes: 32 * gibibyte,
        totalRamBytes: 32 * gibibyte,
      }),
      ipc: ipcTransport,
      launcher,
      dataDirectory: "/simlock",
    });
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith(),
    );
    expect(exitCode).toBe(0);
    expect(launcher.launches).toBe(1);
    const grant = JSON.parse(output.stdout) as LeaseGrant & { role: string };
    expect(grant.role).toBe("admin");
    // Provisioning progress pushes are expected noise on stderr; the agent-fallback notice is
    // the thing that must be absent.
    expect(output.stderr).not.toContain("notice");
  });

  it("B1: a stale admin.token degrades to an agent session instead of bricking the invocation", async () => {
    const filesystem = new MemoryFilesystem();
    const ipcTransport = new MemoryIpcTransport();
    const socketPath = "/simlock/daemon.sock";
    const adminTokenPath = "/simlock/admin.token";
    // A daemon actually runs and persists its own secret first, then the file is overwritten
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
        freeRamBytes: 32 * gibibyte,
        totalRamBytes: 32 * gibibyte,
      }),
      ipc: ipcTransport,
      launcher,
      dataDirectory: "/simlock",
    });
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith(),
    );
    expect(exitCode).toBe(0);
    // The daemon was already running -- a bad credential must never trigger an auto-launch.
    expect(launcher.launches).toBe(0);
    const grant = JSON.parse(output.stdout) as LeaseGrant & { role: string };
    expect(grant.role).toBe("agent");
    expect(output.stderr).toContain("admin.token");
  });
});

describe("CLI: daemon status (ADR 0003 §11)", () => {
  it("reports stopped when the socket cannot be reached at all", async () => {
    const output = outputCapture();
    await expect(
      runCli(
        ["daemon", "status", "--json"],
        output.environmentWith({
          connectExistingAdmin: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        }),
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({ status: "stopped" });
  });

  it("reports stopped for a transport-kind SimlockError (connection lost)", async () => {
    const output = outputCapture();
    await expect(
      runCli(
        ["daemon", "status", "--json"],
        output.environmentWith({
          connectExistingAdmin: async () => {
            throw simlockError("DAEMON_CONNECTION_LOST");
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

  it("never auto-launches the daemon for daemon status/stop", async () => {
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

    // The upgrade contract: `doctor --fix` running unattended in CI never becomes
    // destructive on its own (ADR 0001, decision 6).
    expect(seen).toEqual([{ fix: true, purgeOrphans: false }]);
  });

  it.each([
    ["declined", async () => false],
    // Explicitly absent: the shared harness defaults `confirm` to an auto-yes, so leaving it
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
            // `exactOptionalPropertyTypes`: an explicitly-absent confirm has to be spread in,
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

describe("CLI: config set validates before writing (ADR 0003 §11)", () => {
  it("rejects an invalid merged config without writing the file", async () => {
    const output = outputCapture();
    let wrote = false;
    await expect(
      runCli(
        ["config", "set", "lease.heldTtlBackstopMs", "not-a-number"],
        output.environmentWith({
          readConfigFile: async () => ({}),
          writeConfigFile: async () => {
            wrote = true;
          },
          validateConfig: async () => {
            throw new Error("lease.heldTtlBackstopMs must be a number");
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
  it("rejects an unknown config key instead of silently dropping it", async () => {
    const output = outputCapture(realCliEnvironmentPorts());
    let wrote = false;
    const exitCode = await runCli(
      ["config", "set", "capacty.limits.ios.maxDevices", "2"],
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
  });

  it("rejects a mistyped key (missing the Ms suffix) instead of validating clean", async () => {
    const output = outputCapture(realCliEnvironmentPorts());
    let wrote = false;
    const exitCode = await runCli(
      ["config", "set", "lease.heldTtlBackstop", "60000"],
      output.environmentWith({
        readConfigFile: async () => ({}),
        writeConfigFile: async () => {
          wrote = true;
        },
      }),
    );
    expect(exitCode).toBe(2);
    expect(wrote).toBe(false);
  });

  it("still writes a genuinely valid key", async () => {
    const output = outputCapture(realCliEnvironmentPorts());
    let written: Record<string, unknown> | undefined;
    const exitCode = await runCli(
      // Well above the default heartbeat interval (5 min) * 4, so this doesn't also trip
      // `validateHeartbeatInterval` -- this test is only about the key itself validating clean.
      ["config", "set", "lease.heldTtlBackstopMs", "2400000"],
      output.environmentWith({
        readConfigFile: async () => ({}),
        writeConfigFile: async (contents) => {
          written = contents;
        },
      }),
    );
    expect(exitCode).toBe(0);
    expect(written).toEqual({ lease: { heldTtlBackstopMs: 2400000 } });
  });

  it("does not let a stray file at the scratch validation path change the outcome", async () => {
    // Guards against B9's second bug: the validation scratch path must never be able to read a
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

describe("CLI: --json shape is the contract, as-is (ADR 0003 §11)", () => {
  it("status --json has no snake_case renderings", async () => {
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
  it("release --all without --yes and a non-interactive confirm refuses", async () => {
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

describe("CLI: token operations never write tokens.json directly", () => {
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

describe("CLI: lease pushes and exit codes (own logic, not the dispatcher's)", () => {
  it("exits 14 on a lost lease and does not attempt to re-release it", async () => {
    const output = outputCapture();
    let leaseLostListener:
      | ((push: { leaseId: string; deviceId: string; reason: string }) => void)
      | undefined;
    let released = false;
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
      output.environmentWith({ connectAdmin: async () => client }),
    );
    // Let requestLease resolve and runLease reach the `Promise.race` wait point before firing
    // the push -- otherwise the listener registered by `client.onLeaseLost` may not exist yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    leaseLostListener?.({ leaseId: "lse_1", deviceId: "dev_1", reason: "ttl-backstop" });
    const exitCode = await runPromise;
    expect(exitCode).toBe(14);
    // The daemon already released it -- asking again would only raise UNKNOWN_LEASE.
    expect(released).toBe(false);
  });

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
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A push for another lease this same principal owns (e.g. an earlier `--detach`'d lease) --
    // must not be treated as this invocation's own lease being lost.
    leaseLostListener?.({ leaseId: "some-other-lease", deviceId: "dev_2", reason: "ttl-backstop" });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { platform: "ios", model: "x", osVersion: "26.5" },
          },
          environment: {},
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            mode: "detached",
            grantedAt: 0,
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

  it("maps --full and --no-wait onto the contract's full/noWait input fields", async () => {
    const output = outputCapture();
    let capturedInput: Record<string, unknown> | undefined;
    const client = fakeClient({
      requestLease: (input) => {
        capturedInput = input as unknown as Record<string, unknown>;
        return Promise.resolve({
          device: {
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { platform: "ios", model: "x", osVersion: "26.5" },
          },
          environment: {},
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            mode: "detached",
            grantedAt: 0,
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
        "--full",
        "--no-wait",
      ],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    expect(capturedInput?.full).toBe(true);
    expect(capturedInput?.noWait).toBe(true);
  });

  it("omits full and reports noWait: false when neither flag is given", async () => {
    const output = outputCapture();
    let capturedInput: Record<string, unknown> | undefined;
    const client = fakeClient({
      requestLease: (input) => {
        capturedInput = input as unknown as Record<string, unknown>;
        return Promise.resolve({
          device: {
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { platform: "ios", model: "x", osVersion: "26.5" },
          },
          environment: {},
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            mode: "detached",
            grantedAt: 0,
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
    expect(capturedInput?.full).toBeUndefined();
    expect(capturedInput?.noWait).toBe(false);
  });
});

/**
 * ADR 0004 §2: held mode is a client policy -- this process renews on a timer at a third of the
 * remaining TTL and releases explicitly, rather than ponging a daemon push and relying on the
 * socket closing. The wire is untouched in this slice (`mode: "held"` still goes out); what is
 * asserted here is the CLI's own behaviour while it holds.
 */
describe("CLI: held-mode renew and release (ADR 0004 §2)", () => {
  /** Lets `runLease` get past `requestLease` and arm its timer before the clock is advanced. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("renews at a third of the TTL the daemon returned, re-deriving the cadence from each renewal", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    const signals = new EventEmitter();
    const renewals: Array<{ leaseId: string; at: number }> = [];
    let released: string | undefined;
    const client = fakeClient({
      renewLease: (input) => {
        renewals.push({ at: clock.now(), leaseId: input.leaseId });
        // Half the grant's TTL comes back, so the next renewal must be half as far out too.
        return Promise.resolve({
          deviceId: "dev_1",
          grantedAt: 0,
          id: input.leaseId,
          mode: "held",
          ownerId: "test-requester",
          requesterId: "test-requester",
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

    // The grant's deadline is 60_000, so the first renewal is due at 20_000 -- and not before.
    clock.advance(19_999);
    await settle();
    expect(renewals).toEqual([]);
    clock.advance(1);
    await settle();
    expect(renewals).toEqual([{ at: 20_000, leaseId: "lse_1" }]);

    // 30_000ms of TTL came back at 20_000, so the next renewal is at 30_000, not at 40_000.
    clock.advance(10_000);
    await settle();
    expect(renewals).toEqual([
      { at: 20_000, leaseId: "lse_1" },
      { at: 30_000, leaseId: "lse_1" },
    ]);

    signals.emit("SIGINT");
    expect(await runPromise).toBe(0);
    // The release is the CLI's own call, not a side effect of the socket closing.
    expect(released).toBe("lse_1");
    // And the timer is gone with it: no renewal can race the release, and nothing keeps the
    // process alive after the command returns.
    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    expect(renewals).toHaveLength(2);
  });

  it("declares no heartbeat capability at hello, in either mode (ADR 0004 §4)", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const declared: Array<boolean | undefined> = [];
    const environment = output.environmentWith({
      clock: new FakeClock(0),
      connectAdmin: async (_resolveCredential, options) => {
        declared.push(options?.heartbeat);
        return fakeClient();
      },
      signals: signals as unknown as CliEnvironment["signals"],
    });
    await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      environment,
    );

    // Held mode is the case ADR 0004 §4 is actually about: it is the mode the daemon's push
    // keys off, and the one that used to declare the capability.
    const heldRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      environment,
    );
    await settle();
    signals.emit("SIGINT");
    expect(await heldRun).toBe(0);

    expect(declared).toEqual([false, false]);
  });

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

    // A failed renewal is not an exit condition: the holder still holds, and still releases.
    signals.emit("SIGINT");
    expect(await runPromise).toBe(0);
    expect(released).toBe("lse_1");
  });

  it("still releases the lease when printing the grant throws (--export-env with a bad key)", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    let released: string | undefined;
    const client = fakeClient({
      requestLease: () =>
        Promise.resolve({
          device: {
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { platform: "ios", model: "x", osVersion: "26.5" },
          },
          // A driver-supplied key that is not a shell identifier fails the command rather than
          // being silently dropped -- and that throw must not cost the device.
          environment: { "NOT A KEY": "value" },
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            mode: "held" as const,
            grantedAt: 0,
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
          mode: "held",
          ownerId: "test-requester",
          requesterId: "test-requester",
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
    expect(grant.lease.mode).toBe("detached");

    const statusOut = outputCapture();
    await runCli(
      ["status", "--json"],
      statusOut.environmentWith({ connectAdmin: environment.connectAdmin }),
    );
    const status = JSON.parse(statusOut.stdout) as StatusGetOutput;
    expect(status.leases.map((lease) => lease.id)).toContain(grant.lease.id);

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

describe("CLI: pure helpers", () => {
  it("fallbackRequesterId prefers SIMLOCK_AGENT_ID over a pid-derived default", () => {
    expect(fallbackRequesterId({ SIMLOCK_AGENT_ID: "agent-7" })).toBe("agent-7");
    expect(fallbackRequesterId({})).toBe(String(process.pid));
  });

  it("parseDuration parses units and rejects garbage", () => {
    expect(parseDuration("500")).toBe(500);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("2s")).toBe(2_000);
    expect(parseDuration("3m")).toBe(180_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(() => parseDuration("banana")).toThrow();
  });
});

// ---- test doubles -----------------------------------------------------------------------------

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

function fakeClient(overrides: Partial<SimlockAdminClient> = {}): SimlockAdminClient {
  const emptyStatus: StatusGetOutput = {
    devices: [],
    leases: [],
    capacity: {
      ios: { limit: 1, running: 0, maxRunning: 1, reserved: 0, overLimit: false, warm: 0, used: 0 },
      android: {
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
    health: "running",
    queueDepth: 0,
  };
  const emptyCatalog: CatalogGetOutput = { platforms: [] };
  const emptyDoctor: DoctorReport = { findings: [] };
  const emptyLeaseList: LeaseListOutput = { leases: [] };
  const emptyListGet: ListGetOutput = [];
  const emptyTokenList: TokenListOutput = { tokens: [] };
  const grant: LeaseGrant = {
    environment: {},
    device: {
      id: "dev_1",
      driverDeviceId: "dev_1",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
    },
    lease: {
      id: "lse_1",
      deviceId: "dev_1",
      requesterId: "test-requester",
      ownerId: "test-requester",
      mode: "held",
      grantedAt: 0,
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
    getStatus: () => Promise.resolve(emptyStatus),
    requestLease: (_input, _options) => Promise.resolve(grant),
    resolvePassthrough: () => Promise.resolve({ args: [], command: "adb", env: {} }),
    cancelLease: () => Promise.resolve({ result: "not-found" }),
    renewLease: () => Promise.resolve(grant.lease as LeaseRecord),
    releaseLease: (input) => Promise.resolve({ leaseId: input.leaseId }),
    listLeases: () => Promise.resolve(emptyLeaseList),
    heartbeat: () => Promise.resolve({ leases: [] }),
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
    replayEvents: () => Promise.resolve([]),
    subscribeEvents: () => Promise.resolve(() => Promise.resolve()),
    createToken: (input) =>
      Promise.resolve({
        secret: "sec_1",
        token: { id: "tok_1", role: input.role, createdAt: 0 },
      }),
    listTokens: () => Promise.resolve(emptyTokenList),
    revokeToken: () => Promise.resolve({ revoked: true }),
    ...overrides,
  };
  return base;
}

interface OutputCapture {
  stdout: string;
  stderr: string;
  environmentWith(overrides?: Partial<CliEnvironment>): CliEnvironment;
}

/**
 * `ports` is `undefined` for the fully-mocked default every other suite uses (a bare object
 * literal, `connectAdmin` etc. never call their argument unless a test's override does).
 * Passing `ports` (built with `realCliEnvironmentPorts`, or by hand for the cold-start/B1
 * suites) routes `environmentWith` through the real `buildCliEnvironment` instead -- the only
 * way to exercise the production credential-resolution ordering (B2) and the real config
 * validator (B9) rather than re-testing a test double.
 */
function outputCapture(ports?: CliEnvironmentPorts): OutputCapture {
  const capture: OutputCapture = {
    stdout: "",
    stderr: "",
    environmentWith(overrides = {}) {
      const stderrOut = { write: (value: string) => (capture.stderr += value) };
      const stdoutOut = { write: (value: string) => (capture.stdout += value) };
      if (ports === undefined) {
        return {
          // Overridable through `environmentWith({ clock })` -- see the renew-cadence suite.
          clock: new FakeClock(0),
          configPath: "/simlock/config.json",
          requesterId: "test-requester",
          now: () => 0,
          connectAdmin: async () => fakeClient(),
          connectExistingAdmin: async () => fakeClient(),
          readAdminTokenFile: async () => undefined,
          sleep: async () => {},
          readConfigFile: async () => ({}),
          writeConfigFile: async () => {},
          validateConfig: async () => {},
          readLogFile: async () => "",
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
        {},
      );
      return { ...base, ...overrides };
    },
  };
  return capture;
}

// ---- real-daemon harness for the smoke test ----------------------------------------------------

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
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: sequence(),
    statePath: "/state.json",
  });
  const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  const config = testConfig();
  const engine = new LeaseEngine({
    clock,
    config,
    drivers: [driver],
    eventBus,
    idGenerator: sequence(),
    registry,
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
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
  const tokens = new TokenStore({
    clock,
    filesystem,
    idGenerator: sequence(),
    path: "/tokens.json",
    secrets: new CryptoTokenSecrets(),
  });
  const daemon = new DaemonServer({
    capacity: engine,
    catalog: engine,
    clock,
    config,
    defaultRequesterId: "test-process",
    eventBus,
    host: new DaemonEndpointHost({
      connector: new NodeIpcTransport(),
      endpoint: socketPath,
      filesystem: new NodeFilesystem(),
      listenerFactory: new NodeIpcTransport(),
    }),
    leases: engine,
    queue: engine,
    reaper,
    registry,
    resolveRole: { resolve: () => "admin" },
    tokens,
    version: "test",
  });
  runningDaemons.push(daemon);
  await daemon.start();
  return { socketPath, daemon };
}

/** Bare-minimum ports for exercising `buildCliEnvironment`'s real `validateConfig` (B9) without
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
      freeRamBytes: 32 * gibibyte,
      totalRamBytes: 32 * gibibyte,
    }),
    ipc: new MemoryIpcTransport(),
    launcher: new FakeDaemonLauncher(),
    dataDirectory: "/simlock",
  };
}

/**
 * A real `DaemonServer` wired against in-memory ports (`MemoryFilesystem` + `MemoryIpcTransport`
 * shared with the CLI environment under test), with the genuine credential handshake
 * (`AdminSecretManager` + `createCredentialRoleResolver`) instead of `startTestDaemon`'s
 * `resolveRole: { resolve: () => "admin" }` shortcut -- B1 and B2 both hinge on that handshake
 * actually running.
 */
async function startInMemoryDaemon(options: {
  readonly filesystem: MemoryFilesystem;
  readonly ipcTransport: MemoryIpcTransport;
  readonly socketPath: string;
  readonly adminTokenPath: string;
}): Promise<{ daemon: DaemonServer; adminSecret: AdminSecretManager }> {
  const { adminTokenPath, filesystem, ipcTransport, socketPath } = options;
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: sequence(),
    statePath: "/state.json",
  });
  const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  const config = testConfig();
  const engine = new LeaseEngine({
    clock,
    config,
    drivers: [driver],
    eventBus,
    idGenerator: sequence(),
    registry,
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
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
  const tokens = new TokenStore({
    clock,
    filesystem,
    idGenerator: sequence(),
    path: "/tokens.json",
    secrets: new CryptoTokenSecrets(),
  });
  const adminSecret = new AdminSecretManager({
    filesystem,
    secrets: new CryptoTokenSecrets(),
    path: adminTokenPath,
  });
  const resolveRole = createCredentialRoleResolver({
    verifyOperatorToken: async (secret) => (await tokens.verify(secret))?.role === "operator",
    verifyAdminSecret: (secret) => adminSecret.verify(secret),
  });
  const daemon = new DaemonServer({
    adminSecret,
    capacity: engine,
    catalog: engine,
    clock,
    config,
    defaultRequesterId: "test-process",
    eventBus,
    host: new DaemonEndpointHost({
      connector: ipcTransport,
      endpoint: socketPath,
      filesystem,
      listenerFactory: ipcTransport,
    }),
    leases: engine,
    queue: engine,
    reaper,
    registry,
    resolveRole,
    tokens,
    version: "test",
  });
  runningDaemons.push(daemon);
  await daemon.start();
  return { daemon, adminSecret };
}

function testConfig(): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
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
    ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000, heartbeatIntervalMs: 5_000 },
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
    warmPool: {
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}
