import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { type Config, CleanupReaper, FakeDriver, LeaseEngine, Registry } from "../core/index.js";
import {
  FakeClock,
  FakeSystemStats,
  MemoryFilesystem,
  NodeFilesystem,
  NodeIpcTransport,
} from "../ports/index.js";
import { DaemonEndpointHost } from "./connection-host.js";
import { DaemonServer } from "./server.js";

const gibibyte = 1024 ** 3;

interface Client {
  readonly socket: Socket;
  frames(): readonly ServerFrame[];
  nextFrame(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
  request(type: string, payload: unknown, id?: string): Promise<ServerFrame>;
  send(contents: string): void;
  close(): Promise<void>;
}

interface ServerFrame {
  readonly error?: { readonly code: string; readonly message: string };
  readonly id?: string | null;
  readonly ok?: boolean;
  readonly payload?: unknown;
  readonly push?: "event" | "progress";
}

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("DaemonServer", () => {
  it("releases a held lease when its client connection closes", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);

    await holder.request("hello", { clientVersion: "test", protocolVersion: 1 });
    const grant = await holder.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    expect(grant.ok).toBe(true);
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    await holder.close();

    await expect.poll(() => harness.registry.snapshot.leases).toHaveLength(0);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    const observer = await createClient(harness.socketPath);
    await hello(observer);
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      payload: {
        capacity: { global: { warm: 1 }, ios: { warm: 1 } },
        devices: [{ state: "ready" }],
      },
    });
    await observer.close();
  });

  it("requires a compatible hello before serving requests", async () => {
    const harness = await createHarness();
    const missingHello = await createClient(harness.socketPath);

    await expect(missingHello.request("status.get", {})).resolves.toMatchObject({
      error: { code: "HANDSHAKE_REQUIRED" },
      ok: false,
    });
    await missingHello.close();

    const wrongVersion = await createClient(harness.socketPath);
    await expect(
      wrongVersion.request("hello", { clientVersion: "test", protocolVersion: 2 }),
    ).resolves.toMatchObject({
      error: { code: "PROTOCOL_VERSION_MISMATCH" },
      ok: false,
    });
  });

  it("releases a holder and grants the queued client when the holder disconnects", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    const waiter = await createClient(harness.socketPath);
    await hello(holder);
    await hello(waiter);
    await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    const queuedGrant = waiter.request("lease.request", {
      mode: "held",
      requesterId: "waiter",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    await expect
      .poll(() => harness.eventBus.replay().some((event) => event.event === "lease.queued"))
      .toBe(true);

    await holder.close();

    await expect(queuedGrant).resolves.toMatchObject({ ok: true });
    expect(harness.registry.snapshot.leases.map((lease) => lease.requesterId)).toEqual(["waiter"]);
  });

  it("keeps lease progress on its requesting connection", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    const waiter = await createClient(harness.socketPath);
    await Promise.all([hello(holder), hello(waiter)]);
    await holder.request("lease.request", {
      mode: "held",
      requesterId: "holder",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    const queuedGrant = waiter.request("lease.request", {
      mode: "held",
      requesterId: "waiter",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    await expect(waiter.nextFrame((frame) => frame.push === "progress")).resolves.toMatchObject({
      payload: { queuePosition: 1, stage: "queued" },
      push: "progress",
    });

    expect(
      holder
        .frames()
        .filter(
          (frame) =>
            frame.push === "progress" &&
            (frame.payload as { readonly stage?: unknown } | undefined)?.stage === "queued",
        ),
    ).toEqual([]);
    await holder.close();
    await expect(queuedGrant).resolves.toMatchObject({ ok: true });
    await waiter.close();
  });

  it("multiplexes interleaved request ids on concurrent connections", async () => {
    const harness = await createHarness();
    const first = await createClient(harness.socketPath);
    const second = await createClient(harness.socketPath);
    await Promise.all([hello(first), hello(second)]);

    const [firstResponse, firstConfig, secondResponse] = await Promise.all([
      first.request("status.get", {}, "first-status"),
      first.request("config.get", {}, "first-config"),
      second.request("config.get", {}, "second-config"),
    ]);

    expect(firstResponse).toMatchObject({ id: "first-status", ok: true });
    expect(firstConfig).toMatchObject({ id: "first-config", ok: true });
    expect(secondResponse).toMatchObject({ id: "second-config", ok: true });
  });

  it("pushes driver-estimated progress while a slow lease acquisition is pending", async () => {
    const harness = await createHarness({
      estimateMs: { boot: 30, provision: 60 },
      latencyMs: { makeReady: 10, provision: 10 },
    });
    const client = await createClient(harness.socketPath);
    await hello(client);
    let requestSettled = false;
    const grant = client
      .request("lease.request", {
        mode: "detached",
        requesterId: "agent-1",
        request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      })
      .then((response) => {
        requestSettled = true;
        return response;
      });

    await expect(
      client.nextFrame((frame) => frame.push === "progress" && frame.payload !== undefined),
    ).resolves.toMatchObject({
      payload: { etaMs: 60, stage: "provisioning" },
      push: "progress",
    });
    expect(requestSettled).toBe(false);
    harness.clock.advance(10);
    await flush();
    harness.clock.advance(10);

    await expect(grant).resolves.toMatchObject({ ok: true });
  });

  it("buffers torn frames and recovers from a garbage line", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);

    client.send('{"id":"hello","type":"hel');
    client.send('lo","payload":{"clientVersion":"test","protocolVersion":1}}\n');
    await expect(client.nextFrame((frame) => frame.id === "hello")).resolves.toMatchObject({
      ok: true,
    });

    client.send("not json\n");
    await expect(client.nextFrame((frame) => frame.id === null)).resolves.toMatchObject({
      error: { code: "BAD_FRAME" },
      ok: false,
    });
    await expect(client.request("status.get", {}, "after-garbage")).resolves.toMatchObject({
      id: "after-garbage",
      ok: true,
    });
  });

  it("maps status, cleanup, events, config, and detached lease commands to daemon-owned core state", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: {
        capacity: {
          global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
          ios: {
            limit: 1,
            maxRunning: 1,
            overLimit: false,
            reserved: 0,
            running: 0,
            used: 0,
            warm: 0,
          },
        },
      },
    });
    await expect(client.request("list.get", {})).resolves.toMatchObject({ ok: true });
    await expect(client.request("config.get", {})).resolves.toMatchObject({ ok: true });
    await expect(client.request("cleanup.run", { dryRun: true })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.request("events.replay", { sinceTs: 0 })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.request("events.subscribe", {})).resolves.toMatchObject({ ok: true });
    harness.eventBus.emit(
      "disk.pressure-detected",
      { freeBytes: 1, threshold: testConfig().diskPressure.freeBytesThreshold },
      "test",
    );
    await expect(client.nextFrame((frame) => frame.push === "event")).resolves.toMatchObject({
      push: "event",
    });
    await expect(client.request("events.unsubscribe", {})).resolves.toMatchObject({ ok: true });

    const grant = await client.request("lease.request", {
      mode: "detached",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    const leaseId = (grant.payload as { readonly lease: { readonly id: string } }).lease.id;
    await expect(client.request("lease.renew", { leaseId, ttlMs: 120_000 })).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(client.request("lease.release", { leaseId })).resolves.toMatchObject({ ok: true });
    expect(harness.registry.snapshot.leases).toEqual([]);
  });

  it("recovers a stale socket file and refuses a second live daemon", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pitlane-stale-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "daemon.sock");
    await new NodeFilesystem().writeFileAtomic(socketPath, "stale");
    const first = await createHarness({ socketPath });
    const second = await createHarness({ socketPath, start: false });

    await expect(second.daemon.start()).rejects.toMatchObject({
      name: "DaemonAlreadyRunningError",
    });
    await second.daemon.stop("failed-start");
    const client = await createClient(socketPath);
    await hello(client);
    await client.close();
    expect(first.daemon.socketPath).toBe(socketPath);
  });

  it("gracefully stops by releasing held leases and persisting the final registry", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);
    await client.request("lease.request", {
      mode: "held",
      requesterId: "agent-1",
      request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });

    await expect(client.request("daemon.stop", {})).resolves.toMatchObject({ ok: true });
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);

    expect(harness.registry.snapshot.leases).toEqual([]);
    await expect(harness.stateFilesystem.readFile("/state.json")).resolves.toContain('"leases":[]');
    expect(harness.eventBus.replay().map((event) => event.event)).toContain("daemon.stopping");
  });
});

async function createHarness(
  options: {
    readonly estimateMs?: Partial<Record<"boot" | "provision", number>>;
    readonly latencyMs?: Partial<Record<"makeReady" | "provision", number>>;
    readonly socketPath?: string;
    readonly start?: boolean;
  } = {},
) {
  const directory =
    options.socketPath === undefined ? await mkdtemp(join(tmpdir(), "pitlane-daemon-")) : undefined;
  if (directory !== undefined) {
    temporaryDirectories.push(directory);
  }
  const socketPath = options.socketPath ?? join(directory as string, "daemon.sock");
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const stateFilesystem = new MemoryFilesystem();
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem: stateFilesystem,
    idGenerator: sequence(),
    statePath: "/state.json",
  });
  const driver = new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    ...(options.estimateMs === undefined ? {} : { estimateMs: options.estimateMs }),
    ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
    platform: "ios",
  });
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
    filesystem: new MemoryFilesystem(),
    registry,
  });
  const daemon = new DaemonServer({
    capacity: engine,
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
    protocolVersion: 1,
    queue: engine,
    reaper,
    registry,
    socketPath,
    version: "test",
  });
  runningDaemons.push(daemon);
  if (options.start ?? true) {
    await daemon.start();
  }

  return { clock, daemon, eventBus, registry, socketPath, stateFilesystem };
}

async function createClient(socketPath: string): Promise<Client> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  let buffer = "";
  const frames: ServerFrame[] = [];
  const waiters: Array<{
    readonly predicate: (frame: ServerFrame) => boolean;
    readonly resolve: (frame: ServerFrame) => void;
  }> = [];
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const frame = JSON.parse(line) as ServerFrame;
      const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(frame));
      const waiter = waiterIndex < 0 ? undefined : waiters.splice(waiterIndex, 1)[0];
      if (waiter === undefined) {
        frames.push(frame);
      } else {
        waiter.resolve(frame);
      }
    }
  });
  socket.on("error", () => undefined);

  const nextFrame = (predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> => {
    const frameIndex = frames.findIndex(predicate);
    if (frameIndex >= 0) {
      const frame = frames.splice(frameIndex, 1)[0];
      return Promise.resolve(frame as ServerFrame);
    }
    return new Promise((resolve) => waiters.push({ predicate, resolve }));
  };

  let nextRequestId = 1;
  return {
    socket,
    frames: () => [...frames],
    nextFrame,
    async request(type, payload, id = `request-${nextRequestId++}`) {
      const response = nextFrame((frame) => frame.id === id);
      socket.write(`${JSON.stringify({ id, payload, type })}\n`);
      return response;
    },
    send(contents) {
      socket.write(contents);
    },
    async close() {
      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
        socket.destroy();
      });
    },
  };
}

async function hello(client: Client): Promise<void> {
  await expect(
    client.request("hello", { clientVersion: "test", protocolVersion: 1 }),
  ).resolves.toMatchObject({
    ok: true,
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
  }
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
    limits: {
      android: { maxDevices: 1, maxRunning: 1 },
      ios: { maxDevices: 1, maxRunning: 1 },
      maxRunning: 1 + 1,
    },
    ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
  };
}
