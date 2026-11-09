import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";

import { startOnFreePort } from "../test-support/loopback-port.js";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { startDaemon, type StartDaemonOptions } from "../daemon/main.js";
import { DispatchError } from "../daemon/dispatch.js";
import type { DaemonServer } from "../daemon/server.js";
import type { WebSocketUplinkListenerFactory } from "../ports/uplink-websocket.js";
import type { GatewayRelay } from "../gateway/index.js";
import {
  FakeClock,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  type Filesystem,
} from "../ports/index.js";
import { seedTokensDatabase } from "../auth/testing.js";
import { agentDeviceModuleWith, FakeAgentDevice } from "./testing.js";

export const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

export const secrets = {
  direct: "slk_test_agent_direct_on_worker",
  one: "slk_test_agent_one",
  operator: "slk_test_operator",
  two: "slk_test_agent_two",
} as const;
export const principals = { one: "tok_one", two: "tok_two" } as const;

export const notAvailable = "agent-device is not available on this simlock: ";
export const noWorker = "no worker connected to this gateway can serve agent-device";
export const holderCannot = "the worker holding this lease cannot serve agent-device";
export const missingMessage =
  "No worker connected to this gateway can serve agent-device for this request";
export const tooOld = "refused: this agent-device is too old to use through a gateway; update it";
// why: shorter than the gateway's 10 s call timeout, so the read can finish once the fake clock moves past it.
export const slowCatalogMs = 8_000;
export const phoneSerial = "R58Y61A60HN";
const defaultTtlMs = 600_000;
export const gatewayMaxTtlMs = 1_800_000;
const workerMaxTtlMs = 50_000_000;
export const workerCeilingMs = 2 * workerMaxTtlMs;
export const scope = { clientId: "client-1", leaseProvider: "proxy", runId: "run-1" } as const;
const endedMessage = "lease ended by simlock; run disconnect, then open";

export const adminSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "admin",
  role: "admin",
} as const;

export function sessionFor(principal: string) {
  return {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal,
    role: "agent",
  } as const;
}

export interface Envelope {
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

export interface WorkerSpec {
  readonly label: string;
  readonly platform?: "ios" | "android";
  readonly model?: string;
  // why: an Android worker with one enrolled, present phone, leased with `physical: true` through its phone daemon.
  readonly phone?: boolean;
  readonly capability?: "available" | "off" | "unavailable";
  readonly maxRunning?: number;
  // why: a standalone worker -- no gateway membership, its own HTTP port -- the way a worker without a gateway is; a joined worker may not enable HTTP.
  readonly direct?: boolean;
  // why: a catalog read that waits for the fake clock, so a worker's catalog stays unread.
  readonly slowCatalog?: boolean;
  // why: a worker's model can be a TV, so an adopted lease reads target `tv`.
  readonly modelClass?: "phone" | "tv";
  // why: a worker whose own clock differs from the gateway's, to prove no rule reads a clock across the two.
  readonly clockSkewMs?: number;
}

export interface Member {
  readonly spec: WorkerSpec;
  readonly label: string;
  readonly daemon: Promise<DaemonServer>;
  readonly fake: FakeAgentDevice;
  readonly phone: FakeAgentDevice;
  readonly driver: FakeDriver;
  readonly directory: string;
  readonly filesystem: Filesystem;
  readonly clock: FakeClock;
  // why: shared with the driver, so a test can make the next catalog read wait for the fake clock.
  readonly latency: Record<string, number>;
  readonly secret: string;
  readonly origin: string;
}

export interface Rig {
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

export interface SetUpOptions {
  readonly agentDevice?: "enabled" | "unset";
  readonly command?: string;
  readonly leaseTtlCapMs?: number;
  readonly maxTtlMs?: number;
  readonly defaultTtlMs?: number;
  readonly workers?: readonly WorkerSpec[];
}

export async function sleep(ms: number): Promise<void> {
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
      ...(spec.phone === true
        ? { physicalDevices: [{ class: "phone", ids: [phoneSerial], model, osVersion: "15" }] }
        : {}),
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

// fallow-ignore-next-line complexity -- one rig that starts a gateway and any number of workers over a real uplink.
export async function setUp(options: SetUpOptions = {}): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "sl-gw-"));
  temporaryDirectories.push(directory);
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  await seedTokensDatabase(directory, [
    [principals.one, secrets.one, "agent"],
    [principals.two, secrets.two, "agent"],
    ["tok_operator", secrets.operator, "operator"],
  ]);
  const logs = new MemoryLogSink();
  let relay: GatewayRelay | undefined;
  let uplinks: WebSocketUplinkListenerFactory | undefined;
  const agentDevice = {
    enabled: true,
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.leaseTtlCapMs === undefined ? {} : { leaseTtlCapMs: options.leaseTtlCapMs }),
  };
  const startGateway = async (port: number): Promise<DaemonServer> => {
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
      },
      role: "gateway",
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
      version: "1.2.3",
    } as StartDaemonOptions);
    runningDaemons.push(started);
    return started;
  };
  const { port, started: firstGateway } = await startOnFreePort(startGateway);
  let gateway = firstGateway;
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
    const phone = existing?.phone ?? new FakeAgentDevice();
    if (spec.capability === "unavailable") fake.setUnavailable("down");
    const latency: Record<string, number> = existing?.latency ?? {};
    if (spec.slowCatalog === true) latency["listCatalog"] = slowCatalogMs;
    const workerClock =
      existing?.clock ??
      (spec.clockSkewMs === undefined ? clock : new FakeClock(1_000 + spec.clockSkewMs));
    // why: a restarted worker keeps its driver, so the devices it leased are still running, as after a real daemon restart.
    const driver = existing?.driver ?? driverFor(spec, workerClock, latency);
    if (spec.direct === true) {
      await seedTokensDatabase(workerDirectory, [[principals.one, secrets.direct, "agent"]]);
    }
    const launch = (directPort: number | undefined) =>
      startDaemon({
        clock: workerClock,
        configOverrides: {
          capabilities: { "agent-device": { enabled: spec.capability !== "off" } },
          capacity: { config: { maxRunning: spec.maxRunning ?? 4 }, strategy: "fixed" },
          ...(directPort === undefined
            ? {
                gateway: {
                  label: spec.label,
                  token: secret,
                  url: `ws://127.0.0.1:${String(port)}`,
                },
              }
            : { http: { enabled: true, host: "127.0.0.1", port: directPort } }),
          lease: { defaultTtlMs, maxTtlMs: workerMaxTtlMs },
        },
        dataDirectory: workerDirectory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: [driver],
        filesystem: workerFilesystem,
        logger: new JsonLinesLogger({
          clock: workerClock,
          level: "debug",
          sink: new MemoryLogSink(),
        }),
        optionalModules: [agentDeviceModuleWith({ phoneUpstream: phone, upstream: fake })],
        version: "1.2.3",
      } as StartDaemonOptions).then((daemon) => {
        runningDaemons.push(daemon);
        return daemon;
      });
    // why: a direct worker binds a port picked a moment before, so a start that lost it runs again on another.
    const direct = spec.direct === true ? await startOnFreePort(launch) : undefined;
    const directPort = direct?.port;
    const started = direct === undefined ? launch(undefined) : Promise.resolve(direct.started);
    const member: Member = {
      clock: workerClock,
      daemon: started,
      directory: workerDirectory,
      driver,
      fake,
      filesystem: workerFilesystem,
      label: spec.label,
      latency,
      phone,
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
      gateway = await startGateway(port);
    },
    get uplinks() {
      if (uplinks === undefined) throw new Error("the gateway never handed over its uplinks");
      return uplinks;
    },
  };
  for (const spec of options.workers ?? [{ label: "w1" }]) {
    const member = await addWorker(spec);
    const worker = await member.daemon;
    if (spec.phone === true) {
      await worker.dispatch("device.add", { id: phoneSerial, platform: "android" }, adminSession);
      member.driver.setPhysicalPresence(phoneSerial, true);
    }
  }
  for (const member of members) if (member.spec.direct !== true) await untilRead(rig, member);
  return rig;
}

export async function viewOf(rig: Rig, label: string) {
  const { workers } = await rig.gateway.dispatch("worker.list", {}, adminSession);
  return workers.find((worker) => worker.label === label);
}

// why: a worker is usable for a gateway request only once its view carries capacity, capabilities and a catalog that has been read.
export async function untilRead(rig: Rig, member: Member): Promise<void> {
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

export async function turn(
  rig: Rig,
  member: Member,
  state: "available" | "unavailable",
): Promise<void> {
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

export async function advance(rig: Rig, ms: number, step = 5_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    const by = Math.min(step, ms - elapsed);
    rig.clock.advance(by);
    for (const member of rig.members) if (member.clock !== rig.clock) member.clock.advance(by);
    await sleep(15);
  }
}

export interface SendOptions {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly signal?: AbortSignal;
  readonly token?: string | null;
}

export function send(
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

export function rpcBody(method: string, params: Record<string, unknown>, id: unknown = 1): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method, params });
}

export function rpc(
  target: { readonly origin: string },
  method: string,
  params: Record<string, unknown>,
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return send(target, "/rpc", { ...options, body: rpcBody(method, params) });
}

export async function envelopeOf(response: Response): Promise<Envelope> {
  const text = await response.text();
  expect(
    text.trimStart().startsWith("{"),
    `expected a JSON object body, got ${String(response.status)} ${text.slice(0, 80)}`,
  ).toBe(true);
  return JSON.parse(text) as Envelope;
}

export const hex = (n: number): string => n.toString(16).padStart(32, "0");

function allocateParams(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...scope, leaseId: hex(n), platform: "ios", ttlMs: 120_000, ...extra };
}

export function allocate(
  target: { readonly origin: string },
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(target, "agent_device.lease.allocate", allocateParams(n, extra), options);
}

export async function granted(
  target: { readonly origin: string },
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<void> {
  const answer = await envelopeOf(await allocate(target, n, extra, options));
  expect(answer.result).toMatchObject({ ok: true });
}

export function release(
  rig: Rig,
  n: number,
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(rig, "agent_device.lease.release", { ...scope, leaseId: hex(n) }, options);
}

export function heartbeat(
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

export function command(
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

export interface LeaseView {
  readonly id: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly ttlDeadline: number;
  readonly worker?: { readonly id: string; readonly label?: string };
}

export async function workerLeases(member: Member): Promise<readonly LeaseView[]> {
  return (await (
    await member.daemon
  ).dispatch("list.get", { kind: "leases" }, adminSession)) as unknown as readonly LeaseView[];
}

export async function fleetLeases(rig: Rig, principal: string = principals.one) {
  const { leases } = await rig.gateway.dispatch("lease.list", {}, sessionFor(principal));
  return leases as unknown as readonly LeaseView[];
}

export async function waiting(rig: Rig): Promise<readonly string[]> {
  const requests = (await rig.gateway.dispatch(
    "list.get",
    { kind: "requests" },
    adminSession,
  )) as unknown as readonly { readonly requesterId: string }[];
  return requests.map((request) => request.requesterId);
}

export async function workerLeaseFor(member: Member, n: number): Promise<LeaseView> {
  const found = (await workerLeases(member)).find((lease) =>
    lease.requesterId.endsWith(`:${hex(n)}`),
  );
  expect(found, `the worker holds no lease for ${hex(n)}`).toBeDefined();
  return found as LeaseView;
}

export async function deadlineOf(member: Member, n: number): Promise<number | undefined> {
  return (await workerLeases(member)).find((lease) => lease.requesterId.endsWith(`:${hex(n)}`))
    ?.ttlDeadline;
}

// why: the worker's lease requester is `gw:<gateway instance id>:<CLI lease id>`, which is where the gateway's instance id is read from; the tenant spells it with dots and writes each `_` of the principal as `_5f_`, then the lease id.
export async function tenantOf(member: Member, n: number, principal: string = principals.one) {
  const lease = await workerLeaseFor(member, n);
  const prefix = lease.requesterId.slice(0, -(hex(n).length + 1));
  expect(prefix).toMatch(/^gw:[^:]+$/);
  return `gw.${prefix.slice("gw:".length)}.${principal.replaceAll("_", "_5f_")}.${hex(n)}`;
}

export async function grantedDevice(member: Member) {
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

// why: a released device is deleted and its record stays listed, so only live devices count.
export async function deviceStates(member: Member): Promise<readonly string[]> {
  return (
    (await (
      await member.daemon
    ).dispatch("list.get", { kind: "devices" }, adminSession)) as unknown as readonly {
      readonly state: string;
    }[]
  )
    .map((device) => device.state)
    .filter((state) => state !== "deleted");
}

export function track<T>(promise: Promise<T>): {
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

export function expectEndedBySimlock(answer: Envelope): void {
  expect(answer.result).toBeUndefined();
  expect(answer.error).toMatchObject({
    data: {
      code: "UNAUTHORIZED",
      details: { reason: "LEASE_ENDED_BY_HOST" },
      message: endedMessage,
      retriable: false,
    },
  });
}

type RawDispatch = (operation: string, input: unknown, session: unknown) => Promise<unknown>;

export interface DispatchTap {
  readonly operations: string[];
  readonly inputs: { readonly operation: string; readonly input: Record<string, unknown> }[];
  afterNext(operation: string, run: () => Promise<void>): void;
  rejectNext(operation: string): void;
}

// why: the front reaches simlock through `daemon.dispatch` looked up at call time, so a wrapper on the daemon object sits between the front and leasing.
export function tapDispatch(daemon: DaemonServer): DispatchTap {
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
export function interceptRelay(
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

export function relayFailsWith(rig: Rig, code: string, message: string): void {
  const target = rig.relay as unknown as { relay: RelayFn };
  target.relay = () => Promise.reject(new DispatchError(code, message));
}

const wipeOperations = new Set(["reclaim", "shutdown", "destroy"]);

export function wipes(member: Member): number {
  return member.driver.calls.filter((call) => wipeOperations.has(call.operation)).length;
}

export function heartbeatsReceived(member: Member): number {
  return member.fake.rpcRequests("agent_device.lease.heartbeat").length;
}

export function allocatesReceived(member: Member, n?: number) {
  return member.fake
    .rpcRequests("agent_device.lease.allocate")
    .filter((request) => n === undefined || request.params?.["leaseId"] === hex(n));
}

export async function runningCommand(
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

export function first(rig: Rig): Member {
  const member = rig.members[0];
  if (member === undefined) throw new Error("the rig has no worker");
  return member;
}

// why: on a gateway, `lease.list` skips a lease whose worker view is missing for a moment (a reconnect, a starting worker), so the test cuts one lease from exactly one answer to stand for that.
export function leaveOutOfNextListing(
  daemon: DaemonServer,
  leaseId: string,
): { cut: () => number } {
  const target = daemon as unknown as { dispatch: RawDispatch };
  const original = target.dispatch.bind(target);
  let cut = 0;
  target.dispatch = async (operation, input, session) => {
    const result = await original(operation, input, session);
    if (operation !== "lease.list" || cut > 0) return result;
    const { leases } = result as { leases: readonly { id: string }[] };
    if (!leases.some((lease) => lease.id === leaseId)) return result;
    cut += 1;
    return { ...(result as object), leases: leases.filter((lease) => lease.id !== leaseId) };
  };
  return { cut: () => cut };
}

export async function restarted(rig: Rig, member: Member, leases: number): Promise<void> {
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

export function commandsReceived(member: Member): number {
  return member.fake.rpcRequests("agent_device.command").length;
}
