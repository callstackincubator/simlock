import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testComponentWiring, testStateOf, FakeDriver, loadTestRegistry } from "../core/testing.js";
import { EventBus } from "../bus/index.js";
import { ringEventHistory, seedHistory } from "../history/testing.js";
import { CleanupReaper } from "../core/index.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeDaemonLauncher,
  MemoryFilesystem,
  FakeKeySetFetcher,
  NodeFilesystem,
  NodeIpcTransport,
  NoopLogger,
  FakeSystemStats,
} from "../ports/index.js";
import { createAuth, tokensOwner } from "../auth/index.js";
import { openMemoryStateDatabase } from "../auth/testing.js";
import { DaemonEndpointHost } from "../daemon/connection-host.js";
import { DaemonServer } from "../daemon/server.js";
import { SimlockError } from "../contract/index.js";
import type { EventPush, LeaseGrant, StatusGetOutput } from "../simlock-client/client.js";
import { connectSimlockAdmin } from "../admin/index.js";
import { runCli, type CliEnvironment, type CliEnvironmentPorts } from "./index.js";
import { createTestEngine } from "../leasing/testing.js";
import {
  fakeClient,
  gibibyte,
  outputCapture,
  realCliEnvironmentPorts,
  runningDaemons,
  sequence,
  settle,
  temporaryDirectories,
  cliTestConfig,
} from "./test-index.js";

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI: mcp command (ADR 0003 §11 -- lazy module load)", () => {
  it.each([
    [["--gateway", "mcp"], 0, "gateway"],
    [["mcp", "--gateway"], 0, "gateway"],
    [["mcp"], 0, "none"],
    [["--gateway=yes", "mcp"], 2, "--gateway takes no value"],
    [["--local", "mcp"], 0, "local"],
    [["mcp", "--local"], 0, "local"],
    [["--local=yes", "mcp"], 2, "--local takes no value"],
    [["--local", "--gateway", "mcp"], 2, "--gateway and --local cannot be used together"],
    [["mcp", "--gateway", "--local"], 2, "--gateway and --local cannot be used together"],
  ] as const)(
    "--gateway and --local are taken from anywhere in the argv and reach the command as context.daemonFlag; =<x> and both together are usage errors (%j)",
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

    expect(exitCode).toBe(1);
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

  it.each([
    ["ESC", "\u001b", "\\u001b"],
    ["C1 CSI", "\u009b", "\\u009b"],
  ])(
    "prints %s in a log line escaped, in the tail and in a later line",
    async (_name, raw, escaped) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/simlock");
      await filesystem.writeFileAtomic(LOG, `a${raw}b\n`);
      const run = await follow(filesystem);
      await filesystem.writeFileAtomic(LOG, `a${raw}b\nc${raw}d\n`);
      await run.tick();

      expect(run.output.stdout).toBe(`a${escaped}b\nc${escaped}d\n`);
      run.signals.emit("SIGINT");
      await expect(run.exit).resolves.toBe(0);
    },
  );

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
  const config = cliTestConfig();
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
