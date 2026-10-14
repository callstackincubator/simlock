import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDriver } from "../core/testing.js";
import { startDaemon, type StartDaemonOptions } from "../daemon/main.js";
import { DispatchError } from "../daemon/dispatch.js";
import type { DaemonServer } from "../daemon/server.js";
import type { GatewayRelay } from "../gateway/index.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  type Filesystem,
} from "../ports/index.js";
import { FakeAgentDevice } from "./testing.js";

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
}

interface Member {
  readonly spec: WorkerSpec;
  readonly label: string;
  readonly daemon: Promise<DaemonServer>;
  readonly fake: FakeAgentDevice;
  readonly driver: FakeDriver;
  readonly directory: string;
  readonly filesystem: Filesystem;
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

function driverFor(spec: WorkerSpec, clock: FakeClock): FakeDriver {
  if (spec.platform === "android") {
    const model = spec.model ?? "Pixel 8";
    return new FakeDriver({
      availableOsVersions: ["35"],
      clock,
      defaultModels: { phone: [model] },
      ...(spec.slowCatalog === true ? { latencyMs: { listCatalog: slowCatalogMs } } : {}),
      knownModels: [model],
      modelClasses: { [model]: "phone" },
      platform: "android",
    });
  }
  const model = spec.model ?? "iPhone 16";
  return new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    defaultModels: { phone: [model] },
    ...(spec.slowCatalog === true ? { latencyMs: { listCatalog: slowCatalogMs } } : {}),
    knownModels: [model],
    modelClasses: { [model]: "phone" },
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
  const agentDevice =
    options.agentDevice === "unset"
      ? {}
      : {
          enabled: true,
          ...(options.command === undefined ? {} : { command: options.command }),
          ...(options.leaseTtlCapMs === undefined ? {} : { leaseTtlCapMs: options.leaseTtlCapMs }),
        };
  const gateway = await startDaemon({
    clock,
    configOverrides: {
      agentDevice,
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
    logger: new JsonLinesLogger({ clock, level: "debug", sink: logs }),
    statePath: join(directory, "state.json"),
    version: "1.2.3",
  } as StartDaemonOptions);
  runningDaemons.push(gateway);
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
    const driver = driverFor(spec, clock);
    let directPort: number | undefined;
    if (spec.direct === true) {
      directPort = await freeLoopbackPort();
      await agentTokensFile(workerFilesystem, workerDirectory, [
        [principals.one, secrets.direct, "agent"],
      ]);
    }
    const started = startDaemon({
      agentDeviceUpstream: fake,
      clock,
      configOverrides: {
        agentDevice: { enabled: spec.capability !== "off" },
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
      logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
      statePath: join(workerDirectory, "state.json"),
      version: "1.2.3",
    } as StartDaemonOptions).then((daemon) => {
      runningDaemons.push(daemon);
      return daemon;
    });
    const member: Member = {
      daemon: started,
      directory: workerDirectory,
      driver,
      fake,
      filesystem: workerFilesystem,
      label: spec.label,
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
    gateway,
    logs,
    members,
    origin: `http://127.0.0.1:${String(port)}`,
    get relay() {
      if (relay === undefined) throw new Error("the gateway never handed over its relay");
      return relay;
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
    rig.clock.advance(Math.min(step, ms - elapsed));
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
}

// why: the front reaches simlock through `daemon.dispatch` looked up at call time, so a wrapper on the daemon object sits between the front and leasing.
function tapDispatch(daemon: DaemonServer): DispatchTap {
  const target = daemon as unknown as { dispatch: RawDispatch };
  const original = target.dispatch.bind(target);
  const operations: string[] = [];
  const inputs: { operation: string; input: Record<string, unknown> }[] = [];
  const afters = new Map<string, () => Promise<void>>();
  target.dispatch = async (operation, input, session) => {
    operations.push(operation);
    inputs.push({ input: (input ?? {}) as Record<string, unknown>, operation });
    const result = await original(operation, input, session);
    const after = afters.get(operation);
    afters.delete(operation);
    await after?.();
    return result;
  };
  return { afterNext: (operation, run) => afters.set(operation, run), inputs, operations };
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
  it("with agentDevice.enabled unset on the gateway, /v1/agent-device/health answers 404, as today", async () => {
    const rig = await setUp({ agentDevice: "unset" });

    expect((await send(rig, "/health")).status).toBe(404);
  });

  it("with agentDevice.command set on a gateway, the gateway logs that it ignores it and starts; with agentDevice.leaseTtlCapMs above lease.maxTtlMs on a gateway, the gateway fails to start, as a worker does", async () => {
    const rig = await setUp({ command: "agent-device-elsewhere", workers: [] });

    expect((await send(rig, "/health")).status).toBe(200);
    expect(
      rig.logs.records.some(
        (record) =>
          record.level === "warn" &&
          record.message.includes("agentDevice.command") &&
          record.message.includes("Ignoring"),
      ),
    ).toBe(true);

    await expect(setUp({ leaseTtlCapMs: gatewayMaxTtlMs + 1, workers: [] })).rejects.toThrow(
      /agentDevice\.leaseTtlCapMs/,
    );
  });

  it("with agentDevice.enabled unset on the gateway, /rpc, upload/preflight, artifacts/<id> and a diagnostics URL each answer 404", async () => {
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

  it("`agentDevice.leaseTtlCapMs` on the gateway caps the TTL of a lease made through it", async () => {
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
    await rig.gateway.dispatch(
      "lease.request",
      { leaseId: hex(2), platform: "ios", requesterId: hex(2), requires: ["agent-device"] },
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
