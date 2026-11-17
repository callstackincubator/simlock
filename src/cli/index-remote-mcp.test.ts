import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runMcpStdio } from "../mcp/main.js";
import { FakeClock, WebSocketRefusedError } from "../ports/index.js";
import { runCli } from "./index.js";
import { detachedGrant, outputCapture, realCliEnvironmentPorts, settle } from "./test-index.js";
import { FakeFarm, NO_REPLY, type FarmAnswer } from "./test-remote.js";

const URL = "https://farm.example.com";
const ENV = { SIMLOCK_AGENT_ID: "agent-a", SIMLOCK_TOKEN: "slk_t", SIMLOCK_URL: URL };
const DEADLINE = "1970-01-01T00:01:01.000Z";

const farmAnswers: Record<string, FarmAnswer> = {
  "device.exec": () => ({ exitCode: 0 }),
  "lease.list": () => ({ leases: [detachedGrant.lease] }),
  "lease.release": (payload) => ({ leaseId: (payload as { leaseId: string }).leaseId }),
  "lease.renew": () => detachedGrant.lease,
  "lease.request": () => detachedGrant,
};

class FakeStdin {
  listener: (() => void) | undefined;
  readonly readableEnded = false;
  off(): void {
    this.listener = undefined;
  }
  once(_event: "end", listener: () => void): void {
    this.listener = listener;
  }
  end(): void {
    this.listener?.();
  }
}

interface Served {
  readonly attempts: number[];
  readonly clock: FakeClock;
  readonly farm: FakeFarm;
  readonly mcp: Client;
  readonly stdin: FakeStdin;
  exitCode(): number | undefined;
  levels(): string[];
  messages(): string[];
  tool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function serveRemoteMcp(
  env: NodeJS.ProcessEnv = ENV,
  answers: Record<string, FarmAnswer> = {},
): Promise<Served> {
  const clock = new FakeClock(0);
  // why: a renewal moves the deadline a TTL on from the clock, as the farm does.
  const farm = new FakeFarm({
    ...farmAnswers,
    "lease.renew": () => ({ ...detachedGrant.lease, ttlDeadline: clock.now() + 60_000 }),
    ...answers,
  });
  const attempts: number[] = [];
  const connect = farm.connect.bind(farm);
  farm.connect = (...args) => {
    attempts.push(clock.now());
    return connect(...args);
  };
  const stdin = new FakeStdin();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const output = outputCapture({ ...realCliEnvironmentPorts(), clock }, env);
  const environment = output.environmentWith({
    loadMcpStdio: async () => (options) =>
      runMcpStdio({
        ...options,
        clock,
        createTransport: () => serverTransport,
        env: { SIMLOCK_AGENT_ID: "agent-a" },
        signals: new EventEmitter(),
        stdin,
        webSocket: farm,
      }),
  });
  let exitCode: number | undefined;
  void runCli(["mcp"], environment).then((code) => (exitCode = code));
  const mcp = new Client({ name: "test", version: "1.0.0" });
  const logs: unknown[] = [];
  const levels: string[] = [];
  mcp.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    logs.push(notification.params.data);
    levels.push(notification.params.level);
  });
  await mcp.connect(clientTransport);
  return {
    attempts,
    clock,
    exitCode: () => exitCode,
    farm,
    mcp,
    levels: () => levels,
    messages: () => logs.map((data) => (data as { message: string }).message),
    stdin,
    tool: async (name, input) => {
      const result = await mcp.request(
        { method: "tools/call", params: { arguments: input, name } },
        CallToolResultSchema,
      );
      return result.structuredContent ?? {};
    },
  };
}

const lease = { model: "iPhone 17 Pro", platform: "ios" };

async function held(): Promise<Served> {
  const served = await serveRemoteMcp();
  await served.tool("lease_simulator", lease);
  return served;
}

async function dropped(served: Served): Promise<void> {
  served.farm.connections[0]?.peer.dropped(1006, "");
  await vi.waitFor(() => expect(served.messages()).toHaveLength(1));
  expect(served.messages()[0]).toBe(
    `lost the connection to ${URL}; reconnecting until ${DEADLINE} to keep lease lse_env`,
  );
}

async function noTokenStopsAtStart(): Promise<void> {
  let launched = false;
  const output = outputCapture(
    { ...realCliEnvironmentPorts(), clock: new FakeClock(0) },
    { SIMLOCK_URL: URL },
  );
  const code = await runCli(
    ["mcp"],
    output.environmentWith({
      loadMcpStdio: async () => async () => {
        launched = true;
      },
    }),
  );
  expect(code).toBe(2);
  expect(JSON.parse(output.stderr)).toEqual({
    error: { code: "USAGE", message: "No token: pass --token or set SIMLOCK_TOKEN" },
  });
  expect(launched).toBe(false);
}

async function toolsUseTheFarm(): Promise<void> {
  const served = await serveRemoteMcp();
  const granted = await served.tool("lease_simulator", lease);
  expect((granted.lease as { id: string }).id).toBe("lse_env");
  expect(served.farm.requests.find(({ type }) => type === "lease.request")?.payload).toEqual(
    expect.objectContaining({
      idempotencyKey: expect.stringMatching(/\S/),
      platform: "ios",
      requesterId: "agent-a",
    }),
  );
  expect(
    await served.tool("run_on_device", { args: ["listapps", "booted"], tool: "simctl" }),
  ).toEqual({ exitCode: 0, stderr: "", stdout: "", truncated: false });
  expect(served.farm.requests.find(({ type }) => type === "device.exec")?.payload).toEqual(
    expect.objectContaining({ leaseId: "lse_env" }),
  );
  expect(await served.tool("lease_status", {})).toEqual(
    expect.objectContaining({ held: true, id: "lse_env" }),
  );
  expect(served.farm.connections).toHaveLength(1);
  served.stdin.end();
  await vi.waitFor(() => expect(served.exitCode()).toBe(0));
  expect(served.farm.requestTypes().at(-1)).toBe("lease.release");
}

async function dropsAreRiddenOut(): Promise<void> {
  for (const [name, drop] of [
    ["a closed connection", (served: Served) => served.farm.connections[0]?.peer.dropped(1006, "")],
    ["45 s of silence", (served: Served) => served.clock.advance(45_000)],
  ] as const) {
    const served = await held();
    drop(served);
    await vi.waitFor(() => expect(served.messages(), name).toHaveLength(1));
    expect(served.messages()[0], name).toBe(
      `lost the connection to ${URL}; reconnecting until ${DEADLINE} to keep lease lse_env`,
    );
    served.clock.advance(1_000);
    await vi.waitFor(() => expect(served.messages(), name).toHaveLength(2));
    expect(served.messages()[1], name).toBe(`reconnected to ${URL}; lease lse_env renewed`);
    expect(served.levels(), name).toEqual(["warning", "info"]);
    const renewals = () => served.farm.requestTypes().filter((type) => type === "lease.renew");
    const renewedOnReconnect = renewals().length;
    served.clock.advance(20_000);
    await vi.waitFor(() =>
      expect(renewals(), `${name}: renewing resumes`).toHaveLength(renewedOnReconnect + 1),
    );
    expect(served.farm.requestTypes().at(-1), name).toBe("lease.renew");
    expect(served.farm.connections, name).toHaveLength(2);
    expect(await served.tool("lease_status", {}), name).toEqual(
      expect.objectContaining({ held: true }),
    );
    served.stdin.end();
    await vi.waitFor(() => expect(served.exitCode()).toBe(0));
  }
}

async function endsWithoutALease(): Promise<void> {
  const past = await held();
  await dropped(past);
  past.farm.failure = new Error("connect ECONNREFUSED");
  past.clock.advance(61_000);
  await vi.waitFor(() => expect(past.messages()).toHaveLength(2));
  expect(past.messages()[1]).toBe("Simlock lease ended; this session no longer holds the device.");
  const tried = past.attempts.length;
  past.clock.advance(120_000);
  expect(past.attempts).toHaveLength(tried);

  const refused = await held();
  await dropped(refused);
  refused.farm.failure = new WebSocketRefusedError(401, "");
  refused.clock.advance(1_000);
  await vi.waitFor(() => expect(refused.messages()).toHaveLength(2));
  expect(refused.messages()[1]).toContain("refused the token");
  expect(refused.messages()[1]).toContain(`lease lse_env is still yours until ${DEADLINE}`);
  const triedRefused = refused.attempts.length;
  refused.clock.advance(120_000);
  expect(refused.attempts).toHaveLength(triedRefused);
  refused.stdin.end();
  await vi.waitFor(() => expect(refused.exitCode()).toBe(0));
  expect(refused.attempts, "the refused lease is not released over a new connection").toHaveLength(
    triedRefused,
  );
}

async function endingTheSessionStopsTheReconnect(): Promise<void> {
  const served = await held();
  await dropped(served);
  served.farm.failure = new Error("connect ECONNREFUSED");
  served.stdin.end();
  await vi.waitFor(() => expect(served.exitCode()).toBe(0));
  const tried = served.attempts.length;
  served.clock.advance(120_000);
  await settle();
  expect(served.attempts, "no reconnect timer outlives the session").toHaveLength(tried);
}

const leaseRequestsOf = (served: Served) =>
  served.farm.requests
    .filter(({ type }) => type === "lease.request")
    .map(({ payload }) => payload as { idempotencyKey?: string });

async function queuedRequestIsReattachedAfterADrop(): Promise<void> {
  let asked = 0;
  const served = await serveRemoteMcp(ENV, {
    "lease.request": () => (++asked === 1 ? NO_REPLY : detachedGrant),
  });
  const granted = served.tool("lease_simulator", lease);
  await vi.waitFor(() => expect(leaseRequestsOf(served)).toHaveLength(1));
  served.farm.connections[0]?.peer.dropped(1006, "");
  await vi.waitFor(() => expect(served.messages()).toHaveLength(1));
  expect(served.messages()[0]).toBe(
    `lost the connection to ${URL}; reconnecting to the waiting request`,
  );
  served.clock.advance(1_000);
  expect(((await granted).lease as { id: string }).id).toBe("lse_env");
  const [first, again] = leaseRequestsOf(served);
  expect(first?.idempotencyKey).toMatch(/\S/);
  expect(again?.idempotencyKey).toBe(first?.idempotencyKey);
  served.stdin.end();
  await vi.waitFor(() => expect(served.exitCode()).toBe(0));

  const cancelled = await serveRemoteMcp(ENV, {
    "lease.cancel": () => ({ result: "cancelled" }),
    "lease.request": () => NO_REPLY,
  });
  const abort = new AbortController();
  const waiting = cancelled.mcp
    .request(
      { method: "tools/call", params: { arguments: lease, name: "lease_simulator" } },
      CallToolResultSchema,
      { signal: abort.signal },
    )
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(leaseRequestsOf(cancelled)).toHaveLength(1));
  cancelled.farm.connections[0]?.peer.dropped(1006, "");
  await vi.waitFor(() => expect(cancelled.messages()).toHaveLength(1));
  abort.abort();
  await waiting;
  await vi.waitFor(() => expect(cancelled.farm.requestTypes()).toContain("lease.cancel"));
  expect(cancelled.farm.requests.find(({ type }) => type === "lease.cancel")?.payload).toEqual(
    expect.objectContaining({ platform: "ios", requesterId: "agent-a" }),
  );
  const tried = cancelled.attempts.length;
  cancelled.clock.advance(120_000);
  await settle();
  expect(cancelled.attempts, "no reconnect timer outlives the cancel").toHaveLength(tried);
  cancelled.stdin.end();
  await vi.waitFor(() => expect(cancelled.exitCode()).toBe(0));
}

describe("CLI: simlock mcp against a farm", () => {
  it("remote simlock mcp serves its tools from the farm, rides out a drop, and releases at the end", async () => {
    await noTokenStopsAtStart();
    await toolsUseTheFarm();
    await dropsAreRiddenOut();
    await endsWithoutALease();
    await endingTheSessionStopsTheReconnect();
    await queuedRequestIsReattachedAfterADrop();
  });
});
