import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDriver } from "../core/testing.js";
import { startDaemon, type StartDaemonOptions } from "../daemon/main.js";
import { DispatchError } from "../daemon/dispatch.js";
import type { DaemonServer } from "../daemon/server.js";
import type { WebSocketUplinkListenerFactory } from "../ports/uplink-websocket.js";
import type { GatewayRelay } from "../gateway/index.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  type Filesystem,
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
  direct: "slk_test_agent_direct_on_worker",
  one: "slk_test_agent_one",
  operator: "slk_test_operator",
  two: "slk_test_agent_two",
} as const;
const principals = { one: "tok_one", two: "tok_two" } as const;

const notAvailable = "agent-device is not available on this simlock: ";
const noWorker = "no worker connected to this gateway can serve agent-device";
const holderCannot = "the worker holding this lease cannot serve agent-device";
const missingMessage =
  "No worker connected to this gateway can serve agent-device for this request";
const tooOld = "refused: this agent-device is too old to use through a gateway; update it";
// why: shorter than the gateway's 10 s call timeout, so the read can finish once the fake clock moves past it.
const slowCatalogMs = 8_000;
const defaultTtlMs = 600_000;
const gatewayMaxTtlMs = 1_800_000;
const workerMaxTtlMs = 50_000_000;
const workerCeilingMs = 2 * workerMaxTtlMs;
const scope = { clientId: "client-1", leaseProvider: "proxy", runId: "run-1" } as const;
const endedMessage = "lease ended by simlock; run disconnect, then open";

const adminSession = {
  manageEventSubscription: () => undefined,
  principal: "admin",
  role: "admin",
} as const;

function sessionFor(principal: string) {
  return { manageEventSubscription: () => undefined, principal, role: "agent" } as const;
}

interface Envelope {
  readonly id?: unknown;
  readonly jsonrpc?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: {
      readonly code: string;
      readonly message: string;
      readonly details?: { readonly reason: string };
    };
  };
}

interface WorkerSpec {
  readonly label: string;
  readonly platform?: "ios" | "android";
  readonly model?: string;
  readonly capability?: "available" | "off" | "unavailable";
  readonly maxRunning?: number;
  // why: a worker that is reachable by an agent on its own HTTP port, the way a worker without a gateway is.
  readonly direct?: boolean;
  // why: a catalog read that waits for the fake clock, so a worker's catalog stays unread.
  readonly slowCatalog?: boolean;
  // why: a worker's model can be a TV, so an adopted lease reads target `tv`.
  readonly modelClass?: "phone" | "tv";
  // why: a worker whose own clock differs from the gateway's, to prove no rule reads a clock across the two.
  readonly clockSkewMs?: number;
}

interface Member {
  readonly spec: WorkerSpec;
  readonly label: string;
  readonly daemon: Promise<DaemonServer>;
  readonly fake: FakeAgentDevice;
  readonly driver: FakeDriver;
  readonly directory: string;
  readonly filesystem: Filesystem;
  readonly clock: FakeClock;
  // why: shared with the driver, so a test can make the next catalog read wait for the fake clock.
  readonly latency: Record<string, number>;
  readonly secret: string;
  readonly origin: string;
}

interface Rig {
  readonly clock: FakeClock;
  readonly gateway: DaemonServer;
  readonly directory: string;
  readonly logs: MemoryLogSink;
  readonly origin: string;
  readonly relay: GatewayRelay;
  readonly uplinks: WebSocketUplinkListenerFactory;
  readonly restart: () => Promise<void>;
  readonly members: Member[];
  readonly addWorker: (spec: WorkerSpec, existing?: Member) => Promise<Member>;
}

interface SetUpOptions {
  readonly agentDevice?: "enabled" | "unset";
  readonly command?: string;
  readonly leaseTtlCapMs?: number;
  readonly maxTtlMs?: number;
  readonly defaultTtlMs?: number;
  readonly workers?: readonly WorkerSpec[];
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

function driverFor(
  spec: WorkerSpec,
  clock: FakeClock,
  latency: Record<string, number>,
): FakeDriver {
  if (spec.platform === "android") {
    const model = spec.model ?? "Pixel 8";
    return new FakeDriver({
      availableOsVersions: ["35"],
      clock,
      defaultModels: { phone: [model] },
      latencyMs: latency,
      knownModels: [model],
      modelClasses: { [model]: "phone" },
      platform: "android",
    });
  }
  const modelClass = spec.modelClass ?? "phone";
  const model = spec.model ?? (modelClass === "tv" ? "Apple TV 4K" : "iPhone 16");
  return new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    defaultModels: { [modelClass]: [model] },
    latencyMs: latency,
    knownModels: [model],
    modelClasses: { [model]: modelClass },
    platform: "ios",
  });
}

async function agentTokensFile(filesystem: Filesystem, directory: string, records: string[][]) {
  await filesystem.mkdirp(directory);
  const hasher = new CryptoTokenSecrets();
  await filesystem.writeFileAtomic(
    join(directory, "tokens.json"),
    JSON.stringify(
      records.map(([id, secret, role]) => ({
        createdAt: 0,
        hash: hasher.hash(secret as string),
        id,
        role,
      })),
    ),
  );
}

// fallow-ignore-next-line complexity -- one rig that starts a gateway and any number of workers over a real uplink.
async function setUp(options: SetUpOptions = {}): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "sl-gw-"));
  temporaryDirectories.push(directory);
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  await agentTokensFile(filesystem, directory, [
    [principals.one, secrets.one, "agent"],
    [principals.two, secrets.two, "agent"],
    ["tok_operator", secrets.operator, "operator"],
  ]);
  const port = await freeLoopbackPort();
  const logs = new MemoryLogSink();
  let relay: GatewayRelay | undefined;
  let uplinks: WebSocketUplinkListenerFactory | undefined;
  const agentDevice = {
    enabled: true,
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.leaseTtlCapMs === undefined ? {} : { leaseTtlCapMs: options.leaseTtlCapMs }),
  };
  const startGateway = async (): Promise<DaemonServer> => {
    const started = await startDaemon({
      clock,
      configOverrides: {
        ...(options.agentDevice === "unset"
          ? {}
          : { capabilities: { "agent-device": agentDevice } }),
        http: { enabled: true, host: "127.0.0.1", port },
        lease: {
          defaultTtlMs: options.defaultTtlMs ?? defaultTtlMs,
          maxTtlMs: options.maxTtlMs ?? gatewayMaxTtlMs,
        },
        mode: "gateway",
      },
      dataDirectory: directory,
      filesystem,
      gatewayRelay: (created) => {
        relay = created;
      },
      gatewayUplinks: (created) => {
        uplinks = created;
      },
      logger: new JsonLinesLogger({ clock, level: "debug", sink: logs }),
      optionalModules: [agentDeviceModuleWith({})],
      statePath: join(directory, "state.json"),
      version: "1.2.3",
    } as StartDaemonOptions);
    runningDaemons.push(started);
    return started;
  };
  let gateway = await startGateway();
  const members: Member[] = [];
  // fallow-ignore-next-line complexity -- one worker daemon with its own token, directory, fake agent-device and optional direct port.
  const addWorker = async (spec: WorkerSpec, existing?: Member): Promise<Member> => {
    const secret =
      existing?.secret ??
      (await gateway.dispatch("token.create", { label: spec.label, role: "worker" }, adminSession))
        .secret;
    const workerDirectory = existing?.directory ?? (await mkdtemp(join(tmpdir(), "sl-w-")));
    if (existing === undefined) temporaryDirectories.push(workerDirectory);
    const workerFilesystem = existing?.filesystem ?? new MemoryFilesystem();
    const fake = existing?.fake ?? new FakeAgentDevice();
    if (spec.capability === "unavailable") fake.setUnavailable("down");
    const latency: Record<string, number> =
      spec.slowCatalog === true ? { listCatalog: slowCatalogMs } : {};
    const workerClock =
      spec.clockSkewMs === undefined ? clock : new FakeClock(1_000 + spec.clockSkewMs);
    const driver = driverFor(spec, workerClock, latency);
    let directPort: number | undefined;
    if (spec.direct === true) {
      directPort = await freeLoopbackPort();
      await agentTokensFile(workerFilesystem, workerDirectory, [
        [principals.one, secrets.direct, "agent"],
      ]);
    }
    const started = startDaemon({
      clock: workerClock,
      configOverrides: {
        capabilities: { "agent-device": { enabled: spec.capability !== "off" } },
        capacity: { config: { maxRunning: spec.maxRunning ?? 4 }, strategy: "fixed" },
        gateway: { label: spec.label, token: secret, url: `ws://127.0.0.1:${String(port)}` },
        ...(directPort === undefined
          ? {}
          : { http: { enabled: true, host: "127.0.0.1", port: directPort } }),
        lease: { defaultTtlMs, maxTtlMs: workerMaxTtlMs },
      },
      dataDirectory: workerDirectory,
      drivers: [driver],
      filesystem: workerFilesystem,
      logger: new JsonLinesLogger({
        clock: workerClock,
        level: "debug",
        sink: new MemoryLogSink(),
      }),
      optionalModules: [agentDeviceModuleWith({ upstream: fake })],
      statePath: join(workerDirectory, "state.json"),
      version: "1.2.3",
    } as StartDaemonOptions).then((daemon) => {
      runningDaemons.push(daemon);
      return daemon;
    });
    const member: Member = {
      clock: workerClock,
      daemon: started,
      directory: workerDirectory,
      driver,
      fake,
      filesystem: workerFilesystem,
      label: spec.label,
      latency,
      origin: directPort === undefined ? "" : `http://127.0.0.1:${String(directPort)}`,
      secret,
      spec,
    };
    members.push(member);
    return member;
  };
  const rig: Rig = {
    addWorker,
    clock,
    directory,
    get gateway() {
      return gateway;
    },
    logs,
    members,
    origin: `http://127.0.0.1:${String(port)}`,
    get relay() {
      if (relay === undefined) throw new Error("the gateway never handed over its relay");
      return relay;
    },
    restart: async () => {
      await gateway.stop("test");
      runningDaemons.splice(runningDaemons.indexOf(gateway), 1);
      gateway = await startGateway();
    },
    get uplinks() {
      if (uplinks === undefined) throw new Error("the gateway never handed over its uplinks");
      return uplinks;
    },
  };
  for (const spec of options.workers ?? [{ label: "w1" }]) {
    const member = await addWorker(spec);
    await member.daemon;
  }
  for (const member of members) await untilRead(rig, member);
  return rig;
}

async function viewOf(rig: Rig, label: string) {
  const { workers } = await rig.gateway.dispatch("worker.list", {}, adminSession);
  return workers.find((worker) => worker.label === label);
}

// why: a worker is usable for a gateway request only once its view carries capacity, capabilities and a catalog that has been read.
async function untilRead(rig: Rig, member: Member): Promise<void> {
  await vi.waitFor(
    async () => {
      const view = await viewOf(rig, member.label);
      expect(view?.connection).toBe("connected");
      expect(view?.capacity).toBeDefined();
      expect(view?.capabilities).toBeDefined();
      expect(view?.catalogReadAt).toBeDefined();
    },
    { timeout: 10_000 },
  );
}

async function turn(rig: Rig, member: Member, state: "available" | "unavailable"): Promise<void> {
  member.fake.setUnavailable(state === "available" ? undefined : "down");
  const worker = await member.daemon;
  await vi.waitFor(
    async () => {
      // why: a refused request is a lease event on the worker, which makes the gateway read it again.
      await worker
        .dispatch(
          "lease.request",
          { model: "Nope", noWait: true, platform: member.spec.platform ?? "ios" },
          sessionFor("poke"),
        )
        .catch(() => undefined);
      expect((await viewOf(rig, member.label))?.capabilities?.[0]?.state).toBe(state);
    },
    { timeout: 10_000 },
  );
}

async function advance(rig: Rig, ms: number, step = 5_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    const by = Math.min(step, ms - elapsed);
    rig.clock.advance(by);
    for (const member of rig.members) if (member.clock !== rig.clock) member.clock.advance(by);
    await sleep(15);
  }
}

interface SendOptions {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly signal?: AbortSignal;
  readonly token?: string | null;
}

function send(
  target: { readonly origin: string },
  path: string,
  options: SendOptions = {},
): Promise<Response> {
  const token = options.token === undefined ? secrets.one : options.token;
  return fetch(`${target.origin}/v1/agent-device${path}`, {
    ...(options.body === undefined ? {} : { body: options.body }),
    headers: {
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
  target: { readonly origin: string },
  method: string,
  params: Record<string, unknown>,
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return send(target, "/rpc", { ...options, body: rpcBody(method, params) });
}

async function envelopeOf(response: Response): Promise<Envelope> {
  const text = await response.text();
  expect(
    text.trimStart().startsWith("{"),
    `expected a JSON object body, got ${String(response.status)} ${text.slice(0, 80)}`,
  ).toBe(true);
  return JSON.parse(text) as Envelope;
}

const hex = (n: number): string => n.toString(16).padStart(32, "0");

function allocateParams(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...scope, leaseId: hex(n), platform: "ios", ttlMs: 120_000, ...extra };
}

function allocate(
  target: { readonly origin: string },
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(target, "agent_device.lease.allocate", allocateParams(n, extra), options);
}

async function granted(
  target: { readonly origin: string },
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<void> {
  const answer = await envelopeOf(await allocate(target, n, extra, options));
  expect(answer.result).toMatchObject({ ok: true });
}

function release(rig: Rig, n: number, options: Omit<SendOptions, "body"> = {}): Promise<Response> {
  return rpc(rig, "agent_device.lease.release", { ...scope, leaseId: hex(n) }, options);
}

function heartbeat(
  target: { readonly origin: string },
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(
    target,
    "agent_device.lease.heartbeat",
    { ...scope, leaseId: hex(n), ...extra },
    options,
  );
}

function command(
  target: { readonly origin: string },
  name: string,
  n: number | undefined,
  options: Omit<SendOptions, "body"> = {},
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const { meta, ...rest } = extra;
  return rpc(
    target,
    "agent_device.command",
    {
      command: name,
      ...(n === undefined && meta === undefined
        ? {}
        : { meta: { ...(n === undefined ? {} : { leaseId: hex(n) }), ...(meta as object) } }),
      ...rest,
    },
    options,
  );
}

interface LeaseView {
  readonly id: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly ttlDeadline: number;
  readonly worker?: { readonly id: string; readonly label?: string };
}

async function workerLeases(member: Member): Promise<readonly LeaseView[]> {
  return (await (
    await member.daemon
  ).dispatch("list.get", { kind: "leases" }, adminSession)) as unknown as readonly LeaseView[];
}

async function fleetLeases(rig: Rig, principal: string = principals.one) {
  const { leases } = await rig.gateway.dispatch("lease.list", {}, sessionFor(principal));
  return leases as unknown as readonly LeaseView[];
}

async function waiting(rig: Rig): Promise<readonly string[]> {
  const requests = (await rig.gateway.dispatch(
    "list.get",
    { kind: "requests" },
    adminSession,
  )) as unknown as readonly { readonly requesterId: string }[];
  return requests.map((request) => request.requesterId);
}

async function workerLeaseFor(member: Member, n: number): Promise<LeaseView> {
  const found = (await workerLeases(member)).find((lease) =>
    lease.requesterId.endsWith(`:${hex(n)}`),
  );
  expect(found, `the worker holds no lease for ${hex(n)}`).toBeDefined();
  return found as LeaseView;
}

async function deadlineOf(member: Member, n: number): Promise<number | undefined> {
  return (await workerLeases(member)).find((lease) => lease.requesterId.endsWith(`:${hex(n)}`))
    ?.ttlDeadline;
}

// why: the worker's lease requester is `gw:<gateway instance id>:<CLI lease id>`, which is where the gateway's instance id is read from; the tenant spells it with dots and writes each `_` of the principal as `_5f_`.
async function tenantOf(member: Member, n: number, principal: string = principals.one) {
  const lease = await workerLeaseFor(member, n);
  const prefix = lease.requesterId.slice(0, -(hex(n).length + 1));
  expect(prefix).toMatch(/^gw:[^:]+$/);
  return `gw.${prefix.slice("gw:".length)}.${principal.replaceAll("_", "_5f_")}`;
}

async function grantedDevice(member: Member) {
  const devices = (await (
    await member.daemon
  ).dispatch("list.get", { kind: "devices" }, adminSession)) as unknown as readonly {
    readonly address?: string;
    readonly state: string;
  }[];
  const device = devices.find((entry) => entry.address !== undefined);
  expect(device?.address).toBeDefined();
  return device as { readonly address: string };
}

async function deviceStates(member: Member): Promise<readonly string[]> {
  return (
    (await (
      await member.daemon
    ).dispatch("list.get", { kind: "devices" }, adminSession)) as unknown as readonly {
      readonly state: string;
    }[]
  ).map((device) => device.state);
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

type RawDispatch = (operation: string, input: unknown, session: unknown) => Promise<unknown>;

interface DispatchTap {
  readonly operations: string[];
  readonly inputs: { readonly operation: string; readonly input: Record<string, unknown> }[];
  afterNext(operation: string, run: () => Promise<void>): void;
  rejectNext(operation: string): void;
}

// why: the front reaches simlock through `daemon.dispatch` looked up at call time, so a wrapper on the daemon object sits between the front and leasing.
function tapDispatch(daemon: DaemonServer): DispatchTap {
  const target = daemon as unknown as { dispatch: RawDispatch };
  const original = target.dispatch.bind(target);
  const operations: string[] = [];
  const inputs: { operation: string; input: Record<string, unknown> }[] = [];
  const afters = new Map<string, () => Promise<void>>();
  const rejections = new Set<string>();
  target.dispatch = async (operation, input, session) => {
    operations.push(operation);
    if (rejections.delete(operation)) throw new Error(`${operation} failed`);
    inputs.push({ input: (input ?? {}) as Record<string, unknown>, operation });
    const result = await original(operation, input, session);
    const after = afters.get(operation);
    afters.delete(operation);
    await after?.();
    return result;
  };
  return {
    afterNext: (operation, run) => afters.set(operation, run),
    inputs,
    operations,
    rejectNext: (operation) => rejections.add(operation),
  };
}

type RelayFn = (workerId: string, call: unknown) => Promise<Response>;

// why: the relay is the gateway's own object, so a test decides what the next relays do before they reach the worker.
function interceptRelay(
  rig: Rig,
  before: (call: { readonly target: string; readonly request: Request }) => Promise<void> | void,
): void {
  const target = rig.relay as unknown as { relay: RelayFn };
  const original = target.relay.bind(target);
  target.relay = async (workerId, call) => {
    await before(call as { readonly target: string; readonly request: Request });
    return original(workerId, call);
  };
}

function relayFailsWith(rig: Rig, code: string, message: string): void {
  const target = rig.relay as unknown as { relay: RelayFn };
  target.relay = () => Promise.reject(new DispatchError(code, message));
}

const wipeOperations = new Set(["reclaim", "shutdown", "destroy"]);

function wipes(member: Member): number {
  return member.driver.calls.filter((call) => wipeOperations.has(call.operation)).length;
}

function heartbeatsReceived(member: Member): number {
  return member.fake.rpcRequests("agent_device.lease.heartbeat").length;
}

function allocatesReceived(member: Member, n?: number) {
  return member.fake
    .rpcRequests("agent_device.lease.allocate")
    .filter((request) => n === undefined || request.params?.["leaseId"] === hex(n));
}

async function runningCommand(
  rig: Rig,
  member: Member,
  n: number,
  options: Omit<SendOptions, "body"> = {},
) {
  member.fake.holdCommand();
  const before = member.fake.rpcRequests("agent_device.command").length;
  const running = track(command(rig, "snapshot", n, options));
  await expect.poll(() => member.fake.rpcRequests("agent_device.command").length).toBe(before + 1);
  return running;
}

function first(rig: Rig): Member {
  const member = rig.members[0];
  if (member === undefined) throw new Error("the rig has no worker");
  return member;
}

describe("the agent-device front, through a gateway", { timeout: 60_000 }, () => {
  it("with no capabilities.agent-device section on the gateway, /v1/agent-device/health answers 404, as today", async () => {
    const rig = await setUp({ agentDevice: "unset" });

    expect((await send(rig, "/health")).status).toBe(404);
  });

  it("with capabilities.agent-device.command set on a gateway, the gateway logs that it ignores it and starts; with capabilities.agent-device.leaseTtlCapMs above lease.maxTtlMs on a gateway, the gateway fails to start, as a worker does", async () => {
    const rig = await setUp({ command: "agent-device-elsewhere", workers: [] });

    expect((await send(rig, "/health")).status).toBe(200);
    expect(
      rig.logs.records.some(
        (record) =>
          record.level === "warn" &&
          record.message ===
            'Ignoring "capabilities.agent-device.command": it configures a worker, and this daemon runs in gateway mode.',
      ),
    ).toBe(true);

    await expect(setUp({ leaseTtlCapMs: gatewayMaxTtlMs + 1, workers: [] })).rejects.toThrow(
      /capabilities\.agent-device\.leaseTtlCapMs/,
    );
  });

  it("with no capabilities.agent-device section on the gateway, /rpc, upload/preflight, artifacts/<id> and a diagnostics URL each answer 404", async () => {
    const rig = await setUp({ agentDevice: "unset" });

    const answers = await Promise.all([
      send(rig, "/rpc", { body: rpcBody("agent_device.command", { command: "snapshot" }) }),
      send(rig, "/upload/preflight", { body: "{}" }),
      send(rig, "/artifacts/a.png"),
      send(rig, "/sessions/tok_one:s1/requests/r1/diagnostics"),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404]);
  });

  it("/health answers the proxy's health when a worker is capable, and the notAvailable reply naming `no worker connected to this gateway can serve agent-device`, with status 200, when none is; when the relay to the capable worker fails, it answers the notAvailable reply with status 200", async () => {
    const capable = await setUp();
    const health = await send(capable, "/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      service: "agent-device-proxy",
      upstream: { service: "agent-device-daemon" },
    });

    const none = await setUp({ workers: [{ capability: "off", label: "off" }] });
    const empty = await send(none, "/health");
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain(`${notAvailable}${noWorker}`);

    relayFailsWith(capable, "WORKER_UNREACHABLE", "Worker is not reachable");
    const failed = await send(capable, "/health");
    expect(failed.status).toBe(200);
    expect(await failed.text()).toContain(`${notAvailable}Worker is not reachable`);
  });

  it("with the only capable worker drained, allocate answers the notAvailable reply, while a command on a lease it already holds still works", async () => {
    const rig = await setUp();
    const member = first(rig);
    await granted(rig, 1);
    const view = await viewOf(rig, member.label);
    await rig.gateway.dispatch("worker.drain", { workerId: view?.id ?? "" }, adminSession);
    await vi.waitFor(async () => expect((await viewOf(rig, member.label))?.drained).toBe(true));

    const refused = await allocate(rig, 2);

    expect(refused.status).toBe(503);
    expect((await envelopeOf(refused)).error?.message).toBe(`${notAvailable}${noWorker}`);
    const before = member.fake.rpcRequests("agent_device.command").length;
    const held = await envelopeOf(await command(rig, "snapshot", 1));
    expect(held.result).toMatchObject({ command: "snapshot", ok: true });
    expect(member.fake.rpcRequests("agent_device.command").length).toBe(before + 1);
  });

  it("a worker that disconnected does not count as capable", async () => {
    const rig = await setUp();
    const original = first(rig);
    expect((await send(rig, "/health")).status).toBe(200);
    const stopped = await original.daemon;
    await stopped.stop("test");
    runningDaemons.splice(runningDaemons.indexOf(stopped), 1);
    await vi.waitFor(async () =>
      expect((await viewOf(rig, original.label))?.connection).toBe("disconnected"),
    );

    const answer = await send(rig, "/health");

    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain(`${notAvailable}${noWorker}`);
  });

  it("a worker whose view says `available` but whose catalog was not read yet does not count as capable", async () => {
    const rig = await setUp();
    const original = first(rig);
    const stopped = await original.daemon;
    await stopped.stop("test");
    runningDaemons.splice(runningDaemons.indexOf(stopped), 1);
    await vi.waitFor(async () =>
      expect((await viewOf(rig, original.label))?.connection).toBe("disconnected"),
    );

    const restarted = await rig.addWorker({ ...original.spec, slowCatalog: true }, original);
    void restarted.daemon;
    await vi.waitFor(
      async () => {
        const view = await viewOf(rig, original.label);
        expect(view?.connection).toBe("connected");
        expect(view?.capabilities?.[0]?.state).toBe("available");
        expect(view?.catalogReadAt).toBeUndefined();
      },
      { timeout: 10_000 },
    );

    const unread = await send(rig, "/health");
    expect(await unread.text()).toContain(`${notAvailable}${noWorker}`);

    await advance(rig, 9_000, 1_000);
    await vi.waitFor(async () => expect((await send(rig, "/health")).status).toBe(200), {
      timeout: 10_000,
    });
    await expect
      .poll(
        async () => ((await (await send(rig, "/health")).json()) as { service?: string }).service,
      )
      .toBe("agent-device-proxy");
  });

  it("allocate through the gateway makes a simlock lease on the capable worker, owned by the token's principal, whose id and gateway requester are the CLI's lease id, and its `lease.request` carries `requires: [\"agent-device\"]`", async () => {
    const rig = await setUp();
    const tap = tapDispatch(rig.gateway);

    await granted(rig, 1);

    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(1);
    expect(await fleetLeases(rig)).toMatchObject([
      {
        id: hex(1),
        ownerId: principals.one,
        requesterId: hex(1),
        worker: { label: first(rig).label },
      },
    ]);
    expect(await workerLeases(first(rig))).toHaveLength(1);
    const request = tap.inputs.find((entry) => entry.operation === "lease.request");
    expect(request?.input).toMatchObject({ requesterId: hex(1), requires: ["agent-device"] });
  });

  it("allocate on a worker, directly, sends no `requires`, as today", async () => {
    const rig = await setUp({ workers: [{ direct: true, label: "w1" }] });
    const member = first(rig);
    const tap = tapDispatch(await member.daemon);

    await granted(member, 1, {}, { token: secrets.direct });

    const request = tap.inputs.find((entry) => entry.operation === "lease.request");
    expect(request).toBeDefined();
    expect(request?.input).not.toHaveProperty("requires");
  });

  it("with two workers, one capable, every allocate over 5 tries lands on the capable one", async () => {
    const rig = await setUp({
      workers: [
        { capability: "off", label: "plain" },
        { capability: "available", label: "capable" },
      ],
    });

    const labels: (string | undefined)[] = [];
    for (let n = 1; n <= 5; n += 1) {
      await granted(rig, n);
      await expect.poll(async () => (await fleetLeases(rig)).length).toBe(1);
      labels.push((await fleetLeases(rig))[0]?.worker?.label);
      expect((await envelopeOf(await release(rig, n))).result).toMatchObject({ ok: true });
      await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
    }

    expect(labels).toEqual(Array.from({ length: 5 }, () => "capable"));
  });

  it("the allocate the worker's agent-device daemon receives names the granted device, carries `ttlMs` equal to that worker's ceiling, and has tenant `gw.<gateway instance id>.<principal>`", async () => {
    const rig = await setUp();
    const member = first(rig);

    await granted(rig, 1);

    const received = allocatesReceived(member, 1);
    expect(received).toHaveLength(1);
    const device = await grantedDevice(member);
    expect(received[0]?.params).toMatchObject({ ttlMs: workerCeilingMs, udid: device.address });
    expect(received[0]?.tenant).toBe(await tenantOf(member, 1));
  });

  it("allocate with no capable worker answers the notAvailable reply, and nothing is leased", async () => {
    const rig = await setUp({ workers: [{ capability: "off", label: "off" }] });
    const member = first(rig);

    const answer = await allocate(rig, 1);

    expect(answer.status).toBe(503);
    expect((await envelopeOf(answer)).error?.message).toBe(`${notAvailable}${noWorker}`);
    expect(await fleetLeases(rig)).toEqual([]);
    expect(await workerLeases(member)).toEqual([]);
    expect(member.fake.requests).toEqual([]);
  });

  it("allocate `--platform ios` when the capable workers have Android only is refused `refused: ios is not available on this simlock`", async () => {
    const rig = await setUp({ workers: [{ label: "droid", platform: "android" }] });
    await granted(rig, 1, { platform: "android" });
    await release(rig, 1);

    const answer = await envelopeOf(await allocate(rig, 2));

    expect(answer.error?.message).toBe("refused: ios is not available on this simlock");
    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
  });

  it("allocate when only an incapable worker knows the model answers `refused by simlock: No worker connected to this gateway can serve agent-device for this request`, and nothing is leased", async () => {
    const rig = await setUp({
      workers: [
        { label: "capable", model: "iPhone 16" },
        { capability: "off", label: "plain", model: "iPhone 17 Pro" },
      ],
    });
    await granted(rig, 1, { device: "iPhone 16" });
    await release(rig, 1);
    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);

    const answer = await envelopeOf(await allocate(rig, 2, { device: "iPhone 17 Pro" }));

    expect(answer.error?.message).toBe(`refused by simlock: ${missingMessage}`);
    expect(await fleetLeases(rig)).toEqual([]);
    for (const member of rig.members) expect(await workerLeases(member)).toEqual([]);
  });

  it("allocate whose lease's worker stops being capable between the grant and the forward releases the simlock lease and answers the notAvailable reply naming `the worker holding this lease cannot serve agent-device`", async () => {
    const rig = await setUp();
    const member = first(rig);
    const tap = tapDispatch(rig.gateway);
    tap.afterNext("lease.request", () => turn(rig, member, "unavailable"));

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error?.message).toBe(`${notAvailable}${holderCannot}`);
    await expect.poll(async () => (await workerLeases(member)).length).toBe(0);
    expect(await fleetLeases(rig)).toEqual([]);
    expect(allocatesReceived(member)).toEqual([]);
  });

  it("allocate relayed to a worker whose own agent-device went down while the gateway's view still said `available` answers the notAvailable reply with the worker's reason, and the simlock lease is released", async () => {
    const rig = await setUp();
    const member = first(rig);
    interceptRelay(rig, () => member.fake.setUnavailable("agent-device crashed"));

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error?.message).toBe(`${notAvailable}agent-device crashed`);
    await expect.poll(async () => (await workerLeases(member)).length).toBe(0);
    expect(await fleetLeases(rig)).toEqual([]);
  });

  it("with every matching device leased, allocate waits and is granted once one is released", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 1 }] });
    await granted(rig, 1);

    const second = track(allocate(rig, 2, {}, { token: secrets.two }));
    await expect.poll(() => waiting(rig)).toEqual([hex(2)]);
    expect(second.done()).toBe(false);

    await release(rig, 1);
    const answer = await envelopeOf(await second.promise);

    expect(answer.result).toMatchObject({ data: { lease: { leaseId: hex(2) } }, ok: true });
    await expect
      .poll(async () => (await fleetLeases(rig, principals.two)).map((lease) => lease.id))
      .toEqual([hex(2)]);
  });

  it("a CLI that hangs up while its allocate waits leaves the gateway's queue, and nothing is granted later", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 1 }] });
    const member = first(rig);
    await granted(rig, 1);
    const hangUp = new AbortController();
    const second = track(allocate(rig, 2, {}, { signal: hangUp.signal, token: secrets.two }));
    await expect.poll(() => waiting(rig)).toEqual([hex(2)]);

    hangUp.abort();
    await second.promise.catch(() => undefined);
    await expect.poll(() => waiting(rig)).toEqual([]);
    await release(rig, 1);
    await sleep(100);

    expect(await fleetLeases(rig, principals.two)).toEqual([]);
    expect(await workerLeases(member)).toEqual([]);
    expect(allocatesReceived(member, 2)).toEqual([]);
  });

  it("a command for the lease reaches that worker's agent-device daemon with the prefixed tenant, and its streamed reply reaches the CLI unchanged", async () => {
    const rig = await setUp();
    const member = first(rig);
    await granted(rig, 1);
    const chunks = ['{"progress":1}\n', '{"progress":2}\n', '{"done":true}\n'];
    member.fake.streamNextCommand(chunks);

    const streamed = await command(rig, "snapshot", 1);

    expect(await streamed.text()).toBe(chunks.join(""));
    expect(
      member.fake.rpcRequests("agent_device.command").map((request) => request.tenant),
    ).toEqual([await tenantOf(member, 1)]);
  });

  it("a heartbeat reaches the worker's agent-device daemon first, then renews the simlock lease to now plus its `ttlMs`", async () => {
    const rig = await setUp();
    const member = first(rig);
    await granted(rig, 1, { ttlMs: 60_000 });
    const allocated = await deadlineOf(member, 1);
    let deadlineAtDaemon: number | undefined;
    member.fake.onHeartbeat = async () => {
      deadlineAtDaemon = await deadlineOf(member, 1);
    };
    await advance(rig, 10_000, 5_000);

    const answer = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 120_000 }));

    expect(answer.result).toMatchObject({ ok: true });
    expect(deadlineAtDaemon).toBe(allocated);
    expect(member.fake.rpcRequests("agent_device.lease.heartbeat")[0]?.params).toMatchObject({
      ...scope,
      leaseId: hex(1),
      ttlMs: workerCeilingMs,
    });
    expect(await deadlineOf(member, 1)).toBe(rig.clock.now() + 120_000);
  });

  it("a heartbeat for a lease whose worker stopped being capable answers the notAvailable reply naming `the worker holding this lease cannot serve agent-device`", async () => {
    const rig = await setUp();
    const member = first(rig);
    await granted(rig, 1);
    expect((await envelopeOf(await heartbeat(rig, 1))).result).toMatchObject({ ok: true });
    await turn(rig, member, "unavailable");
    const received = heartbeatsReceived(member);

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expect(answer.error?.message).toBe(`${notAvailable}${holderCannot}`);
    expect(heartbeatsReceived(member)).toBe(received);
  });

  it("while a command runs longer than the TTL, the simlock lease is renewed every TTL/3 through the gateway and does not expire", async () => {
    const rig = await setUp();
    const member = first(rig);
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, member, 1);
    const tap = tapDispatch(rig.gateway);
    const deadlines: (number | undefined)[] = [];

    for (let tick = 0; tick < 9; tick += 1) {
      await advance(rig, 10_000, 5_000);
      await sleep(30);
      deadlines.push(await deadlineOf(member, 1));
    }

    expect(deadlines.every((deadline) => deadline !== undefined)).toBe(true);
    expect(deadlines.at(-1)).toBeGreaterThan(rig.clock.now());
    expect(new Set(deadlines).size).toBeGreaterThan(4);
    expect(tap.operations.filter((name) => name === "lease.renew").length).toBeGreaterThanOrEqual(
      7,
    );
    member.fake.releaseCommand();
  });

  it("release goes to the worker's agent-device daemon first, then releases the simlock lease, and the device is reclaimed", async () => {
    const rig = await setUp();
    const member = first(rig);
    let heldAtDaemonRelease: readonly string[] = [];
    member.fake.onRelease = async () => {
      heldAtDaemonRelease = (await workerLeases(member)).map((lease) => lease.requesterId);
    };
    await granted(rig, 1);

    const released = await envelopeOf(await release(rig, 1));

    expect(released.result).toMatchObject({ ok: true, released: true });
    expect(heldAtDaemonRelease).toHaveLength(1);
    expect(await workerLeases(member)).toEqual([]);
    await expect.poll(() => deviceStates(member)).toEqual(["ready"]);
    expect(await fleetLeases(rig)).toEqual([]);
  });

  it("a release the agent-device daemon fails keeps the simlock lease", async () => {
    const rig = await setUp();
    const member = first(rig);
    await granted(rig, 1);
    member.fake.failNextRelease({ code: "COMMAND_FAILED", message: "daemon could not release" });

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon could not release",
    });
    expect(await workerLeases(member)).toHaveLength(1);
    expect((await fleetLeases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("after `simlock release --all` on the gateway, the worker's agent-device lease is released before the wipe, and the next heartbeat reaches that worker and answers `LEASE_ENDED_BY_HOST`", async () => {
    const rig = await setUp();
    const member = first(rig);
    const wipesAtRelease: number[] = [];
    member.fake.onRelease = async () => {
      wipesAtRelease.push(wipes(member));
    };
    await granted(rig, 1);
    const before = wipes(member);

    await rig.gateway.dispatch("lease.release-all", {}, adminSession);

    await expect.poll(() => member.fake.rpcRequests("agent_device.lease.release").length).toBe(1);
    expect(wipesAtRelease).toEqual([before]);
    const received = heartbeatsReceived(member);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));

    expect(heartbeatsReceived(member)).toBe(received + 1);
  });

  it("a command with no device selector naming a lease id another token holds, and one the gateway does not know, answer `refused: lease <id> is not one of yours on this gateway` with status 403, and no worker receives it; with `--udid`, the same command answers `refused: simlock picks the device`, as on a worker", async () => {
    const rig = await setUp();
    const member = first(rig);
    await granted(rig, 1);
    const own = await envelopeOf(await command(rig, "snapshot", 1));
    expect(own.result).toMatchObject({ ok: true });
    const received = member.fake.rpcRequests("agent_device.command").length;

    const other = await command(rig, "snapshot", 1, { token: secrets.two });
    // why: within 60 s of the gateway starting, a lease it does not know answers "try again" (#517); past that, a refusal.
    rig.clock.advance(60_000);
    const unknown = await command(rig, "snapshot", 9);

    expect(other.status).toBe(403);
    expect((await envelopeOf(other)).error?.message).toBe(
      `refused: lease ${hex(1)} is not one of yours on this gateway`,
    );
    expect(unknown.status).toBe(403);
    expect((await envelopeOf(unknown)).error?.message).toBe(
      `refused: lease ${hex(9)} is not one of yours on this gateway`,
    );
    const picked = await envelopeOf(
      await command(rig, "snapshot", 1, { token: secrets.two }, { flags: { udid: "ABC" } }),
    );
    expect(picked.error?.message).toBe("refused: simlock picks the device");
    expect(member.fake.rpcRequests("agent_device.command").length).toBe(received);
  });

  it("after `simlock release --all`, once the fake clock has moved the gateway's `lease.maxTtlMs` plus 1 s past the index's removal of the lease, the link's memory no longer holds it, and a heartbeat for it answers `refused: lease <id> is not one of yours on this gateway`; one second before that, the heartbeat is still relayed", async () => {
    const options = { defaultTtlMs: 60_000, maxTtlMs: 120_000 } as const;
    const early = await setUp(options);
    const earlyMember = first(early);
    await granted(early, 1, { ttlMs: 30_000 });
    await early.gateway.dispatch("lease.release-all", {}, adminSession);
    await expect.poll(async () => (await fleetLeases(early)).length).toBe(0);
    await advance(early, 119_000, 10_000);
    const received = heartbeatsReceived(earlyMember);

    expectEndedBySimlock(await envelopeOf(await heartbeat(early, 1)));
    expect(heartbeatsReceived(earlyMember)).toBe(received + 1);

    const late = await setUp(options);
    const lateMember = first(late);
    await granted(late, 1, { ttlMs: 30_000 });
    await late.gateway.dispatch("lease.release-all", {}, adminSession);
    await expect.poll(async () => (await fleetLeases(late)).length).toBe(0);
    await advance(late, 121_000, 10_000);
    const lateReceived = heartbeatsReceived(lateMember);

    const answer = await envelopeOf(await heartbeat(late, 1));

    expect(answer.error?.message).toBe(
      `refused: lease ${hex(1)} is not one of yours on this gateway`,
    );
    expect(heartbeatsReceived(lateMember)).toBe(lateReceived);
  });

  it("a request with no lease id other than `/health` is refused with `refused: this agent-device is too old to use through a gateway; update it`", async () => {
    const rig = await setUp();
    const member = first(rig);
    expect((await send(rig, "/health")).status).toBe(200);
    const before = member.fake.requests.length;

    const bare = await envelopeOf(await command(rig, "snapshot", undefined));
    const upload = await send(rig, "/upload/preflight", { body: "{}" });

    expect(bare.error?.message).toBe(tooOld);
    expect(await upload.text()).toContain(tooOld);
    expect(member.fake.requests.length).toBe(before);
  });

  it("a relay that fails with `RELAY_TARGET_MISSING` answers the notAvailable reply with that message", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    expect((await envelopeOf(await command(rig, "snapshot", 1))).result).toMatchObject({
      ok: true,
    });
    relayFailsWith(rig, "RELAY_TARGET_MISSING", "no relay target agent-device on this worker");

    const answer = await command(rig, "snapshot", 1);

    expect(answer.status).toBe(503);
    expect((await envelopeOf(answer)).error?.message).toBe(
      `${notAvailable}no relay target agent-device on this worker`,
    );
  });

  it("an agent on a worker token with the same principal name as a gateway agent, connected to the worker directly, does not see the gateway agent's agent-device session, and the gateway agent's commands still work", async () => {
    const rig = await setUp({ workers: [{ direct: true, label: "w1" }] });
    const member = first(rig);
    await granted(rig, 1);
    expect((await envelopeOf(await heartbeat(rig, 1))).result).toMatchObject({ ok: true });

    const direct = await envelopeOf(await heartbeat(member, 1, {}, { token: secrets.direct }));

    expect(direct.result).toBeUndefined();
    expect(direct.error).toBeDefined();
    const seen = member.fake.rpcRequests("agent_device.lease.heartbeat").map((r) => r.tenant);
    expect(seen).toContain(principals.one);
    expect(seen).toContain(await tenantOf(member, 1));
    expect((await envelopeOf(await heartbeat(rig, 1))).result).toMatchObject({ ok: true });
    expect((await envelopeOf(await command(rig, "snapshot", 1))).result).toMatchObject({
      ok: true,
    });
  });

  it("`capabilities.agent-device.leaseTtlCapMs` on the gateway caps the TTL of a lease made through it", async () => {
    const rig = await setUp({ leaseTtlCapMs: 10_000 });
    const member = first(rig);

    await granted(rig, 1, { ttlMs: 300_000 });

    expect((await workerLeaseFor(member, 1)).ttlMs).toBe(10_000);
    await expect.poll(async () => (await fleetLeases(rig))[0]?.ttlMs).toBe(10_000);
  });

  it("stopping the gateway while an allocate waits ends its lease request `cancelled`, not `DAEMON_STOPPING`, and a running command's renewals stop", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 1 }] });
    const member = first(rig);
    await granted(rig, 1, { ttlMs: 30_000 }, { token: secrets.two });
    await runningCommand(rig, member, 1, { token: secrets.two });
    const tap = tapDispatch(rig.gateway);
    await advance(rig, 20_000, 5_000);
    const renewedBefore = tap.operations.filter((name) => name === "lease.renew").length;
    const second = track(allocate(rig, 2));
    await expect.poll(() => waiting(rig)).toEqual([hex(2)]);

    await rig.gateway.stop("test");
    await second.promise.catch(() => undefined);
    const afterStop = tap.operations.length;
    await advance(rig, 60_000, 10_000);

    expect(renewedBefore).toBeGreaterThan(0);
    expect(tap.operations.length).toBe(afterStop);
    const lines = (await readFile(join(rig.directory, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { event?: string; payload?: Record<string, unknown> });
    expect(
      lines.filter(
        (entry) =>
          entry.event === "lease.rejected" &&
          entry.payload?.["requester"] === hex(2) &&
          entry.payload["reason"] === "cancelled",
      ),
    ).toHaveLength(1);
    member.fake.releaseCommand();
  });

  it("stopping the gateway cancels the link's sweep of a lease the fleet removed, leaving the timers a gateway with no agent-device activity leaves", async () => {
    const idle = await setUp();
    await idle.gateway.stop("test");
    const rig = await setUp();
    await granted(rig, 1);
    expect((await envelopeOf(await release(rig, 1))).result).toMatchObject({ ok: true });
    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
    expect(rig.clock.pendingTimerCount).toBeGreaterThan(idle.clock.pendingTimerCount);

    await rig.gateway.stop("test");

    expect(rig.clock.pendingTimerCount).toBe(idle.clock.pendingTimerCount);
  });

  it("a heartbeat, a release and an allocate whose relay fails with `RELAY_TARGET_MISSING` answer the notAvailable reply with that message, and the failed allocate leaves no lease", async () => {
    const rig = await setUp();
    const member = first(rig);
    await granted(rig, 1);
    const missing = `${notAvailable}no relay target agent-device on this worker`;
    relayFailsWith(rig, "RELAY_TARGET_MISSING", "no relay target agent-device on this worker");

    const beat = await heartbeat(rig, 1);
    const released = await release(rig, 1);
    const made = await allocate(rig, 2);

    expect((await envelopeOf(beat)).error?.message).toBe(missing);
    expect((await envelopeOf(released)).error?.message).toBe(missing);
    expect((await envelopeOf(made)).error?.message).toBe(missing);
    await expect.poll(async () => (await workerLeases(member)).length).toBe(1);
  });

  it("a heartbeat for a lease the front's memory lacks, whose release relay then fails with `RELAY_TARGET_MISSING`, answers the notAvailable reply with that message and leaves the simlock lease", async () => {
    const rig = await setUp();
    const member = first(rig);
    await granted(rig, 1);
    const held = member.fake.leases.get(hex(1));
    expect(held).toBeDefined();
    member.fake.leases.set(hex(2), { ...(held as NonNullable<typeof held>), leaseId: hex(2) });
    // why: a lease whose requester is not its own id is never adopted, so the front's memory lacks it however soon the worker's catalog arrives.
    await rig.gateway.dispatch(
      "lease.request",
      { leaseId: hex(2), platform: "ios", requesterId: "someone-else", requires: ["agent-device"] },
      sessionFor(principals.one),
    );
    interceptRelay(rig, async ({ request }) => {
      const body = (await request.clone().json()) as { method?: string };
      if (body.method === "agent_device.lease.release") {
        throw new DispatchError(
          "RELAY_TARGET_MISSING",
          "no relay target agent-device on this worker",
        );
      }
    });

    const beat = await envelopeOf(await heartbeat(rig, 2));

    expect(beat.error?.message).toBe(`${notAvailable}no relay target agent-device on this worker`);
    expect((await fleetLeases(rig)).map((lease) => lease.id)).toContain(hex(2));
  });
});

const LEASE_HEADER = "x-agent-device-lease-id";
const notYoursOnGateway = (n: number): string =>
  `refused: lease ${hex(n)} is not one of yours on this gateway`;
const notALeaseId = "refused: the x-agent-device-lease-id header is not a lease id";

function leased(n: number): Record<string, string> {
  return { [LEASE_HEADER]: hex(n) };
}

function holderOf(rig: Rig, n: number): Member {
  const member = rig.members.find((candidate) => candidate.fake.leases.has(hex(n)));
  if (member === undefined) throw new Error(`no worker holds the agent-device lease ${hex(n)}`);
  return member;
}

// why: the gateway lists a lease only once its worker's next view reaches it, which can trail the grant.
async function listedByGateway(rig: Rig, count: number): Promise<void> {
  await expect.poll(async () => (await fleetLeases(rig)).length).toBe(count);
}

// why: a worker with room for one lease each puts two leases on two workers.
async function twoLeasesOnTwoWorkers(): Promise<Rig> {
  const rig = await setUp({
    workers: [
      { label: "w1", maxRunning: 1 },
      { label: "w2", maxRunning: 1 },
    ],
  });
  await granted(rig, 1);
  await granted(rig, 2);
  await listedByGateway(rig, 2);
  expect(holderOf(rig, 1)).not.toBe(holderOf(rig, 2));
  return rig;
}

function addressOfLease(rig: Rig, n: number): string {
  const address = holderOf(rig, n).fake.leases.get(hex(n))?.address;
  expect(address).toBeDefined();
  return address as string;
}

function pathsReceived(member: Member): string[] {
  return member.fake.requests.map((request) => request.path);
}

async function listedNames(response: Response): Promise<string[]> {
  const answer = await envelopeOf(response);
  const data = answer.result?.["data"] as { devices?: { name?: string }[] } | undefined;
  expect(Array.isArray(data?.devices), "expected a devices list in result.data").toBe(true);
  return (data?.devices ?? []).map((device) => String(device.name)).sort();
}

describe("the agent-device front, through a gateway: the lease header", { timeout: 60_000 }, () => {
  it("through the gateway, an upload preflight with the header naming the token's lease on W2 reaches W2's agent-device daemon and not W1's", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const target = holderOf(rig, 2);
    const other = holderOf(rig, 1);
    const before = pathsReceived(other);

    const preflight = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });

    expect(preflight.status).toBe(200);
    expect(pathsReceived(target)).toContain("/upload/preflight");
    expect(pathsReceived(other)).toEqual(before);
  });

  it("the preflight's ticket URL names the gateway's origin, its `upload.headers` carry the caller's own `authorization`, W2 received its own daemon's token in `authorization` and `x-agent-device-token` and none of the caller's credentials, and a `PUT` to it with the lease header and those headers reaches W2", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const target = holderOf(rig, 2);

    const preflight = await send(rig, "/upload/preflight", {
      body: "{}",
      headers: { ...leased(2), "x-agent-device-token": "caller-token" },
    });

    const ticket = (
      (await preflight.json()) as { upload: { url: string; headers: Record<string, string> } }
    ).upload;
    expect(ticket.url.startsWith(`${rig.origin}/v1/agent-device/upload/direct/`)).toBe(true);
    const named = (name: string) =>
      Object.entries(ticket.headers).find(([key]) => key.toLowerCase() === name)?.[1];
    expect(named("authorization")).toBe(`Bearer ${secrets.one}`);
    expect(named("x-agent-device-token")).toBe("caller-token");
    const seen = target.fake.preflightHeaders[0] ?? {};
    expect(seen["authorization"]).toBe(`Bearer ${target.fake.token}`);
    // why: the proxy sends its own daemon token in both headers, never the caller's.
    expect(seen["x-agent-device-token"]).toBe(target.fake.token);
    expect(Object.values(seen).join("\n")).not.toContain(secrets.one);
    expect(Object.values(seen).join("\n")).not.toContain("caller-token");

    const put = await fetch(ticket.url, {
      body: "artifact bytes",
      headers: { ...ticket.headers, ...leased(2) },
      method: "PUT",
    });

    expect(put.status).toBe(200);
    expect(target.fake.uploads).toEqual(["artifact bytes"]);
    expect(holderOf(rig, 1).fake.uploads).toEqual([]);
  });

  it("a finalize, a `POST /upload`, a `GET artifacts/<id>` and a diagnostics `GET`, each with the header, reach the lease's worker", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const target = holderOf(rig, 2);
    const other = holderOf(rig, 1);
    const before = pathsReceived(other);

    await send(rig, "/upload/finalize", { body: "{}", headers: leased(2) });
    // why: the proxy confines diagnostics to sessions under the caller's tenant, which the gateway names.
    const tenant = target.fake.requests.at(-1)?.tenant;
    expect(tenant).toBeDefined();
    const diagnostics = `/sessions/${String(tenant)}:s1/requests/r1/diagnostics`;
    await send(rig, "/upload", { body: "{}", headers: leased(2) });
    await send(rig, "/artifacts/a.png", { headers: leased(2) });
    await send(rig, diagnostics, { headers: leased(2) });

    const paths = pathsReceived(target);
    expect(paths).toContain("/upload/finalize");
    expect(paths).toContain("/upload");
    expect(paths).toContain("/artifacts/a.png");
    expect(paths).toContain(diagnostics);
    expect(pathsReceived(other)).toEqual(before);
  });

  it("through the gateway, the same requests without the header, or with an empty one, and a `GET artifacts` list, are refused with `refused: this agent-device is too old to use through a gateway; update it`", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const diagnostics = `/sessions/${principals.one}:s1/requests/r1/diagnostics`;
    const calls: readonly { path: string; body?: string }[] = [
      { body: "{}", path: "/upload/preflight" },
      { body: "{}", path: "/upload/finalize" },
      { body: "{}", path: "/upload" },
      { path: "/artifacts/a.png" },
      { path: diagnostics },
    ];
    for (const call of calls) {
      const accepted = await send(rig, call.path, {
        ...(call.body === undefined ? {} : { body: call.body }),
        headers: leased(2),
      });
      expect(await accepted.text()).not.toContain(tooOld);
    }
    const before = rig.members.map((member) => member.fake.requests.length);

    for (const call of calls) {
      for (const headers of [{}, { [LEASE_HEADER]: "" }]) {
        const answer = await send(rig, call.path, {
          ...(call.body === undefined ? {} : { body: call.body }),
          headers,
        });
        expect(await answer.text()).toContain(tooOld);
      }
    }
    const list = await send(rig, "/artifacts");
    expect(await list.text()).toContain(tooOld);

    expect(rig.members.map((member) => member.fake.requests.length)).toEqual(before);
  });

  it("through the gateway, a header naming another token's lease is refused `refused: lease <id> is not one of yours on this gateway` with status 403, and no agent-device daemon receives it", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const own = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });
    expect(own.status).toBe(200);
    const before = rig.members.map((member) => member.fake.requests.length);

    const other = await send(rig, "/upload/preflight", {
      body: "{}",
      headers: leased(2),
      token: secrets.two,
    });

    expect(other.status).toBe(403);
    expect(await other.text()).toContain(notYoursOnGateway(2));
    expect(rig.members.map((member) => member.fake.requests.length)).toEqual(before);
  });

  it("through the gateway, a header of 40 characters, and one with upper-case hex, are refused `refused: the x-agent-device-lease-id header is not a lease id` with status 400, and the reply does not contain the value", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const accepted = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });
    expect(accepted.status).toBe(200);
    const before = rig.members.map((member) => member.fake.requests.length);

    for (const value of ["a".repeat(40), `ABCDEF${"0".repeat(26)}`]) {
      const answer = await send(rig, "/upload/preflight", {
        body: "{}",
        headers: { [LEASE_HEADER]: value },
      });
      const text = await answer.text();
      expect(answer.status).toBe(400);
      expect(text).toContain(notALeaseId);
      expect(text).not.toContain(value);
    }

    expect(rig.members.map((member) => member.fake.requests.length)).toEqual(before);
  });

  it("through the gateway, a header naming the token's lease whose worker stopped being capable answers the notAvailable reply naming that reason", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const accepted = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });
    expect(accepted.status).toBe(200);
    const target = holderOf(rig, 2);
    await turn(rig, target, "unavailable");
    const before = pathsReceived(target);

    const answer = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });

    expect(await answer.text()).toContain(`${notAvailable}${holderCannot}`);
    expect(pathsReceived(target)).toEqual(before);
  });

  it("through the gateway, `/health` with a header naming another token's lease answers the proxy's health", async () => {
    const rig = await twoLeasesOnTwoWorkers();

    const health = await send(rig, "/health", { headers: leased(2), token: secrets.two });

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ service: "agent-device-proxy" });
  });

  it("through the gateway, an upload naming the token's lease after `simlock release --all` reaches that lease's worker", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const target = holderOf(rig, 2);
    await rig.gateway.dispatch("lease.release-all", {}, adminSession);
    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
    const before = pathsReceived(target).filter((path) => path === "/upload/preflight").length;

    const preflight = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });

    expect(await preflight.text()).not.toContain(notYoursOnGateway(2));
    expect(pathsReceived(target).filter((path) => path === "/upload/preflight").length).toBe(
      before + 1,
    );
  });

  it("through the gateway, `devices` with no lease held answers an empty list and no agent-device daemon receives it", async () => {
    const rig = await setUp({ workers: [{ label: "w1" }, { label: "w2" }] });
    for (const member of rig.members) member.fake.listDevices([{ id: "stray", name: "stray" }]);

    const answer = await envelopeOf(await command(rig, "devices", undefined));

    expect(answer.result).toMatchObject({ data: { devices: [] }, ok: true });
    for (const member of rig.members) {
      expect(member.fake.rpcRequests("agent_device.command")).toEqual([]);
    }
  });

  it("through the gateway, `devices` with leases on W1 and W2 answers both devices, each once, and no device of another token", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    for (const [index, n] of [1, 2].entries()) {
      holderOf(rig, n).fake.listDevices([
        { id: addressOfLease(rig, n), name: `mine-${String(index)}` },
        { id: "another-token-device", name: "foreign" },
      ]);
    }

    expect(await listedNames(await command(rig, "devices", undefined))).toEqual([
      "mine-0",
      "mine-1",
    ]);
  });

  it("through the gateway, `devices` with leases on W1 and W2 whose emulators are both `emulator-5554` answers both, each from its own worker", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    expect(addressOfLease(rig, 1)).toBe(addressOfLease(rig, 2));
    holderOf(rig, 1).fake.listDevices([{ id: addressOfLease(rig, 1), name: "from-first" }]);
    holderOf(rig, 2).fake.listDevices([{ id: addressOfLease(rig, 2), name: "from-second" }]);

    expect(await listedNames(await command(rig, "devices", undefined))).toEqual([
      "from-first",
      "from-second",
    ]);
  });

  it("through the gateway, `devices` with two leases on one worker answers both devices, each once", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 2 }] });
    await granted(rig, 1);
    await granted(rig, 2);
    await listedByGateway(rig, 2);
    const member = first(rig);
    member.fake.listDevices([
      { id: addressOfLease(rig, 1), name: "first" },
      { id: addressOfLease(rig, 2), name: "second" },
      { id: "another-token-device", name: "foreign" },
    ]);

    expect(await listedNames(await command(rig, "devices", undefined))).toEqual([
      "first",
      "second",
    ]);
  });

  it("through the gateway, `devices` when W2's agent-device answers an error passes that error on; when W2 answers a body with no list, it answers `could not read the device list from the worker holding lease <id>` with status 502", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    holderOf(rig, 1).fake.listDevices([{ id: addressOfLease(rig, 1), name: "first" }]);
    const second = holderOf(rig, 2).fake;
    second.answerDevicesWith(
      JSON.stringify({
        error: {
          code: -32000,
          data: { code: "COMMAND_FAILED", message: "inventory down" },
          message: "inventory down",
        },
        id: 1,
        jsonrpc: "2.0",
      }),
    );

    const failed = await envelopeOf(await command(rig, "devices", undefined));

    expect(failed.error?.message).toBe("inventory down");

    second.answerDevicesWith(
      JSON.stringify({ id: 1, jsonrpc: "2.0", result: { data: {}, ok: true } }),
    );
    const unreadable = await command(rig, "devices", undefined);

    expect(unreadable.status).toBe(502);
    expect((await envelopeOf(unreadable)).error?.message).toBe(
      `could not read the device list from the worker holding lease ${hex(2)}`,
    );
  });

  it("through the gateway, `devices` whose lease check fails answers `could not check your leases; try again`, not an empty list, and no daemon receives the command", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    for (const n of [1, 2]) {
      holderOf(rig, n).fake.listDevices([
        { id: addressOfLease(rig, n), name: `mine-${String(n)}` },
      ]);
    }
    const tap = tapDispatch(rig.gateway);
    tap.rejectNext("lease.list");
    const before = rig.members.map(
      (member) => member.fake.rpcRequests("agent_device.command").length,
    );

    const answer = await envelopeOf(await command(rig, "devices", undefined));

    expect(answer.error?.message).toBe("could not check your leases; try again");
    expect(
      rig.members.map((member) => member.fake.rpcRequests("agent_device.command").length),
    ).toEqual(before);
  });

  it("through the gateway, `devices` when W2 answers a body with no list aborts the forward still waiting on W1", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const slow = holderOf(rig, 1).fake;
    slow.holdCommand();
    holderOf(rig, 2).fake.answerDevicesWith(
      JSON.stringify({ id: 1, jsonrpc: "2.0", result: { data: {}, ok: true } }),
    );

    const answer = await command(rig, "devices", undefined);

    expect(answer.status).toBe(502);
    expect((await envelopeOf(answer)).error?.message).toBe(
      `could not read the device list from the worker holding lease ${hex(2)}`,
    );
    await expect.poll(() => slow.abortedCommands).toEqual(["devices"]);
  });

  it("through the gateway, a CLI that hangs up during `devices` aborts every forward", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    for (const member of rig.members) member.fake.holdCommand();
    const hangUp = new AbortController();
    const held = track(command(rig, "devices", undefined, { signal: hangUp.signal }));
    await expect
      .poll(() =>
        rig.members.map((member) => member.fake.rpcRequests("agent_device.command").length),
      )
      .toEqual([1, 1]);

    hangUp.abort();
    await held.promise.catch(() => undefined);

    await expect
      .poll(() => rig.members.map((member) => member.fake.abortedCommands))
      .toEqual([["devices"], ["devices"]]);
  });

  it("through the gateway, `release_materialized_paths` and an `install_from_source` naming the token's lease are refused `refused: unknown method <method>`, and no worker sees either", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const before = rig.members.map((member) => member.fake.requests.length);

    const released = await envelopeOf(
      await rpc(rig, "agent_device.release_materialized_paths", {
        materializationId: "m-1",
      }),
    );
    const installed = await envelopeOf(
      await rpc(rig, "agent_device.install_from_source", {
        meta: { leaseId: hex(2) },
        platform: "ios",
        source: { kind: "url", url: "https://example.com/App.zip" },
      }),
    );

    expect(released.error?.message).toBe(
      "refused: unknown method agent_device.release_materialized_paths",
    );
    expect(installed.error?.message).toBe(
      "refused: unknown method agent_device.install_from_source",
    );
    expect(rig.members.map((member) => member.fake.requests.length)).toEqual(before);
  });
});

const unreachableReason =
  "the worker holding this device is not connected to the gateway; try again";
const unreachableMessage = `${notAvailable}${unreachableReason}`;
const picksTheDevice = "refused: simlock picks the device";
const gatewayWindowMs = 60_000;
const hourMs = 3_600_000;

function expectUnreachable(answer: Envelope): void {
  expect(answer.result).toBeUndefined();
  expect(answer.error).toMatchObject({
    data: { details: { reason: "WORKER_UNREACHABLE" }, message: unreachableMessage },
    message: unreachableMessage,
  });
}

async function expectUnreachablePlain(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body["error"]).toBe(unreachableMessage);
  expect(body).not.toHaveProperty("details");
}

async function expectUnreachableEverywhere(rig: Rig, n: number): Promise<void> {
  for (const response of [
    await heartbeat(rig, n),
    await command(rig, "snapshot", n),
    await release(rig, n),
  ]) {
    expect(response.status).toBe(503);
    expectUnreachable(await envelopeOf(response));
  }
  await expectUnreachablePlain(
    await send(rig, "/upload/preflight", { body: "{}", headers: leased(n) }),
  );
}

// why: the gateway closes the worker's socket as a network drop does; the worker redials only when its clock moves.
async function dropUplink(rig: Rig, member: Member): Promise<void> {
  const view = await viewOf(rig, member.label);
  expect(view?.id).toBeDefined();
  await rig.uplinks.closeWorkerLink(view?.id as string);
  await vi.waitFor(
    async () => expect((await viewOf(rig, member.label))?.connection).toBe("disconnected"),
    { timeout: 10_000 },
  );
}

async function untilConnected(rig: Rig, member: Member): Promise<void> {
  await advance(rig, 2_000, 500);
  await untilRead(rig, member);
}

function commandsReceived(member: Member): number {
  return member.fake.rpcRequests("agent_device.command").length;
}

async function commandWorks(rig: Rig, member: Member, n: number): Promise<void> {
  const before = commandsReceived(member);
  const answer = await envelopeOf(await command(rig, "snapshot", n));
  expect(answer.error).toBeUndefined();
  expect(answer.result).toBeDefined();
  expect(commandsReceived(member)).toBe(before + 1);
}

describe(
  "the agent-device front, through a gateway: an unreachable worker",
  {
    timeout: 90_000,
  },
  () => {
    it("with the device's worker disconnected, a command, a heartbeat and a release each answer 503 with `details.reason` `WORKER_UNREACHABLE` and the `workerUnreachable` message, and no agent-device daemon receives them", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1);
      await listedByGateway(rig, 1);
      await dropUplink(rig, member);
      const received = member.fake.requests.length;

      for (const response of [
        await command(rig, "snapshot", 1),
        await heartbeat(rig, 1),
        await release(rig, 1),
      ]) {
        expect(response.status).toBe(503);
        expectUnreachable(await envelopeOf(response));
      }

      expect(member.fake.requests.length).toBe(received);
    });

    it("with the device's worker disconnected, an upload with the lease header answers 503 with that message and no `details`, and `devices` answers the RPC reply with `details`", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1);
      await listedByGateway(rig, 1);
      await dropUplink(rig, member);

      await expectUnreachablePlain(
        await send(rig, "/upload/preflight", { body: "{}", headers: leased(1) }),
      );
      const devices = await command(rig, "devices", undefined);

      expect(devices.status).toBe(503);
      expectUnreachable(await envelopeOf(devices));
    });

    it("with one of the token's two workers reconnected but not yet read and the other connected, `devices` answers `workerUnreachable()` and asks neither worker", async () => {
      const rig = await twoLeasesOnTwoWorkers();
      const gone = holderOf(rig, 1);
      const kept = holderOf(rig, 2);
      await listedByGateway(rig, 2);
      await dropUplink(rig, gone);
      gone.latency["listCatalog"] = slowCatalogMs;
      await advance(rig, 2_000, 500);
      await vi.waitFor(
        async () => {
          const view = await viewOf(rig, gone.label);
          expect(view?.connection).toBe("connected");
          expect(view?.catalogReadAt).toBeUndefined();
        },
        { timeout: 10_000 },
      );
      const received = [gone, kept].map((member) => member.fake.requests.length);

      const devices = await command(rig, "devices", undefined);

      expect(devices.status).toBe(503);
      expectUnreachable(await envelopeOf(devices));
      expect([gone, kept].map((member) => member.fake.requests.length)).toEqual(received);
    });

    it("while the worker is disconnected, the simlock lease is not released, and the front's entry is not marked ended", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1);
      await listedByGateway(rig, 1);
      const tap = tapDispatch(rig.gateway);
      await dropUplink(rig, member);

      expectUnreachable(await envelopeOf(await heartbeat(rig, 1)));
      expectUnreachable(await envelopeOf(await release(rig, 1)));

      expect(tap.operations).not.toContain("lease.release");
      expect((await fleetLeases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
      await untilConnected(rig, member);
      const beat = await envelopeOf(await heartbeat(rig, 1));
      expect(beat.error).toBeUndefined();
      expect(beat.result).toMatchObject({ ok: true });
    });

    it("the uplink dropping mid-command answers the command with `workerUnreachable()`", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1);
      await listedByGateway(rig, 1);
      const running = await runningCommand(rig, member, 1);

      await dropUplink(rig, member);

      await vi.waitFor(() => expect(running.done()).toBe(true), { timeout: 5_000 });
      member.fake.releaseCommand();
      const answer = await running.promise;
      expect(answer.status).toBe(503);
      expectUnreachable(await envelopeOf(answer));
    });

    it("right after the worker reconnects and before its view is refreshed, a command answers `workerUnreachable()`; once it is refreshed, within the TTL, the next command reaches it, and the next heartbeat renews the lease", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1, { ttlMs: 60_000 });
      await listedByGateway(rig, 1);
      await dropUplink(rig, member);
      member.latency["listCatalog"] = slowCatalogMs;
      await advance(rig, 2_000, 500);
      await vi.waitFor(
        async () => {
          const view = await viewOf(rig, member.label);
          expect(view?.connection).toBe("connected");
          expect(view?.catalogReadAt).toBeUndefined();
        },
        { timeout: 10_000 },
      );

      expectUnreachable(await envelopeOf(await command(rig, "snapshot", 1)));

      await advance(rig, 9_000, 1_000);
      await untilRead(rig, member);
      await commandWorks(rig, member, 1);
      const beat = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 120_000 }));
      expect(beat.result).toMatchObject({ ok: true });
      expect(await deadlineOf(member, 1)).toBe(rig.clock.now() + 120_000);
    });

    it("a worker that stays disconnected past the TTL: once it reconnects, the next heartbeat answers `LEASE_ENDED_BY_HOST`", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1);
      await listedByGateway(rig, 1);
      await dropUplink(rig, member);

      // why: one jump fires the worker's redial and the lease's expiry together, before the new socket is up.
      await sleep(50);
      rig.clock.advance(130_000);
      await untilConnected(rig, member);

      expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    });

    it("a lease known only from the link's memory (after `simlock release --all`) whose worker then disconnects answers `workerUnreachable()`", async () => {
      // why: a worker clock of its own, so moving the gateway's clock past the start window does not make the worker redial.
      const rig = await setUp({ workers: [{ clockSkewMs: 0, label: "w1" }] });
      const member = first(rig);
      await granted(rig, 1);
      await rig.gateway.dispatch("lease.release-all", {}, adminSession);
      await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
      await dropUplink(rig, member);
      // why: past the 60 s start window an unplaced lease is not unreachable, so only the link's memory can place this one.
      rig.clock.advance(70_000);

      expectUnreachable(await envelopeOf(await heartbeat(rig, 1)));
    });

    it("a running command's renewal tick while the worker is disconnected fails, and the entry and its timer stay; after the reconnect the next tick renews", async () => {
      // why: a worker clock of its own, so moving the gateway's clock does not make the worker redial.
      const rig = await setUp({ workers: [{ clockSkewMs: 0, label: "w1" }] });
      const member = first(rig);
      await granted(rig, 1, { ttlMs: 30_000 });
      await listedByGateway(rig, 1);
      await runningCommand(rig, member, 1);
      const tap = tapDispatch(rig.gateway);
      const before = await deadlineOf(member, 1);
      await dropUplink(rig, member);

      rig.clock.advance(10_000);
      await sleep(50);

      expect(tap.operations).toContain("lease.renew");
      expect(tap.operations).not.toContain("lease.release");
      expect((await fleetLeases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
      await untilConnected(rig, member);
      await advance(rig, 10_000, 5_000);
      await sleep(50);
      expect(await deadlineOf(member, 1)).toBeGreaterThan(before ?? 0);
      expect((await envelopeOf(await heartbeat(rig, 1))).result).toMatchObject({ ok: true });
      member.fake.releaseCommand();
    });

    it("an allocate by the same token while its other lease's worker is disconnected does not mark that lease ended", async () => {
      const rig = await setUp({
        workers: [
          { label: "w1", maxRunning: 1 },
          { label: "w2", maxRunning: 1 },
        ],
      });
      await granted(rig, 1);
      await listedByGateway(rig, 1);
      const holder = holderOf(rig, 1);
      await dropUplink(rig, holder);

      await granted(rig, 2);
      expect((await fleetLeases(rig)).map((lease) => lease.id)).toContain(hex(1));
      await untilConnected(rig, holder);

      const beat = await envelopeOf(await heartbeat(rig, 1));
      expect(beat.error).toBeUndefined();
      expect(beat.result).toMatchObject({ ok: true });
    });
  },
);

async function restarted(rig: Rig, member: Member, leases: number): Promise<void> {
  await rig.restart();
  // why: the worker's redial delay doubles with each restart in a row and carries jitter, so the clock moves on until the worker is back instead of by a sum that a fourth restart can outrun.
  await vi.waitFor(
    async () => {
      const view = await viewOf(rig, member.label);
      if (view?.connection !== "connected") await advance(rig, 1_000, 500);
      expect(view?.connection).toBe("connected");
    },
    { interval: 20, timeout: 30_000 },
  );
  await untilRead(rig, member);
  await expect.poll(async () => (await fleetLeases(rig)).length).toBe(leases);
}

describe(
  "the agent-device front, through a gateway: after a gateway restart",
  {
    timeout: 90_000,
  },
  () => {
    it("after a gateway restart and the worker's reconnect, the next heartbeat for the lease reaches the worker's agent-device daemon and renews the simlock lease, and a following command works", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1, { ttlMs: 60_000 });
      await listedByGateway(rig, 1);
      await restarted(rig, member, 1);
      const received = heartbeatsReceived(member);

      const beat = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 120_000 }));

      expect(beat.result).toMatchObject({ ok: true });
      expect(heartbeatsReceived(member)).toBe(received + 1);
      expect(await deadlineOf(member, 1)).toBe(rig.clock.now() + 120_000);
      await commandWorks(rig, member, 1);
    });

    it("after a gateway restart, a command, a release, `devices` and an upload with the lease header, each as the token's first request, work on the adopted lease", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1);
      await listedByGateway(rig, 1);

      await restarted(rig, member, 1);
      await commandWorks(rig, member, 1);

      await restarted(rig, member, 1);
      member.fake.listDevices([{ id: addressOfLease(rig, 1), name: "adopted" }]);
      expect(await listedNames(await command(rig, "devices", undefined))).toEqual(["adopted"]);

      await restarted(rig, member, 1);
      const preflight = await send(rig, "/upload/preflight", { body: "{}", headers: leased(1) });
      expect(preflight.status).toBe(200);
      expect(pathsReceived(member)).toContain("/upload/preflight");

      await restarted(rig, member, 1);
      const released = await envelopeOf(await release(rig, 1));
      expect(released.result).toMatchObject({ ok: true, released: true });
      expect(await fleetLeases(rig)).toEqual([]);
    });

    it("after a gateway restart, an adopted lease on a TV model reads target `tv`, and `test --target tv` sharding uses it", async () => {
      const rig = await setUp({ workers: [{ label: "w1", modelClass: "tv" }] });
      const member = first(rig);
      await granted(rig, 1, { target: "tv" });
      await listedByGateway(rig, 1);
      await restarted(rig, member, 1);

      const answer = await envelopeOf(
        await command(rig, "test", 1, {}, { flags: { shardAll: 1, target: "tv" } }),
      );

      expect(answer.error).toBeUndefined();
      const sent = member.fake.rpcRequests("agent_device.command").at(-1)?.params;
      const flags = (sent?.["flags"] ?? {}) as Record<string, unknown>;
      expect(flags["device"]).toBe(addressOfLease(rig, 1));
    });

    it("after a gateway restart, a command naming a `deviceKey` on the adopted lease is accepted and sets it; a later command naming another `deviceKey` is refused `refused: simlock picks the device`", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1);
      await listedByGateway(rig, 1);
      await restarted(rig, member, 1);

      const accepted = await envelopeOf(
        await command(rig, "snapshot", 1, {}, { meta: { deviceKey: "key-a" } }),
      );
      expect(accepted.error).toBeUndefined();
      const received = commandsReceived(member);
      const other = await envelopeOf(
        await command(rig, "snapshot", 1, {}, { meta: { deviceKey: "key-b" } }),
      );

      expect(other.error?.message).toBe(picksTheDevice);
      expect(commandsReceived(member)).toBe(received);
      const same = await envelopeOf(
        await command(rig, "snapshot", 1, {}, { meta: { deviceKey: "key-a" } }),
      );
      expect(same.error).toBeUndefined();
    });

    it("within 60 s of a gateway restart, before the worker reconnects, a heartbeat, a command, a release and an upload with the lease header for the lease each answer `workerUnreachable()`; after 60 s, with another capable worker connected, a heartbeat for it answers `refused: lease <id> is not one of yours on this gateway`", async () => {
      // why: a worker clock of its own, so the worker does not redial until the test moves it.
      const rig = await setUp({ workers: [{ clockSkewMs: 0, label: "w1" }] });
      const member = first(rig);
      await granted(rig, 1);
      await listedByGateway(rig, 1);
      await rig.restart();
      const received = member.fake.requests.length;

      await expectUnreachableEverywhere(rig, 1);

      expect(member.fake.requests.length).toBe(received);
      const other = await rig.addWorker({ label: "w2" });
      await other.daemon;
      await untilRead(rig, other);
      rig.clock.advance(gatewayWindowMs + 1_000);
      const beat = await envelopeOf(await heartbeat(rig, 1));
      expect(beat.error?.message).toBe(notYoursOnGateway(1));
    });

    it("after a gateway restart, a lease of another token is not adopted, and a heartbeat naming it is refused", async () => {
      const rig = await setUp();
      const member = first(rig);
      await granted(rig, 1, {}, { token: secrets.two });
      await expect.poll(async () => (await fleetLeases(rig, principals.two)).length).toBe(1);
      await rig.restart();
      await untilConnected(rig, member);
      await expect.poll(async () => (await fleetLeases(rig, principals.two)).length).toBe(1);
      const received = commandsReceived(member);

      const beat = await envelopeOf(await heartbeat(rig, 1));
      const devices = await envelopeOf(await command(rig, "devices", undefined));

      expect(beat.error?.message).toBe(notYoursOnGateway(1));
      expect(devices.result).toMatchObject({ data: { devices: [] }, ok: true });
      expect(commandsReceived(member)).toBe(received);
    });

    it("after a gateway restart, a lease of this token whose requester is not its own id is not adopted", async () => {
      const rig = await setUp();
      const member = first(rig);
      await rig.gateway.dispatch(
        "lease.request",
        { platform: "ios", requesterId: "someone-else", requires: ["agent-device"] },
        sessionFor(principals.one),
      );
      await restarted(rig, member, 1);
      const received = commandsReceived(member);

      const devices = await envelopeOf(await command(rig, "devices", undefined));

      expect(devices.result).toMatchObject({ data: { devices: [] }, ok: true });
      expect(commandsReceived(member)).toBe(received);
    });

    it("a lease this gateway process asked for whose allocate failed after the grant (the uplink dropped mid-allocate) is never adopted, and stays out of `devices`, also when the worker's clock is an hour behind or ahead of the gateway's", async () => {
      for (const skew of [0, -hourMs, hourMs]) {
        const rig = await setUp({ workers: [{ clockSkewMs: skew, label: "w1" }] });
        const member = first(rig);
        member.fake.holdAllocate();
        const running = track(allocate(rig, 1));
        await expect.poll(() => allocatesReceived(member, 1).length).toBe(1);
        await dropUplink(rig, member);
        member.fake.letAllocateGo();
        await running.promise;
        await untilConnected(rig, member);
        const received = commandsReceived(member);

        const devices = await envelopeOf(await command(rig, "devices", undefined));

        expect(devices.result, `skew ${String(skew)}`).toMatchObject({
          data: { devices: [] },
          ok: true,
        });
        expect(commandsReceived(member)).toBe(received);
      }
    });

    it("after a gateway restart, a lease made before it is adopted when the worker's clock is an hour behind or ahead of the gateway's", async () => {
      for (const skew of [-hourMs, hourMs]) {
        const rig = await setUp({ workers: [{ clockSkewMs: skew, label: "w1" }] });
        const member = first(rig);
        await granted(rig, 1);
        await listedByGateway(rig, 1);
        await restarted(rig, member, 1);

        const beat = await envelopeOf(await heartbeat(rig, 1));

        expect(beat.error, `skew ${String(skew)}`).toBeUndefined();
        expect(beat.result).toMatchObject({ ok: true });
        await commandWorks(rig, member, 1);
      }
    });
  },
);

describe(
  "the agent-device front, through a gateway: downloads over 2 GiB",
  { timeout: 120_000 },
  () => {
    const limit = 2_147_483_648;

    it("an artifact download whose `content-length` is 2147483649 gets the 413 reply; the worker's fake produced 0 bytes and its body was cancelled", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const worker = holderOf(rig, 1);
      worker.fake.serveArtifact({ contentLength: "size", size: limit + 1 });

      const response = await send(rig, "/artifacts/a1", { headers: leased(1) });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        code: "INVALID_ARGS",
        error: `the download is ${String(limit + 1)} bytes; simlock carries downloads up to 2 GB (2147483648 bytes)`,
        ok: false,
      });
      expect(worker.fake.artifactBytesProduced).toBe(0);
      await expect.poll(() => worker.fake.artifactBodyCancelled).toBe(true);
    });

    it("a download with no `content-length` that passes 2147483648 bytes errors the agent's response, which never ends cleanly", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const worker = holderOf(rig, 1);
      worker.fake.serveArtifact({ contentLength: "none", size: limit + 1 });

      const response = await send(rig, "/artifacts/a1", { headers: leased(1) });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const hash = createHash("sha256");
      let ended = false;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            ended = true;
            break;
          }
          hash.update(next.value);
        }
      } catch {
        ended = false;
      }

      expect(ended).toBe(false);
    });
  },
);
