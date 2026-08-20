import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { type Config, CleanupReaper, FakeDriver, LeaseEngine, Registry } from "../core/index.js";
import {
  FakeClock,
  FakeSystemStats,
  MemoryFilesystem,
  NodeFilesystem,
  NodeIpcTransport,
} from "../ports/index.js";
import { DaemonEndpointHost } from "../daemon/connection-host.js";
import { DaemonServer } from "../daemon/server.js";
import { connectExistingDaemon } from "../daemon-client/client.js";
import {
  DaemonClientError,
  errorExitCode,
  fallbackRequesterId,
  parseDuration,
  readLogFile,
  runCli,
  type CliEnvironment,
  type DaemonConnection,
} from "./index.js";

const gibibyte = 1024 ** 3;
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
    await filesystem.mkdirp("/pitlane");
    await filesystem.writeFileAtomic("/pitlane/daemon.log", "current\n");

    await expect(readLogFile(filesystem, "/pitlane/daemon.log")).resolves.toBe("current\n");
  });

  it("prepends the rotated generation so a pre-rotation crash is not lost", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/pitlane");
    await filesystem.writeFileAtomic("/pitlane/daemon.log.1", "rotated\n");
    await filesystem.writeFileAtomic("/pitlane/daemon.log", "current\n");

    await expect(readLogFile(filesystem, "/pitlane/daemon.log")).resolves.toBe(
      "rotated\ncurrent\n",
    );
  });

  it("propagates the read failure when neither file exists", async () => {
    const filesystem = new MemoryFilesystem();

    await expect(readLogFile(filesystem, "/pitlane/daemon.log")).rejects.toThrow();
  });
});

describe("CLI boundary", () => {
  it.each([
    ["QUEUE_TIMEOUT", 10],
    ["NO_CAPACITY", 11],
    ["RUNTIME_MISSING", 12],
    ["UNKNOWN_MODEL", 12],
    ["BAD_REQUEST", 2],
    ["REQUESTER_ALREADY_LEASED", 13],
  ] as const)("maps %s daemon errors to exit %d", async (code, expected) => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("status.get", new DaemonClientError(code, "failed"));

    await expect(
      runCli(["status"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(expected);
    expect(errorExitCode(new DaemonClientError(code, "failed"))).toBe(expected);
  });

  it("writes a single structured JSON error line to stderr for a daemon error", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("status.get", new DaemonClientError("NO_CAPACITY", "No capacity"));

    await expect(
      runCli(["status"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(11);
    expect(output.stdout).toBe("");
    expect(output.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stderr)).toEqual({
      error: { code: "NO_CAPACITY", message: "No capacity" },
    });
  });

  it("gives REQUESTER_ALREADY_LEASED its own exit code and an actionable message", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response(
      "lease.request",
      new DaemonClientError(
        "REQUESTER_ALREADY_LEASED",
        "Requester test-requester already holds lease lse_1; release it (`pitlane release lse_1`) before requesting another device",
      ),
    );

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 16", "--detach"],
        output.environmentWith({ connect: async () => connection }),
      ),
    ).resolves.toBe(13);
    expect(output.stdout).toBe("");
    const parsed = JSON.parse(output.stderr) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("REQUESTER_ALREADY_LEASED");
    expect(parsed.error.message).toContain("lse_1");
    expect(parsed.error.message).toContain("pitlane release lse_1");
  });

  it("parses human durations and bare milliseconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("250")).toBe(250);
  });

  it("resolves the fallback requester id from PITLANE_AGENT_ID, else the process pid", () => {
    expect(fallbackRequesterId({ PITLANE_AGENT_ID: "agent-from-env" })).toBe("agent-from-env");
    expect(fallbackRequesterId({})).toBe(String(process.pid));
  });

  it("reports missing lease arguments as a structured USAGE error", async () => {
    const output = outputCapture();

    await expect(runCli(["lease"], output.environment)).resolves.toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stderr)).toEqual({
      error: { code: "USAGE", message: expect.stringContaining("--platform") },
    });
  });

  it("rejects --json on a command whose output is already unconditionally JSON", async () => {
    const output = outputCapture();

    await expect(runCli(["list", "--json"], output.environment)).resolves.toBe(2);
    expect(output.stdout).toBe("");
    expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: "USAGE" } });
  });

  it("lists the MCP server in root help", async () => {
    const output = outputCapture();

    await expect(runCli([], output.environment)).resolves.toBe(0);
    expect(output.stdout).toContain("mcp");
    expect(output.stdout).toContain("Start the stdio MCP server");
  });

  it("does not load the MCP runner for non-MCP commands", async () => {
    const output = outputCapture();
    const loadMcpStdio = vi.fn(async () => vi.fn(async () => undefined));
    const connection = new StubConnection();
    connection.response("status.get", {});

    await expect(
      runCli(
        ["status", "--json"],
        output.environmentWith({ connect: async () => connection, loadMcpStdio }),
      ),
    ).resolves.toBe(0);
    expect(loadMcpStdio).not.toHaveBeenCalled();
  });

  it.each([["--help"], ["-h"]])("prints MCP help without starting it: %s", async (help) => {
    const output = outputCapture();
    const runner = vi.fn(async () => undefined);

    await expect(
      runCli(["mcp", help], output.environmentWith({ runMcpStdio: runner })),
    ).resolves.toBe(0);
    expect(output.stdout).toBe("Usage: pitlane mcp\n");
    expect(output.stderr).toBe("");
    expect(runner).not.toHaveBeenCalled();
  });

  it("waits for the MCP runner without writing before it completes", async () => {
    const output = outputCapture();
    let complete!: () => void;
    const runner = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const run = runCli(["mcp"], output.environmentWith({ runMcpStdio: runner }));

    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("");
    complete();
    await expect(run).resolves.toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("");
  });

  it.each([["--json"], ["unexpected"], ["--help=true"]])(
    "rejects unexpected MCP input: %s",
    async (argument) => {
      const output = outputCapture();
      const runner = vi.fn(async () => undefined);

      await expect(
        runCli(["mcp", argument], output.environmentWith({ runMcpStdio: runner })),
      ).resolves.toBe(2);
      expect(output.stdout).toBe("");
      expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: "USAGE" } });
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it("reports MCP startup failures as a structured INTERNAL error on stderr", async () => {
    const output = outputCapture();
    const runner = vi.fn(async () => {
      throw new Error("MCP startup failed");
    });

    await expect(runCli(["mcp"], output.environmentWith({ runMcpStdio: runner }))).resolves.toBe(1);
    expect(output.stdout).toBe("");
    expect(JSON.parse(output.stderr)).toEqual({
      error: { code: "INTERNAL", message: "MCP startup failed" },
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("keeps held lease stdout pure, renders progress to stderr, and releases on SIGTERM", async () => {
    const harness = await createHarness();
    const output = outputCapture();
    const signals = new EventEmitter();
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath, new NodeIpcTransport()),
        signals,
      }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    signals.emit("SIGTERM");

    await expect(run).resolves.toBe(0);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      device: "iPhone 16",
      os: "26.5",
      platform: "ios",
      state: "leased",
    });
    expect(
      output.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "provisioning" }),
        expect.objectContaining({ event: "booting" }),
      ]),
    );
    await expect.poll(() => harness.registry.snapshot.leases).toHaveLength(0);
  });

  it("reports a post-signal release failure as a structured stderr line, not prose", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_release_fail", mode: "held", ttlDeadline: 61_000 },
      timing: {
        estimatedBootMs: 0,
        estimatedProvisionMs: 0,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 0,
      },
    });
    connection.response("lease.release", new Error("release failed"));
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({ connect: async () => connection, signals }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    signals.emit("SIGTERM");

    await expect(run).resolves.toBe(0);
    expect(output.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stderr)).toEqual({
      error: { code: "INTERNAL", message: "release failed" },
    });
  });

  it("flagship e2e: queues a second CLI holder until the first connection drops", async () => {
    const harness = await createHarness();
    const first = outputCapture();
    const second = outputCapture();
    const firstSignals = new EventEmitter();
    const secondSignals = new EventEmitter();
    const firstRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      first.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath, new NodeIpcTransport()),
        requesterId: "agent-a",
        signals: firstSignals,
      }),
    );
    await vi.waitFor(() => expect(first.stdout).not.toBe(""));
    const secondRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      second.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath, new NodeIpcTransport()),
        requesterId: "agent-b",
        signals: secondSignals,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.eventBus.replay().some((event) => event.event === "lease.queued")).toBe(true),
    );
    expect(second.stdout).toBe("");
    expect(
      second.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ event: "queued", queue_position: 1 }]);

    firstSignals.emit("SIGTERM");
    await expect(firstRun).resolves.toBe(0);
    await vi.waitFor(() => expect(second.stdout).not.toBe(""));
    secondSignals.emit("SIGTERM");
    await expect(secondRun).resolves.toBe(0);
    expect(
      second.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ event: "queued", queue_position: 1 }]);
  });

  it("--agent-id overrides the environment's fallback requester id", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_1", mode: "detached", ttlDeadline: 1_000 },
      timing: {
        estimatedBootMs: 1,
        estimatedProvisionMs: 1,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 2,
      },
    });

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
          "agent-x",
        ],
        output.environmentWith({ connect: async () => connection, requesterId: "fallback-id" }),
      ),
    ).resolves.toBe(0);

    expect(connection.calls).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ requesterId: "agent-x" }),
        type: "lease.request",
      }),
    ]);
  });

  it("falls back to the environment's requester id when --agent-id is omitted", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_1", mode: "detached", ttlDeadline: 1_000 },
      timing: {
        estimatedBootMs: 1,
        estimatedProvisionMs: 1,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 2,
      },
    });

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
        output.environmentWith({ connect: async () => connection, requesterId: "fallback-id" }),
      ),
    ).resolves.toBe(0);

    expect(connection.calls).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ requesterId: "fallback-id" }),
        type: "lease.request",
      }),
    ]);
  });

  it("rejects an empty --agent-id as a usage error", async () => {
    const output = outputCapture();

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--agent-id", ""],
        output.environment,
      ),
    ).resolves.toBe(2);
    expect(output.stderr).toContain("--agent-id");
  });

  it("enforces one lease per --agent-id: same id collides, distinct ids do not", async () => {
    const harness = await createHarness();
    const first = outputCapture();

    await expect(
      runCli(
        [
          "lease",
          "--platform",
          "ios",
          "--device",
          "iPhone 16",
          "--detach",
          "--agent-id",
          "dup-agent",
        ],
        first.environmentWith({
          connect: () => connectExistingDaemon(harness.socketPath, new NodeIpcTransport()),
        }),
      ),
    ).resolves.toBe(0);

    const second = outputCapture();
    await expect(
      runCli(
        [
          "lease",
          "--platform",
          "ios",
          "--device",
          "iPhone 16",
          "--detach",
          "--agent-id",
          "dup-agent",
        ],
        second.environmentWith({
          connect: () => connectExistingDaemon(harness.socketPath, new NodeIpcTransport()),
        }),
      ),
    ).resolves.toBe(13);
    expect(second.stderr).toContain("dup-agent");
    expect(second.stderr).toContain("already");
    expect(JSON.parse(second.stderr)).toMatchObject({
      error: { code: "REQUESTER_ALREADY_LEASED" },
    });

    const third = outputCapture();
    await expect(
      runCli(
        [
          "lease",
          "--platform",
          "ios",
          "--device",
          "iPhone 16",
          "--detach",
          "--agent-id",
          "other-agent",
          "--no-wait",
        ],
        third.environmentWith({
          connect: () => connectExistingDaemon(harness.socketPath, new NodeIpcTransport()),
        }),
      ),
    ).resolves.toBe(11);
    expect(third.stderr).not.toContain("already");
  });

  it("prints a detached token, exits, and renews it", async () => {
    const detached = outputCapture();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_9f2c", mode: "detached", ttlDeadline: 61_000 },
      timing: {
        estimatedBootMs: 20,
        estimatedProvisionMs: 10,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 30,
      },
    });

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
        detached.environmentWith({ connect: async () => connection }),
      ),
    ).resolves.toBe(0);
    expect(detached.stdout).toBe(
      '{"device":"iPhone 17 Pro","lease":"lse_9f2c","os":"26.5","platform":"ios","state":"leased","udid":"ABCD"}\n',
    );
    expect(connection.closed).toBe(true);

    const renew = outputCapture();
    const renewConnection = new StubConnection();
    renewConnection.response("lease.renew", { id: "lse_9f2c", ttlDeadline: 61_000 });
    await expect(
      runCli(
        ["lease", "renew", "lse_9f2c", "--ttl", "1m"],
        renew.environmentWith({ connect: async () => renewConnection }),
      ),
    ).resolves.toBe(0);
    expect(renewConnection.calls).toContainEqual({
      payload: { leaseId: "lse_9f2c", ttlMs: 60_000 },
      type: "lease.renew",
    });
  });

  it("keeps status JSON stable", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("status.get", { devices: [], leases: [], revision: 3 });

    await expect(
      runCli(["status", "--json"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(JSON.parse(output.stdout)).toMatchInlineSnapshot(`
      {
        "devices": [],
        "leases": [],
        "revision": 3,
      }
    `);
  });

  it("renders managed and running capacity separately", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("status.get", {
      capacity: {
        global: { maxRunning: 3, overLimit: false, reserved: 1, running: 1, warm: 1 },
        ios: {
          limit: 4,
          maxRunning: 2,
          overLimit: false,
          reserved: 1,
          running: 1,
          used: 3,
          warm: 1,
        },
        android: {
          limit: 2,
          maxRunning: 2,
          overLimit: false,
          reserved: 0,
          running: 0,
          used: 1,
          warm: 0,
        },
      },
      devices: [],
      leases: [],
    });

    await expect(
      runCli(["status"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(output.stdout).toContain("Running global: 1 + 1 reserved/3, warm 1");
    expect(output.stdout).toContain("Capacity ios: managed 3/4, running 1 + 1 reserved/2, warm 1");
  });

  it("requests the full device catalog and prints it as JSON", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("catalog.get", {
      platforms: [
        { defaultRuntime: "26.5", models: ["iPhone 16"], platform: "ios", runtimes: ["26.5"] },
      ],
    });

    await expect(
      runCli(["catalog", "--json"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(connection.calls).toContainEqual({ payload: {}, type: "catalog.get" });
    expect(JSON.parse(output.stdout)).toEqual({
      platforms: [
        { defaultRuntime: "26.5", models: ["iPhone 16"], platform: "ios", runtimes: ["26.5"] },
      ],
    });
  });

  it("narrows the catalog request to the requested platform", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("catalog.get", { platforms: [] });

    await expect(
      runCli(
        ["catalog", "--platform", "android", "--json"],
        output.environmentWith({ connect: async () => connection }),
      ),
    ).resolves.toBe(0);
    expect(connection.calls).toContainEqual({
      payload: { platform: "android" },
      type: "catalog.get",
    });
  });

  it("renders the catalog as human-readable text, marking the default runtime", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("catalog.get", {
      platforms: [
        {
          defaultRuntime: "26.5",
          models: ["iPhone 16", "iPhone 17 Pro"],
          platform: "ios",
          runtimes: ["18.4", "26.5"],
        },
      ],
    });

    await expect(
      runCli(["catalog"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(output.stdout).toBe(
      "Platform: ios\n" +
        "  Models: iPhone 16, iPhone 17 Pro\n" +
        "  Runtimes: 18.4, 26.5 (default: 26.5)\n",
    );
  });

  it("rejects an invalid --platform without contacting the daemon", async () => {
    const output = outputCapture();

    await expect(runCli(["catalog", "--platform", "windows"], output.environment)).resolves.toBe(2);
    expect(output.stderr).toContain("--platform must be ios or android");
  });
});

class StubConnection implements DaemonConnection {
  readonly calls: Array<{ readonly payload: unknown; readonly type: string }> = [];
  closed = false;
  readonly #listeners = new Set<(kind: string, payload: unknown) => void>();
  readonly #responses = new Map<string, unknown>();

  response(type: string, value: unknown): void {
    this.#responses.set(type, value);
  }

  async request(type: string, payload: unknown): Promise<unknown> {
    this.calls.push({ payload, type });
    const value = this.#responses.get(type);
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }

  onPush(listener: (kind: string, payload: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  push(kind: string, payload: unknown): void {
    for (const listener of this.#listeners) {
      listener(kind, payload);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "pitlane-cli-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "daemon.sock");
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem: new MemoryFilesystem(),
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
    reaper: new CleanupReaper({
      clock,
      config,
      eventBus,
      executor: engine.cleanup,
      filesystem: new MemoryFilesystem(),
      registry,
    }),
    registry,
    version: "test",
  });
  runningDaemons.push(daemon);
  await daemon.start();
  return { eventBus, registry, socketPath };
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function testConfig(): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    eventBuffer: { capacity: 100 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000, heartbeatIntervalMs: 15_000 },
    limits: {
      android: { maxDevices: 1, maxRunning: 1 },
      ios: { maxDevices: 1, maxRunning: 1 },
      maxRunning: 1 + 1,
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
  };
}

function outputCapture() {
  let stderr = "";
  let stdout = "";
  const environment: CliEnvironment = {
    connect: async () => {
      throw new Error("Unexpected daemon connection");
    },
    configPath: "/config.json",
    readConfigFile: async () => ({}),
    requesterId: "test-requester",
    signals: new EventEmitter(),
    stderr: { write: (value: string) => (stderr += value) },
    stdout: { write: (value: string) => (stdout += value) },
    writeConfigFile: async () => undefined,
  };
  return {
    environment,
    environmentWith(overrides: Partial<CliEnvironment>): CliEnvironment {
      return { ...environment, ...overrides };
    },
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
  };
}
