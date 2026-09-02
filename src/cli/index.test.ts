import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { type Config, CleanupReaper, FakeDriver, LeaseEngine, Registry } from "../core/index.js";
import {
  FakeClock,
  FakeParentWatch,
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
/** A minimal daemon lease response, for the tests that only care what the CLI prints. */
const detachedGrant = {
  device: {
    driverDeviceId: "ABCD",
    spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
  },
  lease: { id: "lse_env", mode: "detached", ttlDeadline: 61_000 },
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
        "Requester test-requester already holds lease lse_1; release it (`simlock release lse_1`) before requesting another device",
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
    expect(parsed.error.message).toContain("simlock release lse_1");
  });

  it("parses human durations and bare milliseconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("250")).toBe(250);
  });

  it("resolves the fallback requester id from SIMLOCK_AGENT_ID, else the process pid", () => {
    expect(fallbackRequesterId({ SIMLOCK_AGENT_ID: "agent-from-env" })).toBe("agent-from-env");
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
    expect(output.stdout).toBe("Usage: simlock mcp\n");
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

  it("writes structured stderr lines for device-unhealthy/device-recovered pushes, ignoring malformed ones", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_health", mode: "held", ttlDeadline: 61_000 },
      timing: {
        estimatedBootMs: 0,
        estimatedProvisionMs: 0,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 0,
      },
    });
    connection.response("lease.release", { leaseId: "lse_health" });
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({ connect: async () => connection, signals }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    connection.push("device-unhealthy", {
      deviceId: "ABCD",
      leaseId: "lse_health",
      reason: "crashed",
    });
    connection.push("device-recovered", { attempts: 2, deviceId: "ABCD", leaseId: "lse_health" });
    // Malformed pushes must not crash the CLI or emit a diagnostic line.
    connection.push("device-unhealthy", { deviceId: 42 });
    connection.push("device-recovered", null);

    signals.emit("SIGTERM");
    await expect(run).resolves.toBe(0);

    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(
      output.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { device_id: "ABCD", event: "device_unhealthy", lease: "lse_health" },
      { attempts: 2, device_id: "ABCD", event: "device_recovered", lease: "lse_health" },
    ]);
  });

  it("reports a lost lease, exits 14, and does not re-release it", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_lost", mode: "held", ttlDeadline: 61_000 },
      timing: {
        estimatedBootMs: 0,
        estimatedProvisionMs: 0,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 0,
      },
    });
    connection.response("lease.release", new Error("lease.release must not be called"));
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({ connect: async () => connection, signals }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    // A malformed push must not end the holder's lease: it is ignored outright,
    // and the process keeps waiting exactly as it did before.
    connection.push("lease-lost", { deviceId: 42 });
    // No signal: the daemon ending the lease is what must stop the holder.
    connection.push("lease-lost", {
      deviceId: "ABCD",
      leaseId: "lse_lost",
      reason: "device-lost",
    });

    await expect(run).resolves.toBe(14);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(
      output.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { device_id: "ABCD", event: "lease_lost", lease: "lse_lost", reason: "device-lost" },
    ]);
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
      '{"device":"iPhone 17 Pro","environment":{},"expires_at_ms":61000,"lease":"lse_9f2c","os":"26.5","platform":"ios","state":"leased","timing":{"estimated_boot_ms":20,"estimated_provision_ms":10,"estimated_reclaim_ms":0,"estimated_ready_ms":30},"udid":"ABCD"}\n',
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

  it("prints shell export lines instead of the JSON grant under --export-env", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("lease.request", {
      ...detachedGrant,
      // A device root is a user-configurable path, so it can hold a space or an
      // apostrophe; both have to survive `eval "$(...)"` byte for byte.
      environment: {
        SIMLOCK_IOS_DEVICE_SET: "/Users/o'brien/My Sims/devices/ios",
        ANDROID_ADB_SERVER_PORT: "5038",
      },
    });

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach", "--export-env"],
        output.environmentWith({ connect: async () => connection }),
      ),
    ).resolves.toBe(0);
    expect(output.stdout).toBe(
      "export ANDROID_ADB_SERVER_PORT='5038'\n" +
        "export SIMLOCK_IOS_DEVICE_SET='/Users/o'\\''brien/My Sims/devices/ios'\n",
    );
  });

  it("names the lease on stderr when --export-env has no environment to export", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("lease.request", detachedGrant);

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach", "--export-env"],
        output.environmentWith({ connect: async () => connection }),
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
    const connection = new StubConnection();
    connection.response("lease.request", {
      ...detachedGrant,
      // Not reachable through the shipped drivers, whose keys are literals -- but
      // `SIMLOCK_DRIVERS_MODULE` and the wire both accept whatever a driver returns.
      environment: { "K=1; touch /tmp/probe/PWNED_KEY; X": "1" },
    });

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach", "--export-env"],
        output.environmentWith({ connect: async () => connection }),
      ),
    ).resolves.toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("PWNED_KEY");
  });

  it("keeps holding the lease after printing export lines in held mode", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const connection = new StubConnection();
    connection.response("lease.request", {
      ...detachedGrant,
      environment: { SIMLOCK_IOS_DEVICE_SET: "/devices/ios" },
      lease: { id: "lse_held_env", mode: "held", ttlDeadline: 61_000 },
    });
    connection.response("lease.release", { leaseId: "lse_held_env" });
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--export-env"],
      output.environmentWith({ connect: async () => connection, signals }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    expect(output.stdout).toBe("export SIMLOCK_IOS_DEVICE_SET='/devices/ios'\n");
    signals.emit("SIGTERM");

    await expect(run).resolves.toBe(0);
    expect(connection.calls).toContainEqual({
      payload: { leaseId: "lse_held_env" },
      type: "lease.release",
    });
  });

  it.each([
    ["simctl", ["install", "booted", "./MyApp.app"]],
    ["adb", ["shell", "input", "tap", "100", "200"]],
  ])("asks the daemon to scope a %s passthrough and runs it locally", async (tool, args) => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("driver.passthrough", {
      args: ["-P", "5038", ...args],
      command: "/sdk/adb",
      env: { ANDROID_ADB_SERVER_PORT: "5038" },
    });
    const runPassthrough = vi.fn(async () => 0);

    await expect(
      runCli(
        [tool, ...args],
        output.environmentWith({ connect: async () => connection, runPassthrough }),
      ),
    ).resolves.toBe(0);
    expect(connection.calls).toContainEqual({
      payload: { args, tool },
      type: "driver.passthrough",
    });
    expect(runPassthrough).toHaveBeenCalledWith({
      args: ["-P", "5038", ...args],
      command: "/sdk/adb",
      env: { ANDROID_ADB_SERVER_PORT: "5038" },
    });
    expect(output.stdout).toBe("");
  });

  it("propagates the passthrough's own exit code rather than reporting success", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("driver.passthrough", { args: ["devices"], command: "adb", env: {} });

    await expect(
      runCli(
        ["adb", "devices"],
        output.environmentWith({
          connect: async () => connection,
          runPassthrough: async () => 42,
        }),
      ),
    ).resolves.toBe(42);
  });

  it("renders a driver's refusal as a USAGE error, not as a daemon failure", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response(
      "driver.passthrough",
      new DaemonClientError(
        "PASSTHROUGH_REFUSED",
        "Refusing `simlock simctl delete`: use `simlock release` or `simlock cleanup` instead.",
      ),
    );
    const runPassthrough = vi.fn(async () => 0);

    await expect(
      runCli(
        ["simctl", "delete", "ABCD"],
        output.environmentWith({ connect: async () => connection, runPassthrough }),
      ),
    ).resolves.toBe(2);
    expect(runPassthrough).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr)).toEqual({
      error: {
        code: "USAGE",
        message: expect.stringContaining("simlock release"),
      },
    });
  });

  it("passes a passthrough's own --help through to the tool rather than intercepting it", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("driver.passthrough", { args: ["--help"], command: "adb", env: {} });

    await expect(
      runCli(
        ["adb", "--help"],
        output.environmentWith({
          connect: async () => connection,
          runPassthrough: async () => 0,
        }),
      ),
    ).resolves.toBe(0);
    expect(connection.calls).toContainEqual({
      payload: { args: ["--help"], tool: "adb" },
      type: "driver.passthrough",
    });
  });

  it("lists both tool passthroughs in root help", async () => {
    const output = outputCapture();

    await expect(runCli([], output.environment)).resolves.toBe(0);
    expect(output.stdout).toContain("simctl <args...>");
    expect(output.stdout).toContain("adb <args...>");
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

  it("releases and exits when the watched parent process dies, via the same path as a signal", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const parentWatch = new FakeParentWatch();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_parent_death", mode: "held", ttlDeadline: 61_000 },
      timing: {
        estimatedBootMs: 0,
        estimatedProvisionMs: 0,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 0,
      },
    });
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({
        connect: async () => connection,
        parentPid: 4321,
        parentWatch,
        signals,
      }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    parentWatch.exit(4321);

    await expect(run).resolves.toBe(0);
    expect(connection.calls.map((call) => call.type)).toEqual(["lease.request", "lease.release"]);
    expect(connection.closed).toBe(true);
  });

  it("--bind-pid overrides which pid the CLI watches for parent death", async () => {
    const output = outputCapture();
    const signals = new EventEmitter();
    const parentWatch = new FakeParentWatch();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_bind_pid", mode: "held", ttlDeadline: 61_000 },
      timing: {
        estimatedBootMs: 0,
        estimatedProvisionMs: 0,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 0,
      },
    });
    let finished = false;
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16", "--bind-pid", "9999"],
      output.environmentWith({
        connect: async () => connection,
        parentPid: 4321,
        parentWatch,
        signals,
      }),
    );
    void run.then(() => (finished = true));

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    // The default parent pid is not the one bound for this invocation -- must not terminate it.
    parentWatch.exit(4321);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);

    parentWatch.exit(9999);
    await expect(run).resolves.toBe(0);
  });

  it("rejects a non-numeric --bind-pid as a structured USAGE error", async () => {
    const output = outputCapture();

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 16", "--bind-pid", "not-a-pid"],
        output.environment,
      ),
    ).resolves.toBe(2);
    expect(JSON.parse(output.stderr)).toEqual({
      error: { code: "USAGE", message: "lease --bind-pid must be a positive integer" },
    });
  });

  it("declares the heartbeat capability for held-mode leases, not for detached ones", async () => {
    const capabilitiesSeen: unknown[] = [];
    const heldConnection = new StubConnection();
    heldConnection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_held_cap", mode: "held", ttlDeadline: 61_000 },
      timing: {
        estimatedBootMs: 0,
        estimatedProvisionMs: 0,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 0,
      },
    });
    const heldOutput = outputCapture();
    const heldSignals = new EventEmitter();
    const heldRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      heldOutput.environmentWith({
        connect: async (capabilities) => {
          capabilitiesSeen.push(capabilities);
          return heldConnection;
        },
        signals: heldSignals,
      }),
    );
    await vi.waitFor(() => expect(heldOutput.stdout).not.toBe(""));
    heldSignals.emit("SIGTERM");
    await expect(heldRun).resolves.toBe(0);

    const detachedConnection = new StubConnection();
    detachedConnection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_detached_cap", mode: "detached", ttlDeadline: 61_000 },
      timing: {
        estimatedBootMs: 0,
        estimatedProvisionMs: 0,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 0,
      },
    });
    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 16", "--detach"],
        outputCapture().environmentWith({
          connect: async (capabilities) => {
            capabilitiesSeen.push(capabilities);
            return detachedConnection;
          },
        }),
      ),
    ).resolves.toBe(0);

    expect(capabilitiesSeen).toEqual([{ heartbeat: true }, undefined]);
  });

  it("rejects an invalid --platform without contacting the daemon", async () => {
    const output = outputCapture();

    await expect(runCli(["catalog", "--platform", "windows"], output.environment)).resolves.toBe(2);
    expect(output.stderr).toContain("--platform must be ios or android");
  });

  it("asks the daemon to purge orphans only once the operator has confirmed", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("doctor.run", { findings: [] });

    await expect(
      runCli(
        ["doctor", "--purge-orphans"],
        output.environmentWith({ confirm: async () => true, connect: async () => connection }),
      ),
    ).resolves.toBe(0);

    expect(connection.calls).toEqual([
      { payload: { fix: false, purgeOrphans: true }, type: "doctor.run" },
    ]);
  });

  it("keeps --purge-orphans off the wire when --fix is all that was asked for", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("doctor.run", { findings: [] });

    await expect(
      runCli(["doctor", "--fix"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);

    // The upgrade contract: `doctor --fix` running unattended in CI never becomes
    // destructive on its own (ADR 0001, decision 6).
    expect(connection.calls).toEqual([
      { payload: { fix: true, purgeOrphans: false }, type: "doctor.run" },
    ]);
  });

  it.each([
    ["declined", async () => false],
    ["unavailable", undefined],
  ] as const)(
    "refuses --purge-orphans and contacts nobody when confirmation is %s",
    async (_case, confirm) => {
      const output = outputCapture();
      const connection = new StubConnection();

      await expect(
        runCli(
          ["doctor", "--purge-orphans"],
          output.environmentWith({
            ...(confirm === undefined ? {} : { confirm }),
            connect: async () => connection,
          }),
        ),
      ).resolves.toBe(2);

      expect(connection.calls).toEqual([]);
      expect(JSON.parse(output.stderr)).toEqual({
        error: { code: "USAGE", message: expect.stringContaining("--yes") },
      });
    },
  );

  it("takes --yes as the confirmation, so an unattended purge needs no terminal", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("doctor.run", { findings: [] });

    await expect(
      runCli(
        ["doctor", "--purge-orphans", "--yes"],
        output.environmentWith({
          confirm: async () => {
            throw new Error("--yes must not ask");
          },
          connect: async () => connection,
        }),
      ),
    ).resolves.toBe(0);

    expect(connection.calls).toEqual([
      { payload: { fix: false, purgeOrphans: true }, type: "doctor.run" },
    ]);
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

  onClose(): () => void {
    return () => undefined;
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
  const directory = await mkdtemp(join(tmpdir(), "simlock-cli-"));
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
    drivers: {},
    eventBuffer: { capacity: 100 },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000, heartbeatIntervalMs: 15_000 },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 1 + 1,
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
