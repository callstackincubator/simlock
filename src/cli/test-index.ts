import {
  testConfig as configWithDefaults,
  testComponentWiring,
  testStateOf,
  FakeDriver,
  loadTestRegistry,
} from "../core/testing.js";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { EventBus } from "../bus/index.js";
import { ringEventHistory } from "../history/testing.js";
import { CleanupReaper, type Config } from "../core/index.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeDaemonLauncher,
  FakeParentWatch,
  MemoryFilesystem,
  MemoryIpcTransport,
  FakeKeySetFetcher,
  NoopLogger,
  type Filesystem,
  type IdGenerator,
  FakeHttpJsonClient,
  FakeHttpStreamClient,
  FakeSystemStats,
  FakeTcpListenerFactory,
  FakeTcpStreamConnector,
  FakeWebSocketClientConnector,
} from "../ports/index.js";
import { type Auth, createAuth, tokensOwner } from "../auth/index.js";
import { openMemoryStateDatabase } from "../auth/testing.js";
import { DaemonEndpointHost } from "../daemon/connection-host.js";
import { DaemonServer } from "../daemon/server.js";
import { SimlockError, type AnySimlockError, type UsageOutput } from "../contract/index.js";
import type {
  CatalogGetOutput,
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
import { runCli, type CliEnvironment, type CliEnvironmentPorts } from "./index.js";
import { buildCliEnvironment } from "./environment.js";
import { createTestEngine } from "../leasing/testing.js";

export const gibibyte = 1024 ** 3;

/**
 * why: Yields to the macrotask queue, so `runLease` gets past `requestLease` and reaches its wait
 * point -- its push listeners registered and its renew timer armed -- before a test fires a
 * push or advances the clock.
 */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const detachedGrant: LeaseGrant = {
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

export const runningDaemons: DaemonServer[] = [];

export const temporaryDirectories: string[] = [];

// why: read straight from the manifest so the expected version is not computed by the code under test.
export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export function simlockError(code: AnySimlockError["code"]): AnySimlockError {
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

export const EMPTY_STATUS = {
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

export async function statusLines(daemon: Partial<StatusGetOutput["daemon"]>) {
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
  return output.stdout.split("\n").slice(0, 5);
}

export function fakeClient(overrides: Partial<SimlockAdminClient> = {}): SimlockAdminClient {
  const emptyCatalog: CatalogGetOutput = { platforms: [] };
  const emptyDoctor: DoctorReport = { findings: [], sources: [] };
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
    rotate: (leaseId, orientation) => Promise.resolve({ leaseId, orientation }),
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
    runNuke: () =>
      Promise.resolve({ deletedDevices: [], releasedLeaseIds: [], removedBaselines: [] }),
    forgetWarmKind: () => Promise.resolve({ forgotten: [] }),
    saveBaseline: () => Promise.reject(new Error("saveBaseline was not expected")),
    listBaselines: () => Promise.resolve({ baselines: [] }),
    removeBaseline: () => Promise.reject(new Error("removeBaseline was not expected")),
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

export interface OutputCapture {
  stdout: string;
  stderr: string;
  environmentWith(overrides?: Partial<CliEnvironment>): CliEnvironment;
}

export function outputCapture(
  ports?: CliEnvironmentPorts,
  env: NodeJS.ProcessEnv = {},
): OutputCapture {
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
          homeDirectory: "/home/operator",
          workingDirectory: "/work/project",
          hostPlatform: "linux",
          runTool: async () => ({ outcome: "not-found" }),
          filesystem: new MemoryFilesystem(),
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
          stdoutBytes: (bytes) => (capture.stdout += Buffer.from(bytes).toString("utf8")),
          confirm: async () => true,
          webSocket: new FakeWebSocketClientConnector(),
          httpJson: new FakeHttpJsonClient(),
          httpStream: new FakeHttpStreamClient(),
          tcpListeners: new FakeTcpListenerFactory(),
          tcpStreams: new FakeTcpStreamConnector(),
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

export function sequence(): IdGenerator {
  let next = 0;
  return { generate: () => `id${next++}` };
}

export function realCliEnvironmentPorts(
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
    homeDirectory: "/home/operator",
    workingDirectory: "/work/project",
    hostPlatform: "linux",
    runTool: async () => ({ outcome: "not-found" }),
  };
}

/**
 * why: A real `DaemonServer` wired against in-memory ports (`MemoryFilesystem` + `MemoryIpcTransport`
 * shared with the CLI environment under test), with the genuine credential handshake
 * (`createAuth`) instead of `startTestDaemon`'s
 * `resolveRole: { resolve: () => "admin" }` shortcut -- B1 and B2 both hinge on that handshake
 * actually running.
 */
export async function startInMemoryDaemon(options: {
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

export function cliTestConfig(): Config {
  return configWithDefaults({
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
    eventBuffer: { capacity: 100 },
    health: { enabled: false },
    http: { enabled: false, port: 4700 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { defaultTtlMs: 60_000, maxTtlMs: 3_600_000 },
    warmPool: { maxConcurrentBoots: 1 },
  });
}

export function usageAnswer(
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
