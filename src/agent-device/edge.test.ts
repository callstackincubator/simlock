import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDriver } from "../core/testing.js";
import { startDaemon, type StartDaemonOptions } from "../daemon/main.js";
import type { DaemonServer } from "../daemon/server.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { agentDeviceModuleWith, FakeAgentDevice } from "./testing.js";

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const secrets = {
  one: "slk_test_agent_one",
  operator: "slk_test_operator",
  two: "slk_test_agent_two",
  worker: "slk_test_worker_join",
} as const;
const principals = { one: "tok_one", two: "tok_two" } as const;

const notAvailable = "agent-device is not available on this simlock: ";
const agentTokenOnly = "refused: agent-device through simlock needs an agent token";
const queueTimeoutMessage = "timed out waiting for a device; nothing was leased";
const defaultTtlMs = 600_000;
const maxTtlMs = 1_800_000;
const scope = { clientId: "client-1", leaseProvider: "proxy", runId: "run-1" } as const;

const adminSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "admin",
  role: "admin",
} as const;

function sessionFor(principal: string) {
  return {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal,
    role: "agent",
  } as const;
}

interface Envelope {
  readonly id?: unknown;
  readonly jsonrpc?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: { readonly code: string; readonly message: string };
  };
}

interface SetUpOptions {
  readonly leaseTtlCapMs?: number;
  readonly drivers?: (clock: FakeClock) => FakeDriver[];
  readonly enabled?: boolean | "unset";
  readonly endWaitMs?: number;
  readonly gatewayMode?: boolean;
  readonly maxRunning?: number;
  readonly slowStart?: boolean;
  readonly upstream?: FakeAgentDevice;
}

interface Rig {
  readonly clock: FakeClock;
  readonly daemon: DaemonServer;
  readonly driver: FakeDriver;
  readonly fake: FakeAgentDevice;
  readonly filesystem: MemoryFilesystem;
  readonly logs: MemoryLogSink;
  readonly origin: string;
  readonly statePath: string;
  readonly started: Promise<DaemonServer>;
  readonly restart: (between?: () => void) => Promise<Rig>;
}

const phoneModels = {
  defaultModels: { phone: ["iPhone 16"] },
  modelClasses: { "iPhone 16": "phone" },
} as const;

function iosDriver(clock: FakeClock): FakeDriver {
  return new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    defaultModels: { desktop: ["Mac"], phone: ["iPhone 16"], tv: ["Apple TV 4K"] },
    knownModels: ["iPhone 16", "iPhone 17 Pro", "Apple TV 4K", "Mac"],
    modelClasses: {
      "Apple TV 4K": "tv",
      "iPhone 16": "phone",
      "iPhone 17 Pro": "phone",
      Mac: "desktop",
    },
    platform: "ios",
  });
}

function androidDriver(clock: FakeClock): FakeDriver {
  return new FakeDriver({
    availableOsVersions: ["35"],
    clock,
    defaultModels: { phone: ["Pixel 8"] },
    knownModels: ["Pixel 8"],
    modelAliases: { "Pixel 8": ["P8"] },
    modelClasses: { "Pixel 8": "phone" },
    platform: "android",
  });
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function setUp(options: SetUpOptions = {}): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-agent-device-edge-"));
  temporaryDirectories.push(directory);
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(directory);
  const hasher = new CryptoTokenSecrets();
  const record = (id: string, secret: string, role: string) => ({
    createdAt: 0,
    hash: hasher.hash(secret),
    id,
    role,
  });
  await filesystem.writeFileAtomic(
    join(directory, "tokens.json"),
    JSON.stringify([
      record(principals.one, secrets.one, "agent"),
      record(principals.two, secrets.two, "agent"),
      record("tok_operator", secrets.operator, "operator"),
      record("tok_worker", secrets.worker, "worker"),
    ]),
  );
  const port = await freeLoopbackPort();
  const fake = options.upstream ?? new FakeAgentDevice();
  const drivers = options.drivers?.(clock) ?? [iosDriver(clock)];
  const statePath = join(directory, "state.json");
  const logs = new MemoryLogSink();
  const launch = () =>
    startDaemon({
      clock,
      configOverrides: {
        ...(options.enabled === "unset"
          ? {}
          : {
              capabilities: {
                "agent-device": {
                  enabled: options.enabled ?? true,
                  ...(options.leaseTtlCapMs === undefined
                    ? {}
                    : { leaseTtlCapMs: options.leaseTtlCapMs }),
                },
              },
            }),
        capacity: { config: { maxRunning: options.maxRunning ?? 4 }, strategy: "fixed" },
        http: { enabled: true, host: "127.0.0.1", port },
        lease: {
          defaultTtlMs,
          maxTtlMs,
          ...(options.endWaitMs === undefined ? {} : { endWaitMs: options.endWaitMs }),
        },
        ...(options.gatewayMode === true ? { mode: "gateway" as const } : {}),
      },
      dataDirectory: directory,
      drivers,
      filesystem,
      logger: new JsonLinesLogger({ clock, level: "debug", sink: logs }),
      optionalModules: [agentDeviceModuleWith({ upstream: fake })],
      statePath,
      version: "1.2.3",
    } as StartDaemonOptions).then((daemon) => {
      runningDaemons.push(daemon);
      return daemon;
    });
  const started = launch();
  const origin = `http://127.0.0.1:${port}`;
  if (options.slowStart === true) {
    await waitListening(origin);
    return {
      clock,
      daemon: undefined as never,
      driver: drivers[0] as FakeDriver,
      fake,
      filesystem,
      logs,
      origin,
      restart: () => Promise.reject(new Error("restart needs a started daemon")),
      started,
      statePath,
    };
  }
  const rigFor = (daemon: DaemonServer, running: Promise<DaemonServer>): Rig => ({
    clock,
    daemon,
    driver: drivers[0] as FakeDriver,
    fake,
    filesystem,
    logs,
    origin,
    restart: async (between) => {
      await daemon.stop("test");
      between?.();
      const next = await launch();
      return rigFor(next, Promise.resolve(next));
    },
    started: running,
    statePath,
  });
  return rigFor(await started, started);
}

async function waitListening(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await fetch(`${origin}/v1/healthz`);
      return;
    } catch {
      await sleep(5);
    }
  }
  throw new Error("the daemon never listened");
}

async function advance(rig: Rig, ms: number, step = 1_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    rig.clock.advance(Math.min(step, ms - elapsed));
    await sleep(3);
  }
}

interface SendOptions {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly signal?: AbortSignal;
  readonly token?: string | null;
}

function send(rig: Rig, path: string, options: SendOptions = {}): Promise<Response> {
  const token = options.token === undefined ? secrets.one : options.token;
  return fetch(`${rig.origin}/v1/agent-device${path}`, {
    ...(options.body === undefined ? {} : { body: options.body }),
    headers: {
      // why: a pooled socket to a daemon the test restarted on the same port is closed by the server, so a request must not reuse one.
      connection: "close",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function rpcBody(method: string, params: Record<string, unknown>, id: unknown = 1): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method, params });
}

function rpc(
  rig: Rig,
  method: string,
  params: Record<string, unknown>,
  options: Omit<SendOptions, "body"> & { readonly id?: unknown } = {},
): Promise<Response> {
  return send(rig, "/rpc", { ...options, body: rpcBody(method, params, options.id ?? 1) });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  expect(
    text.trimStart().startsWith("{"),
    `expected a JSON object body, got ${response.status} ${text.slice(0, 80)}`,
  ).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

async function envelopeOf(response: Response): Promise<Envelope> {
  return (await bodyOf(response)) as Envelope;
}

const hex = (n: number): string => n.toString(16).padStart(32, "0");

function allocateParams(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...scope, leaseId: hex(n), platform: "ios", ttlMs: 120_000, ...extra };
}

function allocate(
  rig: Rig,
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(rig, "agent_device.lease.allocate", allocateParams(n, extra), options);
}

async function granted(
  rig: Rig,
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<void> {
  const answer = await envelopeOf(await allocate(rig, n, extra, options));
  expect(answer.result).toMatchObject({ ok: true });
}

function release(rig: Rig, n: number, options: Omit<SendOptions, "body"> = {}): Promise<Response> {
  return rpc(rig, "agent_device.lease.release", { ...scope, leaseId: hex(n) }, options);
}

function command(
  rig: Rig,
  name: string,
  n: number | undefined,
  options: Omit<SendOptions, "body"> = {},
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return rpc(
    rig,
    "agent_device.command",
    {
      command: name,
      ...(n === undefined ? {} : { meta: { leaseId: hex(n) } }),
      ...extra,
    },
    options,
  );
}

interface LeaseView {
  readonly id: string;
  readonly deviceId: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly ttlDeadline: number;
  readonly lastRenewedAt: number;
}

async function leases(rig: Rig): Promise<readonly LeaseView[]> {
  return (await rig.daemon.dispatch(
    "list.get",
    { kind: "leases" },
    adminSession,
  )) as unknown as readonly LeaseView[];
}

async function waiting(
  rig: Rig,
): Promise<readonly { readonly id: string; readonly requesterId: string }[]> {
  return (await rig.daemon.dispatch("list.get", { kind: "requests" }, adminSession)) as never;
}

async function devices(rig: Rig): Promise<
  readonly {
    readonly id: string;
    readonly state: string;
    readonly address?: string;
    readonly driverDeviceId?: string;
  }[]
> {
  return (await rig.daemon.dispatch("list.get", { kind: "devices" }, adminSession)) as never;
}

async function requestedSpecs(rig: Rig, requester: string): Promise<readonly unknown[]> {
  const events = await rig.daemon.dispatch("events.replay", {}, adminSession);
  return events
    .filter((entry) => entry.event === "lease.requested")
    .map((entry) => entry.payload as { requester: string; requestSpec: unknown })
    .filter((payload) => payload.requester === requester)
    .map((payload) => payload.requestSpec);
}

async function grantedDevice(rig: Rig) {
  const [device] = await devices(rig);
  expect(device?.address).toBeDefined();
  return device as { readonly address: string; readonly driverDeviceId?: string };
}

function receivedAllocate(rig: Rig, n: number): Record<string, unknown> {
  const params = allocatesReceived(rig, n)[0]?.params;
  expect(params).toBeDefined();
  return params as Record<string, unknown>;
}

function allocatesReceived(rig: Rig, n?: number) {
  return rig.fake
    .rpcRequests("agent_device.lease.allocate")
    .filter((request) => n === undefined || request.params?.["leaseId"] === hex(n));
}

async function simlockMessage(rig: Rig, input: Record<string, unknown>): Promise<string> {
  try {
    await rig.daemon.dispatch("lease.request", input, sessionFor(principals.one));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("simlock accepted a request the test expected it to refuse");
}

function track<T>(promise: Promise<T>): {
  readonly done: () => boolean;
  readonly promise: Promise<T>;
} {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  return { done: () => settled, promise: tracked };
}

function refusal(message: string, code = "INVALID_ARGS") {
  return { code: -32000, data: { code, message }, message };
}

const endedMessage = "lease ended by simlock; run disconnect, then open";

function heartbeat(
  rig: Rig,
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(rig, "agent_device.lease.heartbeat", { ...scope, leaseId: hex(n), ...extra }, options);
}

function heartbeatsReceived(rig: Rig): number {
  return rig.fake.rpcRequests("agent_device.lease.heartbeat").length;
}

function expectEndedBySimlock(answer: Envelope): void {
  expect(answer.result).toBeUndefined();
  expect(answer.error).toMatchObject({
    data: {
      code: "UNAUTHORIZED",
      details: { reason: "LEASE_ENDED_BY_HOST" },
      message: endedMessage,
    },
  });
}

function expectLeaseGone(answer: Envelope, reason: string): void {
  expect(answer.error).toMatchObject({
    data: { code: "UNAUTHORIZED", details: { reason } },
  });
}

async function deadlineOf(rig: Rig, n: number): Promise<number | undefined> {
  return (await leases(rig)).find((lease) => lease.id === hex(n))?.ttlDeadline;
}

async function listed(rig: Rig): Promise<readonly string[]> {
  return (await leases(rig)).map((lease) => lease.id);
}

type RawDispatch = (operation: string, input: unknown, session: unknown) => Promise<unknown>;

interface DispatchTap {
  readonly operations: string[];
  rejectNext(operation: string): void;
  afterNext(operation: string, run: () => Promise<void>): void;
}

// why: the front reaches simlock through `daemon.dispatch` looked up at call time, so a wrapper on the daemon object sits between the front and leasing.
function tapDispatch(rig: Rig): DispatchTap {
  const daemon = rig.daemon as unknown as { dispatch: RawDispatch };
  const original = daemon.dispatch.bind(daemon);
  const operations: string[] = [];
  const rejections = new Set<string>();
  const afters = new Map<string, () => Promise<void>>();
  daemon.dispatch = async (operation, input, session) => {
    operations.push(operation);
    if (rejections.delete(operation)) throw new Error("simlock could not do that");
    const result = await original(operation, input, session);
    const after = afters.get(operation);
    afters.delete(operation);
    await after?.();
    return result;
  };
  return {
    afterNext: (operation, run) => afters.set(operation, run),
    operations,
    rejectNext: (operation) => rejections.add(operation),
  };
}

function frontCalls(tap: DispatchTap): readonly string[] {
  return tap.operations.filter((name) => name === "lease.renew" || name === "lease.list");
}

async function renewMessage(rig: Rig, leaseId: string, ttlMs: number): Promise<string> {
  try {
    await rig.daemon.dispatch("lease.renew", { leaseId, ttlMs }, sessionFor(principals.one));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("simlock accepted a renewal the test expected it to refuse");
}

async function runningCommand(rig: Rig, n: number, options: Omit<SendOptions, "body"> = {}) {
  rig.fake.holdCommand();
  const before = rig.fake.rpcRequests("agent_device.command").length;
  const running = track(command(rig, "snapshot", n, options));
  await expect.poll(() => rig.fake.rpcRequests("agent_device.command").length).toBe(before + 1);
  return running;
}

describe("the agent-device front, through the whole worker daemon", () => {
  it("with capabilities.agent-device.enabled false, and unset on a gateway-mode daemon, /v1/agent-device/health answers 404, as today", async () => {
    const enabled = await setUp();
    expect((await send(enabled, "/health")).status).toBe(200);

    const off = await setUp({ enabled: false });
    expect((await send(off, "/health")).status).toBe(404);

    const gateway = await setUp({ enabled: "unset", gatewayMode: true });
    expect((await send(gateway, "/health")).status).toBe(404);
  });

  it("/v1/agent-device/rpc with no simlock token answers 401, with a worker join token 403, and with an operator token 403 `refused: agent-device through simlock needs an agent token`; the agent-device daemon receives nothing", async () => {
    const rig = await setUp();
    expect((await command(rig, "snapshot", undefined)).status).toBe(200);
    const received = rig.fake.requests.length;

    expect((await command(rig, "snapshot", undefined, { token: null })).status).toBe(401);
    expect((await command(rig, "snapshot", undefined, { token: secrets.worker })).status).toBe(403);
    const operator = await command(rig, "snapshot", undefined, { token: secrets.operator });
    expect(operator.status).toBe(403);
    expect(await operator.text()).toContain(agentTokenOnly);

    expect(rig.fake.requests).toHaveLength(received);
  });

  it("/v1/agent-device/health with a simlock token answers the proxy's health, with the agent-device daemon's health under `upstream`", async () => {
    const rig = await setUp();

    const response = await send(rig, "/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "agent-device-proxy",
      upstream: { service: "agent-device-daemon" },
    });
  });

  it("with capabilities.agent-device.enabled true and agent-device unavailable, /health, /rpc and an upload each answer `agent-device is not available on this simlock: <reason>`, nothing is leased, and POST /v1/lease-requests still grants a device", async () => {
    const rig = await setUp();
    const reason = "found 0.20.3, need 0.21.28 or later";
    rig.fake.setUnavailable(reason);

    const health = await send(rig, "/health");
    const rpcAnswer = await allocate(rig, 1);
    const upload = await send(rig, "/upload/preflight", { body: "{}" });

    expect(health.status).toBe(200);
    expect(rpcAnswer.status).toBe(503);
    expect(upload.status).toBe(503);
    expect(await health.text()).toContain(`${notAvailable}${reason}`);
    expect((await envelopeOf(rpcAnswer)).error?.message).toBe(`${notAvailable}${reason}`);
    expect(await upload.text()).toContain(`${notAvailable}${reason}`);
    expect(await leases(rig)).toEqual([]);
    expect(rig.fake.requests).toEqual([]);

    const granted = await fetch(`${rig.origin}/v1/lease-requests`, {
      body: JSON.stringify({ device: "iPhone 16", platform: "ios" }),
      headers: { authorization: `Bearer ${secrets.one}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(granted.status).toBe(201);
  });

  it("after the agent-device daemon restarts with a new base URL, token and generation, the next request reaches the new daemon", async () => {
    const rig = await setUp();
    expect(await bodyOf(await send(rig, "/health"))).toMatchObject({
      upstream: { service: "agent-device-daemon" },
    });
    const before = rig.fake.requests.length;

    rig.fake.restart();
    const response = await send(rig, "/health");

    expect(await bodyOf(response)).toMatchObject({ upstream: { service: "agent-device-daemon" } });
    expect(rig.fake.requests.length).toBeGreaterThan(before);
  });

  it("commands sent with two simlock tokens reach the agent-device daemon as two tenants, each its token's principal, though the client named another tenant", async () => {
    const rig = await setUp();
    const named = { meta: { tenantId: "someone-else" }, tenantId: "someone-else" };

    await command(rig, "snapshot", undefined, { token: secrets.one }, named);
    await command(rig, "snapshot", undefined, { token: secrets.two }, named);

    expect(rig.fake.rpcRequests("agent_device.command").map((request) => request.tenant)).toEqual([
      principals.one,
      principals.two,
    ]);
  });

  it("allocate `--platform ios` makes a simlock lease whose ID and requester are the CLI's lease ID, owned by the token's principal, and the lease request names no osVersion, mode, imageTag or physical device", async () => {
    const rig = await setUp();

    const answer = await allocate(rig, 1);

    expect((await envelopeOf(answer)).result).toMatchObject({ ok: true });
    expect(await leases(rig)).toMatchObject([
      { id: hex(1), ownerId: principals.one, requesterId: hex(1) },
    ]);
    expect(await requestedSpecs(rig, hex(1))).toEqual([{ platform: "ios" }]);

    const bare = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          knownModels: ["iPhone 16"],
          platform: "ios",
        }),
      ],
    });
    const refused = await allocate(bare, 2);
    expect((await envelopeOf(refused)).error?.message).toContain("refused by simlock: ");
    expect(bare.driver.calls.map((call) => call.operation)).not.toContain("installComponent");
  });

  it("the simlock lease's TTL is the CLI's `ttlMs`, 5 s when the CLI sent less, and `lease.defaultTtlMs` when it sent none; the allocate the agent-device daemon receives carries `ttlMs` equal to the ceiling in each case", async () => {
    const rig = await setUp();

    await granted(rig, 1, { ttlMs: 120_000 });
    await granted(rig, 2, { ttlMs: 1_000 });
    await granted(rig, 3, { ttlMs: undefined });

    const byId = new Map((await leases(rig)).map((lease) => [lease.id, lease.ttlMs]));
    expect(byId.get(hex(1))).toBe(120_000);
    expect(byId.get(hex(2))).toBe(5_000);
    expect(byId.get(hex(3))).toBe(defaultTtlMs);
    expect(allocatesReceived(rig).map((request) => request.params?.["ttlMs"])).toEqual([
      rig.fake.leaseMaxTtlMs,
      rig.fake.leaseMaxTtlMs,
      rig.fake.leaseMaxTtlMs,
    ]);
  });

  it('allocate `--target mobile`, `tv` and `desktop` ask simlock for class `phone`, `tv` and `desktop`; allocate `--device "iPhone 17 Pro"`, alone and with `--target tv`, asks for that model and no class', async () => {
    const rig = await setUp({ maxRunning: 8 });

    await granted(rig, 1, { target: "mobile" });
    await granted(rig, 2, { target: "tv" });
    await granted(rig, 3, { target: "desktop" });
    await granted(rig, 4, { device: "iPhone 17 Pro" });
    await granted(rig, 5, { device: "iPhone 17 Pro", target: "tv" });

    expect(await requestedSpecs(rig, hex(1))).toEqual([{ class: "phone", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(2))).toEqual([{ class: "tv", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(3))).toEqual([{ class: "desktop", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(4))).toEqual([
      { model: "iPhone 17 Pro", platform: "ios" },
    ]);
    expect(await requestedSpecs(rig, hex(5))).toEqual([
      { model: "iPhone 17 Pro", platform: "ios" },
    ]);
  });

  it("an allocate whose `ttlMs` is above `lease.maxTtlMs` answers `refused by simlock:` with simlock's `BAD_REQUEST` message and leaves no simlock lease; one with `ttlMs: null` gets `lease.defaultTtlMs`", async () => {
    const rig = await setUp();
    expect((await envelopeOf(await allocate(rig, 1, { ttlMs: null }))).result).toMatchObject({
      ok: true,
    });
    expect((await leases(rig)).map((lease) => lease.ttlMs)).toEqual([defaultTtlMs]);

    const over = maxTtlMs + 1;
    const expected = await simlockMessage(rig, { leaseId: hex(9), platform: "ios", ttlMs: over });
    const answer = await envelopeOf(await allocate(rig, 2, { ttlMs: over }));

    expect(answer.error?.message).toBe(`refused by simlock: ${expected}`);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it('allocate `--device "My test phone"` answers `refused by simlock:` with simlock\'s message, and leaves no simlock lease', async () => {
    const rig = await setUp();
    expect(
      (await envelopeOf(await allocate(rig, 1, { device: "iPhone 17 Pro" }))).result,
    ).toMatchObject({ ok: true });
    const expected = await simlockMessage(rig, {
      leaseId: hex(9),
      model: "My test phone",
      platform: "ios",
    });

    const answer = await envelopeOf(await allocate(rig, 2, { device: "My test phone" }));

    expect(answer.error).toMatchObject(refusal(`refused by simlock: ${expected}`));
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  describe("each input refused before simlock", () => {
    const tooOld = "refused: this agent-device is too old for simlock; upgrade it";
    const ttlRefusal = "refused: ttlMs must be a positive number of milliseconds";
    const plainOnly = "refused: simlock leases only plain devices";
    const lifecycle = "refused: send lease calls as lease RPCs";
    const cases: readonly {
      readonly title: string;
      readonly message: string;
      readonly method?: string;
      readonly params: (n: number) => Record<string, unknown>;
    }[] = [
      {
        message: "refused: only iOS and Android",
        params: (n) => allocateParams(n, { platform: "macos" }),
        title: "--platform macos",
      },
      {
        message: "refused: simlock picks the device",
        params: (n) => allocateParams(n, { udid: "ABC" }),
        title: "--udid",
      },
      {
        message: "refused: simlock picks the device",
        params: (n) => allocateParams(n, { serial: "emulator-5554" }),
        title: "--serial",
      },
      {
        message: "refused: name --platform ios or android",
        params: (n) => allocateParams(n, { platform: undefined }),
        title: "no platform",
      },
      {
        message: tooOld,
        params: (n) => allocateParams(n, { leaseId: undefined }),
        title: "no lease ID",
      },
      {
        message: tooOld,
        params: (n) => allocateParams(n, { leaseId: hex(n).toUpperCase().replace(/[0-9]/g, "A") }),
        title: "a lease ID that is not 32 lowercase hex",
      },
      {
        message: ttlRefusal,
        params: (n) => allocateParams(n, { ttlMs: "abc" }),
        title: 'a ttlMs of "abc"',
      },
      {
        message: ttlRefusal,
        params: (n) => allocateParams(n, { ttlMs: -1 }),
        title: "a ttlMs of -1",
      },
      {
        message: ttlRefusal,
        params: (n) => allocateParams(n, { ttlMs: 0 }),
        title: "a ttlMs of 0",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { backend: "cloud" }),
        title: "backend",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { backend: "android-instance" }),
        title: "the Android backend on an iOS allocate",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { retainOnClose: true }),
        title: "retainOnClose: true",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { providerName: "x" }),
        title: "a provider* key",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { leaseProvider: "aws" }),
        title: 'leaseProvider: "aws"',
      },
      ...["agent_device.command", "agent-device.command"].flatMap((method) =>
        ["lease_allocate", "lease_heartbeat", "lease_release"].map((name) => ({
          message: lifecycle,
          method,
          params: (n: number) => ({ command: name, meta: { leaseId: hex(n) } }),
          title: `${method} carrying ${name}`,
        })),
      ),
    ];

    it.each(cases)(
      "$title answers its message, simlock stores no lease request, and the agent-device daemon receives nothing",
      async ({ message, method, params }) => {
        const rig = await setUp();
        const accepted = await allocate(rig, 1);
        expect((await envelopeOf(accepted)).result).toMatchObject({ ok: true });
        const heldBefore = (await leases(rig)).map((lease) => lease.id);
        const receivedBefore = rig.fake.requests.length;

        const answer = await rpc(rig, method ?? "agent_device.lease.allocate", params(2));

        expect((await envelopeOf(answer)).error).toMatchObject(refusal(message));
        expect(await requestedSpecs(rig, hex(2))).toEqual([]);
        expect(await waiting(rig)).toEqual([]);
        expect((await leases(rig)).map((lease) => lease.id)).toEqual(heldBefore);
        expect(rig.fake.requests).toHaveLength(receivedBefore);
      },
    );
  });

  it("an allocate in the shape connect proxy sends, with backend ios-instance, is granted and keeps the backend toward the agent-device daemon", async () => {
    const rig = await setUp();

    const answer = await envelopeOf(
      await allocate(rig, 1, {
        backend: "ios-instance",
        runId: "proxy-1",
        session: "adc-1",
        tenantId: "proxy",
      }),
    );

    expect(answer.result).toMatchObject({ ok: true });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(allocatesReceived(rig, 1).map((received) => received.params?.["backend"])).toEqual([
      "ios-instance",
    ]);
  });

  it("allocate and release sent as `agent-device.lease.allocate` and `agent-device.lease.release` act exactly as the `agent_device.lease.*` spelling", async () => {
    const rig = await setUp();

    const allocated = await rpc(rig, "agent-device.lease.allocate", allocateParams(1));

    expect((await envelopeOf(allocated)).result).toMatchObject({ ok: true });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(rig.fake.leases.has(hex(1))).toBe(true);

    const released = await rpc(rig, "agent-device.lease.release", { ...scope, leaseId: hex(1) });

    expect((await envelopeOf(released)).result).toMatchObject({ ok: true });
    expect(await leases(rig)).toEqual([]);
    expect(rig.fake.leases.has(hex(1))).toBe(false);
  });

  it("after the grant, the allocate the agent-device daemon receives names the granted device's address by `udid` on iOS and by `serial` on Android (the emulator serial, not the AVD name), and carries no `device`, `deviceKey` or `target`; the CLI gets the daemon's reply with the same lease ID", async () => {
    const ios = await setUp();
    const iosAnswer = await envelopeOf(
      await allocate(ios, 1, { device: "iPhone 17 Pro", deviceKey: "saved", target: "mobile" }),
    );
    const iosDevice = await grantedDevice(ios);
    const iosParams = receivedAllocate(ios, 1);

    expect(iosAnswer.result).toMatchObject({ data: { lease: { leaseId: hex(1) } }, ok: true });
    expect(iosParams["udid"]).toBe(iosDevice.address);
    expect(iosParams).not.toHaveProperty("serial");
    for (const dropped of ["device", "deviceKey", "target"]) {
      expect(iosParams).not.toHaveProperty(dropped);
    }

    const android = await setUp({ drivers: (clock) => [androidDriver(clock)] });
    const androidAnswer = await envelopeOf(
      await allocate(android, 2, { device: "Pixel 8", platform: "android" }),
    );
    const androidDevice = await grantedDevice(android);
    const androidParams = receivedAllocate(android, 2);

    expect(androidAnswer.result).toMatchObject({ data: { lease: { leaseId: hex(2) } }, ok: true });
    expect(androidParams["serial"]).toBe(androidDevice.address);
    expect(androidParams["serial"]).not.toBe(androidDevice.driverDeviceId);
    expect(androidParams).not.toHaveProperty("udid");
  });

  it("with every matching device leased, allocate waits, and is granted and answered once that device is released and reclaimed", async () => {
    const rig = await setUp({ maxRunning: 1 });
    expect((await envelopeOf(await allocate(rig, 1))).result).toMatchObject({ ok: true });

    const second = track(allocate(rig, 2, {}, { token: secrets.two }));
    await expect
      .poll(async () => (await waiting(rig)).map((request) => request.requesterId))
      .toEqual([hex(2)]);
    expect(second.done()).toBe(false);

    await release(rig, 1);
    const answer = await envelopeOf(await second.promise);

    expect(answer.result).toMatchObject({ data: { lease: { leaseId: hex(2) } }, ok: true });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(2)]);
  });

  it("a CLI that hangs up while its allocate waits, and one that hangs up before simlock admitted the request, leave simlock's queue, and neither request is granted when a device frees", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1);
    const hangUp = new AbortController();
    const second = track(allocate(rig, 2, {}, { signal: hangUp.signal, token: secrets.two }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    hangUp.abort();
    await second.promise.catch(() => undefined);
    await expect.poll(async () => (await waiting(rig)).length).toBe(0);
    await release(rig, 1);
    await sleep(50);

    expect(await leases(rig)).toEqual([]);
    expect(allocatesReceived(rig, 2)).toEqual([]);

    const slow = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          ...phoneModels,
          availableOsVersions: ["26.5"],
          clock,
          knownModels: ["iPhone 16"],
          latencyMs: { listManaged: 30_000 },
          platform: "ios",
        }),
      ],
      slowStart: true,
    });
    const early = new AbortController();
    const parked = track(
      fetch(`${slow.origin}/v1/agent-device/rpc`, {
        body: rpcBody("agent_device.lease.allocate", allocateParams(3)),
        headers: { authorization: `Bearer ${secrets.one}`, "content-type": "application/json" },
        method: "POST",
        signal: early.signal,
      }),
    );
    await sleep(100);
    expect(parked.done()).toBe(false);
    early.abort();
    await parked.promise.catch(() => undefined);
    await sleep(50);
    slow.clock.advance(30_000);
    const ready = { ...slow, daemon: await slow.started };
    await sleep(100);

    expect(await leases(ready)).toEqual([]);
    expect(await requestedSpecs(ready, hex(3))).toEqual([]);
    expect(allocatesReceived(ready, 3)).toEqual([]);
  });

  it("a CLI that hangs up after device work started for it gets no agent-device lease: the grant that lands later is released at once and never reaches the agent-device daemon; when that device work fails and the request goes back to the queue, it is never granted", async () => {
    const slowDevice = (clock: FakeClock) => [
      new FakeDriver({
        ...phoneModels,
        availableOsVersions: ["26.5"],
        clock,
        knownModels: ["iPhone 16"],
        latencyMs: { makeReady: 10_000 },
        platform: "ios",
      }),
    ];
    const rig = await setUp({ drivers: slowDevice });
    const hangUp = new AbortController();
    const first = track(allocate(rig, 1, {}, { signal: hangUp.signal }));
    await sleep(50);
    expect(first.done()).toBe(false);
    await expect
      .poll(() => rig.driver.calls.some((call) => call.operation === "makeReady"))
      .toBe(true);

    hangUp.abort();
    await first.promise.catch(() => undefined);
    await advance(rig, 12_000);
    await expect.poll(async () => (await leases(rig)).length).toBe(0);

    expect(allocatesReceived(rig, 1)).toEqual([]);

    const failing = await setUp({ drivers: slowDevice });
    failing.driver.failOn("makeReady", 1, new Error("boot failed"));
    const abort = new AbortController();
    const second = track(allocate(failing, 2, {}, { signal: abort.signal }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect
      .poll(() => failing.driver.calls.some((call) => call.operation === "makeReady"))
      .toBe(true);
    abort.abort();
    await second.promise.catch(() => undefined);

    await advance(failing, 15_000);

    await expect.poll(async () => (await waiting(failing)).length).toBe(0);
    expect(await leases(failing)).toEqual([]);
    expect(allocatesReceived(failing, 2)).toEqual([]);
  });

  it("`DELETE /v1/lease-requests/:id` for the front's waiting request answers the allocate `refused by simlock:` with simlock's message, and nothing is leased", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, {}, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);
    const [request] = await waiting(rig);

    const cancelled = await fetch(`${rig.origin}/v1/lease-requests/${request?.id}`, {
      headers: { authorization: `Bearer ${secrets.one}` },
      method: "DELETE",
    });
    const answer = await envelopeOf(await second.promise);

    expect(cancelled.status).toBe(204);
    expect(answer.error?.message).toMatch(/^refused by simlock: .+/);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(await waiting(rig)).toEqual([]);
  });

  it("stopping the daemon while an allocate waits ends with no simlock lease, and the lease request it waited on is cancelled, not open, in state.json", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, {}, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    await rig.daemon.stop("test");
    await second.promise.catch(() => undefined);

    const state = await rig.filesystem.readFile(rig.statePath);
    expect(second.done()).toBe(true);
    expect(state).toContain(hex(1));
    const records = JSON.parse(state ?? "{}") as {
      leaseRequests?: readonly { leaseId?: string; state: string }[];
    };
    expect(records.leaseRequests?.filter((record) => record.leaseId === hex(2))).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    expect(records.leaseRequests?.some((record) => record.state === "open")).toBe(false);
  });

  it("an allocate still waiting 330 s after the front admitted it answers `timed out waiting for a device; nothing was leased`, and simlock's queue is empty", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, { ttlMs: maxTtlMs }, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    await advance(rig, 329_000);
    expect(second.done()).toBe(false);
    await advance(rig, 1_000);
    const answer = await envelopeOf(await second.promise);

    expect(answer.error).toMatchObject(refusal(queueTimeoutMessage, "COMMAND_FAILED"));
    expect(await waiting(rig)).toEqual([]);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("an agent-device allocate that answers an error, and a grant that names no device address, release the simlock lease, and the CLI gets the error", async () => {
    const rig = await setUp();
    rig.fake.failNextAllocate({ code: "NO_DEVICE", message: "no such device" });

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error).toMatchObject({
      data: { code: "NO_DEVICE", message: "no such device" },
      message: "no such device",
    });
    await expect.poll(async () => (await leases(rig)).length).toBe(0);

    class NoAddressDriver extends FakeDriver {
      override async makeReady(...arguments_: Parameters<FakeDriver["makeReady"]>) {
        const ready = await super.makeReady(...arguments_);
        return { ...ready, address: undefined as unknown as string };
      }
    }
    const bare = await setUp({
      drivers: (clock) => [
        new NoAddressDriver({
          ...phoneModels,
          availableOsVersions: ["26.5"],
          clock,
          knownModels: ["iPhone 16"],
          platform: "ios",
        }),
      ],
    });

    const noAddress = await envelopeOf(await allocate(bare, 2));

    expect(noAddress.error?.data?.code).toBe("COMMAND_FAILED");
    await expect.poll(async () => (await leases(bare)).length).toBe(0);
    expect(allocatesReceived(bare, 2)).toEqual([]);
  });

  it("an agent-device allocate with no usable reply (an unreachable daemon, a non-JSON body) releases the simlock lease and answers `COMMAND_FAILED`; when agent-device answers the follow-up release with a scope error, the simlock lease stays until its TTL, and when it answers `LEASE_NOT_FOUND`, the simlock lease is released", async () => {
    const rig = await setUp();
    expect((await envelopeOf(await allocate(rig, 1))).result).toMatchObject({ ok: true });
    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await allocate(rig, 2));
    rig.fake.setUnreachable(false);

    expect(unreachable.error?.data?.code).toBe("COMMAND_FAILED");
    await expect.poll(async () => (await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    const notJson = await envelopeOf(await allocate(rig, 3));

    expect(notJson.error?.data?.code).toBe("COMMAND_FAILED");
    await expect.poll(async () => (await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    rig.fake.failNextRelease({ code: "UNAUTHORIZED", message: "lease scope mismatch" });
    const kept = await envelopeOf(await allocate(rig, 4, { ttlMs: 60_000 }));

    expect(kept.error?.data?.code).toBe("COMMAND_FAILED");
    expect((await leases(rig)).map((lease) => lease.id)).toContain(hex(4));
    await advance(rig, 61_000);
    await expect
      .poll(async () => (await leases(rig)).map((lease) => lease.id))
      .not.toContain(hex(4));
  });

  it("the follow-up release after an allocate with no usable reply carries the allocate's runId, leaseProvider and clientId and not its deviceKey", async () => {
    const rig = await setUp();
    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");

    const answer = await envelopeOf(await allocate(rig, 1, { deviceKey: "saved-device" }));

    expect(answer.error?.data?.code).toBe("COMMAND_FAILED");
    const params = rig.fake.rpcRequests("agent_device.lease.release")[0]?.params;
    expect(params).toMatchObject({ ...scope, leaseId: hex(1) });
    expect(params).not.toHaveProperty("deviceKey");
  });

  it("a lease whose allocate reply names device key `ios:mobile:<id>` keeps it: a command naming that lease with that `deviceKey` reaches agent-device", async () => {
    const rig = await setUp();
    const key = "ios:mobile:00008110-001A2B3C4D5E";
    rig.fake.nameDeviceKeyInNextReply(key);
    await granted(rig, 1);

    await forwarded(rig, () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: key } }));
  });

  it("an allocate reply whose lease `deviceKey` is over 128 characters still succeeds and keeps the lease, with the device key left unset: no release is sent and a command naming the lease with a `deviceKey` is refused", async () => {
    const rig = await setUp();
    rig.fake.nameDeviceKeyInNextReply("x".repeat(129));

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error).toBeUndefined();
    expect(rig.fake.rpcRequests("agent_device.lease.release")).toHaveLength(0);
    expect((await leases(rig)).map((lease) => lease.id)).toContain(hex(1));
    await refused(
      rig,
      () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: "x".repeat(129) } }),
      simlockPicks,
    );
  });

  it("a CLI that hangs up while agent-device makes its lease leaves neither lease: the agent-device lease is released with the reply's scope, then the simlock lease; when that release fails, the simlock lease stays until its TTL", async () => {
    const rig = await setUp();
    rig.fake.holdAllocate();
    rig.fake.nameDeviceKeyInNextReply("device-key-1");
    const hangUp = new AbortController();
    const first = track(allocate(rig, 1, {}, { signal: hangUp.signal }));
    await sleep(50);
    expect(first.done()).toBe(false);
    await expect.poll(() => allocatesReceived(rig, 1).length).toBe(1);

    hangUp.abort();
    await first.promise.catch(() => undefined);
    await sleep(50);
    rig.fake.letAllocateGo();

    await expect.poll(async () => (await leases(rig)).length).toBe(0);
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(rig.fake.rpcRequests("agent_device.lease.release")[0]?.params).toMatchObject({
      ...scope,
      deviceKey: "device-key-1",
    });

    rig.fake.holdAllocate();
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });
    const abort = new AbortController();
    const second = track(allocate(rig, 2, { ttlMs: 60_000 }, { signal: abort.signal }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect.poll(() => allocatesReceived(rig, 2).length).toBe(1);
    abort.abort();
    await second.promise.catch(() => undefined);
    await sleep(50);
    rig.fake.letAllocateGo();
    await expect.poll(() => rig.fake.rpcRequests("agent_device.lease.release").length).toBe(2);

    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(2)]);
    await advance(rig, 61_000);
    await expect.poll(async () => (await leases(rig)).length).toBe(0);
  });

  it("release goes to the agent-device daemon first, then frees the simlock lease and the device; a release after `close`, which already freed the simlock lease, reaches the daemon with no lease held and is answered `released: false`", async () => {
    const rig = await setUp();
    let heldAtDaemonRelease: readonly string[] = [];
    rig.fake.onRelease = async () => {
      heldAtDaemonRelease = (await leases(rig)).map((lease) => lease.id);
    };
    await granted(rig, 1);

    const released = await envelopeOf(await release(rig, 1));

    expect(released.result).toMatchObject({ ok: true, released: true });
    expect(heldAtDaemonRelease).toEqual([hex(1)]);
    expect(await leases(rig)).toEqual([]);
    await expect
      .poll(async () => (await devices(rig)).map((device) => device.state))
      .toEqual(["ready"]);

    await granted(rig, 2);
    await command(rig, "close", 2);
    await expect.poll(async () => leases(rig)).toEqual([]);
    const afterClose = await envelopeOf(await release(rig, 2));

    expect(afterClose.result).toMatchObject({ ok: true, released: false });
    expect(heldAtDaemonRelease).toEqual([]);
    expect(await leases(rig)).toEqual([]);
    await expect
      .poll(async () => (await devices(rig)).map((device) => device.state))
      .toEqual(["ready"]);
  });

  const ended = [{ leaseId: hex(1), outcome: "released" }];
  it.each([
    [
      "a `close` that succeeds, in `data`",
      { result: { data: { endedLeases: ended } } },
      (rig: Rig) => command(rig, "close", 1),
    ],
    [
      "a `close` that fails, in `error.details`",
      { error: { data: { details: { endedLeases: ended } } } },
      (rig: Rig) => {
        rig.fake.failNextCommand({ code: "COMMAND_FAILED", message: "close failed" });
        return command(rig, "close", 1);
      },
    ],
    [
      "a `batch` with a close step, in `data` beside `results`",
      { result: { data: { endedLeases: ended, results: [] } } },
      (rig: Rig) => batch(rig, 1, [{ command: "snapshot" }, { command: "close" }]),
    ],
  ] as const)(
    "%s: a command that ends the agent-device lease and names it in `endedLeases` releases the simlock lease and frees the device though the CLI sends no release, and a later heartbeat answers `LEASE_NOT_FOUND`",
    async (_case, reply, send) => {
      const rig = await setUp();
      await granted(rig, 1);

      expect(await envelopeOf(await send(rig))).toMatchObject(reply);
      await expect.poll(async () => listed(rig)).toEqual([]);
      await expect
        .poll(async () => (await devices(rig)).map((device) => device.state))
        .toEqual(["ready"]);
      expectLeaseGone(await envelopeOf(await heartbeat(rig, 1)), "LEASE_NOT_FOUND");
    },
  );

  // why: agent-device 0.21.28 streams a reply when the CLI runs without --json; the JSON-RPC answer is the `response` of a `type: "response"` line, not the line itself.
  it("a close streamed in agent-device's own line shape releases the simlock lease", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const chunks = [
      `${JSON.stringify({ event: { kind: "command", message: "Closing" }, type: "progress" })}\n`,
      `${JSON.stringify({
        response: {
          id: "x",
          jsonrpc: "2.0",
          result: { data: { endedLeases: ended, session: "t:adc-1" }, ok: true },
        },
        type: "response",
      })}\n`,
    ];
    rig.fake.streamNextCommand(chunks);

    const streamed = await command(rig, "close", 1);

    expect(await streamed.text()).toBe(chunks.join(""));
    await expect.poll(async () => listed(rig), { timeout: 3_000 }).toEqual([]);
    await expect
      .poll(async () => (await devices(rig)).map((device) => device.state))
      .toEqual(["ready"]);
  });

  it("a release the agent-device daemon fails keeps the simlock lease and answers the daemon's error", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "daemon could not release" });

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon could not release",
    });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("a release after `simlock release --all` ended the simlock lease answers the daemon's reply", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    expect(await leases(rig)).toEqual([]);

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.result).toMatchObject({ ok: true, released: false });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
  });

  it("a release from a second token naming the first token's lease ID leaves the first token's simlock lease in place", async () => {
    const rig = await setUp();
    await granted(rig, 1);

    const answer = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(answer.error).toBeDefined();
    expect(rig.fake.rpcRequests("agent_device.lease.release")).toHaveLength(1);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(rig.fake.leases.has(hex(1))).toBe(true);

    rig.fake.letAnyTenantRelease();
    const crossed = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(crossed.result).toMatchObject({ ok: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("a command's reply, a streamed progress body included, reaches the CLI unchanged, and a CLI that hangs up during it aborts the request the agent-device daemon was answering", async () => {
    const rig = await setUp();
    const chunks = [
      '{"type":"progress","event":{"kind":"command","message":"one"}}\n',
      '{"type":"progress","event":{"kind":"command","message":"two"}}\n',
      '{"type":"response","response":{"jsonrpc":"2.0","id":"x","result":{"ok":true,"data":{}}}}\n',
    ];
    rig.fake.streamNextCommand(chunks);

    const streamed = await command(
      rig,
      "install",
      undefined,
      {},
      { meta: { uploadedArtifactId: "art-1" } },
    );

    expect(await streamed.text()).toBe(chunks.join(""));

    const plain = await envelopeOf(await command(rig, "snapshot", undefined));
    expect(plain.result).toMatchObject({ command: "snapshot", ok: true });

    rig.fake.holdCommand();
    const hangUp = new AbortController();
    const held = track(command(rig, "snapshot", undefined, { signal: hangUp.signal }));
    await sleep(50);
    expect(held.done()).toBe(false);
    await expect.poll(() => rig.fake.rpcRequests("agent_device.command").length).toBe(3);
    hangUp.abort();
    await held.promise.catch(() => undefined);

    await expect.poll(() => rig.fake.abortedCommands).toEqual(["snapshot"]);
  });

  it("an upload preflight answers a ticket URL under `/v1/agent-device/upload/direct/` on simlock's own origin, carrying the agent's own simlock token, and a `PUT` to it reaches the agent-device daemon", async () => {
    const rig = await setUp();

    const preflight = await send(rig, "/upload/preflight", { body: "{}" });
    expect(preflight.status).toBe(200);
    const ticket = (
      (await preflight.json()) as { upload: { url: string; headers: Record<string, string> } }
    ).upload;

    expect(ticket.url.startsWith(`${rig.origin}/v1/agent-device/upload/direct/`)).toBe(true);
    const carried = Object.entries(ticket.headers).find(
      ([name]) => name.toLowerCase() === "authorization",
    );
    expect(carried?.[1]).toBe(`Bearer ${secrets.one}`);

    const put = await fetch(ticket.url, {
      body: "artifact bytes",
      headers: ticket.headers,
      method: "PUT",
    });

    expect(put.status).toBe(200);
    expect(rig.fake.uploads).toEqual(["artifact bytes"]);
  });

  it("on a worker, an `x-agent-device-lease-id` header naming another token's lease, a malformed one and no header are each forwarded, as today", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const other = { "x-agent-device-lease-id": hex(1) };
    const malformed = { "x-agent-device-lease-id": "NOT-A-LEASE-ID".repeat(4) };
    const preflights = () =>
      rig.fake.requests.filter((request) => request.path === "/upload/preflight").length;

    const answers: Response[] = [];
    for (const headers of [other, malformed, {}]) {
      const before = preflights();
      const answer = await send(rig, "/upload/preflight", {
        body: "{}",
        headers,
        token: secrets.two,
      });
      answers.push(answer);
      expect(preflights()).toBe(before + 1);
    }

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
  });

  it("an `/rpc` body over 1 MiB, one that is not JSON, a JSON array, and an object with no `method` are each refused with their message and `id: null`, also while agent-device is unavailable, and neither simlock nor the agent-device daemon sees them", async () => {
    const rig = await setUp();
    expect((await command(rig, "snapshot", undefined)).status).toBe(200);
    const oneMiB = 1024 * 1024;
    const bodies: readonly [string, string][] = [
      [
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "agent_device.command",
          params: { pad: "x".repeat(oneMiB) },
        }),
        "refused: request body over 1 MiB",
      ],
      ["{ not json", "refused: send one JSON-RPC request"],
      ["[]", "refused: send one JSON-RPC request"],
      [JSON.stringify({ id: 3, jsonrpc: "2.0" }), "refused: send one JSON-RPC request"],
    ];

    for (const unavailable of [false, true]) {
      rig.fake.setUnavailable(unavailable ? "starting" : undefined);
      const receivedBefore = rig.fake.requests.length;
      for (const [body, message] of bodies) {
        const answer = await envelopeOf(await send(rig, "/rpc", { body }));
        expect(answer).toMatchObject({ error: refusal(message), id: null, jsonrpc: "2.0" });
      }
      expect(rig.fake.requests).toHaveLength(receivedBefore);
    }
    expect(await waiting(rig)).toEqual([]);
    expect(await leases(rig)).toEqual([]);
  });

  it("a heartbeat reaches the agent-device daemon before simlock, carrying `ttlMs` equal to the ceiling, and once it answers, the simlock lease's deadline is now plus the CLI's `ttlMs`", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const allocated = await deadlineOf(rig, 1);
    let deadlineAtDaemon: number | undefined;
    rig.fake.onHeartbeat = async () => {
      deadlineAtDaemon = await deadlineOf(rig, 1);
    };
    await advance(rig, 10_000);

    const answer = await envelopeOf(
      await heartbeat(rig, 1, { ttlMs: 120_000 }, { token: secrets.one }),
    );

    expect(answer.result).toMatchObject({ ok: true });
    expect(deadlineAtDaemon).toBe(allocated);
    expect(rig.fake.rpcRequests("agent_device.lease.heartbeat")[0]?.params).toMatchObject({
      ...scope,
      leaseId: hex(1),
      ttlMs: rig.fake.leaseMaxTtlMs,
    });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 120_000);
  });

  it.each([
    { cap: undefined, expected: 300_000, row: "300000 with no cap", sent: 300_000 },
    { cap: 10_000, expected: 10_000, row: "300000 with cap 10000", sent: 300_000 },
    { cap: 600_000, expected: 300_000, row: "300000 with cap 600000", sent: 300_000 },
    { cap: 10_000, expected: 10_000, row: "none with cap 10000", sent: undefined },
    { cap: undefined, expected: defaultTtlMs, row: "none with no cap", sent: undefined },
    { cap: undefined, expected: 5_000, row: "1 with no cap", sent: 1 },
  ])(
    "a CLI `ttlMs` of $row gives the simlock lease, its heartbeat renewal and its renewal interval a TTL of $expected ms",
    async ({ cap, expected, sent }) => {
      const rig = await setUp(cap === undefined ? {} : { leaseTtlCapMs: cap });
      const ttl = expected as number;
      await granted(rig, 1, { ttlMs: sent });
      expect((await leases(rig))[0]?.ttlMs).toBe(ttl);
      await advance(rig, 1_000);

      const answer = await envelopeOf(
        await heartbeat(rig, 1, sent === undefined ? {} : { ttlMs: sent }),
      );

      expect(answer.result).toMatchObject({ ok: true });
      expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + ttl);
      const settled = await deadlineOf(rig, 1);
      await runningCommand(rig, 1);
      await advance(rig, Math.floor(ttl / 3) - 700, 500);
      expect(await deadlineOf(rig, 1)).toBe(settled);
      await advance(rig, 1_400, 500);
      const renewed = (await deadlineOf(rig, 1)) as number;
      expect(renewed).toBeGreaterThan(settled as number);
      expect(renewed - (settled as number)).toBeLessThanOrEqual(ttl / 3 + 700);
    },
    60_000,
  );

  it("a heartbeat with a longer `ttlMs` than the allocate's moves the deadline to now plus that TTL, and a following heartbeat with no `ttlMs` renews with it too", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    await advance(rig, 5_000);

    await heartbeat(rig, 1, { ttlMs: 300_000 });

    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 300_000);
    await advance(rig, 20_000);

    await heartbeat(rig, 1);

    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 300_000);
    expect((await leases(rig))[0]?.ttlMs).toBe(300_000);
  });

  it("after the agent's own `simlock lease renew` with a longer TTL, a heartbeat and a running command's renewals leave that later deadline in place", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    await rig.daemon.dispatch(
      "lease.renew",
      { leaseId: hex(1), ttlMs: 900_000 },
      sessionFor(principals.one),
    );
    const later = await deadlineOf(rig, 1);
    expect(later).toBe(rig.clock.now() + 900_000);
    await advance(rig, 5_000);

    await heartbeat(rig, 1, { ttlMs: 120_000 });

    expect(await deadlineOf(rig, 1)).toBe(later);
    const running = await runningCommand(rig, 1);
    await advance(rig, 130_000, 5_000);
    expect(await deadlineOf(rig, 1)).toBe(later);
    rig.fake.releaseCommand();
    await running.promise;
    await expect.poll(() => running.done()).toBe(true);
    expect(await deadlineOf(rig, 1)).toBe(later);
  });

  it("a heartbeat the agent-device daemon cannot answer returns that error and leaves the simlock lease's deadline where it was", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const before = await deadlineOf(rig, 1);
    await advance(rig, 10_000);
    rig.fake.failNextHeartbeat({ code: "COMMAND_FAILED", message: "daemon is busy" });

    const failed = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

    expect(failed.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon is busy",
    });
    expect(await deadlineOf(rig, 1)).toBe(before);

    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

    expect(unreachable.error).toBeDefined();
    expect(unreachable.result).toBeUndefined();
    expect(await deadlineOf(rig, 1)).toBe(before);

    rig.fake.setUnreachable(false);
    await heartbeat(rig, 1, { ttlMs: 60_000 });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 60_000);
  });

  it("with no cap set, a heartbeat whose `ttlMs` is above `lease.maxTtlMs` answers `COMMAND_FAILED` with simlock's `BAD_REQUEST` message and leaves the deadline where it was, and a following heartbeat with a valid `ttlMs` renews the lease", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const before = await deadlineOf(rig, 1);
    await advance(rig, 10_000);
    const message = await renewMessage(rig, hex(1), maxTtlMs + 1);

    const refused = await envelopeOf(await heartbeat(rig, 1, { ttlMs: maxTtlMs + 1 }));

    expect(refused.error).toMatchObject({ data: { code: "COMMAND_FAILED" }, message });
    expect(await deadlineOf(rig, 1)).toBe(before);

    const renewed = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 120_000 }));

    expect(renewed.result).toMatchObject({ ok: true });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 120_000);
    expect((await leases(rig))[0]?.ttlMs).toBe(120_000);
  });

  it("a heartbeat for a lease the agent released through the front answers `LEASE_NOT_FOUND`, and a following allocate gets a new lease", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await release(rig, 1);

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expectLeaseGone(answer, "LEASE_NOT_FOUND");
    expect(await listed(rig)).toEqual([]);

    await granted(rig, 2);

    expect(await listed(rig)).toEqual([hex(2)]);
  });

  it("one TTL after the agent's release, a heartbeat for that lease answers `LEASE_ENDED_BY_HOST`", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    await release(rig, 1);
    expectLeaseGone(await envelopeOf(await heartbeat(rig, 1)), "LEASE_NOT_FOUND");
    await advance(rig, 61_000, 5_000);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
  });

  it.each([
    [
      "`simlock release --all`",
      5_000,
      async (rig: Rig) => {
        await rig.daemon.dispatch("lease.release-all", {}, adminSession);
      },
    ],
    [
      "expiry",
      5_000,
      async (rig: Rig) => {
        await advance(rig, 6_000);
      },
    ],
    [
      "the device is lost",
      600_000,
      async (rig: Rig) => {
        rig.driver.setManagedReality({ devices: [], processes: [] });
        await advance(rig, 120_000, 10_000);
      },
    ],
  ])(
    "after %s, a heartbeat for the lease answers `LEASE_ENDED_BY_HOST` with the message and reason, and makes no new simlock lease",
    async (_cause, ttl, end) => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: ttl });
      await end(rig);
      await expect.poll(() => listed(rig)).toEqual([]);

      const answer = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 5_000 }));

      expectEndedBySimlock(answer);
      expect(await listed(rig)).toEqual([]);
    },
  );

  it.each(["LEASE_NOT_FOUND", "LEASE_EXPIRED", "LEASE_REVOKED"] as const)(
    "a heartbeat the agent-device daemon answers `%s`, for a lease simlock holds and the agent did not release, releases the simlock lease and answers `LEASE_ENDED_BY_HOST`",
    async (reason) => {
      const rig = await setUp();
      await granted(rig, 1);
      rig.fake.loseLease(hex(1), reason);
      expect(await listed(rig)).toEqual([hex(1)]);

      const answer = await envelopeOf(await heartbeat(rig, 1));

      expectEndedBySimlock(answer);
      expect(await listed(rig)).toEqual([]);
    },
  );

  it("a heartbeat naming a lease ID the front map lacks, which simlock holds for this token's principal: when agent-device answers a lease-gone reason, the simlock lease is released; when agent-device still holds the lease, it is released with the heartbeat's scope first, then the simlock lease; when agent-device is unreachable, neither lease is touched; each answers as in the table", async () => {
    const first = await setUp();
    await granted(first, 1);
    await granted(first, 2);
    await granted(first, 3);
    const rig = await first.restart();
    expect(await listed(rig)).toEqual([hex(1), hex(2), hex(3)]);

    rig.fake.loseLease(hex(1), "LEASE_EXPIRED");
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(await listed(rig)).toEqual([hex(2), hex(3)]);

    let heldAtDaemonRelease: readonly string[] = [];
    rig.fake.onRelease = async () => {
      heldAtDaemonRelease = await listed(rig);
    };
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 2)));
    expect(heldAtDaemonRelease).toEqual([hex(2), hex(3)]);
    expect(rig.fake.rpcRequests("agent_device.lease.release")[0]?.params).toMatchObject(scope);
    expect(rig.fake.leases.has(hex(2))).toBe(false);
    expect(await listed(rig)).toEqual([hex(3)]);

    const before = await deadlineOf(rig, 3);
    await advance(rig, 10_000);
    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await heartbeat(rig, 3));
    rig.fake.setUnreachable(false);

    expect(unreachable.error).toBeDefined();
    expect(unreachable.error?.data?.code).not.toBe("UNAUTHORIZED");
    expect(await listed(rig)).toEqual([hex(3)]);
    expect(await deadlineOf(rig, 3)).toBe(before);
    expect(rig.fake.leases.has(hex(3))).toBe(true);
  });

  it("a heartbeat from a second token naming the first token's lease ID answers `LEASE_ENDED_BY_HOST`, and the first token's lease is neither released nor renewed", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const before = await deadlineOf(rig, 1);
    await advance(rig, 10_000);

    const answer = await envelopeOf(
      await heartbeat(rig, 1, { ttlMs: 60_000 }, { token: secrets.two }),
    );

    expectEndedBySimlock(answer);
    expect(await listed(rig)).toEqual([hex(1)]);
    expect(await deadlineOf(rig, 1)).toBe(before);
    expect(rig.fake.leases.has(hex(1))).toBe(true);

    const own = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

    expect(own.result).toMatchObject({ ok: true });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 60_000);
  });

  it("a heartbeat naming a lease ID the front map lacks, when the agent-device daemon fails to release its lease, answers that error and leaves the simlock lease in place", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig = await first.restart();
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "daemon cannot release" });

    const failed = await envelopeOf(await heartbeat(rig, 1));

    expect(failed.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon cannot release",
    });
    expect(await listed(rig)).toEqual([hex(1)]);
  });

  it("a heartbeat for a lease the agent-device daemon lost, when simlock cannot release its lease, answers `COMMAND_FAILED` with simlock's message and marks nothing, and the next heartbeat releases it and answers `LEASE_ENDED_BY_HOST`", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.loseLease(hex(1), "LEASE_EXPIRED");
    const tap = tapDispatch(rig);
    tap.rejectNext("lease.release");

    const failed = await envelopeOf(await heartbeat(rig, 1));

    expect(failed.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "simlock could not do that",
    });
    expect(await listed(rig)).toEqual([hex(1)]);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(await listed(rig)).toEqual([]);
  });

  it.each([0, -5, "soon", true])(
    "a heartbeat with a `ttlMs` of %j is refused with `ttlMs must be a positive number of milliseconds`, and neither daemon is reached",
    async (ttlMs) => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      const before = await deadlineOf(rig, 1);
      const received = heartbeatsReceived(rig);
      await advance(rig, 10_000);

      const refused = await envelopeOf(await heartbeat(rig, 1, { ttlMs }));

      expect(refused.error).toMatchObject(
        refusal("refused: ttlMs must be a positive number of milliseconds"),
      );
      expect(heartbeatsReceived(rig)).toBe(received);
      expect(await deadlineOf(rig, 1)).toBe(before);
    },
  );

  it("after a heartbeat answered `LEASE_ENDED_BY_HOST` because simlock ended the lease, the next heartbeat answers it again and the agent-device daemon receives nothing for it", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    const received = rig.fake.requests.length;

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));

    expect(rig.fake.requests).toHaveLength(received);
  });

  it("a lease released through the front while a command runs stays ended by the agent: a renewal that fires between the simlock release and the end of the agent's release, and the command's final renewal, mark nothing, and the next heartbeat still answers `LEASE_NOT_FOUND`", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const running = await runningCommand(rig, 1);
    const tap = tapDispatch(rig);
    tap.afterNext("lease.release", async () => {
      await advance(rig, 12_000, 4_000);
    });

    rig.fake.answerReleaseWhileCommandsRun();

    const released = await envelopeOf(await release(rig, 1));
    rig.fake.releaseCommand();
    await running.promise;

    expect(released.result).toMatchObject({ ok: true, released: true });
    expect(await listed(rig)).toEqual([]);
    expectLeaseGone(await envelopeOf(await heartbeat(rig, 1)), "LEASE_NOT_FOUND");
  });

  it("after `simlock release --all`, the agent's release answers success, a heartbeat for the old ID then answers `LEASE_ENDED_BY_HOST` (ended by simlock, not `LEASE_NOT_FOUND`), and the next allocate gets a new lease; an entry found unlisted by another allocate's check answers its next heartbeat `LEASE_ENDED_BY_HOST` without reaching the agent-device daemon", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);

    const released = await envelopeOf(await release(rig, 1));

    expect(released.result).toMatchObject({ ok: true });
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    await granted(rig, 2);
    expect(await listed(rig)).toEqual([hex(2)]);

    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    await advance(rig, 125_000, 25_000);
    await granted(rig, 3);
    const received = heartbeatsReceived(rig);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 2)));
    expect(heartbeatsReceived(rig)).toBe(received);
  });

  it("after `simlock release --all` and the agent's release, a heartbeat answers `LEASE_ENDED_BY_HOST` without reaching the agent-device daemon, and a running command's renewals stop", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    rig.fake.answerReleaseWhileCommandsRun();
    await release(rig, 1);
    const received = rig.fake.requests.length;
    const tap = tapDispatch(rig);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    await advance(rig, 120_000, 10_000);

    expect(rig.fake.requests).toHaveLength(received);
    rig.fake.releaseCommand();
    expect(tap.operations).not.toContain("lease.list");
    expect(tap.operations).not.toContain("lease.renew");
  });

  it("a release for a lease simlock ended answers the agent-device daemon's reply as a success, and the agent-device lease is released", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    const tap = tapDispatch(rig);

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.result).toMatchObject({ ok: true, released: false });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(tap.operations).not.toContain("lease.release");
  });

  it("while a command for the lease runs longer than its TTL, the simlock lease is renewed every TTL/3 and does not expire", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    const tap = tapDispatch(rig);
    const deadlines: (number | undefined)[] = [];

    for (let tick = 0; tick < 9; tick += 1) {
      await advance(rig, 10_000, 5_000);
      deadlines.push(await deadlineOf(rig, 1));
    }

    expect(deadlines.every((deadline) => deadline !== undefined)).toBe(true);
    expect(deadlines.at(-1)).toBeGreaterThan(rig.clock.now());
    expect(new Set(deadlines).size).toBeGreaterThan(5);
    const checks = tap.operations.filter((name) => name === "lease.list").length;
    expect(checks).toBeGreaterThanOrEqual(8);
    expect(checks).toBeLessThanOrEqual(9);
  });

  it("a command that runs on past `lease.maxTtlMs` stops counting as running: its renewals stop, and the lease is no longer kept", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const tap = tapDispatch(rig);
    await runningCommand(rig, 1);

    await advance(rig, maxTtlMs + 400_000, 100_000);
    const calls = frontCalls(tap).length;
    await advance(rig, 1_000_000, 100_000);

    expect(calls).toBeGreaterThan(0);
    expect(frontCalls(tap)).toHaveLength(calls);
    expect(await listed(rig)).toEqual([]);
  }, 60_000);

  it("when the command ends, the lease is renewed once more, and its deadline does not move again over the next TTL", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const running = await runningCommand(rig, 1);
    await advance(rig, 25_000, 5_000);
    rig.fake.releaseCommand();
    await running.promise;

    await expect.poll(() => deadlineOf(rig, 1)).toBe(rig.clock.now() + 30_000);
    const final = await deadlineOf(rig, 1);
    await advance(rig, 29_000, 5_000);

    expect(await deadlineOf(rig, 1)).toBe(final);
  });

  it("a command agent-device answers with a 5xx reaches the CLI unchanged, and simlock logs a warning with that status and the start of the body", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.failNextCommandWithStatus(500, "snapshot runner crashed");

    const response = await command(rig, "snapshot", 1);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("snapshot runner crashed");
    await expect
      .poll(() => rig.logs.records.find((record) => record.message.includes("5xx"))?.fields)
      .toEqual({ body: "snapshot runner crashed", status: 500 });
  });

  it("a command that fails, and one whose CLI hangs up, stop the renewals the same way", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await granted(rig, 2, { ttlMs: 30_000 });
    rig.fake.failNextCommand({ code: "COMMAND_FAILED", message: "the command failed" });
    const failing = await runningCommand(rig, 1);
    await advance(rig, 15_000, 5_000);
    rig.fake.releaseCommand();
    const failure = await envelopeOf(await failing.promise);
    expect(failure.error).toMatchObject({ message: "the command failed" });
    await expect.poll(() => deadlineOf(rig, 1)).toBe(rig.clock.now() + 30_000);
    const afterFailure = await deadlineOf(rig, 1);

    const hangUp = new AbortController();
    const hanging = await runningCommand(rig, 2, { signal: hangUp.signal });
    await advance(rig, 15_000, 5_000);
    hangUp.abort();
    await hanging.promise.catch(() => undefined);
    await expect.poll(() => deadlineOf(rig, 2)).toBe(rig.clock.now() + 30_000);
    const afterHangUp = await deadlineOf(rig, 2);

    await advance(rig, 14_000, 2_000);
    expect(await deadlineOf(rig, 1)).toBe(afterFailure);
    expect(await deadlineOf(rig, 2)).toBe(afterHangUp);
  });

  it("with two overlapping commands on one lease, renewals go on until the second one ends", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const firstHangUp = new AbortController();
    await runningCommand(rig, 1, { signal: firstHangUp.signal });
    const second = await runningCommand(rig, 1);
    await advance(rig, 20_000, 5_000);
    firstHangUp.abort();

    await advance(rig, 40_000, 5_000);

    expect(await deadlineOf(rig, 1)).toBeGreaterThan(rig.clock.now());
    rig.fake.releaseCommand();
    await second.promise;
    await expect.poll(() => deadlineOf(rig, 1)).toBe(rig.clock.now() + 30_000);
    const final = await deadlineOf(rig, 1);
    await advance(rig, 29_000, 5_000);
    expect(await deadlineOf(rig, 1)).toBe(final);
  });

  it("a renewal that fails because simlock ended the lease mid-command stops the renewals, and the command's reply still reaches the CLI; a renewal refused for another reason is tried again at the next tick", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const tap = tapDispatch(rig);
    const running = await runningCommand(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    await advance(rig, 15_000, 5_000);
    const calls = frontCalls(tap).length;

    await advance(rig, 60_000, 5_000);

    expect(frontCalls(tap)).toHaveLength(calls);
    rig.fake.releaseCommand();
    const reply = await envelopeOf(await running.promise);
    expect(reply.result).toMatchObject({ command: "snapshot", ok: true });
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));

    await granted(rig, 2, { ttlMs: 30_000 });
    const started = await deadlineOf(rig, 2);
    await runningCommand(rig, 2);
    tap.rejectNext("lease.renew");
    await advance(rig, 11_000, 1_000);
    expect(await deadlineOf(rig, 2)).toBe(started);

    await advance(rig, 10_000, 1_000);

    expect(await deadlineOf(rig, 2)).toBeGreaterThan(started as number);
  });

  it('an agent release whose `lease.release` simlock refuses with another error clears "release in progress": the simlock lease stays, and a later renewal that finds it gone marks it ended by simlock', async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const tap = tapDispatch(rig);
    tap.rejectNext("lease.release");

    const refused = await envelopeOf(await release(rig, 1));

    expect(refused.result).toMatchObject({ ok: true });
    expect(await listed(rig)).toEqual([hex(1)]);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expectEndedBySimlock(answer);
    const received = heartbeatsReceived(rig);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(heartbeatsReceived(rig)).toBe(received);
  });

  it("a heartbeat lowering the TTL from 300 s to 5 s while a command runs re-arms the renewals, and the lease does not expire before the command ends", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 300_000 });
    await runningCommand(rig, 1);
    await advance(rig, 1_000);

    await heartbeat(rig, 1, { ttlMs: 5_000 });

    await advance(rig, 360_000, 2_000);
    expect(await listed(rig)).toEqual([hex(1)]);
    expect(await deadlineOf(rig, 1)).toBeGreaterThan(rig.clock.now());
  }, 60_000);

  it("a command naming a lease ID the front map does not hold for its token, or the lease of an ended entry, starts no renewals", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await granted(rig, 2, { ttlMs: 30_000 });
    await release(rig, 2);
    const tap = tapDispatch(rig);
    await runningCommand(rig, 1, { token: secrets.two });
    await runningCommand(rig, 2);

    await advance(rig, 40_000, 5_000);

    expect(frontCalls(tap)).toEqual([]);
    expect(await listed(rig)).toEqual([]);
  });

  it("a release through the front while a command runs stops that lease's renewals", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    await advance(rig, 5_000, 5_000);
    rig.fake.answerReleaseWhileCommandsRun();
    await release(rig, 1);
    const tap = tapDispatch(rig);

    await advance(rig, 60_000, 5_000);

    expect(frontCalls(tap)).toEqual([]);
    rig.fake.releaseCommand();
  });

  it("a lease whose CLI stops sending heartbeats expires one TTL after its last heartbeat, and its device can be leased again", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, { ttlMs: 30_000 });
    await advance(rig, 10_000, 5_000);
    await heartbeat(rig, 1, { ttlMs: 30_000 });
    await advance(rig, 29_000, 5_000);
    expect(await listed(rig)).toEqual([hex(1)]);

    await advance(rig, 3_000, 1_000);

    expect(await listed(rig)).toEqual([]);
    await granted(rig, 2);
    expect(await listed(rig)).toEqual([hex(2)]);
  });

  it("after the agent-device daemon restarts, the next heartbeat answers `LEASE_ENDED_BY_HOST` and releases the simlock lease", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.restart();

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expectEndedBySimlock(answer);
    expect(await listed(rig)).toEqual([]);
  });

  it("after a simlock daemon restart on the same data directory and the same `FakeDriver`, so the device keeps running and the test first sees the lease still listed, a heartbeat for a lease made before the restart answers `LEASE_ENDED_BY_HOST` and releases that simlock lease", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig = await first.restart();
    expect(await listed(rig)).toEqual([hex(1)]);

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expectEndedBySimlock(answer);
    expect(await listed(rig)).toEqual([]);
  });

  it("on a worker, after a simlock restart, a command for the old lease is not adopted and the next heartbeat answers `LEASE_ENDED_BY_HOST`, as today", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig = await first.restart();
    expect(await listed(rig)).toEqual([hex(1)]);

    const answer = await envelopeOf(await runCommand(rig, "snapshot", 1));
    // why: a worker has no map entry for the old lease and adopts nothing, so the command is forwarded as before and the heartbeat still ends the lease.
    expect(answer.error).toBeUndefined();
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(await listed(rig)).toEqual([]);
  });

  it("after the same restart (same `FakeDriver`, lease still listed), a release for a lease made before the restart answers the agent-device daemon's reply as a success and releases that simlock lease", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig = await first.restart();
    expect(await listed(rig)).toEqual([hex(1)]);

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.result).toMatchObject({ ok: true, released: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(await listed(rig)).toEqual([]);
  });

  it("a release with no map entry from a second token, naming the first token's lease ID, answers the agent-device daemon's reply and leaves the first token's simlock lease in place", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig = await first.restart();
    rig.fake.letAnyTenantRelease();

    const answer = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(answer.result).toMatchObject({ ok: true, released: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(await listed(rig)).toEqual([hex(1)]);
  });

  it("stopping the daemon while a command runs renews nothing once the stop began: the lease's deadline, read after a restart on the same data directory and the same `FakeDriver` (the lease still listed), is the one it had before the stop", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    await advance(rig, 12_000, 4_000);
    const before = await deadlineOf(rig, 1);
    const tap = tapDispatch(rig);

    const stopping = rig.daemon.stop("test");
    await advance(rig, 3_000, 1_000).catch(() => undefined);
    await stopping;
    expect(frontCalls(tap)).toEqual([]);
    const restarted = await rig.restart();

    expect(await listed(restarted)).toEqual([hex(1)]);
    expect(await deadlineOf(restarted, 1)).toBe(before);
  });

  it("`config.get` returns `capabilities.agent-device.leaseTtlCapMs` when it is set, and no `agentDevice` key", async () => {
    const rig = await setUp({ leaseTtlCapMs: 10_000 });

    const config = (await rig.daemon.dispatch("config.get", {}, adminSession)) as {
      readonly capabilities: Record<string, { readonly leaseTtlCapMs?: number }>;
    };

    expect(config.capabilities["agent-device"]?.leaseTtlCapMs).toBe(10_000);
    expect(config).not.toHaveProperty("agentDevice");
  });
});

const wipeOperations = new Set(["reclaim", "shutdown", "destroy"]);

function wipes(rig: Rig): number {
  return rig.driver.calls.filter((call) => wipeOperations.has(call.operation)).length;
}

function releasesReceived(rig: Rig) {
  return rig.fake.rpcRequests("agent_device.lease.release");
}

async function releaseAll(rig: Rig): Promise<void> {
  await rig.daemon.dispatch("lease.release-all", {}, adminSession);
}

// why: the wipe count the agent-device daemon saw when each release reached it says whether the wipe had started.
function watchWipes(rig: Rig): number[] {
  const seen: number[] = [];
  rig.fake.onRelease = async () => {
    seen.push(wipes(rig));
  };
  return seen;
}

function gateOnRelease(rig: Rig): () => void {
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  rig.fake.onRelease = () => held;
  return open;
}

async function plainLease(rig: Rig, requesterId: string): Promise<void> {
  await rig.daemon.dispatch(
    "lease.request",
    { model: "iPhone 16", platform: "ios", requesterId },
    sessionFor(principals.one),
  );
}

describe("simlock ending a simlock lease ends the agent-device session first", () => {
  it("release-all while an agent holds a device sends agent-device a release with the agent's principal as tenant and the run ID, lease provider and client ID of the allocate reply, plus its device key when the reply names one", async () => {
    const rig = await setUp();
    rig.fake.nameDeviceKeyInNextReply("device-key-1");
    await granted(rig, 1);

    await releaseAll(rig);

    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    const sent = releasesReceived(rig)[0];
    expect(sent?.tenant).toBe(principals.one);
    expect(sent?.params).toEqual({
      ...scope,
      deviceKey: "device-key-1",
      leaseId: hex(1),
      tenantId: principals.one,
    });

    const plain = await setUp();
    await granted(plain, 1);
    await releaseAll(plain);
    await expect.poll(() => releasesReceived(plain).length).toBe(1);
    expect(releasesReceived(plain)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
  });

  it("release-all while an agent holds a device whose allocate reply named an empty device key (under 1 character) sends agent-device a release without a `deviceKey`", async () => {
    const rig = await setUp();
    rig.fake.nameDeviceKeyInNextReply("");
    await granted(rig, 1);

    await releaseAll(rig);

    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    expect(releasesReceived(rig)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
  });

  it("an allocate reply whose device key is `ios:mobile:<id>` is recorded, and release-all sends that device key in the release", async () => {
    const rig = await setUp();
    rig.fake.nameDeviceKeyInNextReply("ios:mobile:00008110-001A2B3C4D5E");
    await granted(rig, 1);

    await releaseAll(rig);

    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    expect(releasesReceived(rig)[0]?.params).toMatchObject({
      deviceKey: "ios:mobile:00008110-001A2B3C4D5E",
      leaseId: hex(1),
    });
  });

  it("release-all: the driver's reclaim of the device starts only after agent-device answers that release", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const before = wipes(rig);
    const answer = gateOnRelease(rig);

    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    await sleep(50);

    expect(wipes(rig)).toBe(before);
    answer();
    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
  });

  it("a command still running at release-all finishes before the driver's reclaim of that device starts", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const running = await runningCommand(rig, 1);
    const before = wipes(rig);

    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    await sleep(50);

    expect(running.done()).toBe(false);
    expect(wipes(rig)).toBe(before);
    rig.fake.releaseCommand();
    await running.promise;
    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
  });

  it("while the host waits for that release, the device stays `reclaiming` and a second agent's open for the same model is not granted it", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1);
    await runningCommand(rig, 1);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    const second = track(allocate(rig, 2, {}, { token: secrets.two }));
    await sleep(100);

    expect((await devices(rig)).map((device) => device.state)).toEqual(["reclaiming"]);
    expect(second.done()).toBe(false);
    expect(allocatesReceived(rig, 2)).toEqual([]);
    rig.fake.releaseCommand();
    await second.promise;
  });

  it("once the reclaim ends, a second agent's open is granted that device", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1);
    const device = await grantedDevice(rig);
    await runningCommand(rig, 1);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    const second = track(allocate(rig, 2, {}, { token: secrets.two }));
    await sleep(50);
    expect(second.done()).toBe(false);

    rig.fake.releaseCommand();
    const answer = await envelopeOf(await second.promise);

    expect(answer.result).toMatchObject({ ok: true });
    expect(receivedAllocate(rig, 2)["udid"]).toBe(device.address);
  });

  it("a simlock lease that expires, one an operator releases with `lease.release`, and one whose device is lost each send agent-device the same release before the reclaim starts", async () => {
    const expiring = await setUp();
    const atRelease = watchWipes(expiring);
    await granted(expiring, 1, { ttlMs: 30_000 });
    const expiringBefore = wipes(expiring);
    await advance(expiring, 31_000, 5_000);
    await expect.poll(() => releasesReceived(expiring).length).toBe(1);
    expect(releasesReceived(expiring)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
    expect(atRelease).toEqual([expiringBefore]);

    const operator = await setUp();
    const atOperatorRelease = watchWipes(operator);
    await granted(operator, 1);
    const operatorBefore = wipes(operator);
    await operator.daemon.dispatch("lease.release", { leaseId: hex(1) }, adminSession);
    await expect.poll(() => releasesReceived(operator).length).toBe(1);
    expect(releasesReceived(operator)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
    expect(atOperatorRelease).toEqual([operatorBefore]);

    const lost = await setUp();
    const atLostRelease = watchWipes(lost);
    await granted(lost, 1);
    const lostBefore = wipes(lost);
    const reality = await lost.driver.listManaged();
    lost.driver.setManagedReality({
      ...reality,
      devices: reality.devices.map((device) => ({ ...device, runState: "stopped" as const })),
    });
    await advance(lost, 120_000, 15_000);
    await expect.poll(() => releasesReceived(lost).length).toBe(1);
    expect(releasesReceived(lost)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
    expect(atLostRelease).toEqual([lostBefore]);
  });

  it("after release-all, the agent's next heartbeat answers LEASE_ENDED_BY_HOST and makes no new simlock lease", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await releaseAll(rig);
    await expect.poll(() => rig.fake.leases.has(hex(1))).toBe(false);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));

    expect(await listed(rig)).toEqual([]);
  });

  it("the agent's own release, answered before simlock leasing ends the lease, leaves agent-device with no second release", async () => {
    const rig = await setUp();
    await granted(rig, 1);

    expect((await envelopeOf(await release(rig, 1))).result).toMatchObject({ released: true });
    await expect
      .poll(async () => (await devices(rig)).map((device) => device.state))
      .toEqual(["ready"]);
    await sleep(50);

    expect(releasesReceived(rig)).toHaveLength(1);
  });

  it.each(["an error", "a non-JSON body", "an unreachable daemon"])(
    "the agent's own release that agent-device answers with %s keeps the record: a later release-all sends the participant's release",
    async (failure) => {
      const rig = await setUp();
      await granted(rig, 1);
      if (failure === "an error") {
        rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });
      } else if (failure === "a non-JSON body") {
        rig.fake.answerNextReleaseWith("<html>bad gateway</html>");
      } else {
        rig.fake.setUnreachable(true);
      }
      await release(rig, 1);
      rig.fake.setUnreachable(false);
      expect(await listed(rig)).toEqual([hex(1)]);
      const before = releasesReceived(rig).length;

      await releaseAll(rig);

      await expect.poll(() => releasesReceived(rig).length).toBe(before + 1);
      expect(releasesReceived(rig).at(-1)?.params).toEqual({
        ...scope,
        leaseId: hex(1),
        tenantId: principals.one,
      });
    },
  );

  it("release-all while the agent's own release is in flight waits for it; when it succeeds, no second release is sent and the reclaim starts after it answers", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const before = wipes(rig);
    const answer = gateOnRelease(rig);
    const agentRelease = track(release(rig, 1));
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    await releaseAll(rig);
    await sleep(50);

    expect(releasesReceived(rig)).toHaveLength(1);
    expect(wipes(rig)).toBe(before);
    answer();
    await agentRelease.promise;
    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(releasesReceived(rig)).toHaveLength(1);
  });

  it("release-all while the agent's own release is in flight: when it fails, or its CLI hangs up, the participant sends its own release before the reclaim", async () => {
    const failing = await setUp();
    await granted(failing, 1);
    const failingBefore = wipes(failing);
    const answerFailing = gateOnRelease(failing);
    failing.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });
    const failedRelease = track(release(failing, 1));
    await expect.poll(() => releasesReceived(failing).length).toBe(1);
    await releaseAll(failing);
    const seenFailing = watchWipes(failing);

    answerFailing();
    await failedRelease.promise;

    await expect.poll(() => releasesReceived(failing).length).toBe(2);
    expect(seenFailing).toEqual([failingBefore]);
    await expect.poll(() => wipes(failing)).toBeGreaterThan(failingBefore);

    const hungUp = await setUp();
    await granted(hungUp, 1);
    const hungUpBefore = wipes(hungUp);
    const answerHungUp = gateOnRelease(hungUp);
    const hangUp = new AbortController();
    const abandoned = track(release(hungUp, 1, { signal: hangUp.signal }));
    await expect.poll(() => releasesReceived(hungUp).length).toBe(1);
    await releaseAll(hungUp);
    const seenHungUp = watchWipes(hungUp);
    hangUp.abort();
    await abandoned.promise.catch(() => undefined);
    await expect.poll(() => hungUp.fake.hungUpReleases).toEqual([hex(1)]);

    answerHungUp();

    await expect.poll(() => releasesReceived(hungUp).length).toBe(2);
    await expect.poll(() => seenHungUp).toEqual([hungUpBefore]);
    await expect.poll(() => wipes(hungUp)).toBeGreaterThan(hungUpBefore);
  });

  it("release-all while the agent's own release hangs: at lease.endWaitMs the wait ends and the reclaim starts", async () => {
    const rig = await setUp({ endWaitMs: 30_000 });
    await granted(rig, 1);
    const before = wipes(rig);
    rig.fake.hangNextRelease();
    const agentRelease = track(release(rig, 1));
    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    await releaseAll(rig);

    await advance(rig, 20_000, 5_000);
    expect(wipes(rig)).toBe(before);
    await advance(rig, 15_000, 5_000);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    void agentRelease;
  });

  it("the agent's release sent while the participant's release is in flight answers released false, and the reclaim starts once the participant's release answers", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await runningCommand(rig, 1);
    const before = wipes(rig);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    const agentRelease = await envelopeOf(await release(rig, 1));

    expect(agentRelease.result).toMatchObject({ ok: true, released: false });
    expect(wipes(rig)).toBe(before);
    rig.fake.releaseCommand();
    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
  });

  it("an agent holding two devices: release-all sends one release per lease, each with that lease's scope", async () => {
    const rig = await setUp();
    await granted(rig, 1, { clientId: "client-1", runId: "run-1" });
    await granted(rig, 2, { clientId: "client-2", runId: "run-2" });

    await releaseAll(rig);

    await expect.poll(() => releasesReceived(rig).length).toBe(2);
    const byLease = new Map(
      releasesReceived(rig).map((request) => [request.params?.["leaseId"], request.params]),
    );
    expect(byLease.get(hex(1))).toEqual({
      ...scope,
      clientId: "client-1",
      leaseId: hex(1),
      runId: "run-1",
      tenantId: principals.one,
    });
    expect(byLease.get(hex(2))).toEqual({
      ...scope,
      clientId: "client-2",
      leaseId: hex(2),
      runId: "run-2",
      tenantId: principals.one,
    });
  });

  it("a simlock lease from a plain client, with the edge on, ends with nothing sent to agent-device and its reclaim starts at once", async () => {
    const rig = await setUp();
    await plainLease(rig, "plain-1");
    const before = wipes(rig);

    await releaseAll(rig);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(releasesReceived(rig)).toEqual([]);
  });

  it("with capabilities.agent-device.enabled false, release-all reclaims at once, as today", async () => {
    const rig = await setUp({ enabled: false });
    await plainLease(rig, "plain-1");
    const before = wipes(rig);

    await releaseAll(rig);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(rig.fake.requests).toEqual([]);
  });

  it("agent-device answering the release with an error: the device's reclaim still starts", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const before = wipes(rig);
    const atRelease = watchWipes(rig);
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });

    await releaseAll(rig);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(releasesReceived(rig)).toHaveLength(1);
    expect(atRelease).toEqual([before]);
  });

  it("agent-device unreachable for the release: the device's reclaim still starts", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const before = wipes(rig);
    rig.fake.setUnreachable(true);

    await releaseAll(rig);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(rig.fake.refused).toContain("agent_device.lease.release");
  });

  it("after the agent-device daemon restarts, release-all gets released false from it and the reclaim starts at once", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.restart();
    const before = wipes(rig);

    await releaseAll(rig);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(releasesReceived(rig)).toHaveLength(1);
    expect(rig.fake.releaseReplies).toHaveLength(1);
    expect(JSON.parse(rig.fake.releaseReplies[0] ?? "")).toMatchObject({
      result: { ok: true, released: false },
    });
  });

  it("after a simlock daemon restart on the same data directory, a lease made before the restart ends at startup with nothing sent to agent-device", async () => {
    const first = await setUp();
    await granted(first, 1, { ttlMs: 30_000 });

    const rig = await first.restart(() => first.clock.advance(60_000));

    await expect.poll(async () => await listed(rig)).toEqual([]);
    expect(releasesReceived(rig)).toEqual([]);
  });

  it("an allocate reply with a run ID of 129 characters, and one with a client ID holding `/`: the front releases the agent-device lease and the simlock lease and answers a COMMAND_FAILED error", async () => {
    const rig = await setUp();
    const good = await envelopeOf(await allocate(rig, 1));
    expect(good.result).toMatchObject({ ok: true });
    await release(rig, 1);

    for (const [n, edit] of [
      [2, { runId: "r".repeat(129) }],
      [3, { clientId: "client/1" }],
    ] as const) {
      rig.fake.editNextAllocateReply(edit);

      const answer = await envelopeOf(await allocate(rig, n));

      expect(answer.error?.data?.code).toBe("COMMAND_FAILED");
      await expect.poll(async () => await listed(rig)).toEqual([]);
      expect(rig.fake.leases.has(hex(n))).toBe(false);
    }
  });

  it("a lease ended by `nuke` sends nothing to agent-device", async () => {
    const rig = await setUp();
    await granted(rig, 1);

    await rig.daemon.dispatch("nuke.run", {}, adminSession);

    await sleep(100);
    expect(await listed(rig)).toEqual([]);
    expect(releasesReceived(rig)).toEqual([]);
  });

  it("a command held past lease.endWaitMs: the reclaim starts at the ceiling and the host's release request is aborted; a second agent's open of that device answers DEVICE_IN_USE and leaves no simlock lease until the command is let go, then is granted", async () => {
    const rig = await setUp({ endWaitMs: 30_000, maxRunning: 1 });
    await granted(rig, 1);
    await runningCommand(rig, 1);
    const before = wipes(rig);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    await advance(rig, 35_000, 5_000);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(rig.fake.abortedReleases).toEqual([hex(1)]);
    await expect
      .poll(async () => (await devices(rig)).map((device) => device.state))
      .toEqual(["ready"]);
    const refused = await envelopeOf(await allocate(rig, 2, {}, { token: secrets.two }));
    expect(refused.error?.data?.code).toBe("DEVICE_IN_USE");
    await expect.poll(async () => await listed(rig)).toEqual([]);

    rig.fake.releaseCommand();
    await expect
      .poll(async () => {
        const retry = await envelopeOf(await allocate(rig, 3, {}, { token: secrets.two }));
        return retry.result === undefined ? "refused" : "granted";
      })
      .toBe("granted");
  });

  it("a daemon stop while the host waits for a release, with the held command set to outlive its HTTP request, aborts the participant's request and the stop finishes before the command is let go", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.keepCommandsAfterAbort();
    await runningCommand(rig, 1);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    const stopped = track(rig.daemon.stop("test"));

    await expect.poll(() => stopped.done()).toBe(true);
    expect(rig.fake.abortedReleases).toEqual([hex(1)]);
  });

  it("`nuke.run` while the host waits for a release aborts that request and the reset goes on", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.keepCommandsAfterAbort();
    await runningCommand(rig, 1);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    const reset = track(rig.daemon.dispatch("nuke.run", {}, adminSession));

    await expect.poll(() => reset.done()).toBe(true);
    expect(rig.fake.abortedReleases).toEqual([hex(1)]);
  });
});

describe("FakeAgentDevice as agent-device behaves", () => {
  const udid = "00000000-0000-0000-0000-000000000001";

  function call(
    fake: FakeAgentDevice,
    method: string,
    params: Record<string, unknown>,
    tenant: string | null = "tok_a",
  ): Promise<Response> {
    return fake.fetch(
      new Request(`${fake.baseUrl}/rpc`, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        headers: {
          authorization: `Bearer ${fake.token}`,
          "content-type": "application/json",
          ...(tenant === null ? {} : { "x-agent-device-tenant": tenant }),
        },
        method: "POST",
      }),
    );
  }

  const allocation = (n: number, extra: Record<string, unknown> = {}) => ({
    ...scope,
    deviceKey: "key-1",
    leaseId: hex(n),
    platform: "ios",
    udid,
    ...extra,
  });

  it("refuses a release missing the tenant, the run ID, the lease provider, the client ID or the device key with LEASE_SCOPE_REQUIRED, and one with a different client ID with LEASE_SCOPE_MISMATCH, as agent-device does", async () => {
    const fake = new FakeAgentDevice();
    await call(fake, "agent_device.lease.allocate", allocation(1));
    const full = { ...allocation(1), tenantId: "tok_a" };
    delete (full as Record<string, unknown>)["platform"];
    delete (full as Record<string, unknown>)["udid"];

    const accepted = (await (
      await call(fake, "agent_device.lease.release", full)
    ).json()) as Envelope;
    expect(accepted.result).toMatchObject({ released: true });
    await call(fake, "agent_device.lease.allocate", allocation(1));

    const reasonOf = async (params: Record<string, unknown>, tenant: string | null = "tok_a") => {
      const answer = (await (
        await call(fake, "agent_device.lease.release", params, tenant)
      ).json()) as {
        readonly error?: { readonly data?: { readonly details?: { readonly reason?: string } } };
      };
      return answer.error?.data?.details?.reason;
    };
    const { tenantId: _tenantId, ...untenanted } = full;
    expect(await reasonOf(untenanted, null)).toBe("LEASE_SCOPE_REQUIRED");
    for (const missing of ["runId", "leaseProvider", "clientId", "deviceKey"]) {
      const partial = { ...full } as Record<string, unknown>;
      delete partial[missing];
      expect(await reasonOf(partial), missing).toBe("LEASE_SCOPE_REQUIRED");
    }
    expect(await reasonOf({ ...full, clientId: "client-2" })).toBe("LEASE_SCOPE_MISMATCH");
  });

  it("answers an allocate for a device a live lease holds with DEVICE_IN_USE, and a release of a lease with a held command only after the command is let go", async () => {
    const fake = new FakeAgentDevice();
    const codeOf = async (response: Response) =>
      ((await response.json()) as Envelope).error?.data?.code;
    expect(
      await codeOf(await call(fake, "agent_device.lease.allocate", allocation(1))),
    ).toBeUndefined();
    expect(
      await codeOf(
        await call(fake, "agent_device.lease.allocate", allocation(2, { udid: "other-device" })),
      ),
    ).toBeUndefined();

    expect(await codeOf(await call(fake, "agent_device.lease.allocate", allocation(3)))).toBe(
      "DEVICE_IN_USE",
    );

    fake.holdCommand();
    const running = track(
      call(fake, "agent_device.command", { command: "snapshot", meta: { leaseId: hex(1) } }),
    );
    await sleep(20);
    const full = { ...allocation(1), tenantId: "tok_a" };
    const releasing = track(call(fake, "agent_device.lease.release", full));
    await sleep(50);

    expect(releasing.done()).toBe(false);
    expect(await codeOf(await call(fake, "agent_device.lease.allocate", allocation(3)))).toBe(
      "DEVICE_IN_USE",
    );
    fake.releaseCommand();
    await running.promise;
    expect(((await (await releasing.promise).json()) as Envelope).result).toMatchObject({
      released: true,
    });
    expect(
      await codeOf(await call(fake, "agent_device.lease.allocate", allocation(3))),
    ).toBeUndefined();
  });
});

const simlockPicks = "refused: simlock picks the device";
const onlyIosAndAndroid = "refused: only iOS and Android";
const uploadOnly = "refused: send the app from your machine as an upload";
const noDeviceLeased = "refused: no device leased; run open first";
const deviceSetRefusal =
  "refused: simlock chooses the device set; run disconnect, then connect proxy without --ios-simulator-device-set";
const allowlistRefusal =
  "refused: simlock chooses the devices; run disconnect, then connect proxy without --android-device-allowlist";

const bothDrivers = (clock: FakeClock): FakeDriver[] => [iosDriver(clock), androidDriver(clock)];

function runCommand(
  rig: Rig,
  name: string,
  n: number | undefined,
  fields: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  const { meta, ...rest } = fields;
  return command(rig, name, undefined, options, {
    ...(n === undefined && meta === undefined
      ? {}
      : { meta: { ...(n === undefined ? {} : { leaseId: hex(n) }), ...(meta as object) } }),
    ...rest,
  });
}

// why: the fake agent-device names the device it leases `simlock-<id>`, as the real one does.
function nameOf(rig: Rig, n: number): string {
  return `simlock-${idOf(rig, n)}`;
}

function idOf(rig: Rig, n: number): string {
  const params = receivedAllocate(rig, n);
  return String(params["udid"] ?? params["serial"]);
}

function commandsReceived(rig: Rig) {
  return rig.fake.rpcRequests("agent_device.command");
}

// why: a refusal test starts from a request that is accepted, then changes one thing (testing rule 2).
async function forwarded(
  rig: Rig,
  send: () => Promise<Response>,
): Promise<Record<string, unknown>> {
  const before = rig.fake.requests.length;
  const answer = await envelopeOf(await send());
  expect(answer.error).toBeUndefined();
  expect(answer.result).toBeDefined();
  expect(rig.fake.requests.length).toBe(before + 1);
  return rig.fake.requests.at(-1)?.params as Record<string, unknown>;
}

async function refused(rig: Rig, send: () => Promise<Response>, message: string): Promise<void> {
  const before = rig.fake.requests.length;
  const answer = await envelopeOf(await send());
  expect(answer.error).toMatchObject(refusal(message));
  expect(answer.result).toBeUndefined();
  expect(rig.fake.requests.length).toBe(before);
}

function flagsOf(params: Record<string, unknown>): Record<string, unknown> {
  return (params["flags"] ?? {}) as Record<string, unknown>;
}

function batch(rig: Rig, n: number | undefined, steps: readonly Record<string, unknown>[]) {
  return runCommand(rig, "batch", n, { flags: { batchSteps: steps } });
}

describe("the agent-device front's request rules", () => {
  describe("rule 1, the route", () => {
    it.each([
      ["GET", "/health"],
      ["POST", "/upload"],
      ["POST", "/upload/preflight"],
      ["POST", "/upload/finalize"],
      ["PUT", "/upload/direct/ticket-1"],
      ["GET", "/artifacts"],
      ["GET", "/artifacts/"],
      ["GET", "/artifacts/a.png"],
      ["GET", "/artifacts/dir/a.png"],
      ["GET", "/sessions/tok_one:s1/requests/r1/diagnostics"],
    ])("%s %s with a token reaches agent-device", async (method, path) => {
      const rig = await setUp();

      const answer = await send(rig, path, { method, ...(method === "GET" ? {} : { body: "{}" }) });

      await answer.text();
      expect(rig.fake.requests.map((request) => request.path)).toEqual([path]);
    });

    it("POST /rpc with a token reaches agent-device", async () => {
      const rig = await setUp();

      await forwarded(rig, () => runCommand(rig, "snapshot", undefined));
    });

    it.each([
      ["GET", "/admin/leases"],
      ["POST", "/health"],
      ["POST", "/rpcx"],
      ["POST", "/rpc/x"],
      ["PUT", "/upload/direct/a/b"],
      ["GET", "/sessions/s1/requests/r1/diagnostics/extra"],
    ])("%s %s is refused 404 and reaches nothing", async (method, path) => {
      const rig = await setUp();
      await (await send(rig, "/health")).text();
      const before = rig.fake.requests.length;

      const answer = await send(rig, path, { method, ...(method === "GET" ? {} : { body: "{}" }) });

      expect(answer.status).toBe(404);
      expect(await bodyOf(answer)).toEqual({
        code: "INVALID_ARGS",
        error: `refused: unknown route ${method} ${path}`,
        ok: false,
      });
      expect(rig.fake.requests.length).toBe(before);
    });

    it("a route refusal answers 404 with `refused: unknown route POST /rpcx`", async () => {
      const rig = await setUp();

      const answer = await send(rig, "/rpcx", { body: "{}" });

      expect(answer.status).toBe(404);
      expect(((await bodyOf(answer)) as { error: string }).error).toBe(
        "refused: unknown route POST /rpcx",
      );
    });

    it("a route outside the list answers 401 without a token, and `agent-device is not available on this simlock` while agent-device is unavailable", async () => {
      const rig = await setUp();
      expect((await send(rig, "/admin/leases")).status).toBe(404);
      const missing = await send(rig, "/admin/leases", { token: null });
      expect(missing.status).toBe(401);
      rig.fake.setUnavailable("found 0.20.3, need 0.21.28 or later");

      const unavailable = await send(rig, "/admin/leases");

      expect(await unavailable.text()).toContain(`${notAvailable}found 0.20.3`);
      expect(rig.fake.requests).toEqual([]);
    });
  });

  describe("rule 2, the RPC method", () => {
    it("an unknown RPC method is refused, and `agent-device.command` with a dash is forwarded", async () => {
      const rig = await setUp();
      await forwarded(rig, () => rpc(rig, "agent-device.command", { command: "snapshot" }));

      await refused(
        rig,
        () => rpc(rig, "agent_device.admin", { command: "snapshot" }),
        "refused: unknown method agent_device.admin",
      );
    });

    it("`install_from_source` and `release_materialized_paths`, which agent-device's proxy refuses for a tenant, are refused `refused: unknown method <method>` and never forwarded", async () => {
      const rig = await setUp();

      await refused(
        rig,
        () =>
          rpc(rig, "agent_device.install_from_source", {
            platform: "ios",
            source: { kind: "url", url: "https://example.com/App.zip" },
          }),
        "refused: unknown method agent_device.install_from_source",
      );
      await refused(
        rig,
        () => rpc(rig, "agent_device.release_materialized_paths", { materializationId: "m-1" }),
        "refused: unknown method agent_device.release_materialized_paths",
      );
    });
  });

  describe("rule 4, the platform", () => {
    it("a command with `--platform android` is forwarded; with `macos` or `apple`, or `runtime.platform` `harmonyos`, it is refused", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await forwarded(rig, () =>
        runCommand(rig, "snapshot", undefined, { flags: { platform: "android" } }),
      );

      for (const platform of ["macos", "apple"]) {
        await refused(
          rig,
          () => runCommand(rig, "snapshot", undefined, { flags: { platform } }),
          onlyIosAndAndroid,
        );
      }
      await refused(
        rig,
        () => runCommand(rig, "snapshot", undefined, { runtime: { platform: "harmonyos" } }),
        onlyIosAndAndroid,
      );
    });

    it("a command with `--platform ios` while the iOS driver is off is refused with `refused: ios is not available on this simlock`", async () => {
      const rig = await setUp({ drivers: (clock) => [androidDriver(clock)] });
      await forwarded(rig, () =>
        runCommand(rig, "snapshot", undefined, { flags: { platform: "android" } }),
      );

      await refused(
        rig,
        () => runCommand(rig, "snapshot", undefined, { flags: { platform: "ios" } }),
        "refused: ios is not available on this simlock",
      );
    });

    it("a batch step whose `runtime.platform` is `web` is refused", async () => {
      const rig = await setUp();
      await forwarded(rig, () =>
        batch(rig, undefined, [{ command: "snapshot", runtime: { platform: "ios" } }]),
      );

      await refused(
        rig,
        () => batch(rig, undefined, [{ command: "snapshot", runtime: { platform: "web" } }]),
        onlyIosAndAndroid,
      );
    });

    it("a batch step with `platform: web` is refused and no step reaches agent-device", async () => {
      const rig = await setUp();
      const steps = [{ command: "snapshot", flags: { platform: "ios" } }];
      await forwarded(rig, () => batch(rig, undefined, steps));

      await refused(
        rig,
        () =>
          batch(rig, undefined, [...steps, { command: "snapshot", flags: { platform: "web" } }]),
        onlyIosAndAndroid,
      );
      expect(commandsReceived(rig)).toHaveLength(1);
    });
  });

  describe("rule 6, device selectors", () => {
    it("`udid` and `serial` of the agent's own leased device are forwarded; another device's are refused, in `flags` and in `input` alike", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await granted(rig, 1);
      await granted(rig, 2, { device: "Pixel 8", platform: "android" });
      await granted(rig, 3, {}, { token: secrets.two });
      const own = idOf(rig, 1);
      const ownSerial = idOf(rig, 2);
      const other = idOf(rig, 3);
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: own } }));
      await forwarded(rig, () => runCommand(rig, "snapshot", 2, { flags: { serial: ownSerial } }));
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { input: { udid: own } }));

      const attempts: [number, Record<string, unknown>][] = [
        [1, { flags: { udid: other } }],
        [1, { input: { udid: other } }],
        [2, { flags: { serial: other } }],
        [2, { input: { serial: other } }],
      ];
      for (const [lease, fields] of attempts) {
        await refused(rig, () => runCommand(rig, "snapshot", lease, fields), simlockPicks);
      }
    });

    it("`--device` with the leased device's id, and its name with `_` for a space, extra spaces and other letter case, are forwarded unchanged", async () => {
      const rig = await setUp();
      rig.fake.nameDeviceInNextReply({ name: "Sim Lock Phone" });
      await granted(rig, 1);
      const own = idOf(rig, 1);

      for (const device of [own, "Sim Lock Phone", "sim_lock_phone", "  SIM   lock  phone "]) {
        const params = await forwarded(rig, () =>
          runCommand(rig, "snapshot", 1, { flags: { device } }),
        );
        expect(flagsOf(params)["device"]).toBe(device);
      }
    });

    it("`--device` with the leased model, or a catalog alias of it, reaches agent-device as `udid` of the leased device on iOS and `serial` on Android, with no `device`; another model is refused", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await granted(rig, 1, { device: "iPhone 17 Pro" });
      await granted(rig, 2, { device: "Pixel 8", platform: "android" });
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: idOf(rig, 1) } }));

      const ios = flagsOf(
        await forwarded(rig, () =>
          runCommand(rig, "snapshot", 1, { flags: { device: "iphone 17 pro" } }),
        ),
      );
      const android = flagsOf(
        await forwarded(rig, () => runCommand(rig, "snapshot", 2, { flags: { device: "p8" } })),
      );

      expect(ios["udid"]).toBe(idOf(rig, 1));
      expect(ios).not.toHaveProperty("device");
      expect(android["serial"]).toBe(idOf(rig, 2));
      expect(android).not.toHaveProperty("device");
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { device: "iPhone 16" } }),
        simlockPicks,
      );
    });

    it("`--device` with the leased model in `input` is removed from `input` and sent as `flags.udid`", async () => {
      const rig = await setUp();
      await granted(rig, 1, { device: "iPhone 17 Pro" });

      const params = await forwarded(rig, () =>
        runCommand(rig, "snapshot", 1, { input: { device: "iPhone 17 Pro" } }),
      );

      expect(flagsOf(params)["udid"]).toBe(idOf(rig, 1));
      expect(params["input"] ?? {}).not.toHaveProperty("device");
    });

    it("`test --device <own udid>,<own name>` is forwarded; for an agent holding two devices, `test --device \"<udid A>, ,<udid B>,\"` is forwarded; a list with an entry naming another token's device, or the leased device's model, is refused", async () => {
      const rig = await setUp();
      rig.fake.nameDeviceInNextReply({ name: "Sim Lock Phone" });
      await granted(rig, 1, { device: "iPhone 17 Pro" });
      await granted(rig, 2);
      await granted(rig, 3, {}, { token: secrets.two });
      const [a, b, other] = [idOf(rig, 1), idOf(rig, 2), idOf(rig, 3)];
      const test = (device: string) => runCommand(rig, "test", 1, { flags: { device } });
      await forwarded(rig, () => test(`${a},Sim Lock Phone`));
      await forwarded(rig, () => test(` ${a}, ,${b},`));

      await refused(rig, () => test(`${a},${other}`), simlockPicks);
      await refused(rig, () => test(`${a},iPhone 17 Pro`), simlockPicks);
    });

    it("`test --device <own udid>` with no lease named is forwarded; naming the device of the token's own ended lease it is refused", async () => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      await granted(rig, 2, { ttlMs: 600_000 });
      const [ended, alive] = [idOf(rig, 1), idOf(rig, 2)];
      await forwarded(rig, () => runCommand(rig, "test", undefined, { flags: { device: ended } }));
      await rig.daemon.dispatch("lease.release", { leaseId: hex(1) }, sessionFor(principals.one));
      await expect.poll(() => listed(rig)).toEqual([hex(2)]);

      await forwarded(rig, () => runCommand(rig, "test", undefined, { flags: { device: alive } }));
      await refused(
        rig,
        () => runCommand(rig, "test", undefined, { flags: { device: ended } }),
        simlockPicks,
      );
    });

    it("with no lease named, a command with `udid`, one with `serial` and one with `device` are each refused", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: idOf(rig, 1) } }));

      for (const flags of [
        { udid: idOf(rig, 1) },
        { serial: "emulator-5554" },
        { device: "iPhone 16" },
      ]) {
        await refused(rig, () => runCommand(rig, "snapshot", undefined, { flags }), simlockPicks);
      }
    });

    it("with no lease named and no selector, a command reaches agent-device unchanged", async () => {
      const rig = await setUp();
      const fields = { flags: { session: "main" }, positionals: ["a"] };

      const params = await forwarded(rig, () => runCommand(rig, "snapshot", undefined, fields));

      expect(params).toMatchObject({ command: "snapshot", ...fields });
      expect(Object.keys(flagsOf(params))).toEqual(["session"]);
    });

    it("a command naming its lease only in `flags.leaseId`, with its own udid, is forwarded", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const own = idOf(rig, 1);
      await refused(
        rig,
        () => runCommand(rig, "snapshot", undefined, { flags: { udid: own } }),
        simlockPicks,
      );

      await forwarded(rig, () =>
        runCommand(rig, "snapshot", undefined, { flags: { leaseId: hex(1), udid: own } }),
      );
    });

    it("a command naming agent B's lease with that lease's udid is refused; an agent holding two devices is refused lease B's udid on a command for lease A", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await granted(rig, 2);
      await granted(rig, 3, {}, { token: secrets.two });
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: idOf(rig, 1) } }));

      await refused(
        rig,
        () => runCommand(rig, "snapshot", 3, { flags: { udid: idOf(rig, 3) } }),
        simlockPicks,
      );
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { udid: idOf(rig, 2) } }),
        simlockPicks,
      );
    });

    it("a command naming its lease with that lease's `deviceKey` is forwarded; with another lease's `deviceKey`, in `meta` or only in `flags`, it is refused; with no lease named, a stale `deviceKey` is forwarded", async () => {
      const rig = await setUp();
      rig.fake.nameDeviceKeyInNextReply("key-1");
      await granted(rig, 1);
      rig.fake.nameDeviceKeyInNextReply("key-2");
      await granted(rig, 2);
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: "key-1" } }));

      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: "key-2" } }),
        simlockPicks,
      );
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { deviceKey: "key-2" } }),
        simlockPicks,
      );
      await forwarded(rig, () =>
        runCommand(rig, "snapshot", undefined, { meta: { deviceKey: "key-2" } }),
      );
    });

    it("a batch step with another device's udid is refused and no step reaches agent-device", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await granted(rig, 2, {}, { token: secrets.two });
      const steps = [{ command: "snapshot", flags: { udid: idOf(rig, 1) } }];
      await forwarded(rig, () => batch(rig, 1, steps));

      await refused(
        rig,
        () => batch(rig, 1, [...steps, { command: "snapshot", flags: { udid: idOf(rig, 2) } }]),
        simlockPicks,
      );
      expect(commandsReceived(rig)).toHaveLength(1);
    });

    it("in a batch, a step with the leased model reaches agent-device with the leased id, a sharded `test` step is filled as rule 7 says, and a step naming another lease is refused", async () => {
      const rig = await setUp();
      await granted(rig, 1, { device: "iPhone 17 Pro" });
      await granted(rig, 2, {}, { token: secrets.two });

      const params = await forwarded(rig, () =>
        batch(rig, 1, [
          { command: "snapshot", flags: { device: "iPhone 17 Pro" } },
          { command: "test", flags: { shardAll: 2 } },
        ]),
      );

      const steps = flagsOf(params)["batchSteps"] as { flags: Record<string, unknown> }[];
      expect(steps[0]?.flags["udid"]).toBe(idOf(rig, 1));
      expect(steps[0]?.flags).not.toHaveProperty("device");
      expect(steps[1]?.flags["device"]).toBe(nameOf(rig, 1));
      await refused(
        rig,
        () => batch(rig, 1, [{ command: "snapshot", flags: { leaseId: hex(2) } }]),
        "refused: a batch step cannot name another lease",
      );
    });

    it("a `udid` that is a number is refused with `refused: malformed udid`; a `shardAll` that is a string with `refused: malformed shardAll`", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await forwarded(rig, () => runCommand(rig, "test", 1, { flags: { shardAll: 2 } }));

      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { udid: 12 } }),
        "refused: malformed udid",
      );
      await refused(
        rig,
        () => runCommand(rig, "test", 1, { flags: { shardAll: "2" } }),
        "refused: malformed shardAll",
      );
    });

    it("after simlock ended the lease, a command with that lease's udid is forwarded and agent-device's answer reaches the CLI; one TTL later the same command is refused with `refused: simlock picks the device`", async () => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      const own = idOf(rig, 1);
      await rig.daemon.dispatch("lease.release-all", {}, adminSession);
      await expect.poll(() => listed(rig)).toEqual([]);

      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: own } }));
      await advance(rig, 61_000, 5_000);

      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { udid: own } }),
        simlockPicks,
      );
    });
  });

  describe("rule 5, device set and allowlist", () => {
    it("`--ios-simulator-device-set` naming any directory is refused with the disconnect-and-reconnect message, on a command and on an allocate", async () => {
      const rig = await setUp();
      await forwarded(rig, () => runCommand(rig, "snapshot", undefined));
      const set = "/var/simlock/devices";

      await refused(
        rig,
        () => runCommand(rig, "snapshot", undefined, { flags: { iosSimulatorDeviceSet: set } }),
        deviceSetRefusal,
      );
      await refused(rig, () => allocate(rig, 1, { iosSimulatorDeviceSet: set }), deviceSetRefusal);
      expect(await requestedSpecs(rig, principals.one)).toEqual([]);
    });

    it("`--android-device-allowlist` is refused with its disconnect-and-reconnect message, on a command and in a batch step", async () => {
      const rig = await setUp();
      await forwarded(rig, () => batch(rig, undefined, [{ command: "snapshot" }]));

      await refused(
        rig,
        () =>
          runCommand(rig, "snapshot", undefined, {
            flags: { androidDeviceAllowlist: "emulator-5554" },
          }),
        allowlistRefusal,
      );
      await refused(
        rig,
        () =>
          batch(rig, undefined, [
            { command: "snapshot", flags: { androidDeviceAllowlist: "emulator-5554" } },
          ]),
        allowlistRefusal,
      );
    });
  });

  describe("rule 7, sharding", () => {
    const shard = (
      rig: Rig,
      n: number | undefined,
      flags: Record<string, unknown> = {},
      token: string = secrets.one,
    ) => runCommand(rig, "test", n, { flags: { shardAll: 2, ...flags } }, { token });

    it("`test --shard-all 2` with no `--device` reaches agent-device with `device` set to the token's leased devices, for an agent holding one device and one holding two, while another token's leased device is left out", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await granted(rig, 2, {}, { token: secrets.two });
      await granted(rig, 3, {}, { token: secrets.two });

      const one = await forwarded(rig, () => shard(rig, 1));
      const two = await forwarded(rig, () => shard(rig, 2, {}, secrets.two));

      expect(flagsOf(one)["device"]).toBe(nameOf(rig, 1));
      expect(String(flagsOf(two)["device"]).split(",").sort()).toEqual(
        [nameOf(rig, 2), nameOf(rig, 3)].sort(),
      );
    });

    it("`test --platform ios --shard-all 1` gets only the simulator's id, `--target tv` only the TV's id (a device whose reply named no target counts as `mobile`), and `--platform android` from a token holding only the simulator is refused", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await granted(rig, 1);
      await granted(rig, 2, { device: "Pixel 8", platform: "android" });
      rig.fake.nameDeviceInNextReply({ target: "tv" });
      await granted(rig, 3, { device: "Apple TV 4K", target: "tv" });

      const ios = await forwarded(rig, () =>
        shard(rig, 1, { platform: "ios", shardAll: 1, target: "mobile" }),
      );
      const tv = await forwarded(rig, () => shard(rig, 1, { shardAll: 1, target: "tv" }));
      const android = await forwarded(rig, () =>
        shard(rig, 2, { platform: "android", shardAll: 1 }),
      );

      expect(flagsOf(ios)["device"]).toBe(nameOf(rig, 1));
      expect(flagsOf(tv)["device"]).toBe(nameOf(rig, 3));
      expect(flagsOf(android)["device"]).toBe(nameOf(rig, 2));
      const iosOnly = await setUp({ drivers: bothDrivers });
      await granted(iosOnly, 1);
      await forwarded(iosOnly, () => shard(iosOnly, 1, { platform: "ios", shardAll: 1 }));
      await refused(
        iosOnly,
        () => shard(iosOnly, 1, { platform: "android", shardAll: 1 }),
        noDeviceLeased,
      );
    });

    it("`test --shard-all 2` names a device by the name agent-device gave it, and by its id when that name holds a comma or the reply named none", async () => {
      const rig = await setUp();
      rig.fake.nameDeviceInNextReply({ name: "Lab, left" });
      await granted(rig, 1);
      rig.fake.nameDeviceInNextReply("none");
      await granted(rig, 2, {}, { token: secrets.two });

      const comma = await forwarded(rig, () => shard(rig, 1));
      const unnamed = await forwarded(rig, () => shard(rig, 2, {}, secrets.two));

      expect(flagsOf(comma)["device"]).toBe(idOf(rig, 1));
      expect(flagsOf(unnamed)["device"]).toBe(idOf(rig, 2));
    });

    it('`test --shard-split 2` with `device: " , "` is filled as if no list were sent; from a token that holds no device it is refused with `refused: no device leased; run open first`', async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const split = (token: string, n: number | undefined) =>
        runCommand(rig, "test", n, { flags: { device: " , ", shardSplit: 2 } }, { token });

      const params = await forwarded(rig, () => split(secrets.one, 1));

      expect(flagsOf(params)["device"]).toBe(nameOf(rig, 1));
      await refused(rig, () => split(secrets.two, undefined), noDeviceLeased);
    });
  });

  describe("rule 8, install", () => {
    it('`install` with `meta.uploadedArtifactId` is forwarded; without it, with `""` and with `"  "` it is refused with `send the app from your machine as an upload`', async () => {
      const rig = await setUp();
      const install = (meta: Record<string, unknown>) =>
        runCommand(rig, "install", undefined, {
          meta,
          positionals: ["MyApp", "remote:/Users/ci/MyApp.app"],
        });
      await forwarded(rig, () => install({ uploadedArtifactId: "art-1" }));

      await refused(rig, () => install({}), uploadOnly);
      await refused(rig, () => install({ uploadedArtifactId: "" }), uploadOnly);
      await refused(rig, () => install({ uploadedArtifactId: "  " }), uploadOnly);
    });

    it('`reinstall` without an upload is refused; batch steps `install` and `" Install "` are refused and no step reaches agent-device', async () => {
      const rig = await setUp();
      await forwarded(rig, () =>
        runCommand(rig, "reinstall", undefined, { meta: { uploadedArtifactId: "art-1" } }),
      );
      await forwarded(rig, () => batch(rig, undefined, [{ command: "snapshot" }]));
      const before = commandsReceived(rig).length;

      await refused(rig, () => runCommand(rig, "reinstall", undefined), uploadOnly);
      await refused(rig, () => batch(rig, undefined, [{ command: "install" }]), uploadOnly);
      await refused(
        rig,
        () => batch(rig, undefined, [{ command: "snapshot" }, { command: " Install " }]),
        uploadOnly,
      );
      expect(commandsReceived(rig)).toHaveLength(before);
    });

    it("a batch with an upload in `meta` still refuses its `install` step, and forwards when it has no install step", async () => {
      const rig = await setUp();
      const withUpload = (steps: readonly Record<string, unknown>[]) =>
        runCommand(rig, "batch", undefined, {
          flags: { batchSteps: steps },
          meta: { uploadedArtifactId: "art-1" },
        });
      await forwarded(rig, () => withUpload([{ command: "snapshot" }]));
      const before = commandsReceived(rig).length;

      await refused(rig, () => withUpload([{ command: "install" }]), uploadOnly);
      expect(commandsReceived(rig)).toHaveLength(before);
    });
  });

  describe("rule 9, batch devices", () => {
    it('batch steps `devices` and `" DEVICES "` are refused', async () => {
      const rig = await setUp();
      await forwarded(rig, () => batch(rig, undefined, [{ command: "snapshot" }]));

      for (const step of ["devices", " DEVICES "]) {
        await refused(
          rig,
          () => batch(rig, undefined, [{ command: step }]),
          "refused: run devices on its own",
        );
      }
    });
  });

  describe("the devices filter", () => {
    const three = [{ id: "d-1" }, { id: "d-2" }, { id: "d-3" }];
    const listedIds = async (response: Response): Promise<unknown> => {
      const answer = await envelopeOf(response);
      const data = answer.result?.["data"] as { devices: { id: string }[] } | undefined;
      expect(Array.isArray(data?.devices), "expected a devices list in result.data").toBe(true);
      return data?.devices.map((device) => device.id);
    };

    it("`devices` before open answers an empty list while agent-device lists three devices; after open it answers only the leased device, without agent B's", async () => {
      const rig = await setUp();
      await granted(rig, 2, {}, { token: secrets.two });
      rig.fake.listDevices([...three, { id: idOf(rig, 2) }]);
      const before = commandsReceived(rig).length;

      expect(await listedIds(await runCommand(rig, "devices", undefined))).toEqual([]);
      expect(commandsReceived(rig)).toHaveLength(before + 1);
      await granted(rig, 1);
      rig.fake.listDevices([...three, { id: idOf(rig, 2) }, { id: idOf(rig, 1) }]);

      expect(await listedIds(await runCommand(rig, "devices", 1))).toEqual([idOf(rig, 1)]);
    });

    it("`devices` for an agent holding two devices answers both, and after simlock released one of the two leases (no heartbeat sent since), only the other", async () => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      await granted(rig, 2, { ttlMs: 600_000 });
      rig.fake.listDevices([...three, { id: idOf(rig, 1) }, { id: idOf(rig, 2) }]);

      expect(
        ((await listedIds(await runCommand(rig, "devices", undefined))) as string[]).sort(),
      ).toEqual([idOf(rig, 1), idOf(rig, 2)].sort());
      await rig.daemon.dispatch("lease.release", { leaseId: hex(1) }, adminSession);
      await expect.poll(() => listed(rig)).toEqual([hex(2)]);

      expect(await listedIds(await runCommand(rig, "devices", undefined))).toEqual([idOf(rig, 2)]);
    });

    it("a `devices` error answer from agent-device passes unchanged; a success with no list at `data.devices`, a body over 1 MiB, a non-JSON body and a list holding a non-object each answer an empty list; `devices` with `meta.requestProgress` is refused", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      rig.fake.listDevices([{ id: idOf(rig, 1) }]);
      expect(await listedIds(await runCommand(rig, "devices", 1))).toEqual([idOf(rig, 1)]);

      const failure = {
        error: {
          code: -32000,
          data: { code: "COMMAND_FAILED", message: "inventory down" },
          message: "inventory down",
        },
        id: 1,
        jsonrpc: "2.0",
      };
      rig.fake.answerDevicesWith(JSON.stringify(failure));
      expect(await envelopeOf(await runCommand(rig, "devices", 1))).toMatchObject({
        error: { message: "inventory down" },
      });
      const unusable = [
        JSON.stringify({ id: 1, jsonrpc: "2.0", result: { data: {}, ok: true } }),
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: {
            data: { devices: [{ id: idOf(rig, 1) }], pad: "x".repeat(1024 * 1024) },
            ok: true,
          },
        }),
        "not json",
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: { data: { devices: [{ id: idOf(rig, 1) }, "stray"] }, ok: true },
        }),
      ];
      for (const body of unusable) {
        rig.fake.answerDevicesWith(body);
        expect(await listedIds(await runCommand(rig, "devices", 1))).toEqual([]);
      }
      await refused(
        rig,
        () => runCommand(rig, "devices", 1, { meta: { requestProgress: true } }),
        "refused: devices does not stream through simlock",
      );
    });
  });

  describe("the token's leased devices", () => {
    it("a `test` shard fill whose lease check fails answers `COMMAND_FAILED` with `could not check your leases; try again` and reaches nothing", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const tap = tapDispatch(rig);
      const sharded = () => runCommand(rig, "test", 1, { flags: { shardAll: 2 } });
      await forwarded(rig, sharded);
      tap.rejectNext("lease.list");
      const before = rig.fake.requests.length;

      const answer = await envelopeOf(await sharded());

      expect(answer.error).toMatchObject({
        data: { code: "COMMAND_FAILED", message: "could not check your leases; try again" },
      });
      expect(rig.fake.requests.length).toBe(before);
    });

    it("a `devices` whose lease check fails answers `COMMAND_FAILED` with `could not check your leases; try again`, not an empty list", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      rig.fake.listDevices([{ id: idOf(rig, 1) }]);
      const tap = tapDispatch(rig);
      tap.rejectNext("lease.list");

      const answer = await envelopeOf(await runCommand(rig, "devices", 1));

      expect(answer.error).toMatchObject({
        data: { code: "COMMAND_FAILED", message: "could not check your leases; try again" },
      });
    });

    it("a batch whose `batchSteps` is not a list is refused with `refused: malformed batchSteps`", async () => {
      const rig = await setUp();
      await forwarded(rig, () => batch(rig, undefined, [{ command: "snapshot" }]));

      await refused(
        rig,
        () => runCommand(rig, "batch", undefined, { flags: { batchSteps: "snapshot" } }),
        "refused: malformed batchSteps",
      );
    });

    it("a `flags`, `input` or `runtime` that is not an object, a batch step that is not an object or whose `command` is not a string, and a `meta.deviceKey` that is not a string are each refused with their `malformed` message", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: {} }));

      for (const key of ["flags", "input", "runtime"]) {
        await refused(
          rig,
          () => runCommand(rig, "snapshot", 1, { [key]: "text" }),
          `refused: malformed ${key}`,
        );
      }
      await refused(
        rig,
        () => batch(rig, 1, ["snapshot"] as unknown as Record<string, unknown>[]),
        "refused: malformed batchSteps",
      );
      await refused(rig, () => batch(rig, 1, [{ command: 5 }]), "refused: malformed command");
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: 5 } }),
        "refused: malformed deviceKey",
      );
    });
  });

  describe("rule 10, commands agent-device runs without a lease", () => {
    it("`capabilities` with no selector reaches agent-device with the leased device's id; from a token holding no device it is refused; `doctor` the same", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      for (const name of ["capabilities", "doctor"]) {
        const params = await forwarded(rig, () => runCommand(rig, name, 1));
        expect(flagsOf(params)["udid"]).toBe(idOf(rig, 1));
        await refused(
          rig,
          () => runCommand(rig, name, undefined, {}, { token: secrets.two }),
          "refused: name the device with --udid <id>; run devices to see yours",
        );
      }
    });

    it("`capabilities` naming no lease is filled with the token's only device; with two devices it is refused unless `platform` leaves one, and then it gets that device's `serial` on Android", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await granted(rig, 1, {}, { token: secrets.two });
      const only = await forwarded(rig, () =>
        runCommand(rig, "capabilities", undefined, {}, { token: secrets.two }),
      );
      expect(flagsOf(only)["udid"]).toBe(idOf(rig, 1));

      await granted(rig, 2, { device: "Pixel 8", platform: "android" }, { token: secrets.two });
      await refused(
        rig,
        () => runCommand(rig, "capabilities", undefined, {}, { token: secrets.two }),
        "refused: name the device with --udid <id>; run devices to see yours",
      );
      const android = await forwarded(rig, () =>
        runCommand(
          rig,
          "capabilities",
          undefined,
          { flags: { platform: "android" } },
          { token: secrets.two },
        ),
      );
      expect(flagsOf(android)["serial"]).toBe(idOf(rig, 2));
      expect(flagsOf(android)).not.toHaveProperty("udid");
    });
  });

  describe("commands the policy file refuses", () => {
    it("`boot` passes the rules and reaches agent-device, as before this PR", async () => {
      const rig = await setUp();
      await granted(rig, 1);

      const params = await forwarded(rig, () => runCommand(rig, "boot", 1));

      expect(params["command"]).toBe("boot");
    });
  });
});

describe("a worker's capabilities in status.get, through the whole worker daemon", () => {
  async function capabilities(rig: Rig) {
    return (await rig.daemon.dispatch("status.get", {}, adminSession)).capabilities;
  }

  it("a worker with no capabilities.agent-device section answers status.get with capabilities [{name: agent-device, state: off}], and so does one with it false", async () => {
    const unset = await setUp({ enabled: "unset" });
    const off = await setUp({ enabled: false });
    const running = await setUp();

    expect(await capabilities(running)).toEqual([{ name: "agent-device", state: "available" }]);
    expect(await capabilities(unset)).toEqual([{ name: "agent-device", state: "off" }]);
    expect(await capabilities(off)).toEqual([{ name: "agent-device", state: "off" }]);
  });

  it("a worker with agent-device running answers [{name: agent-device, state: available}], with no reason", async () => {
    const rig = await setUp();

    const [entry] = (await capabilities(rig)) ?? [];

    expect(entry).toEqual({ name: "agent-device", state: "available" });
    expect(entry).not.toHaveProperty("reason");
  });

  it("a worker whose agent-device is unavailable answers state unavailable with the same reason its front's notAvailable reply names", async () => {
    const rig = await setUp();
    const reason = "found 0.20.1, need 0.21.28 or later";
    rig.fake.setUnavailable(reason);

    const health = await (await send(rig, "/health")).text();

    expect(await capabilities(rig)).toEqual([
      { name: "agent-device", reason, state: "unavailable" },
    ]);
    expect(health).toContain(`${notAvailable}${reason}`);
  });

  it("a worker whose agent-device is starting answers unavailable with reason starting", async () => {
    const rig = await setUp();
    rig.fake.setUnavailable("starting");

    expect(await capabilities(rig)).toEqual([
      { name: "agent-device", reason: "starting", state: "unavailable" },
    ]);
  });

  it("a worker whose agent-device goes from unavailable to running answers available on the next status.get", async () => {
    const rig = await setUp();
    rig.fake.setUnavailable("starting");
    expect((await capabilities(rig))?.[0]?.state).toBe("unavailable");

    rig.fake.setUnavailable(undefined);

    expect(await capabilities(rig)).toEqual([{ name: "agent-device", state: "available" }]);
  });

  it("a worker's own worker.list answer carries its capabilities", async () => {
    const rig = await setUp();

    const { workers } = await rig.daemon.dispatch("worker.list", {}, adminSession);

    expect(workers[0]?.capabilities).toEqual([{ name: "agent-device", state: "available" }]);
  });
});

const downloadLimit = 2_147_483_648;
const tooLargeReply = (size: number) => ({
  code: "INVALID_ARGS",
  error: `the download is ${String(size)} bytes; simlock carries downloads up to 2 GB (2147483648 bytes)`,
  ok: false,
});

async function drainDownload(response: Response): Promise<{
  readonly bytes: number;
  readonly digest: string;
  readonly ended: boolean;
}> {
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return { bytes, digest: hash.digest("hex"), ended: true };
      hash.update(next.value);
      bytes += next.value.length;
    }
  } catch {
    return { bytes, digest: "", ended: false };
  }
}

describe(
  "the agent-device front, through the whole worker daemon: downloads over 2 GiB",
  {
    timeout: 120_000,
  },
  () => {
    it("an artifact download whose `content-length` is 2147483649 is answered 413 with simlock's reply; the fake produced 0 bytes and its body was cancelled", async () => {
      const rig = await setUp();
      rig.fake.serveArtifact({ contentLength: "size", size: downloadLimit + 1 });

      const response = await send(rig, "/artifacts/a1");

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(tooLargeReply(downloadLimit + 1));
      expect(rig.fake.artifactBytesProduced).toBe(0);
      await expect.poll(() => rig.fake.artifactBodyCancelled).toBe(true);
    });

    it("an artifact download of exactly 2147483648 bytes with `content-length` arrives byte for byte", async () => {
      const rig = await setUp();
      rig.fake.serveArtifact({ contentLength: "size", size: downloadLimit });

      const response = await send(rig, "/artifacts/a1");
      const received = await drainDownload(response);

      expect(response.status).toBe(200);
      expect(received.ended).toBe(true);
      expect(received.bytes).toBe(downloadLimit);
      expect(received.digest).toBe(rig.fake.producedDigest());
    });

    it("a download with no `content-length` of exactly 2147483648 bytes arrives byte for byte", async () => {
      const rig = await setUp();
      rig.fake.serveArtifact({ contentLength: "none", size: downloadLimit });

      const response = await send(rig, "/artifacts/a1");
      const received = await drainDownload(response);

      expect(response.status).toBe(200);
      expect(received.ended).toBe(true);
      expect(received.bytes).toBe(downloadLimit);
      expect(received.digest).toBe(rig.fake.producedDigest());
    });

    it("a download with no `content-length` that passes 2147483648 bytes errors the agent's response, which never ends cleanly, and the fake's body is cancelled", async () => {
      const rig = await setUp();
      rig.fake.serveArtifact({ contentLength: "none", size: downloadLimit + 1 });

      const response = await send(rig, "/artifacts/a1");
      const received = await drainDownload(response);

      expect(received.ended).toBe(false);
      await expect.poll(() => rig.fake.artifactBodyCancelled).toBe(true);
    });

    it("an agent that cancels a 1 GiB download halfway cancels the fake's body", async () => {
      const rig = await setUp();
      rig.fake.serveArtifact({ contentLength: "none", size: 1_073_741_824 });

      const response = await send(rig, "/artifacts/a1");
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let bytes = 0;
      while (bytes < 536_870_912) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
      }
      await reader.cancel();

      expect(bytes).toBeGreaterThanOrEqual(536_870_912);
      await expect.poll(() => rig.fake.artifactBodyCancelled).toBe(true);
      expect(rig.fake.artifactBytesProduced).toBeLessThan(1_073_741_824);
    });

    it("an RPC reply and a preflight reply pass unchanged", async () => {
      const rig = await setUp();
      await granted(rig, 1);

      const reply = await command(rig, "snapshot", 1);
      const preflight = await send(rig, "/upload/preflight", { body: "{}" });

      expect(reply.status).toBe(200);
      expect((await envelopeOf(reply)).result).toMatchObject({ ok: true });
      expect(preflight.status).toBe(200);
      expect(
        ((await preflight.json()) as { upload: { url: string } }).upload.url.startsWith(
          `${rig.origin}/v1/agent-device/upload/direct/`,
        ),
      ).toBe(true);
    });

    it("a 2147483648-byte upload reaches the fake byte for byte", async () => {
      const rig = await setUp();
      const preflight = await send(rig, "/upload/preflight", { body: "{}" });
      const ticket = (
        (await preflight.json()) as { upload: { url: string; headers: Record<string, string> } }
      ).upload;
      const hash = createHash("sha256");
      let sent = 0;
      const piece = new Uint8Array(65_536).fill(7);
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            if (sent >= downloadLimit) {
              controller.close();
              return;
            }
            sent += piece.length;
            hash.update(piece);
            controller.enqueue(piece);
          },
        },
        { highWaterMark: 0 },
      );

      const put = await fetch(ticket.url, {
        body,
        duplex: "half",
        headers: { ...ticket.headers, "content-length": String(downloadLimit) },
        method: "PUT",
      } as RequestInit);

      expect(put.status).toBe(200);
      expect(rig.fake.uploadSummaries).toEqual([
        { bytes: downloadLimit, sha256: hash.copy().digest("hex") },
      ]);
    });
  },
);
