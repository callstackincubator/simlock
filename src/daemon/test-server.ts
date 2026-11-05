import { testConfig as configWithDefaults } from "../core/testing.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket, connect } from "node:net";
import { expect } from "vitest";
import {
  FakeDriver,
  loadTestRegistry,
  openTestState,
  testComponentWiring,
  testStateOf,
} from "../core/testing.js";
import type { StateDatabase } from "../state/index.js";
import { EventBus } from "../bus/index.js";
import { removeUsageRigs, ringEventHistory, usageRig, type UsageRig } from "../history/testing.js";
import {
  CleanupReaper,
  type Config,
  type DriverRejection,
  type PassthroughCommand,
} from "../core/index.js";
import { type ProtocolRange } from "../contract/index.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeSystemStats,
  IpcError,
  MemoryFilesystem,
  FakeKeySetFetcher,
  FakeNpmCli,
  FakeUpdaterLauncher,
  NodeFilesystem,
  NodeIpcTransport,
  NoopLogger,
  type IpcConnection,
  type Logger,
  type ProcessRunner,
  type ProcessStreamOptions,
  type StreamingProcessHandle,
  type StreamingProcessResult,
} from "../ports/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import { DaemonEndpointHost, type ConnectionHost } from "./connection-host.js";
import { describeLeaseRequestFailure } from "./error-code.js";
import { type Auth, createAuth, type SessionRoleResolver, tokensOwner } from "../auth/index.js";
import { openMemoryStateDatabase } from "../auth/testing.js";
import { DaemonServer } from "./server.js";
import { createUpdateCoordinator } from "./update-coordinator.js";
import type { RelayTargets } from "./relay.js";
import { type PhysicalDeviceWatcher } from "../leasing/index.js";
import { createTestEngine } from "../leasing/testing.js";

const gibibyte = 1024 ** 3;

interface Client {
  readonly socket: Socket;
  frames(): readonly ServerFrame[];
  nextFrame(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
  request(type: string, payload: unknown, id?: string): Promise<ServerFrame>;
  send(contents: string): void;
  close(): Promise<void>;
}

export interface ServerFrame {
  readonly error?: { readonly code: string; readonly message: string; readonly details?: unknown };
  readonly id?: string | number | null;
  readonly ok?: boolean;
  readonly payload?: unknown;
  readonly push?:
    | "device-recovered"
    | "device-unhealthy"
    | "event"
    | "lease-lost"
    | "lease.heartbeat"
    | "output"
    | "progress"
    | "started"
    | "component-progress";
}

export const runningDaemons: DaemonServer[] = [];
export const temporaryDirectories: string[] = [];
const usageRigs: UsageRig[] = [];

export async function stopTestDaemons(): Promise<void> {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
  await Promise.all(usageRigs.splice(0).map((rig) => rig.close()));
  await removeUsageRigs();
}

export async function createClientRetrying(socketPath: string, timeoutMs = 2_000): Promise<Client> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await createClient(socketPath);
    } catch (error: unknown) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

export function driveConnection(connection: IpcConnection): {
  request(type: string, payload: unknown): Promise<ServerFrame>;
} {
  let buffer = "";
  let nextId = 1;
  const waiters = new Map<number, (frame: ServerFrame) => void>();
  connection.onData((chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as ServerFrame;
      if (typeof frame.id !== "number") continue;
      const waiter = waiters.get(frame.id);
      waiters.delete(frame.id);
      waiter?.(frame);
    }
  });
  return {
    request: async (type, payload) => {
      const id = nextId++;
      const settled = new Promise<ServerFrame>((resolve) => waiters.set(id, resolve));
      await connection.write(`${JSON.stringify({ id, payload, type })}\n`);
      return settled;
    },
  };
}

export async function helloAs(
  client: Client,
  principal: string,
  capabilities?: Record<string, unknown>,
): Promise<void> {
  await expect(
    client.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      principal,
      ...(capabilities === undefined ? {} : { capabilities }),
    }),
  ).resolves.toMatchObject({ ok: true });
}

// fallow-ignore-next-line complexity -- a test harness whose branches are all trivial optional-parameter defaulting.
export async function createHarness(
  options: {
    readonly estimateMs?: Partial<Record<"boot" | "provision", number>>;
    readonly withHistory?: boolean;
    readonly latencyMs?: Partial<Record<"makeReady" | "provision", number>>;
    readonly lease?: Partial<Config["lease"]>;
    readonly socketPath?: string;
    readonly start?: boolean;
    readonly clock?: FakeClock;
    readonly converge?: () => Promise<void>;
    readonly dispose?: () => void | Promise<void>;
    readonly driver?: FakeDriver;
    readonly driverRejections?: readonly DriverRejection[];
    readonly logger?: Logger;
    readonly slimmableOsVersions?: readonly string[];
    readonly iosMaxDevices?: number;
    readonly settle?: () => Promise<void>;
    readonly physicalDeviceWatcher?: Pick<PhysicalDeviceWatcher, "dispose" | "start">;
    readonly beginStop?: () => void;
    readonly state?: StateDatabase;
    readonly stopAuxiliary?: () => Promise<void>;
    readonly adminSecret?: Auth["adminSecret"];
    readonly resolveRole?: SessionRoleResolver;
    readonly downloads?: Partial<Config["downloads"]>;
    readonly processRunner?: ProcessRunner;
    readonly host?: ConnectionHost;
    readonly protocolVersion?: ProtocolRange;
    readonly includeEnrollment?: boolean;
    readonly relayTargets?: RelayTargets;
    readonly update?: {
      readonly npm: FakeNpmCli;
      readonly launcher: FakeUpdaterLauncher;
      readonly version: string;
      readonly packageRoot?: string;
      readonly otherRoleRunning?: boolean;
      readonly resultFile?: string | Error;
      readonly resultFileGate?: Promise<void>;
    };
  } = {},
) {
  const directory =
    options.socketPath === undefined ? await mkdtemp(join(tmpdir(), "simlock-daemon-")) : undefined;
  if (directory !== undefined) {
    temporaryDirectories.push(directory);
  }
  const socketPath = options.socketPath ?? join(directory as string, "daemon.sock");
  const clock = options.clock ?? new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const state = options.state ?? (await openTestState());
  const history = options.withHistory === true ? await usageRig() : undefined;
  if (history !== undefined) usageRigs.push(history);
  const registry = await loadTestRegistry({
    clock,
    eventBus,
    idGenerator: sequence(),
    state,
  });
  const driver =
    options.driver ??
    new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      ...(options.estimateMs === undefined ? {} : { estimateMs: options.estimateMs }),
      ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
      platform: "ios",
      ...(options.slimmableOsVersions === undefined
        ? {}
        : { slimmableOsVersions: options.slimmableOsVersions }),
    });
  const config = testConfig(options.lease, options.downloads, options.iosMaxDevices);
  const unreadable =
    options.update?.resultFile instanceof Error ? options.update.resultFile : undefined;
  const resultFileGate = options.update?.resultFileGate;
  const updateFilesystem =
    unreadable === undefined && resultFileGate === undefined
      ? new MemoryFilesystem()
      : new (class extends MemoryFilesystem {
          override async readFile(...args: Parameters<MemoryFilesystem["readFile"]>) {
            if (args[0] === "/data/update-result.json") {
              await resultFileGate;
              if (unreadable !== undefined) throw unreadable;
            }
            return super.readFile(...args);
          }
        })();
  for (const path of ["/opt", "/opt/simlock", "/src", "/src/simlock", "/data"]) {
    await updateFilesystem.mkdir(path);
  }
  if (typeof options.update?.resultFile === "string") {
    await updateFilesystem.writeFileAtomic("/data/update-result.json", options.update.resultFile);
  }
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
    describeFailure: describeLeaseRequestFailure,
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
    filesystem: new MemoryFilesystem(),
    registry,
  });
  const daemon = new DaemonServer({
    ...(options.adminSecret === undefined ? {} : { adminSecret: options.adminSecret }),
    capacity: engine,
    warmPool: engine,
    deviceModes: engine,
    catalog: engine,
    ...(options.includeEnrollment === true ? { enrollment: engine.core.enrollment } : {}),
    instanceId: "instance-test",
    clock,
    components: wiring.components,
    config,
    ...(options.converge === undefined ? {} : { converge: options.converge }),
    ...(options.relayTargets === undefined ? {} : { relayTargets: options.relayTargets }),
    ...(options.driverRejections === undefined
      ? {}
      : { driverRejections: options.driverRejections }),
    defaultRequesterId: "test-process",
    eventBus,
    eventHistory: history?.history ?? ringEventHistory(eventBus),
    ...(history === undefined ? {} : { historyPath: history.historyPath }),
    host:
      options.host ??
      new DaemonEndpointHost({
        connector: new NodeIpcTransport(),
        endpoint: socketPath,
        filesystem: new NodeFilesystem(),
        listenerFactory: new NodeIpcTransport(),
      }),
    hostFacts: () => ({ arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] }),
    leases: engine,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    passthrough: engine,
    ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
    queue: engine,
    ...(options.physicalDeviceWatcher === undefined
      ? {}
      : { physicalDeviceWatcher: options.physicalDeviceWatcher as PhysicalDeviceWatcher }),
    reaper,
    registry,
    resolveRole: options.resolveRole ?? { resolve: () => "admin" },
    settle: options.settle ?? (async () => engine.settle()),
    ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
    ...(options.beginStop === undefined ? {} : { beginStop: options.beginStop }),
    ...(options.stopAuxiliary === undefined ? {} : { stopAuxiliary: options.stopAuxiliary }),
    ...(options.update === undefined
      ? {}
      : {
          update: createUpdateCoordinator({
            npm: options.update.npm,
            latestVersion: () => null,
            launcher: options.update.launcher,
            leasing: engine.leasing,
            registry,
            eventBus,
            clock,
            version: options.update.version,
            filesystem: updateFilesystem,
            dataDirectory: "/data",
            otherRoleRunning: async () => options.update?.otherRoleRunning ?? false,
            packageRoot: options.update.packageRoot ?? "/opt/simlock",
            simlockHome: "/home/simlock",
            role: "worker",
            logPath: "/data/daemon.log",
            pid: 4242,
          }),
        }),
    version: options.update?.version ?? "test",
  });
  runningDaemons.push(daemon);
  if (options.start ?? true) {
    await daemon.start();
  }

  return {
    clock,
    config,
    daemon,
    driver,
    engine,
    eventBus,
    registry,
    socketPath,
    state,
    updateFilesystem,
  };
}

export class SingleConnectionHost implements ConnectionHost {
  readonly endpoint = "memory://test";

  constructor(private readonly connection: BlockingConnection) {}

  async start(accept: (connection: IpcConnection) => void): Promise<void> {
    accept(this.connection);
  }

  async stop(): Promise<void> {}
}

export class BlockingConnection implements IpcConnection {
  readonly closed = false;
  readonly frames: Record<string, unknown>[] = [];
  #blocked = false;
  #hungUp = false;
  #pending: Array<() => void> = [];
  #dataListeners = new Set<(chunk: string) => void>();

  onData(listener: (chunk: string) => void): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onClose(): () => void {
    return () => {};
  }

  onError(): () => void {
    return () => {};
  }

  async write(contents: string): Promise<void> {
    for (const line of contents.split("\n")) {
      if (line.trim() !== "") this.frames.push(JSON.parse(line) as Record<string, unknown>);
    }
    if (this.#hungUp) {
      throw new IpcError("unknown", "This socket has been ended by the other party", "EPIPE");
    }
    if (!this.#blocked) return;
    await new Promise<void>((resolve) => this.#pending.push(resolve));
  }

  async close(): Promise<void> {}

  block(): void {
    this.#blocked = true;
  }

  hangUp(): void {
    this.#hungUp = true;
  }

  releaseAll(): void {
    this.#blocked = false;
    const pending = this.#pending;
    this.#pending = [];
    for (const resolve of pending) resolve();
  }

  async request(payload: unknown, type: string, id = type): Promise<ServerFrame> {
    for (const listener of this.#dataListeners) {
      listener(`${JSON.stringify({ id, payload, type })}\n`);
    }
    await waitFor(() => this.frames.some((frame) => frame.id === id));
    return this.frames.find((frame) => frame.id === id) as ServerFrame;
  }
}

export function passthroughDriver(clock: FakeClock): FakeDriver {
  return passthroughFake({
    availableOsVersions: ["26.5"],
    clock,
    passthrough: (args: readonly string[]) => ({
      args: ["--set", "/root", ...args],
      command: "simctl",
      env: {},
    }),
    passthroughTools: ["simctl"],
    platform: "ios",
  });
}

interface PassthroughFakeOptions {
  readonly availableOsVersions: readonly string[];
  readonly clock: FakeClock;
  readonly passthrough: (args: readonly string[]) => PassthroughCommand;
  readonly passthroughTools: readonly string[];
  readonly platform: "android" | "ios";
}

/** why: the tests here build their command from the arguments alone, so this one place drops the tool and the device. */
export function passthroughFake(options: PassthroughFakeOptions): FakeDriver {
  const { passthrough, ...rest } = options;
  return new FakeDriver({
    ...rest,
    passthrough: (_tool, _device, args) => passthrough(args),
  });
}

/** why: a rejection names every tool its driver would have answered to. */
export function rejectionNaming(
  rejection: DriverRejection,
  passthroughTools: readonly string[],
): DriverRejection {
  return { ...rejection, passthroughTools };
}

export class ControllableStreamingRunner implements ProcessRunner {
  handle: ControllableStreamingHandle | undefined;

  run(): Promise<never> {
    throw new Error("not used");
  }

  spawn(): never {
    throw new Error("not used");
  }

  spawnStreaming(
    _command: string,
    _args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    this.handle = new ControllableStreamingHandle(options.onChunk);
    return this.handle;
  }
}

class ControllableStreamingHandle implements StreamingProcessHandle {
  readonly pid = 4_242;
  settled = false;
  readonly #result: Promise<StreamingProcessResult>;
  #resolve!: (result: StreamingProcessResult) => void;

  constructor(
    private readonly onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>,
  ) {
    this.#result = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  emit(stream: "stdout" | "stderr", chunk: string): void | Promise<void> {
    return this.onChunk(stream, chunk);
  }

  finish(code: number): void {
    this.settled = true;
    this.#resolve({ code, signal: null });
  }

  kill(): void {
    this.finish(0);
  }

  wait(): Promise<StreamingProcessResult> {
    return this.#result;
  }
}

export async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for a condition");
}

export async function createClient(socketPath: string): Promise<Client> {
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

export async function hello(client: Client, capabilities?: Record<string, unknown>): Promise<void> {
  await expect(
    client.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      ...(capabilities === undefined ? {} : { capabilities }),
    }),
  ).resolves.toMatchObject({
    ok: true,
  });
}

export function leaseIdOf(frame: ServerFrame): string {
  return (frame.payload as { readonly lease: { readonly id: string } }).lease.id;
}

export async function flush(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
  }
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

export function testConfig(
  leaseOverrides?: Partial<Config["lease"]>,
  downloadsOverrides?: Partial<Config["downloads"]>,
  iosMaxDevices = 1,
): Config {
  return configWithDefaults({
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: iosMaxDevices, maxRunning: iosMaxDevices },
          maxRunning: iosMaxDevices + 1,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    ...(downloadsOverrides === undefined ? {} : { downloads: downloadsOverrides }),
    eventBuffer: { capacity: 100 },
    http: { enabled: false, port: 4700 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { defaultTtlMs: 60_000, maxTtlMs: 3_600_000, ...leaseOverrides },
    warmPool: { maxConcurrentBoots: 1 },
  });
}

export async function adminAuth(
  filesystem: MemoryFilesystem,
  secrets: CryptoTokenSecrets,
): Promise<Auth> {
  return createAuth({
    config: { enabled: false, host: "127.0.0.1", port: 4700 },
    dataDirectory: "/",
    database: (await openMemoryStateDatabase([tokensOwner])).database,
    filesystem,
    secrets,
    idGenerator: { generate: () => "id" },
    clock: new FakeClock(1_000),
    logger: new NoopLogger(),
    keySetFetcher: new FakeKeySetFetcher(),
  });
}
