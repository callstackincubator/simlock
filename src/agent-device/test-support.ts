import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";

import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { startDaemon, type StartDaemonOptions } from "../daemon/main.js";
import type { DaemonServer } from "../daemon/server.js";
import { FakeClock, JsonLinesLogger, MemoryFilesystem, MemoryLogSink } from "../ports/index.js";
import { seedTokensDatabase } from "../auth/testing.js";
import { freeLoopbackPort, startOnFreePort } from "../test-support/loopback-port.js";
import { sleep } from "../daemon/test-relay-support.js";
import { agentDeviceModuleWith, FakeAgentDevice } from "./testing.js";

// why: the edge tests and the baseline tests share one daemon rig; its daemons and data directories are cleaned after each test of whichever file imports it.
afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

export const secrets = {
  one: "slk_test_agent_one",
  operator: "slk_test_operator",
  two: "slk_test_agent_two",
  worker: "slk_test_worker_join",
} as const;
export const principals = { one: "tok_one", two: "tok_two" } as const;

export const notAvailable = "agent-device is not available on this simlock: ";
export const agentTokenOnly = "refused: agent-device through simlock needs an agent token";
export const queueTimeoutMessage = "timed out waiting for a device; nothing was leased";
export const defaultTtlMs = 600_000;
export const maxTtlMs = 1_800_000;
export { sleep };

export const scope = { clientId: "client-1", leaseProvider: "proxy", runId: "run-1" } as const;

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
    readonly data?: { readonly code: string; readonly message: string };
  };
}

export interface SetUpOptions {
  readonly leaseTtlCapMs?: number;
  readonly downloads?: "always";
  readonly drivers?: (clock: FakeClock) => FakeDriver[];
  readonly enabled?: boolean | "unset";
  readonly endWaitMs?: number;
  readonly gatewayMode?: boolean;
  readonly maxRunning?: number;
  readonly slowStart?: boolean;
  readonly upstream?: FakeAgentDevice;
  readonly phoneUpstream?: FakeAgentDevice;
}

export interface Rig {
  readonly clock: FakeClock;
  readonly daemon: DaemonServer;
  readonly driver: FakeDriver;
  readonly fake: FakeAgentDevice;
  readonly phone: FakeAgentDevice;
  readonly filesystem: MemoryFilesystem;
  readonly logs: MemoryLogSink;
  readonly origin: string;
  readonly stateDbPath: string;
  readonly started: Promise<DaemonServer>;
  readonly restart: (between?: () => void) => Promise<Rig>;
}

export function iosDriver(clock: FakeClock, slimmableOsVersions?: readonly string[]): FakeDriver {
  return new FakeDriver({
    ...(slimmableOsVersions === undefined ? {} : { slimmableOsVersions }),
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

export function androidDriver(clock: FakeClock): FakeDriver {
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

export function taggedAndroidDriver(clock: FakeClock): FakeDriver {
  return new FakeDriver({
    availableOsVersions: ["33", "34", "35"],
    clock,
    defaultModels: { phone: ["Pixel 8"] },
    images: [
      { abi: "arm64-v8a", runtime: "33", tag: "google_apis_playstore" },
      { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
      { abi: "arm64-v8a", runtime: "35", tag: "default" },
    ],
    knownModels: ["Pixel 8"],
    modelClasses: { "Pixel 8": "phone" },
    platform: "android",
  });
}

export async function setUp(options: SetUpOptions = {}): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-agent-device-edge-"));
  temporaryDirectories.push(directory);
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  await seedTokensDatabase(directory, [
    [principals.one, secrets.one, "agent"],
    [principals.two, secrets.two, "agent"],
    ["tok_operator", secrets.operator, "operator"],
    ["tok_worker", secrets.worker, "worker"],
  ]);
  const fake = options.upstream ?? new FakeAgentDevice();
  const phone = options.phoneUpstream ?? new FakeAgentDevice();
  const drivers = options.drivers?.(clock) ?? [iosDriver(clock)];
  const stateDbPath = join(directory, "state.db");
  const logs = new MemoryLogSink();
  const launch = (port: number) =>
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
        ...(options.downloads === undefined ? {} : { downloads: { policy: options.downloads } }),
        http: { enabled: true, host: "127.0.0.1", port },
        lease: {
          defaultTtlMs,
          maxTtlMs,
          ...(options.endWaitMs === undefined ? {} : { endWaitMs: options.endWaitMs }),
        },
      },
      ...(options.gatewayMode === true ? { role: "gateway" as const } : {}),
      dataDirectory: directory,
      deviceDataTables: fakeDeviceDataTables,
      drivers,
      filesystem,
      logger: new JsonLinesLogger({ clock, level: "debug", sink: logs }),
      optionalModules: [agentDeviceModuleWith({ phoneUpstream: phone, upstream: fake })],
      version: "1.2.3",
    } as StartDaemonOptions).then((daemon) => {
      runningDaemons.push(daemon);
      return daemon;
    });
  // why: only the slow start knows its port first, so only a normal start can retry on another port.
  const picked = options.slowStart === true ? await freeLoopbackPort() : undefined;
  const first = picked === undefined ? await startOnFreePort(launch) : undefined;
  const port = picked ?? (first as NonNullable<typeof first>).port;
  const started = first === undefined ? launch(port) : Promise.resolve(first.started);
  const origin = `http://127.0.0.1:${port}`;
  if (options.slowStart === true) {
    await waitListening(origin);
    return {
      clock,
      daemon: undefined as never,
      driver: drivers[0] as FakeDriver,
      fake,
      phone,
      filesystem,
      logs,
      origin,
      restart: () => Promise.reject(new Error("restart needs a started daemon")),
      started,
      stateDbPath,
    };
  }
  const rigFor = (daemon: DaemonServer, running: Promise<DaemonServer>): Rig => ({
    clock,
    daemon,
    driver: drivers[0] as FakeDriver,
    fake,
    phone,
    filesystem,
    logs,
    origin,
    restart: async (between) => {
      await daemon.stop("test");
      between?.();
      const next = await launch(port);
      return rigFor(next, Promise.resolve(next));
    },
    started: running,
    stateDbPath,
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

export interface SendOptions {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly signal?: AbortSignal;
  readonly token?: string | null;
}

export function send(rig: Rig, path: string, options: SendOptions = {}): Promise<Response> {
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

export function rpcBody(method: string, params: Record<string, unknown>, id: unknown = 1): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method, params });
}

export function rpc(
  rig: Rig,
  method: string,
  params: Record<string, unknown>,
  options: Omit<SendOptions, "body"> & { readonly id?: unknown } = {},
): Promise<Response> {
  return send(rig, "/rpc", { ...options, body: rpcBody(method, params, options.id ?? 1) });
}

export async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  expect(
    text.trimStart().startsWith("{"),
    `expected a JSON object body, got ${response.status} ${text.slice(0, 80)}`,
  ).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

export async function envelopeOf(response: Response): Promise<Envelope> {
  return (await bodyOf(response)) as Envelope;
}

export const hex = (n: number): string => n.toString(16).padStart(32, "0");

export function allocateParams(
  n: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...scope, leaseId: hex(n), platform: "ios", ttlMs: 120_000, ...extra };
}

export function allocate(
  rig: Rig,
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(rig, "agent_device.lease.allocate", allocateParams(n, extra), options);
}

export async function granted(
  rig: Rig,
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<void> {
  const answer = await envelopeOf(await allocate(rig, n, extra, options));
  expect(answer.result).toMatchObject({ ok: true });
}

export function command(
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

export async function leases(rig: Rig): Promise<readonly LeaseView[]> {
  return (await rig.daemon.dispatch(
    "list.get",
    { kind: "leases" },
    adminSession,
  )) as unknown as readonly LeaseView[];
}

export async function requestedSpecs(rig: Rig, requester: string): Promise<readonly unknown[]> {
  const events = await rig.daemon.dispatch("events.replay", {}, adminSession);
  return events
    .filter((entry) => entry.event === "lease.requested")
    .map((entry) => entry.payload as { requester: string; requestSpec: unknown })
    .filter((payload) => payload.requester === requester)
    .map((payload) => payload.requestSpec);
}

export function receivedAllocate(rig: Rig, n: number): Record<string, unknown> {
  const params = allocatesReceived(rig, n)[0]?.params;
  expect(params).toBeDefined();
  return params as Record<string, unknown>;
}

export function allocatesReceived(rig: Rig, n?: number) {
  return rig.fake
    .rpcRequests("agent_device.lease.allocate")
    .filter((request) => n === undefined || request.params?.["leaseId"] === hex(n));
}

export async function simlockMessage(rig: Rig, input: Record<string, unknown>): Promise<string> {
  try {
    await rig.daemon.dispatch("lease.request", input, sessionFor(principals.one));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("simlock accepted a request the test expected it to refuse");
}

export function refusal(message: string, code = "INVALID_ARGS") {
  return { code: -32000, data: { code, message }, message };
}

export function runCommand(
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

// why: a refusal test starts from a request that is accepted, then changes one thing (testing rule 2).
export async function forwarded(
  rig: Rig,
  send: () => Promise<Response>,
): Promise<Record<string, unknown>> {
  const before = rig.fake.requests.length;
  const answer = await envelopeOf(await send());
  expect(answer.error).toBeUndefined();
  expect(answer.result).toBeDefined();
  // why: the front reads a leased device's name from agent-device's device list the first time a rule needs it, before it forwards the command.
  const sent = rig.fake.requests.slice(before).filter((r) => r.params?.["command"] !== "devices");
  expect(sent.length).toBe(1);
  return sent[0]?.params as Record<string, unknown>;
}

export async function refused(
  rig: Rig,
  send: () => Promise<Response>,
  message: string,
): Promise<void> {
  const before = rig.fake.requests.length;
  const answer = await envelopeOf(await send());
  expect(answer.error).toMatchObject(refusal(message));
  expect(answer.result).toBeUndefined();
  // why: a refusal can follow the front's one read of a leased device's name from agent-device's device list; no command reaches it.
  expect(
    rig.fake.requests.slice(before).filter((r) => r.params?.["command"] !== "devices"),
  ).toEqual([]);
}
