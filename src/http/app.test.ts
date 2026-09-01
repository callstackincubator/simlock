import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { NoCapacityError, RequesterAlreadyLeasedError } from "../core/index.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { createHttpApp, type HttpGatewayDeps } from "./app.js";
import {
  FakeCapacityReader,
  FakeCatalogReader,
  FakeLeaseCommands,
  FakeQueueControl,
  FakeRegistry,
  FakeTokenVerifier,
  makeDevice,
  makeGrant,
  makeLease,
  sequenceIdGenerator,
  testConfig,
  waitForCall,
} from "./test-fakes.js";

function buildHarness(overrides: { readonly config?: HttpGatewayDeps["config"] } = {}) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const leases = new FakeLeaseCommands();
  const queue = new FakeQueueControl();
  const capacity = new FakeCapacityReader();
  const catalog = new FakeCatalogReader();
  const registry = new FakeRegistry();
  const tokens = new FakeTokenVerifier();
  tokens.register("slk_agent", { requesterId: "tok_agent", role: "agent" });
  tokens.register("slk_other", { requesterId: "tok_other", role: "agent" });
  tokens.register("slk_operator", { requesterId: "tok_operator", role: "operator" });
  const logSink = new MemoryLogSink();
  const logger = new JsonLinesLogger({ clock, sink: logSink });
  const config = overrides.config ?? testConfig();

  const app = createHttpApp({
    capacity,
    catalog,
    clock,
    config,
    daemonHealth: () => "running",
    eventBus,
    idGenerator: sequenceIdGenerator("gw"),
    leases,
    logger,
    queue,
    registry,
    tokens,
  });

  return { app, clock, config, eventBus, leases, logSink, queue, registry, tokens };
}

type App = ReturnType<typeof buildHarness>["app"];

const agentAuth = { authorization: "Bearer slk_agent" };
const otherAgentAuth = { authorization: "Bearer slk_other" };
const operatorAuth = { authorization: "Bearer slk_operator" };
const defaultBody = { device: "iPhone 17 Pro", platform: "ios" };

function postLeaseRequest(
  app: App,
  body: Record<string, unknown>,
  headers: Record<string, string> = agentAuth,
): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/lease-requests", {
      body: JSON.stringify(body),
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    }),
  );
}

/**
 * Drives a `POST /v1/lease-requests` through to its 201 response and returns the created
 * request's id. `LeaseRequestTracker.submit` never settles until `LeaseCommands.request`'s
 * first `onProgress` call (or its own grant/rejection) -- see `tracker.ts` -- so this scripts
 * one `queued` progress event rather than awaiting the response before that call exists.
 */
async function createLeaseRequest(
  app: App,
  leases: FakeLeaseCommands,
  body: Record<string, unknown> = defaultBody,
  headers: Record<string, string> = agentAuth,
): Promise<{ readonly id: string; readonly callIndex: number }> {
  const callIndex = leases.calls.length;
  const responsePromise = postLeaseRequest(app, body, headers);
  await waitForCall(leases, callIndex);
  leases.calls[callIndex]?.options.onProgress?.({ queuePosition: 1, stage: "queued" });
  const response = await responsePromise;
  const { request } = (await response.json()) as { request: { id: string } };
  return { callIndex, id: request.id };
}

interface SseFrame {
  readonly event?: string;
  readonly data: unknown;
}

/** A keepalive comment (`: ...`) is not a frame; everything else parses as event+data lines. */
function parseSseFrame(raw: string): SseFrame | undefined {
  if (raw.startsWith(":")) return undefined;
  let event: string | undefined;
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return { data: JSON.parse(data) as unknown, ...(event === undefined ? {} : { event }) };
}

/** Splits off every complete (`\n\n`-terminated) frame; the trailing partial stays in `rest`. */
function splitCompleteFrames(buffer: string): { complete: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { complete: parts, rest };
}

async function readSseFrames(response: Response, count: number): Promise<SseFrame[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SseFrame[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { complete, rest } = splitCompleteFrames(buffer);
    buffer = rest;
    for (const raw of complete) {
      if (frames.length >= count) break;
      const frame = parseSseFrame(raw);
      if (frame !== undefined) frames.push(frame);
    }
  }
  await reader.cancel();
  return frames;
}

describe("GET /v1/healthz", () => {
  it("answers without authentication", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("authentication and ownership", () => {
  it("401s a protected route with no token", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/status");
    expect(response.status).toBe(401);
  });

  it("403s an agent token reaching an operator-only route", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/leases", { headers: agentAuth });
    expect(response.status).toBe(403);
  });

  it("403s an agent reaching another requester's lease request", async () => {
    const { app, leases } = buildHarness();
    const { id } = await createLeaseRequest(app, leases);

    const response = await app.request(`/v1/lease-requests/${id}`, { headers: otherAgentAuth });
    expect(response.status).toBe(403);
  });
});

describe("GET /v1/status, /v1/catalog", () => {
  it("reports status shaped like the daemon's status.get", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1", state: "ready" })];
    registry.leases = [];

    const response = await app.request("/v1/status", { headers: agentAuth });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      health: string;
      queueDepth: number;
      devices: unknown[];
      capacity: { ios: { warm: number } };
    };
    expect(body.health).toBe("running");
    expect(body.queueDepth).toBe(0);
    expect(body.devices).toHaveLength(1);
    expect(body.capacity.ios.warm).toBe(1);
  });

  it("filters the catalog by platform query", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/catalog?platform=ios", { headers: agentAuth });
    expect(await response.json()).toEqual({
      platforms: [
        { defaultRuntime: "26.5", models: ["iPhone 17 Pro"], platform: "ios", runtimes: ["26.5"] },
      ],
    });
  });

  it("400s an invalid platform query", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/catalog?platform=windows", { headers: agentAuth });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});

describe("POST /v1/lease-requests", () => {
  it("creates a request resource, 201 with a Location header", async () => {
    const { app, leases } = buildHarness();
    const responsePromise = postLeaseRequest(app, defaultBody);
    await waitForCall(leases);
    leases.calls[0]?.options.onProgress?.({ queuePosition: 2, stage: "queued" });
    const response = await responsePromise;

    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toMatch(/^\/v1\/lease-requests\/req_/);
    const body = (await response.json()) as {
      request: { id: string; state: string; queuePosition: number };
    };
    expect(body.request.state).toBe("queued");
    expect(body.request.queuePosition).toBe(2);
  });

  it("400s a malformed body before ever calling LeaseCommands", async () => {
    const { app, leases } = buildHarness();
    const response = await postLeaseRequest(app, { platform: "ios" });
    expect(response.status).toBe(400);
    expect(leases.calls).toHaveLength(0);
  });

  it("maps a fast RequesterAlreadyLeasedError to 409, naming the existing lease", async () => {
    const { app, leases } = buildHarness();
    const responsePromise = postLeaseRequest(app, defaultBody);
    await waitForCall(leases);
    leases.calls[0]?.reject(new RequesterAlreadyLeasedError("tok_agent", "lse_existing"));
    const response = await responsePromise;

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "REQUESTER_ALREADY_LEASED",
        existingLeaseId: "lse_existing",
        message: expect.any(String),
      },
    });
  });

  it("maps a fast NoCapacityError (noWait) to 503 with Retry-After", async () => {
    const { app, leases } = buildHarness();
    const responsePromise = postLeaseRequest(app, { ...defaultBody, noWait: true });
    await waitForCall(leases);
    leases.calls[0]?.reject(new NoCapacityError());
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });

  it("replays an identical Idempotency-Key without a second LeaseCommands.request call", async () => {
    const { app, leases } = buildHarness();
    const { id: firstId } = await createLeaseRequest(app, leases, defaultBody, {
      ...agentAuth,
      "idempotency-key": "abc",
    });

    const second = await postLeaseRequest(app, defaultBody, {
      ...agentAuth,
      "idempotency-key": "abc",
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { request: { id: string } };
    expect(leases.calls).toHaveLength(1);
    expect(secondBody.request.id).toBe(firstId);
  });
});

describe("full lease-request lifecycle via GET / long-poll / SSE", () => {
  it("progresses queued -> booting -> granted, observable through GET", async () => {
    const { app, leases } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, leases);

    leases.calls[callIndex]?.options.onProgress?.({ etaMs: 30_000, stage: "booting" });
    const midway = await app.request(`/v1/lease-requests/${id}`, { headers: agentAuth });
    expect(
      ((await midway.json()) as { request: { state: string; etaSeconds: number } }).request,
    ).toEqual({
      createdAt: expect.any(String),
      etaSeconds: 30,
      id,
      state: "booting",
    });

    leases.calls[callIndex]?.resolve(makeGrant({ lease: { id: "lse_final" } }));
    const final = await app.request(`/v1/lease-requests/${id}`, { headers: agentAuth });
    const finalBody = (await final.json()) as {
      request: { state: string; lease: { id: string; dataPlane: unknown } };
    };
    expect(finalBody.request.state).toBe("granted");
    expect(finalBody.request.lease.id).toBe("lse_final");
    expect(finalBody.request.lease.dataPlane).toBeNull();
  });

  it("long-polls: ?wait returns early on a state change", async () => {
    const { app, leases } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, leases);

    const waitPromise = app.request(`/v1/lease-requests/${id}?wait=30`, { headers: agentAuth });
    await Promise.resolve();
    await Promise.resolve();
    leases.calls[callIndex]?.options.onProgress?.({ etaMs: 10_000, stage: "provisioning" });
    const response = await waitPromise;
    const body = (await response.json()) as { request: { state: string } };
    expect(body.request.state).toBe("provisioning");
  });

  it("long-polls: ?wait returns the unchanged state once the timer elapses", async () => {
    const { app, clock, leases } = buildHarness();
    const { id } = await createLeaseRequest(app, leases);

    const waitPromise = app.request(`/v1/lease-requests/${id}?wait=5`, { headers: agentAuth });
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(5_000);
    const response = await waitPromise;
    const body = (await response.json()) as { request: { state: string; queuePosition: number } };
    expect(body.request).toMatchObject({ queuePosition: 1, state: "queued" });
  });

  it("streams SSE progress events, ending with the terminal granted event", async () => {
    const { app, leases } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, leases);

    const streamResponse = await app.request(`/v1/lease-requests/${id}/events`, {
      headers: agentAuth,
    });
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

    const framesPromise = readSseFrames(streamResponse, 3);
    leases.calls[callIndex]?.options.onProgress?.({ etaMs: 20_000, stage: "provisioning" });
    leases.calls[callIndex]?.resolve(makeGrant({ lease: { id: "lse_sse" } }));
    const frames = await framesPromise;

    expect(frames.map((frame) => frame.event)).toEqual(["queued", "provisioning", "granted"]);
    const last = frames.at(-1)?.data as { lease: { id: string } };
    expect(last.lease.id).toBe("lse_sse");
  });
});

describe("DELETE /v1/lease-requests/:id", () => {
  it("404s an unknown request id", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/lease-requests/req-missing", {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  it("204s when the request was still queued and cancellable", async () => {
    const { app, leases, queue } = buildHarness();
    const { id } = await createLeaseRequest(app, leases);

    queue.cancelOutcome = "cancelled";
    const response = await app.request(`/v1/lease-requests/${id}`, {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(204);
  });

  it("409s not-cancellable once device work is in flight", async () => {
    const { app, leases, queue } = buildHarness();
    const { id } = await createLeaseRequest(app, leases);

    queue.cancelOutcome = "not-cancellable";
    const response = await app.request(`/v1/lease-requests/${id}`, {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "REQUEST_NOT_CANCELLABLE",
    );
  });

  it("409s not-cancellable naming the lease id once already granted", async () => {
    const { app, leases } = buildHarness();
    const responsePromise = postLeaseRequest(app, defaultBody);
    await waitForCall(leases);
    leases.calls[0]?.resolve(makeGrant({ lease: { id: "lse_granted" } }));
    const created = await responsePromise;
    const { request } = (await created.json()) as { request: { id: string } };

    const response = await app.request(`/v1/lease-requests/${request.id}`, {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "REQUEST_NOT_CANCELLABLE",
        leaseId: "lse_granted",
        message: expect.any(String),
      },
    });
  });
});

describe("lease routes", () => {
  it("GET /v1/leases/:id returns the acquisition-shaped lease object", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", requesterId: "tok_agent" })];

    const response = await app.request("/v1/leases/lse_1", { headers: agentAuth });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { lease: Record<string, unknown> };
    expect(body.lease).toMatchObject({
      dataPlane: null,
      deviceId: "dev_1",
      device: "iPhone 17 Pro",
      id: "lse_1",
      platform: "ios",
      udid: "ABCD-1234",
    });
  });

  it("404s an unknown lease id", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/leases/lse-missing", { headers: agentAuth });
    expect(response.status).toBe(404);
  });

  it("403s an agent fetching another requester's lease", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", requesterId: "tok_other" })];

    const response = await app.request("/v1/leases/lse_1", { headers: agentAuth });
    expect(response.status).toBe(403);
  });

  it("POST /v1/leases/:id/renew drains buffered device-health notices", async () => {
    const { app, eventBus, leases, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", requesterId: "tok_agent" })];
    leases.renewImpl = async (leaseId, ttlMs) => ({
      deviceId: "dev_1",
      grantedAt: 1_000,
      id: leaseId,
      mode: "detached",
      requesterId: "tok_agent",
      ttlDeadline: 2_000 + (ttlMs ?? 900_000),
    });

    eventBus.emit(
      "device.crash-detected",
      { deviceId: "dev_1", leaseId: "lse_1", observed: "x", platform: "ios" },
      "test",
    );
    eventBus.emit(
      "device.recovered",
      { attempts: 1, deviceId: "dev_1", duration: 500, leaseId: "lse_1" },
      "test",
    );

    const response = await app.request("/v1/leases/lse_1/renew", {
      body: JSON.stringify({ ttlMs: 120_000 }),
      headers: { ...agentAuth, "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { leaseId: string; notices: unknown[] };
    expect(body.leaseId).toBe("lse_1");
    expect(body.notices).toEqual([
      { event: "device_unhealthy" },
      { attempts: 1, event: "device_recovered" },
    ]);
    expect(leases.renewCalls).toEqual([{ leaseId: "lse_1", ttlMs: 120_000 }]);
  });

  it("POST /v1/leases/:id/renew accepts an empty body", async () => {
    const { app, leases, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", requesterId: "tok_agent" })];
    leases.renewImpl = async (leaseId) => ({
      deviceId: "dev_1",
      grantedAt: 1_000,
      id: leaseId,
      mode: "detached",
      requesterId: "tok_agent",
      ttlDeadline: 2_000,
    });

    const response = await app.request("/v1/leases/lse_1/renew", {
      headers: agentAuth,
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(leases.renewCalls).toEqual([{ leaseId: "lse_1" }]);
  });

  it("404s a renew for an unknown lease", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/leases/lse-missing/renew", {
      headers: agentAuth,
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  it("streams live lease notices over SSE, ending on lease_lost", async () => {
    const { app, eventBus, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", requesterId: "tok_agent" })];

    const streamResponse = await app.request("/v1/leases/lse_1/events", { headers: agentAuth });
    const framesPromise = readSseFrames(streamResponse, 2);
    await Promise.resolve();
    eventBus.emit(
      "device.crash-detected",
      { deviceId: "dev_1", leaseId: "lse_1", observed: "x", platform: "ios" },
      "test",
    );
    eventBus.emit("lease.expired", { deviceId: "dev_1", leaseId: "lse_1" }, "test");
    const frames = await framesPromise;

    expect(frames.map((frame) => frame.event)).toEqual(["device_unhealthy", "lease_lost"]);
  });

  it("DELETE /v1/leases/:id releases and answers 202 with the device's post-release state", async () => {
    const { app, leases, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1", state: "leased" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", requesterId: "tok_agent" })];
    leases.releaseImpl = async (leaseId) => {
      registry.leases = registry.leases.filter((lease) => lease.id !== leaseId);
      registry.devices = registry.devices.map((device) =>
        device.id === "dev_1" ? { ...device, state: "reclaiming" } : device,
      );
    };

    const response = await app.request("/v1/leases/lse_1", {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      device: { id: "dev_1", state: "reclaiming" },
      released: true,
    });
    expect(leases.releaseCalls).toEqual([{ leaseId: "lse_1", reason: "explicit" }]);
  });

  it("an operator may release another requester's lease", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", requesterId: "tok_agent" })];

    const response = await app.request("/v1/leases/lse_1", {
      headers: operatorAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(202);
  });
});

describe("operator surface", () => {
  it("GET /v1/leases lists every lease", async () => {
    const { app, registry } = buildHarness();
    registry.leases = [
      makeLease({ id: "lse_1" }),
      makeLease({ id: "lse_2", requesterId: "tok_other" }),
    ];

    const response = await app.request("/v1/leases", { headers: operatorAuth });
    const body = (await response.json()) as { leases: Array<{ id: string }> };
    expect(body.leases.map((lease) => lease.id).sort()).toEqual(["lse_1", "lse_2"]);
  });

  it("GET /v1/devices lists every device", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" }), makeDevice({ id: "dev_2" })];

    const response = await app.request("/v1/devices", { headers: operatorAuth });
    const body = (await response.json()) as { devices: Array<{ id: string }> };
    expect(body.devices.map((device) => device.id).sort()).toEqual(["dev_1", "dev_2"]);
  });

  it("GET /v1/events replays the ring buffer, optionally filtered by ?since", async () => {
    const { app, clock, eventBus } = buildHarness();
    eventBus.emit("daemon.started", { configSnapshot: {}, version: "1" }, "test");
    clock.advance(10_000);
    eventBus.emit("daemon.stopping", { reason: "test" }, "test");

    const all = await app.request("/v1/events", { headers: operatorAuth });
    expect(((await all.json()) as { events: unknown[] }).events).toHaveLength(2);

    const recent = await app.request("/v1/events?since=5s", { headers: operatorAuth });
    const recentBody = (await recent.json()) as { events: Array<{ event: string }> };
    expect(recentBody.events).toEqual([expect.objectContaining({ event: "daemon.stopping" })]);
  });

  it("400s an invalid ?since duration", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/events?since=nonsense", { headers: operatorAuth });
    expect(response.status).toBe(400);
  });

  it("GET /v1/events/stream follows the event bus live", async () => {
    const { app, eventBus } = buildHarness();
    const streamResponse = await app.request("/v1/events/stream", { headers: operatorAuth });
    const framesPromise = readSseFrames(streamResponse, 1);
    await Promise.resolve();
    eventBus.emit("daemon.stopping", { reason: "live" }, "test");
    const frames = await framesPromise;
    expect(frames[0]?.event).toBe("daemon.stopping");
  });
});
