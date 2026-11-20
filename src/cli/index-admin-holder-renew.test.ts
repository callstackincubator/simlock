import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeClock,
  FakeDaemonLauncher,
  FakeParentWatch,
  MemoryFilesystem,
  MemoryIpcTransport,
  FakeSystemStats,
} from "../ports/index.js";
import { fromWireError, SimlockError, type AnySimlockError } from "../contract/index.js";
import type { LeaseGrant } from "../simlock-client/client.js";
import { RELEASE_TIMEOUT_MS } from "../lease-policy/index.js";
import { runCli, type CliEnvironment } from "./index.js";
import { promiseState } from "../test-support/promise-state.js";
import {
  detachedGrant,
  fakeClient,
  gibibyte,
  outputCapture,
  runningDaemons,
  settle,
  simlockError,
  startInMemoryDaemon,
  temporaryDirectories,
} from "./test-index.js";

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI: admin credential resolution (ADR 0003 §5)", () => {
  it.each([
    [
      "--token over env and file",
      ["--token", "from-flag", "status"],
      "from-env",
      "from-file",
      "from-flag",
      true,
    ],
    [
      "SIMLOCK_ADMIN_TOKEN over the file when --token is absent",
      ["status"],
      "from-env",
      "from-file",
      "from-env",
      false,
    ],
    [
      "the admin.token file when neither --token nor the env var is set",
      ["status"],
      undefined,
      "from-file",
      "from-file",
      true,
    ],
  ] as const)(
    "resolves the admin credential in priority order: %s",
    async (_case, argv, envToken, fileToken, expected, stderrEmpty) => {
      const output = outputCapture();
      let seen: string | undefined;
      await runCli(
        [...argv],
        output.environmentWith({
          ...(envToken === undefined ? {} : { adminTokenFromEnv: envToken }),
          readAdminTokenFile: async () => fileToken,
          connectAdmin: async (resolveCredential) => {
            seen = await resolveCredential();
            return fakeClient();
          },
        }),
      );
      expect(seen).toBe(expected);
      if (stderrEmpty) expect(output.stderr).toBe("");
    },
  );

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
    expect(exitCode).toBe(1);
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
      homeDirectory: "/home/operator",
      workingDirectory: "/work/project",
      hostPlatform: "linux",
      runTool: async () => ({ outcome: "not-found" }),
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
      homeDirectory: "/home/operator",
      workingDirectory: "/work/project",
      hostPlatform: "linux",
      runTool: async () => ({ outcome: "not-found" }),
    });
    const exitCode = await runCli(["daemon", "start"], output.environmentWith());
    expect(exitCode).toBe(2);
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
      homeDirectory: "/home/operator",
      workingDirectory: "/work/project",
      hostPlatform: "linux",
      runTool: async () => ({ outcome: "not-found" }),
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

  it.each([
    { trigger: "SIGINT", act: (signals: EventEmitter) => signals.emit("SIGINT") },
    { trigger: "SIGTERM", act: (signals: EventEmitter) => signals.emit("SIGTERM") },
    {
      trigger: "the exit of the --bind-pid process",
      act: (_signals: EventEmitter, parentWatch: FakeParentWatch) => parentWatch.exit(9876),
    },
  ])("cancels its waiting request and exits 0 on $trigger before a grant", async ({ act }) => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const parentWatch = new FakeParentWatch();
    let requestSignal: AbortSignal | undefined;
    let requested = false;
    const client = fakeClient({
      // why: The request waits in the queue and never resolves on its own; like the client's
      // documented abort, it rejects CANCELLED once its signal aborts.
      requestLease: (_input, options) => {
        requested = true;
        requestSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new SimlockError("CANCELLED", "domain", "Lease request was cancelled", {}));
          });
        });
      },
    });
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--bind-pid", "9876"],
      output.environmentWith({
        connectAdmin: async () => client,
        parentPid: 4321,
        parentWatch,
        signals: signals as unknown as CliEnvironment["signals"],
      }),
    );
    const runState = promiseState(run);
    await vi.waitFor(() => expect(requested).toBe(true));

    act(signals, parentWatch);
    await settle();

    expect(requestSignal?.aborted).toBe(true);
    expect(runState.state).toBe("fulfilled");
    expect(await run).toBe(0);
    expect(output.stdout).toBe("");
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
});
