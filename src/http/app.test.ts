import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { NoCapacityError, RequesterAlreadyLeasedError, UnknownLeaseError } from "../core/index.js";
import { runDispatch } from "../daemon/dispatch.js";
import { DispatchError } from "../daemon/dispatcher.js";
import { describeLeaseRequestFailure } from "../daemon/error-code.js";
import { OwnerRoutedFactBus } from "../daemon/owner-routed-facts.js";
import { LeaseRequestBook } from "../core/lease-request-book.js";
import { Registry } from "../core/registry.js";
import { SerializedDecision } from "../core/serialized-decision.js";
import { RequestCancelledError } from "../core/wait-queue.js";
import { FakeClock, JsonLinesLogger, MemoryFilesystem, MemoryLogSink } from "../ports/index.js";
import { createHttpApp, type HttpGatewayDeps } from "./app.js";
import {
  FakeDispatcher,
  FakeRegistry,
  FakeTokenVerifier,
  makeDevice,
  makeGrant,
  makeLease,
  sequenceIdGenerator,
  testConfig,
  waitForDispatch,
} from "./test-fakes.js";

function buildHarness(
  overrides: {
    readonly config?: HttpGatewayDeps["config"];
    readonly leaseRequests?: HttpGatewayDeps["leaseRequests"];
    /** A gateway's device reader, in place of the fake worker registry. */
    readonly registry?: HttpGatewayDeps["registry"];
    readonly answerDownloadsEarly?: boolean;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const dispatcher = new FakeDispatcher(clock);
  const registry = new FakeRegistry();
  const ownerRoutedFacts = new OwnerRoutedFactBus(eventBus, registry);
  const tokens = new FakeTokenVerifier();
  tokens.register("slk_agent", { requesterId: "tok_agent", role: "agent" });
  tokens.register("slk_other", { requesterId: "tok_other", role: "agent" });
  tokens.register("slk_operator", { requesterId: "tok_operator", role: "operator" });
  const logSink = new MemoryLogSink();
  const logger = new JsonLinesLogger({ clock, sink: logSink });
  const config = overrides.config ?? testConfig();

  // Default `lease.list` behaviour mirrors the real dispatcher's handler (agent sees its own
  // leases by `ownerId`, admin sees all) -- most lease-detail routes go through it via
  // `findOwnedLease`, so tests that don't care about ownership specifically don't each need to
  // register their own handler.
  dispatcher.handlers["lease.list"] = (_input, session) => ({
    leases: registry.leases.filter(
      (lease) => session.role === "admin" || lease.ownerId === session.principal,
    ),
  });

  const app = createHttpApp({
    clock,
    config,
    dispatch: (op, input, session) => dispatcher.dispatch(op, input, session) as never,
    eventBus,
    idGenerator: sequenceIdGenerator("gw"),
    leaseRequests: overrides.leaseRequests ?? dispatcher.requests,
    logger,
    ownerRoutedFacts,
    registry: overrides.registry ?? registry,
    tokens,
    ...(overrides.answerDownloadsEarly === undefined
      ? {}
      : { answerDownloadsEarly: overrides.answerDownloadsEarly }),
  });

  return { app, clock, config, dispatcher, eventBus, logSink, registry, tokens };
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
 * request's id. `LeaseRequestTracker.submit` never settles until the `lease.request` dispatch's
 * first `onProgress` call (or its own grant/rejection) -- see `tracker.ts`.
 */
async function createLeaseRequest(
  app: App,
  dispatcher: FakeDispatcher,
  body: Record<string, unknown> = defaultBody,
  headers: Record<string, string> = agentAuth,
): Promise<{ readonly id: string; readonly callIndex: number }> {
  const responsePromise = postLeaseRequest(app, body, headers);
  const call = await waitForDispatch(dispatcher, "lease.request");
  const callIndex = dispatcher.calls.indexOf(call);
  call.session.onProgress?.({ queuePosition: 1, stage: "queued" });
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

describe("authentication and role/ownership (via the shared dispatcher)", () => {
  it("401s a protected route with no token", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/status");
    expect(response.status).toBe(401);
  });

  it("403s an agent token whose dispatched operation is admin-only -- ADR: role gating moved to the shared dispatcher, not an HTTP-only minRole check", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["list.get"] = () => {
      throw new DispatchError("FORBIDDEN", "Operation list.get requires role admin");
    };
    const response = await app.request("/v1/devices", { headers: agentAuth });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("admits an operator token on the same admin-only route", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["list.get"] = () => [];
    const response = await app.request("/v1/devices", { headers: operatorAuth });
    expect(response.status).toBe(200);
  });

  it("403s an agent reaching another requester's lease request (HTTP-only tracker resource guard)", async () => {
    const { app, dispatcher } = buildHarness();
    const { id } = await createLeaseRequest(app, dispatcher);

    const response = await app.request(`/v1/lease-requests/${id}`, { headers: otherAgentAuth });
    expect(response.status).toBe(403);
  });

  it("404s (not 403) an agent fetching another requester's lease -- ownership is lease.list's own filter now, not a separate check", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_other" })];

    const response = await app.request("/v1/leases/lse_1", { headers: agentAuth });
    expect(response.status).toBe(404);
  });
});

describe("GET /v1/status, /v1/catalog", () => {
  it("passes the dispatched status.get response straight through", async () => {
    const { app, dispatcher } = buildHarness();
    const status = {
      capacity: {},
      daemon: { health: "running", mode: "worker" },
      devices: [{ id: "dev_1" }],
      leases: [],
      queueDepth: 0,
    };
    dispatcher.handlers["status.get"] = () => status;

    const response = await app.request("/v1/status", { headers: agentAuth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  });

  it("filters the catalog by platform query", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["catalog.get"] = (input) => {
      expect(input).toEqual({ platform: "ios" });
      return {
        platforms: [
          {
            defaultRuntime: "26.5",
            modelClasses: { "iPhone 17 Pro": "phone" },
            models: ["iPhone 17 Pro"],
            platform: "ios",
            runtimes: ["26.5"],
          },
        ],
      };
    };
    const response = await app.request("/v1/catalog?platform=ios", { headers: agentAuth });
    expect(await response.json()).toEqual({
      platforms: [
        {
          defaultRuntime: "26.5",
          modelClasses: { "iPhone 17 Pro": "phone" },
          models: ["iPhone 17 Pro"],
          platform: "ios",
          runtimes: ["26.5"],
        },
      ],
    });
  });

  it("400s an invalid platform query, before ever dispatching", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["catalog.get"] = () => {
      throw new Error("should not be called");
    };
    const response = await app.request("/v1/catalog?platform=windows", { headers: agentAuth });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});

describe("GET /v1/components", () => {
  const listing = {
    components: [
      {
        devices: 1,
        foreignDevices: 0,
        installedAt: 1_790_864_071_200,
        installedBySimlock: true,
        platform: "android",
        sizeBytes: 4_200_000_000,
        variant: "google_apis/arm64-v8a",
        version: "35",
      },
    ],
  };

  it("answers an agent token with component.list, passing the platform query through", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["component.list"] = (input) => {
      expect(input).toEqual({ platform: "android" });
      return listing;
    };

    const response = await app.request("/v1/components?platform=android", { headers: agentAuth });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(listing);
  });

  it("lists every platform when no platform is asked for", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["component.list"] = (input) => {
      expect(input).toEqual({});
      return listing;
    };

    const response = await app.request("/v1/components", { headers: agentAuth });

    expect(response.status).toBe(200);
  });

  it("400s an invalid platform query, before ever dispatching", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["component.list"] = () => {
      throw new Error("should not be called");
    };

    const response = await app.request("/v1/components?platform=windows", { headers: agentAuth });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});

describe("DELETE /v1/components/{platform}/{version}", () => {
  it("dispatches component.remove with the path's platform and version, and answers its result as JSON", async () => {
    const { app, dispatcher } = buildHarness();
    const answer = { outcome: "removed", platform: "ios", sizeBytes: 7, version: "26.4" };
    dispatcher.handlers["component.remove"] = (input) => {
      expect(input).toEqual({ platform: "ios", version: "26.4" });
      return answer;
    };

    const response = await app.request("/v1/components/ios/26.4", {
      headers: operatorAuth,
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toEqual(answer);
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("passes ?dryRun=%s through as dryRun", async (query, dryRun) => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["component.remove"] = (input) => {
      expect(input).toEqual({ dryRun, platform: "android", version: "35" });
      return { outcome: "would-remove", platform: "android", version: "35" };
    };

    const response = await app.request(`/v1/components/android/35?dryRun=${query}`, {
      headers: operatorAuth,
      method: "DELETE",
    });

    expect(response.status).toBe(200);
  });

  it("400s a dryRun that is not true or false, before ever dispatching", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["component.remove"] = () => {
      throw new Error("should not be called");
    };

    const response = await app.request("/v1/components/ios/26.4?dryRun=yes", {
      headers: operatorAuth,
      method: "DELETE",
    });

    expect(response.status).toBe(400);
  });

  it("answers COMPONENT_IN_USE with 409 and both counts in the body", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["component.remove"] = () => {
      throw new DispatchError("COMPONENT_IN_USE", "ios 26.4 is in use", {
        devices: 1,
        foreignDevices: 2,
      });
    };

    const response = await app.request("/v1/components/ios/26.4", {
      headers: operatorAuth,
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "COMPONENT_IN_USE",
        devices: 1,
        foreignDevices: 2,
        message: "ios 26.4 is in use",
      },
    });
  });
});

describe("POST /v1/lease-requests", () => {
  it("creates a request resource, 201 with a Location header", async () => {
    const { app, dispatcher } = buildHarness();
    const responsePromise = postLeaseRequest(app, defaultBody);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.session.onProgress?.({ queuePosition: 2, stage: "queued" });
    const response = await responsePromise;

    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toMatch(/^\/v1\/lease-requests\/req_/);
    const body = (await response.json()) as {
      request: { id: string; state: string; queuePosition: number };
    };
    expect(body.request.state).toBe("queued");
    expect(body.request.queuePosition).toBe(2);
  });

  it("400s a malformed body before ever dispatching", async () => {
    const { app, dispatcher } = buildHarness();
    const response = await postLeaseRequest(app, { device: "iPhone 17 Pro" });
    expect(response.status).toBe(400);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("400s a body naming both a device and a class as BAD_REQUEST before dispatching, the message naming both fields", async () => {
    const { app, dispatcher } = buildHarness();

    const response = await postLeaseRequest(app, { ...defaultBody, class: "phone" });

    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe(
      "class: a request names a model or a class, not both: send only one of `device` and `class`",
    );
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("dispatches a body naming a device as the model, with no class", async () => {
    const { app, dispatcher } = buildHarness();
    const responsePromise = postLeaseRequest(app, defaultBody);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.session.onProgress?.({ queuePosition: 1, stage: "queued" });
    await responsePromise;

    expect(call.input).toMatchObject({ model: "iPhone 17 Pro", platform: "ios" });
    expect(call.input).not.toHaveProperty("class");
  });

  it.each([
    ["a class", { class: "tablet", platform: "ios" }, { class: "tablet", platform: "ios" }],
    ["only a platform", { platform: "android" }, { platform: "android" }],
  ])("dispatches a body naming %s with no model", async (_label, body, expected) => {
    const { app, dispatcher } = buildHarness();
    const responsePromise = postLeaseRequest(app, body);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.session.onProgress?.({ queuePosition: 1, stage: "queued" });
    await responsePromise;

    expect(call.input).toMatchObject(expected);
    expect(call.input).not.toHaveProperty("model");
  });

  it.each([
    ["full", { full: true }],
    ["a mode other than slim or full", { mode: "fast" }],
    ["a key the route does not know", { colour: "blue" }],
    ["an image tag with a space", { imageTag: "google apis" }],
    ["an image tag over 64 characters", { imageTag: "a".repeat(65) }],
  ])("400s a body carrying %s as BAD_REQUEST before ever dispatching", async (_label, extra) => {
    const { app, dispatcher } = buildHarness();
    // Raced against a dispatch, so a body that is wrongly accepted fails here on the assertion
    // below rather than by waiting for a 201 that only comes once the request is queued.
    const response = await Promise.race([
      postLeaseRequest(app, { ...defaultBody, ...extra }),
      waitForDispatch(dispatcher, "lease.request").then(() => "dispatched" as const),
    ]);
    if (response === "dispatched") throw new Error("the body was dispatched instead of refused");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("forwards a body's imageTag to the dispatched lease.request", async () => {
    const { app, dispatcher } = buildHarness();
    void postLeaseRequest(app, { ...defaultBody, imageTag: "google_apis_playstore" });
    const call = await waitForDispatch(dispatcher, "lease.request");
    expect(call.input).toMatchObject({ imageTag: "google_apis_playstore" });
  });

  it("forwards a body's mode to the dispatched lease.request", async () => {
    const { app, dispatcher } = buildHarness();
    void postLeaseRequest(app, { ...defaultBody, mode: "slim" });
    const call = await waitForDispatch(dispatcher, "lease.request");
    expect(call.input).toMatchObject({ mode: "slim" });
  });

  it("forwards a body's owner field to the dispatched lease.request rather than silently dropping it (ADR §27a, H7)", async () => {
    // Before this, `leaseRequestBodySchema` had no `owner` field at all, so a caller naming one
    // was answered as though it had named none -- the same anti-pattern this codebase's own
    // `device.exec`'s `requesterId` precedent already rejected: an identity named and answered
    // as if it had not is the kind of silence that reads like authorization. The gate itself
    // (FORBIDDEN for a non-admin token) lives in the shared dispatcher, exercised once for every
    // transport in `daemon/dispatcher.test.ts`/`gateway/dispatcher.test.ts` -- this only proves
    // the field actually reaches that dispatcher from HTTP instead of being dropped in transit.
    const { app, dispatcher } = buildHarness();
    void postLeaseRequest(app, { ...defaultBody, owner: "someone-else" });
    const call = await waitForDispatch(dispatcher, "lease.request");

    expect((call.input as { owner?: string }).owner).toBe("someone-else");
  });

  it("builds an operator token's session as admin but never as the gateway's uplink, so §27a's owner gate still refuses it at the shared dispatcher (ADR §27a, H3)", async () => {
    // §27a's `owner` field is narrowed to `session.isGatewayUplink` (round 3 review, H3): an
    // HTTP `operator` bearer token maps onto `role: "admin"` (`dispatcher-session.ts`'s
    // `toRole`), same as before, but `buildHttpSession` never sets `isGatewayUplink` -- no HTTP
    // request is ever the worker's own uplink connection to its configured gateway, which is the
    // only session that connection-acceptance signal is stamped on (`DaemonServer#acceptUplink`,
    // via `connection.forcedRole`). This is what makes the real gate in
    // `daemon/dispatcher.test.ts`/`gateway/dispatcher.test.ts` (FORBIDDEN for `isGatewayUplink !==
    // true`, exercised there against the real dispatcher) actually bite an operator token too,
    // not just an agent one -- this test only proves the session HTTP hands that dispatcher never
    // carries the one flag that would let it through.
    const { app, dispatcher } = buildHarness();
    void postLeaseRequest(app, { ...defaultBody, owner: "someone-else" }, operatorAuth);
    const call = await waitForDispatch(dispatcher, "lease.request");

    expect(call.session.role).toBe("admin");
    expect(call.session.isGatewayUplink).not.toBe(true);
  });

  it("maps a fast RequesterAlreadyLeasedError to 409, naming the existing lease", async () => {
    const { app, dispatcher } = buildHarness();
    const responsePromise = postLeaseRequest(app, defaultBody);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.reject(new RequesterAlreadyLeasedError("tok_agent", "lse_existing"));
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
    const { app, dispatcher } = buildHarness();
    const responsePromise = postLeaseRequest(app, { ...defaultBody, noWait: true });
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.reject(new NoCapacityError());
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });

  it("replays an identical Idempotency-Key without a second dispatch call", async () => {
    const { app, dispatcher } = buildHarness();
    const { id: firstId } = await createLeaseRequest(app, dispatcher, defaultBody, {
      ...agentAuth,
      "idempotency-key": "abc",
    });

    const second = await postLeaseRequest(app, defaultBody, {
      ...agentAuth,
      "idempotency-key": "abc",
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { request: { id: string } };
    expect(dispatcher.calls.filter((c) => c.operation === "lease.request")).toHaveLength(1);
    expect(secondBody.request.id).toBe(firstId);
  });

  it("answers a dispatcher refusal that lands before admission on the POST itself, even with allowDownload", async () => {
    // `allowDownload: true` answers `201` once the request is stored, not before: a refusal the
    // dispatcher raises ahead of admission -- a `ttlMs` above `lease.maxTtlMs` is one -- still
    // fails the POST, so the route needs no cap check of its own.
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.request"] = () => {
      throw new DispatchError("BAD_REQUEST", "ttlMs 120001 exceeds lease.maxTtlMs (120000)");
    };

    const response = await postLeaseRequest(app, {
      ...defaultBody,
      allowDownload: true,
      ttlMs: 120_001,
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it.each([
    ["with allowDownload", { allowDownload: true }],
    ["without allowDownload", {}],
  ])(
    "fails the POST with the dispatcher's rejection, allowDownload or not, when the app is told downloads do not answer early (%s)",
    async (_label, extra) => {
      const { app, dispatcher } = buildHarness({ answerDownloadsEarly: false });
      const responsePromise = postLeaseRequest(app, { ...defaultBody, ...extra });
      const call = await waitForDispatch(dispatcher, "lease.request");
      call.session.onRequestAdmitted?.("req_1", false);
      call.reject(new DispatchError("UNKNOWN_MODEL", "no worker lists iPhone 17 Pro"));

      const response = await responsePromise;

      expect(response.status).toBe(422);
      expect((await response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "UNKNOWN_MODEL" },
      });
    },
  );

  it("answers 201 as soon as the request is stored with allowDownload, by default", async () => {
    const { app, dispatcher } = buildHarness();
    const responsePromise = postLeaseRequest(app, { ...defaultBody, allowDownload: true });
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.session.onRequestAdmitted?.("req_1", false);

    // Settles with the dispatch still open: nothing was granted or rejected.
    expect((await responsePromise).status).toBe(201);
  });

  it("passes a caller-supplied ttlMs straight onto the dispatch input -- no separate renew call (ADR §9)", async () => {
    const { app, dispatcher } = buildHarness();
    const responsePromise = postLeaseRequest(app, { ...defaultBody, ttlMs: 60_000 });
    const call = await waitForDispatch(dispatcher, "lease.request");
    expect(call.input).toMatchObject({ ttlMs: 60_000 });
    call.resolve(makeGrant({ lease: { grantedAt: 1_000, id: "lse_1", ttlDeadline: 61_000 } }));
    await responsePromise;
    expect(dispatcher.calls.filter((c) => c.operation === "lease.renew")).toHaveLength(0);
  });
});

describe("full lease-request lifecycle via GET / long-poll / SSE", () => {
  it("progresses queued -> booting -> granted, observable through GET", async () => {
    const { app, dispatcher } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, dispatcher);

    dispatcher.calls[callIndex]?.session.onProgress?.({ etaMs: 30_000, stage: "booting" });
    const midway = await app.request(`/v1/lease-requests/${id}`, { headers: agentAuth });
    expect(
      ((await midway.json()) as { request: { state: string; etaSeconds: number } }).request,
    ).toEqual({
      createdAt: expect.any(String),
      etaSeconds: 30,
      id,
      state: "booting",
    });

    dispatcher.calls[callIndex]?.resolve(makeGrant({ lease: { id: "lse_final" } }));
    const final = await app.request(`/v1/lease-requests/${id}`, { headers: agentAuth });
    const finalBody = (await final.json()) as {
      request: { state: string; lease: { id: string; dataPlane: unknown } };
    };
    expect(finalBody.request.state).toBe("granted");
    expect(finalBody.request.lease.id).toBe("lse_final");
    expect(finalBody.request.lease.dataPlane).toBeNull();
  });

  it("long-polls: ?wait returns early on a state change", async () => {
    const { app, dispatcher } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, dispatcher);

    const waitPromise = app.request(`/v1/lease-requests/${id}?wait=30`, { headers: agentAuth });
    await Promise.resolve();
    await Promise.resolve();
    dispatcher.calls[callIndex]?.session.onProgress?.({ etaMs: 10_000, stage: "provisioning" });
    const response = await waitPromise;
    const body = (await response.json()) as { request: { state: string } };
    expect(body.request.state).toBe("provisioning");
  });

  it("long-polls: ?wait returns the unchanged state once the timer elapses", async () => {
    const { app, clock, dispatcher } = buildHarness();
    const { id } = await createLeaseRequest(app, dispatcher);

    const waitPromise = app.request(`/v1/lease-requests/${id}?wait=5`, { headers: agentAuth });
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(5_000);
    const response = await waitPromise;
    const body = (await response.json()) as { request: { state: string; queuePosition: number } };
    expect(body.request).toMatchObject({ queuePosition: 1, state: "queued" });
  });

  it("streams SSE progress events, ending with the terminal granted event", async () => {
    const { app, dispatcher } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, dispatcher);

    const streamResponse = await app.request(`/v1/lease-requests/${id}/events`, {
      headers: agentAuth,
    });
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

    const framesPromise = readSseFrames(streamResponse, 3);
    dispatcher.calls[callIndex]?.session.onProgress?.({ etaMs: 20_000, stage: "provisioning" });
    dispatcher.calls[callIndex]?.resolve(makeGrant({ lease: { id: "lse_sse" } }));
    const frames = await framesPromise;

    expect(frames.map((frame) => frame.event)).toEqual(["queued", "provisioning", "granted"]);
    const last = frames.at(-1)?.data as { lease: { id: string } };
    expect(last.lease.id).toBe("lse_sse");
  });

  it("shows downloading with its component, whether it waits, and its percent on GET while the install runs", async () => {
    const { app, dispatcher } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, dispatcher, {
      ...defaultBody,
      allowDownload: true,
    });
    const read = async () =>
      (
        (await (await app.request(`/v1/lease-requests/${id}`, { headers: agentAuth })).json()) as {
          request: unknown;
        }
      ).request;

    const session = dispatcher.calls[callIndex]?.session;
    session?.onProgress?.({ component: "26.4", stage: "downloading", waiting: true });
    expect(await read()).toEqual({
      component: "26.4",
      createdAt: expect.any(String),
      id,
      state: "downloading",
      waiting: true,
    });

    session?.onProgress?.({ component: "26.4", percent: 41, stage: "downloading", waiting: false });
    expect(await read()).toEqual({
      component: "26.4",
      createdAt: expect.any(String),
      id,
      percent: 41,
      state: "downloading",
      waiting: false,
    });
  });

  it("sends a downloading event on the lease-request event stream", async () => {
    const { app, dispatcher } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, dispatcher, {
      ...defaultBody,
      allowDownload: true,
    });

    const streamResponse = await app.request(`/v1/lease-requests/${id}/events`, {
      headers: agentAuth,
    });
    const framesPromise = readSseFrames(streamResponse, 3);
    dispatcher.calls[callIndex]?.session.onProgress?.({
      component: "26.4",
      percent: 41,
      stage: "downloading",
      waiting: false,
    });
    dispatcher.calls[callIndex]?.resolve(makeGrant({ lease: { id: "lse_download" } }));
    const frames = await framesPromise;

    expect(frames.map((frame) => frame.event)).toEqual(["queued", "downloading", "granted"]);
    expect(frames[1]?.data).toEqual({
      component: "26.4",
      createdAt: expect.any(String),
      id,
      percent: 41,
      state: "downloading",
      waiting: false,
    });
  });
});

describe("GET /v1/lease-requests/:id across a daemon restart", () => {
  it("answers from the core record a previous daemon process stored", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const load = () =>
      Registry.load({
        clock,
        eventBus: new EventBus(clock),
        filesystem,
        idGenerator: sequenceIdGenerator("stored"),
        statePath: "/home/agent/.simlock/state.json",
      });
    const before = await load();
    const stored = await before.createLeaseRequest({
      ownerId: "tok_agent",
      request: { model: "iPhone 17 Pro", platform: "ios" },
      requesterId: "tok_agent",
    });
    await before.settleLeaseRequest(stored.id, {
      grant: makeGrant({ lease: { id: "lse_before_restart" } }),
      state: "granted",
    });

    // A new process: a fresh registry read from disk, and a request book nothing was ever
    // submitted through.
    const after = await load();
    const { app } = buildHarness({
      leaseRequests: new LeaseRequestBook({
        decisions: new SerializedDecision(),
        describeFailure: describeLeaseRequestFailure,
        store: after,
      }),
    });
    const response = await app.request(`/v1/lease-requests/${stored.id}`, {
      headers: agentAuth,
    });

    expect(response.status).toBe(200);
    expect(
      (await response.json()) as { request: { state: string; lease: { id: string } } },
    ).toMatchObject({
      request: {
        id: stored.id,
        lease: { id: "lse_before_restart", requestId: stored.id },
        state: "granted",
      },
    });
  });
});

describe("GET /v1/lease-requests/:id/events for a request nothing is driving", () => {
  it("ends the stream after the current state when the request has no live wait to report on", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: sequenceIdGenerator("stored"),
      statePath: "/home/agent/.simlock/state.json",
    });
    // Stored open by a previous process; this one has not settled it yet.
    const stored = await registry.createLeaseRequest({
      ownerId: "tok_agent",
      request: { model: "iPhone 17 Pro", platform: "ios" },
      requesterId: "tok_agent",
    });
    const { app } = buildHarness({
      leaseRequests: new LeaseRequestBook({
        decisions: new SerializedDecision(),
        describeFailure: describeLeaseRequestFailure,
        store: registry,
      }),
    });

    const response = await app.request(`/v1/lease-requests/${stored.id}/events`, {
      headers: agentAuth,
    });
    const body = await Promise.race([
      response.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve("STILL OPEN"), 1_000)),
    ]);

    expect(body).not.toBe("STILL OPEN");
    expect(body).toContain("event: queued");
  });
});

describe("lease-request ownership", () => {
  /** A request sent over another frontend under `tok_agent`'s requester id, by `tok_other`. */
  async function requestOwnedByOther(dispatcher: FakeDispatcher): Promise<string> {
    let id: string | undefined;
    void dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", platform: "ios", requesterId: "tok_agent" },
      {
        manageEventSubscription: () => undefined,
        onRequestAdmitted: (admitted) => (id = admitted),
        principal: "tok_other",
        role: "agent",
      },
    );
    await waitForDispatch(dispatcher, "lease.request");
    if (id === undefined) throw new Error("expected the request to be stored");
    return id;
  }

  it("answers 403 to a GET from the token named as requester, and 200 to the token that sent it", async () => {
    const { app, dispatcher } = buildHarness();
    const id = await requestOwnedByOther(dispatcher);

    const named = await app.request(`/v1/lease-requests/${id}`, { headers: agentAuth });
    const sender = await app.request(`/v1/lease-requests/${id}`, { headers: otherAgentAuth });

    expect(named.status).toBe(403);
    expect(sender.status).toBe(200);
  });

  it("answers 403 to a DELETE from a token that did not send the request", async () => {
    const { app, dispatcher } = buildHarness();
    const id = await requestOwnedByOther(dispatcher);
    dispatcher.handlers["lease.cancel"] = () => ({ result: "not-cancellable" });

    const response = await app.request(`/v1/lease-requests/${id}`, {
      headers: agentAuth,
      method: "DELETE",
    });

    expect(response.status).toBe(403);
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

  it("204s when the request was still queued and cancellable, and a GET right after reads cancelled", async () => {
    const { app, dispatcher } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, dispatcher);

    // What the daemon's `lease.cancel` does to a queued wait: rejects it as cancelled.
    dispatcher.handlers["lease.cancel"] = () => {
      dispatcher.calls[callIndex]?.reject(new RequestCancelledError(id));
      return { result: "cancelled" };
    };
    const response = await app.request(`/v1/lease-requests/${id}`, {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    const after = await app.request(`/v1/lease-requests/${id}`, { headers: agentAuth });
    expect(((await after.json()) as { request: { state: string } }).request.state).toBe(
      "cancelled",
    );
  });

  it("409s not-cancellable once device work is in flight", async () => {
    const { app, dispatcher } = buildHarness();
    const { id } = await createLeaseRequest(app, dispatcher);

    dispatcher.handlers["lease.cancel"] = () => ({ result: "not-cancellable" });
    const response = await app.request(`/v1/lease-requests/${id}`, {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "REQUEST_NOT_CANCELLABLE",
    );
  });

  it("409s not-cancellable naming the lease id once already granted -- caught before dispatching lease.cancel at all", async () => {
    const { app, dispatcher } = buildHarness();
    const responsePromise = postLeaseRequest(app, defaultBody);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.resolve(makeGrant({ lease: { id: "lse_granted" } }));
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
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];

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
    expect(body.lease).not.toHaveProperty("worker");
    expect(body.lease).not.toHaveProperty("workerId");
  });

  it("GET /v1/leases/:id on a gateway builds the lease from its own worker's device, not another worker's with the same device id", async () => {
    const device = (workerId: string, udid: string) => ({
      ...makeDevice({ driverDeviceId: udid, id: "dev_1" }),
      workerId,
    });
    const { app, dispatcher } = buildHarness({
      registry: {
        snapshot: { devices: [device("wrk_a", "UDID-A"), device("wrk_b", "UDID-B")] },
      },
    });
    dispatcher.handlers["lease.list"] = () => ({
      leases: [
        {
          ...makeLease({ deviceId: "dev_1", id: "wrk_b.lse_1", ownerId: "tok_agent" }),
          worker: { id: "wrk_b", label: "mac-b" },
          workerId: "wrk_b",
        },
      ],
    });

    const response = await app.request("/v1/leases/wrk_b.lse_1", { headers: agentAuth });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { lease: unknown }).lease).toMatchObject({
      deviceId: "dev_1",
      id: "wrk_b.lse_1",
      udid: "UDID-B",
      worker: { id: "wrk_b", label: "mac-b" },
      workerId: "wrk_b",
    });
  });

  it("404s an unknown lease id", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/leases/lse-missing", { headers: agentAuth });
    expect(response.status).toBe(404);
  });

  it("POST /v1/leases/:id/renew drains buffered device-health notices", async () => {
    const { app, dispatcher, eventBus, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];
    dispatcher.handlers["lease.renew"] = (input) => ({
      deviceId: "dev_1",
      grantedAt: 1_000,
      id: (input as { leaseId: string }).leaseId,
      ownerId: "tok_agent",
      requesterId: "tok_agent",
      ttlDeadline: 2_000 + ((input as { ttlMs?: number }).ttlMs ?? 900_000),
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
  });

  it("POST /v1/leases/:id/renew accepts an empty body", async () => {
    const { app, dispatcher, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];
    dispatcher.handlers["lease.renew"] = (input) => {
      expect(input).toEqual({ leaseId: "lse_1" });
      return {
        deviceId: "dev_1",
        grantedAt: 1_000,
        id: "lse_1",
        ownerId: "tok_agent",
        requesterId: "tok_agent",
        ttlDeadline: 2_000,
      };
    };

    const response = await app.request("/v1/leases/lse_1/renew", {
      headers: agentAuth,
      method: "POST",
    });
    expect(response.status).toBe(200);
  });

  it("404s a renew for an unknown lease", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.renew"] = () => {
      throw new UnknownLeaseError("lse-missing");
    };

    const response = await app.request("/v1/leases/lse-missing/renew", {
      headers: agentAuth,
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_LEASE",
    );
  });

  it("403s a renew for another requester's still-live lease -- dispatched directly through lease.renew's own ownsLease hook, not lease.list's 404-for-everything filter (S6)", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.renew"] = () => {
      throw new DispatchError("FORBIDDEN", "Not authorized for lease.renew");
    };

    const response = await app.request("/v1/leases/lse_other/renew", {
      headers: agentAuth,
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("streams live lease notices over SSE, ending on lease_lost -- fed by the owner-routed fact bus, not a direct eventBus subscription", async () => {
    const { app, eventBus, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];

    const streamResponse = await app.request("/v1/leases/lse_1/events", { headers: agentAuth });
    const framesPromise = readSseFrames(streamResponse, 2);
    await Promise.resolve();
    eventBus.emit(
      "device.crash-detected",
      { deviceId: "dev_1", leaseId: "lse_1", observed: "x", platform: "ios" },
      "test",
    );
    eventBus.emit(
      "lease.expired",
      { deviceId: "dev_1", leaseId: "lse_1", ownerId: "tok_agent" },
      "test",
    );
    const frames = await framesPromise;

    expect(frames.map((frame) => frame.event)).toEqual(["device_unhealthy", "lease_lost"]);
  });

  /**
   * ADR 0005 §19a's HTTP frontend. The route's whole job is to turn one dispatched
   * `device.exec` into a stream: `output` per chunk, one terminal `exit` or `error`. What the
   * command does is the dispatcher's business (see `daemon/dispatcher.test.ts`).
   */
  describe("POST /v1/leases/:id/exec", () => {
    function postExec(
      app: App,
      body: Record<string, unknown> = { args: ["list"], tool: "simctl" },
    ) {
      return app.request("/v1/leases/lse_1/exec", {
        body: JSON.stringify(body),
        headers: { ...agentAuth, "content-type": "application/json" },
        method: "POST",
      });
    }

    it("streams a chunk per output event and ends with the command's exit code", async () => {
      const { app, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      // The path names the lease; the body is the rest of the operation's input.
      expect(call.input).toEqual({ args: ["list"], leaseId: "lse_1", tool: "simctl" });

      // The stream opens when the process starts, not when it first speaks (ADR 0005 §19e).
      // This chunk lands in the window between the two, which is the only thing the route's
      // handoff buffer is for: it must still arrive, and still arrive first.
      call.session.onStarted?.();
      call.session.onOutput?.("stdout", "one");
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const framesPromise = readSseFrames(response, 3);
      await Promise.resolve();
      call.session.onOutput?.("stderr", "two");
      call.resolve({ exitCode: 5 });
      const frames = await framesPromise;

      expect(frames.map((frame) => frame.event)).toEqual(["output", "output", "exit"]);
      expect(frames.map((frame) => frame.data)).toEqual([
        { chunk: "one", stream: "stdout" },
        { chunk: "two", stream: "stderr" },
        { exitCode: 5 },
      ]);
    });

    it("answers a failure that lands before any output with its own status, not a stream", async () => {
      // An SSE response cannot take back its status code, so ownership and the refusal list
      // have to be answered ahead of the stream -- 403 here, exactly as `renew`/`release` do.
      const { app, dispatcher } = buildHarness();
      dispatcher.handlers["device.exec"] = () => {
        throw new DispatchError("FORBIDDEN", "Not authorized for device.exec");
      };

      const response = await postExec(app);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    });

    it("reports a failure that lands after output began as a terminal error event", async () => {
      const { app, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      call.session.onStarted?.();
      call.session.onOutput?.("stdout", "working");
      const response = await responsePromise;

      const framesPromise = readSseFrames(response, 2);
      await Promise.resolve();
      call.reject(new DispatchError("EXEC_TIMEOUT", "exceeded exec.timeoutMs (1000ms)"));
      const frames = await framesPromise;

      expect(frames.map((frame) => frame.event)).toEqual(["output", "error"]);
      expect(frames.at(-1)?.data).toMatchObject({ error: { code: "EXEC_TIMEOUT" } });
    });

    it("forwards requesterId unchanged for both an operator and an agent token, leaving the FORBIDDEN decision to device.exec's own authorize hook", async () => {
      // Requester identity is never client-declared over HTTP (docs/HTTP-API.md,
      // "Authentication"): the token is the identity, except for an operator token proxying
      // for someone (ADR 0005 §19b/§27). Round 4, F4: this route used to decide on its own
      // that an agent token may not supply `requesterId` at all, which left that rule living
      // only in the HTTP transport (ADR 0003 §2 puts a contract operation's answer in the
      // dispatcher). The rule moved into `device.exec`'s own `authorize` hook -- exercised
      // directly in `dispatcher.test.ts` -- so this route now forwards `requesterId` exactly
      // the same way for either token and merely surfaces whatever the dispatcher answers.
      const { app, dispatcher } = buildHarness();

      const asOperator = app.request("/v1/leases/lse_1/exec", {
        body: JSON.stringify({ args: ["list"], requesterId: "agent-7", tool: "simctl" }),
        headers: { ...operatorAuth, "content-type": "application/json" },
        method: "POST",
      });
      const operatorCall = await waitForDispatch(dispatcher, "device.exec");
      expect(operatorCall.input).toEqual({
        args: ["list"],
        leaseId: "lse_1",
        requesterId: "agent-7",
        tool: "simctl",
      });
      operatorCall.session.onStarted?.();
      operatorCall.resolve({ exitCode: 0 });
      await asOperator;

      // Forwarded exactly the same way for an agent token -- the route makes no distinction
      // any more. `FakeDispatcher` has no `authorize` hook of its own to reject this with, so
      // the rejection is simulated here (`DispatchError("FORBIDDEN", ...)`, precisely what the
      // real dispatcher's `authorize` hook now throws for this case) to prove this route still
      // surfaces it as a 403 rather than requiring a route-level check to produce one.
      const asAgent = app.request("/v1/leases/lse_1/exec", {
        body: JSON.stringify({ args: ["list"], requesterId: "agent-7", tool: "simctl" }),
        headers: { ...agentAuth, "content-type": "application/json" },
        method: "POST",
      });
      const agentCall = await waitForDispatch(dispatcher, "device.exec", 1);
      expect(agentCall.input).toEqual({
        args: ["list"],
        leaseId: "lse_1",
        requesterId: "agent-7",
        tool: "simctl",
      });
      agentCall.reject(new DispatchError("FORBIDDEN", "Not authorized for device.exec"));
      const asAgentResponse = await asAgent;
      expect(asAgentResponse.status).toBe(403);
      expect(((await asAgentResponse.json()) as { error: { code: string } }).error.code).toBe(
        "FORBIDDEN",
      );

      // A `null` for either optional is the documented example's own spelling, and normalizes
      // to an omitted field rather than a 400 -- including for an agent, which is not
      // "supplying a requesterId".
      const withNulls = app.request("/v1/leases/lse_1/exec", {
        body: JSON.stringify({ args: ["list"], requesterId: null, stdin: null, tool: "simctl" }),
        headers: { ...agentAuth, "content-type": "application/json" },
        method: "POST",
      });
      const nullCall = await waitForDispatch(dispatcher, "device.exec", 2);
      expect(nullCall.input).toEqual({ args: ["list"], leaseId: "lse_1", tool: "simctl" });
      nullCall.session.onStarted?.();
      nullCall.resolve({ exitCode: 0 });
      await withNulls;
    });

    it("dispatches an unwrapped tool rather than rejecting it, and 400s a malformed body", async () => {
      // Which wrappers exist is the drivers' answer: `bash` is a tool this host does not wrap
      // (`UNKNOWN_PASSTHROUGH_TOOL`, 422, from the driver catalog -- see the dispatcher suite),
      // not a malformed request. `400` here is about the body's shape only.
      const { app, dispatcher } = buildHarness();

      const unwrapped = postExec(app, { args: [], tool: "bash" });
      const call = await waitForDispatch(dispatcher, "device.exec");
      expect(call.input).toEqual({ args: [], leaseId: "lse_1", tool: "bash" });
      call.reject(
        new DispatchError("UNKNOWN_PASSTHROUGH_TOOL", "No driver provides a bash passthrough"),
      );
      const refused = await unwrapped;
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        "UNKNOWN_PASSTHROUGH_TOOL",
      );

      for (const body of [
        { args: [] },
        { args: "list", tool: "simctl" },
        { args: [], tool: "simctl", unexpected: true },
      ]) {
        const response = await postExec(app, body);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          "BAD_REQUEST",
        );
      }
      expect(dispatcher.calls.filter((call) => call.operation === "device.exec")).toHaveLength(1);
    });

    it("opens the stream when the process starts, before it has written anything", async () => {
      // ADR 0005 §19e: a command that prints nothing for nine minutes still gets its `200` and
      // its keepalives, and an `EXEC_TIMEOUT` therefore always arrives as the stream's terminal
      // event rather than as a status the client can no longer be given.
      //
      // C3 (round 3 review): this only proves that half of the route's *own* logic given a
      // dispatcher that calls `onStarted` when told to (`call.session.onStarted?.()` below is
      // this test driving that by hand) -- it says nothing about when a real dispatcher actually
      // calls it, and cannot notice a dispatcher that stops calling it for a genuinely silent,
      // long-running command. That is `FleetLeaseCoordinator`'s own job for a gateway
      // (`src/gateway/fleet-coordinator.ts#exec`); the invariant this comment describes is
      // guarded end to end there, not here -- see `fleet-coordinator.test.ts`'s "relays the
      // worker's own started push for a silent, long-running command".
      const { app, clock, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      call.session.onStarted?.();
      const response = await responsePromise;
      expect(response.status).toBe(200);

      const framesPromise = readSseFrames(response, 1);
      await Promise.resolve();
      // Nothing written yet, and the connection is already alive enough to keep alive.
      clock.advance(15_000);
      call.reject(new DispatchError("EXEC_TIMEOUT", "exceeded exec.timeoutMs (600000ms)"));
      const frames = await framesPromise;
      expect(frames).toEqual([
        { data: { error: { code: "EXEC_TIMEOUT", message: expect.any(String) } }, event: "error" },
      ]);
    });

    it("stalls the command when the client stops reading, instead of buffering for it", async () => {
      // ADR 0005 §19e end to end. The route hands each chunk's SSE write back through
      // `onOutput`, the process runner awaits it, so a client that opened the stream and does
      // not read stops the command at its own pipe -- the alternative being an unbounded
      // in-process queue for exactly the client least able to consume it.
      const { app, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      call.session.onStarted?.();
      const response = await responsePromise;
      const reader = response.body?.getReader();
      await Promise.resolve();

      const settled: number[] = [];
      let pending: number | undefined;
      for (let index = 0; index < 64 && pending === undefined; index += 1) {
        const delivery = Promise.resolve(call.session.onOutput?.("stdout", `chunk-${index}`)).then(
          () => settled.push(index),
        );
        // A delivery that has not settled after the microtask queue drains is the stream
        // refusing more, which is the state this test exists to reach.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!settled.includes(index)) {
          pending = index;
          void delivery;
        }
      }
      expect(pending, "the unread stream never applied backpressure").toBeDefined();

      // Reading again lets the queued writes through, and the stalled delivery completes --
      // the command resumes rather than having been dropped. Each read is bounded: once the
      // queue is empty a further read would block on the very producer this test has stalled.
      for (let attempt = 0; attempt < 8 && !settled.includes(pending as number); attempt += 1) {
        await Promise.race([reader?.read(), new Promise((resolve) => setTimeout(resolve, 20))]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(settled).toContain(pending);

      await reader?.cancel();
      call.resolve({ exitCode: 0 });
      await responsePromise;
    });

    it("survives a client that disconnects while the command keeps writing", async () => {
      // The command runs on deliberately, so chunks keep arriving at a route with nowhere to
      // put them. They go nowhere and the request still settles normally -- what "nowhere"
      // means precisely, and that nothing accumulates, is `output-relay.test.ts`.
      const { app, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      call.session.onStarted?.();
      const response = await responsePromise;
      const reader = response.body?.getReader();
      await Promise.resolve();
      await reader?.cancel();
      await Promise.resolve();

      const chunk = "x".repeat(1_024);
      for (let index = 0; index < 1_000; index += 1) call.session.onOutput?.("stdout", chunk);

      // The relay is dropped, not merely detached: a chunk after the disconnect is discarded
      // outright, which is observable as the delivery no longer being something to wait for.
      // (Without the `relay.drop()` in the route's unsubscribe, this returns the pending write
      // of a stream nobody will ever read.)
      expect(call.session.onOutput?.("stdout", chunk)).toBeUndefined();

      call.resolve({ exitCode: 0 });
      await expect(responsePromise).resolves.toBeDefined();
    });
  });

  it("DELETE /v1/leases/:id releases and answers 202 with the device's post-release state", async () => {
    const { app, dispatcher, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1", state: "leased" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];
    dispatcher.handlers["lease.release"] = (input) => {
      const leaseId = (input as { leaseId: string }).leaseId;
      registry.leases = registry.leases.filter((lease) => lease.id !== leaseId);
      // Not `reclaiming`: that is also the route's default for a device it cannot find, so only
      // another state proves the answer is read from the registry.
      registry.devices = registry.devices.map((device) =>
        device.id === "dev_1" ? { ...device, state: "quarantined" } : device,
      );
      return { leaseId };
    };

    const response = await app.request("/v1/leases/lse_1", {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      device: { id: "dev_1", state: "quarantined" },
      released: true,
    });
  });

  it("an operator may release another requester's lease (lease.list's own admin bypass)", async () => {
    const { app, dispatcher, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];
    dispatcher.handlers["lease.release"] = (input) => ({
      leaseId: (input as { leaseId: string }).leaseId,
    });

    const response = await app.request("/v1/leases/lse_1", {
      headers: operatorAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(202);
  });

  it("404s a release for an unknown lease", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.release"] = () => {
      throw new UnknownLeaseError("lse-missing");
    };

    const response = await app.request("/v1/leases/lse-missing", {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_LEASE",
    );
  });

  it("403s a release of another requester's still-live lease -- dispatched directly through lease.release's own ownsLease hook, not lease.list's 404-for-everything filter (S6)", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.release"] = () => {
      throw new DispatchError("FORBIDDEN", "Not authorized for lease.release");
    };

    const response = await app.request("/v1/leases/lse_other", {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
});

/**
 * ADR 0010 §6's HTTP frontend: one dispatched `component.install` turned into a stream of
 * `progress` events and one terminal `result` or `error`. What the install does is the
 * dispatcher's and the installer's business (`daemon/dispatcher.test.ts`).
 */
describe("POST /v1/components/install", () => {
  /** The response, which must arrive while the dispatched install is still unsettled. */
  async function answeredWhileOpen(response: Response | Promise<Response>): Promise<Response> {
    const answered = await Promise.race([
      Promise.resolve(response),
      new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 200)),
    ]);
    expect(answered, "the route waited for the install to settle").not.toBe("still waiting");
    return answered as Response;
  }

  function postInstall(
    app: App,
    body: Record<string, unknown> = { platform: "android", version: "35" },
    headers: Record<string, string> = operatorAuth,
  ) {
    return app.request("/v1/components/install", {
      body: JSON.stringify(body),
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    });
  }

  it("streams progress events, including one sent before the stream opened, and ends with one result event", async () => {
    const { app, dispatcher } = buildHarness();

    const responsePromise = postInstall(app);
    const call = await waitForDispatch(dispatcher, "component.install");
    expect(call.input).toEqual({ platform: "android", version: "35" });
    expect(call.session).toMatchObject({ principal: "tok_operator", role: "admin" });

    call.session.onStarted?.();
    call.session.onComponentProgress?.({ stage: "waiting" });
    // The response is committed at admission, while the install is still open.
    const response = await answeredWhileOpen(responsePromise);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const framesPromise = readSseFrames(response, 3);
    await Promise.resolve();
    call.session.onComponentProgress?.({ fraction: 0.41, stage: "downloading" });
    const result = { component: "35", outcome: "installed", platform: "android", version: "35" };
    call.resolve(result);
    const frames = await framesPromise;

    expect(frames).toEqual([
      { data: { stage: "waiting" }, event: "progress" },
      { data: { fraction: 0.41, stage: "downloading" }, event: "progress" },
      { data: result, event: "result" },
    ]);
  });

  it.each([
    ["FORBIDDEN", 403],
    ["DOWNLOADS_DISABLED", 403],
    ["NO_DRIVER", 422],
  ] as const)(
    "answers %s, refused before the install admitted the call, as a JSON error with status %i",
    async (code, status) => {
      const { app, dispatcher } = buildHarness();
      dispatcher.handlers["component.install"] = () => {
        throw new DispatchError(code, `refused: ${code}`);
      };

      const response = await postInstall(app);

      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    },
  );

  it("reports a failure after the install admitted the call as a terminal error event", async () => {
    const { app, dispatcher } = buildHarness();

    const responsePromise = postInstall(app);
    const call = await waitForDispatch(dispatcher, "component.install");
    call.session.onStarted?.();
    const response = await answeredWhileOpen(responsePromise);
    expect(response.status).toBe(200);

    const framesPromise = readSseFrames(response, 1);
    await Promise.resolve();
    call.reject(new DispatchError("DOWNLOAD_TIMEOUT", "outlived downloads.timeoutMs"));
    const frames = await framesPromise;

    expect(frames).toEqual([
      {
        data: { error: { code: "DOWNLOAD_TIMEOUT", message: expect.any(String) } },
        event: "error",
      },
    ]);
  });

  it("with workers, dispatches worker.install-component, streams progress with each workerId, and ends with the results", async () => {
    const { app, dispatcher } = buildHarness();

    const responsePromise = postInstall(app, {
      platform: "android",
      version: "35",
      workers: ["wrk_a", "wrk_b"],
    });
    const call = await waitForDispatch(dispatcher, "worker.install-component");
    expect(call.input).toEqual({ platform: "android", version: "35", workers: ["wrk_a", "wrk_b"] });

    call.session.onStarted?.();
    call.session.onComponentProgress?.({ stage: "waiting" }, "wrk_a");
    const response = await answeredWhileOpen(responsePromise);
    expect(response.status).toBe(200);

    const framesPromise = readSseFrames(response, 3);
    await Promise.resolve();
    call.session.onComponentProgress?.({ fraction: 0.5, stage: "downloading" }, "wrk_b");
    const result = {
      results: [
        { outcome: "installed", version: "35", workerId: "wrk_a" },
        {
          error: { code: "DOWNLOADS_DISABLED", message: "never" },
          outcome: "refused",
          workerId: "wrk_b",
        },
      ],
    };
    call.resolve(result);

    expect(await framesPromise).toEqual([
      { data: { stage: "waiting", workerId: "wrk_a" }, event: "progress" },
      { data: { fraction: 0.5, stage: "downloading", workerId: "wrk_b" }, event: "progress" },
      { data: result, event: "result" },
    ]);
  });

  it("with workers, answers the gateway operation's UNKNOWN_WORKER as a JSON 404 rather than a stream", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["worker.install-component"] = () => {
      throw new DispatchError("UNKNOWN_WORKER", "Unknown worker: wrk_nope");
    };

    const response = await postInstall(app, {
      platform: "android",
      version: "35",
      workers: ["wrk_nope"],
    });

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_WORKER",
    );
    expect(response.status).toBe(404);
  });

  it("refuses a body with a field the operation does not take with 400, dispatching nothing", async () => {
    const { app, dispatcher } = buildHarness();

    const response = await postInstall(app, { platform: "ios", version: "26.4", force: true });

    expect(response.status).toBe(400);
    expect(dispatcher.calls).toEqual([]);
  });
});

describe("operator-only listing routes", () => {
  it.each([
    ["an agent", agentAuth, { principal: "tok_agent", role: "agent" }],
    ["an operator", operatorAuth, { principal: "tok_operator", role: "admin" }],
  ] as const)(
    "GET /v1/leases dispatches lease.list under %s's own session and answers the handler's leases",
    async (_caller, headers, session) => {
      // Which leases a caller may see is `lease.list`'s rule, owned and tested by the dispatcher;
      // the route's part is to dispatch under the caller's session and return what it answers.
      const { app, dispatcher } = buildHarness();
      const leases = [makeLease({ id: "lse_1", ownerId: "tok_somebody" })];
      dispatcher.handlers["lease.list"] = () => ({ leases });

      const response = await app.request("/v1/leases", { headers });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ leases });
      expect(dispatcher.calls).toEqual([
        expect.objectContaining({
          input: {},
          operation: "lease.list",
          session: expect.objectContaining(session),
        }),
      ]);
    },
  );

  it("GET /v1/lease-requests answers 403 for an agent token", async () => {
    const { app, dispatcher } = buildHarness();
    const waiting = {
      createdAt: 900,
      id: "req_1",
      queuePosition: 1,
      requesterId: "agent-b",
      spec: { model: "iPhone 16", platform: "ios" },
      stage: "queued",
    };
    // `list.get`'s own role check, through the contract's real pipeline: the route adds none.
    dispatcher.handlers["list.get"] = (input, session) =>
      runDispatch("list.get", input, session, {
        handlers: {
          "list.get": (listInput) => {
            expect(listInput).toEqual({ kind: "requests" });
            return [waiting];
          },
        },
      });

    const asAgent = await app.request("/v1/lease-requests", { headers: agentAuth });
    const asOperator = await app.request("/v1/lease-requests", { headers: operatorAuth });

    expect(asAgent.status).toBe(403);
    expect(((await asAgent.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(asOperator.status).toBe(200);
    expect(await asOperator.json()).toEqual({ requests: [waiting] });
  });

  it("GET /v1/devices dispatches list.get(kind: devices)", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["list.get"] = (input) => {
      expect(input).toEqual({ kind: "devices" });
      return [{ id: "dev_1" }, { id: "dev_2" }];
    };

    const response = await app.request("/v1/devices", { headers: operatorAuth });
    const body = (await response.json()) as { devices: Array<{ id: string }> };
    expect(body.devices.map((device) => device.id).sort()).toEqual(["dev_1", "dev_2"]);
  });

  it("GET /v1/events replays via events.replay, translating ?since to an absolute sinceTs", async () => {
    const { app, clock, dispatcher } = buildHarness();
    dispatcher.handlers["events.replay"] = (input) => {
      const sinceTs = (input as { sinceTs?: number }).sinceTs;
      if (sinceTs === undefined) return [{ event: "daemon.started" }, { event: "daemon.stopping" }];
      expect(sinceTs).toBe(clock.now() - 5_000);
      return [{ event: "daemon.stopping" }];
    };

    const all = await app.request("/v1/events", { headers: operatorAuth });
    expect(((await all.json()) as { events: unknown[] }).events).toHaveLength(2);

    const recent = await app.request("/v1/events?since=5s", { headers: operatorAuth });
    const recentBody = (await recent.json()) as { events: Array<{ event: string }> };
    expect(recentBody.events).toEqual([{ event: "daemon.stopping" }]);
  });

  it("GET /v1/events accepts the d unit in ?since", async () => {
    const { app, clock, dispatcher } = buildHarness();
    let seen: number | undefined;
    dispatcher.handlers["events.replay"] = (input) => {
      seen = (input as { sinceTs?: number }).sinceTs;
      return [];
    };

    const response = await app.request("/v1/events?since=2d", { headers: operatorAuth });

    expect(response.status).toBe(200);
    expect(seen).toBe(clock.now() - 2 * 24 * 60 * 60 * 1000);
  });

  it("400s an invalid ?since duration, before dispatching", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["events.replay"] = () => {
      throw new Error("should not be called");
    };
    const response = await app.request("/v1/events?since=nonsense", { headers: operatorAuth });
    expect(response.status).toBe(400);
  });

  it("GET /v1/events/stream dispatches events.subscribe then follows the raw event bus live", async () => {
    const { app, dispatcher, eventBus } = buildHarness();
    dispatcher.handlers["events.subscribe"] = (_input, session) => ({
      subscribed: true,
      subscriptionId: session.manageEventSubscription(true),
    });
    const streamResponse = await app.request("/v1/events/stream", { headers: operatorAuth });
    // `dispatch("events.subscribe", ...)` is awaited before the SSE stream opens, so it has
    // already run by the time `app.request` resolves.
    expect(dispatcher.calls.some((c) => c.operation === "events.subscribe")).toBe(true);
    const framesPromise = readSseFrames(streamResponse, 1);
    await Promise.resolve();
    eventBus.emit("daemon.stopping", { reason: "live" }, "test");
    const frames = await framesPromise;
    expect(frames[0]?.event).toBe("daemon.stopping");
  });
});

describe("hardening from review", () => {
  it("400s an oversized Idempotency-Key", async () => {
    const { app } = buildHarness();
    const response = await postLeaseRequest(app, defaultBody, {
      ...agentAuth,
      "Idempotency-Key": "x".repeat(201),
    });
    expect(response.status).toBe(400);
  });

  it("clamps an oversized ?wait to the 60s ceiling", async () => {
    const { app, clock, dispatcher } = buildHarness();
    const { id } = await createLeaseRequest(app, dispatcher);

    const waitPromise = app.request(`/v1/lease-requests/${id}?wait=999999`, {
      headers: agentAuth,
    });
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(60_000);
    const response = await waitPromise;
    expect(((await response.json()) as { request: { state: string } }).request.state).toBe(
      "queued",
    );
  });

  it("reports the lease's own stored ttlMs, with nothing gateway-side to remember", async () => {
    // ADR 0004: the width lives on the lease record, so a payload served by a gateway that
    // never saw the request (after a daemon restart, say) still reports the real width
    // instead of a mode default standing in for one.
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [
      makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent", ttlMs: 123_000 }),
    ];

    const response = await app.request("/v1/leases/lse_1", { headers: agentAuth });
    const body = (await response.json()) as { lease: { ttlMs: number } };
    expect(body.lease.ttlMs).toBe(123_000);
  });
});

/**
 * ADR 0005 §23. The routes themselves are thin -- one dispatch each -- so what is worth
 * asserting is which daemon has them at all, that they reach the right operation with the id
 * from the path, and that a refusal's typed `details` reach the body. What a worker's own
 * dispatcher answers for all four operations is proven in `src/daemon/dispatcher.test.ts`;
 * `e2e/single-host-fleet.test.ts` drives `GET /v1/workers` and the drain route end to end.
 */
describe("worker routes", () => {
  function gatewayHarness() {
    return buildHarness({ config: testConfig({}, "gateway") });
  }

  it("are routes on a worker too (ADR 0012 §3), each dispatching its operation", async () => {
    const { app, config, dispatcher } = buildHarness();
    expect(config.mode).toBe("worker");
    dispatcher.handlers["worker.list"] = () => ({ workers: [] });
    for (const operation of ["worker.drain", "worker.undrain", "worker.remove"] as const) {
      dispatcher.handlers[operation] = () => {
        throw new DispatchError("UNSUPPORTED_IN_WORKER_MODE", `${operation} is refused`, {
          operation,
        });
      };
    }

    const list = await app.request("/v1/workers", { headers: operatorAuth });
    const drain = await app.request("/v1/workers/w/drain", {
      headers: operatorAuth,
      method: "POST",
    });
    const undrain = await app.request("/v1/workers/w/drain", {
      headers: operatorAuth,
      method: "DELETE",
    });
    const remove = await app.request("/v1/workers/w", { headers: operatorAuth, method: "DELETE" });

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ workers: [] });
    // Each refusal names the operation its handler was reached through, so the body proves
    // which route dispatched what.
    const refusals = [drain, undrain, remove];
    expect(refusals.map((response) => response.status)).toEqual([501, 501, 501]);
    expect(await Promise.all(refusals.map((response) => response.json()))).toEqual(
      ["worker.drain", "worker.undrain", "worker.remove"].map((operation) => ({
        error: { code: "UNSUPPORTED_IN_WORKER_MODE", message: expect.any(String), operation },
      })),
    );
  });

  it("GET /v1/workers returns the views", async () => {
    const { app, dispatcher } = gatewayHarness();
    dispatcher.handlers["worker.list"] = () => ({
      workers: [
        {
          catalog: [],
          connection: "connected",
          devices: [],
          drained: false,
          id: "wrk_1",
          lastSeenAt: 1,
          leases: [],
        },
      ],
    });

    const response = await app.request("/v1/workers", { headers: operatorAuth });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workers: [{ id: "wrk_1" }] });
  });

  it("maps drain, undrain and remove onto their operations, with the id from the path", async () => {
    const { app, dispatcher } = gatewayHarness();
    dispatcher.handlers["worker.drain"] = (input: never) => ({
      drained: true,
      workerId: (input as { workerId: string }).workerId,
    });
    dispatcher.handlers["worker.undrain"] = (input: never) => ({
      drained: false,
      workerId: (input as { workerId: string }).workerId,
    });
    dispatcher.handlers["worker.remove"] = (input: never) => ({
      removed: true,
      workerId: (input as { workerId: string }).workerId,
    });

    const drained = await app.request("/v1/workers/wrk_1/drain", {
      headers: operatorAuth,
      method: "POST",
    });
    expect(await drained.json()).toEqual({ drained: true, workerId: "wrk_1" });
    const undrained = await app.request("/v1/workers/wrk_1/drain", {
      headers: operatorAuth,
      method: "DELETE",
    });
    expect(await undrained.json()).toEqual({ drained: false, workerId: "wrk_1" });
    const removed = await app.request("/v1/workers/wrk_2", {
      headers: operatorAuth,
      method: "DELETE",
    });
    expect(await removed.json()).toEqual({ removed: true, workerId: "wrk_2" });

    expect(dispatcher.calls.map((call) => call.operation)).toEqual([
      "worker.drain",
      "worker.undrain",
      "worker.remove",
    ]);
  });

  it("leaves the role check to the shared dispatcher, which 403s an agent token", async () => {
    const { app, dispatcher } = gatewayHarness();
    dispatcher.handlers["worker.list"] = () => {
      throw new DispatchError("FORBIDDEN", "Operation worker.list requires role admin");
    };

    const response = await app.request("/v1/workers", { headers: agentAuth });

    expect(response.status).toBe(403);
  });

  it("puts a refusal's typed details in the body, so a client need not parse prose", async () => {
    const { app, dispatcher } = gatewayHarness();
    dispatcher.handlers["worker.remove"] = () => {
      throw new DispatchError("WORKER_CONNECTED", "Worker wrk_1 is still connected", {
        workerId: "wrk_1",
      });
    };

    const response = await app.request("/v1/workers/wrk_1", {
      headers: operatorAuth,
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "WORKER_CONNECTED", message: expect.any(String), workerId: "wrk_1" },
    });
  });

  it("answers 501 for an operation a gateway does not implement", async () => {
    const { app, dispatcher } = gatewayHarness();
    dispatcher.handlers["lease.request"] = () => {
      throw new DispatchError(
        "UNSUPPORTED_IN_GATEWAY_MODE",
        "lease.request is not available on a gateway yet",
        { operation: "lease.request" },
      );
    };

    const response = await postLeaseRequest(app, defaultBody);

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: { code: "UNSUPPORTED_IN_GATEWAY_MODE", operation: "lease.request" },
    });
  });
});
