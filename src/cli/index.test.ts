import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { type Config, CleanupReaper, FakeDriver, LeaseEngine, Registry } from "../core/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem, NodeFilesystem } from "../ports/index.js";
import { DaemonServer } from "../daemon/server.js";
import { connectExistingDaemon } from "./client.js";
import {
  DaemonClientError,
  errorExitCode,
  parseDuration,
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

describe("CLI boundary", () => {
  it.each([
    ["QUEUE_TIMEOUT", 10],
    ["NO_CAPACITY", 11],
    ["RUNTIME_MISSING", 12],
    ["UNKNOWN_MODEL", 12],
    ["BAD_REQUEST", 2],
  ] as const)("maps %s daemon errors to exit %d", async (code, expected) => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("status.get", new DaemonClientError(code, "failed"));

    await expect(
      runCli(["status"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(expected);
    expect(errorExitCode(new DaemonClientError(code, "failed"))).toBe(expected);
  });

  it("parses human durations and bare milliseconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("250")).toBe(250);
  });

  it("reports missing lease arguments as usage errors", async () => {
    const output = outputCapture();

    await expect(runCli(["lease"], output.environment)).resolves.toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("--platform");
    expect(output.stderr).toContain("Usage:");
  });

  it("keeps held lease stdout pure, renders progress to stderr, and releases on SIGTERM", async () => {
    const harness = await createHarness();
    const output = outputCapture();
    const signals = new EventEmitter();
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
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

  it("flagship e2e: queues a second CLI holder until the first connection drops", async () => {
    const harness = await createHarness();
    const first = outputCapture();
    const second = outputCapture();
    const firstSignals = new EventEmitter();
    const secondSignals = new EventEmitter();
    const firstRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      first.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        requesterId: "agent-a",
        signals: firstSignals,
      }),
    );
    await vi.waitFor(() => expect(first.stdout).not.toBe(""));
    const secondRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      second.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
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

  it("prints a detached token, exits, and renews it", async () => {
    const detached = outputCapture();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_9f2c" },
    });

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
        detached.environmentWith({ connect: async () => connection }),
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(detached.stdout)).toMatchObject({ lease: "lse_9f2c" });
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
    config,
    defaultRequesterId: "test-process",
    eventBus,
    filesystem: new NodeFilesystem(),
    leaseEngine: engine,
    reaper: new CleanupReaper({
      clock,
      config,
      eventBus,
      filesystem: new MemoryFilesystem(),
      leaseEngine: engine,
      registry,
    }),
    registry,
    socketPath,
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
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000 },
    limits: { android: { maxDevices: 1 }, ios: { maxDevices: 1 } },
    ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    warmPool: {},
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
