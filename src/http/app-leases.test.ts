import { describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import { SerializedDecision } from "../core/index.js";
import { loadTestRegistry, openTestState } from "../core/testing.js";
import {
  NoCapacityError,
  RequesterAlreadyLeasedError,
  LeaseRequestBook,
  RequestCancelledError,
} from "../leasing/index.js";
import { DispatchError } from "../daemon/dispatcher.js";
import { describeLeaseRequestFailure } from "../daemon/error-code.js";
import { FakeClock } from "../ports/index.js";
import {
  agentAuth,
  buildHarness,
  createLeaseRequest,
  defaultBody,
  operatorAuth,
  otherAgentAuth,
  postLeaseRequest,
  readSseFrames,
  settle,
} from "./test-app.js";
import { FakeDispatcher, makeGrant, sequenceIdGenerator, waitForDispatch } from "./test-fakes.js";

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

  it.each([
    ["a device as the model", defaultBody, { model: "iPhone 17 Pro", platform: "ios" }, "class"],
    [
      "a class",
      { class: "tablet", platform: "ios" },
      { class: "tablet", platform: "ios" },
      "model",
    ],
    ["only a platform", { platform: "android" }, { platform: "android" }, "model"],
  ])(
    "dispatches a body naming %s with only the keys it names",
    async (_label, body, expected, absentKey) => {
      const { app, dispatcher } = buildHarness();
      const responsePromise = postLeaseRequest(app, body);
      const call = await waitForDispatch(dispatcher, "lease.request");
      call.session.onProgress?.({ queuePosition: 1, stage: "queued" });
      await responsePromise;

      expect(call.input).toMatchObject(expected);
      expect(call.input).not.toHaveProperty(absentKey);
    },
  );

  it.each<[string, Record<string, unknown>, string?]>([
    ["full", { full: true }],
    ["a mode other than slim or full", { mode: "fast" }],
    ["a key the route does not know", { colour: "blue" }],
    [
      "a fleetRequestId, a contract field the route does not take",
      { fleetRequestId: "req_1", noWait: true },
    ],
    ["an image tag with a space", { imageTag: "google apis" }],
    ["an image tag over 64 characters", { imageTag: "a".repeat(65) }],
    ["a baseline name with a capital letter", { baseline: "Checkout" }],
    ["a device over 256 characters", { device: "d".repeat(257) }, "device"],
  ])(
    "400s a body carrying %s as BAD_REQUEST before ever dispatching",
    async (_label, extra, named) => {
      const { app, dispatcher } = buildHarness();
      // why: raced against a dispatch, so a body that is wrongly accepted fails here on the assertion
      // below rather than by waiting for a 201 that only comes once the request is queued.
      const response = await Promise.race([
        postLeaseRequest(app, { ...defaultBody, ...extra }),
        waitForDispatch(dispatcher, "lease.request").then(() => "dispatched" as const),
      ]);
      if (response === "dispatched") throw new Error("the body was dispatched instead of refused");
      expect(response.status).toBe(400);
      const { error } = (await response.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe("BAD_REQUEST");
      if (named !== undefined) expect(error.message).toContain(named);
      expect(dispatcher.calls).toHaveLength(0);
    },
  );

  it.each<[string, Record<string, unknown>, Record<string, unknown>?]>([
    ["imageTag", { imageTag: "google_apis_playstore" }],
    ["mode", { mode: "slim" }],
    ["except", { except: ["store", "other"] }],
    ["baseline", { baseline: "checkout" }],
    ["owner field rather than silently dropping it (ADR §27a, H7)", { owner: "someone-else" }],
    ["physical true", { physical: true }],
    [
      "a device of exactly 256 characters, as the model",
      { device: "d".repeat(256) },
      { model: "d".repeat(256) },
    ],
  ])("forwards a body's %s to the dispatched lease.request", async (_label, extra, forwarded) => {
    const { app, dispatcher } = buildHarness();
    const first = await Promise.race([
      postLeaseRequest(app, { ...defaultBody, ...extra }),
      waitForDispatch(dispatcher, "lease.request").then((call) => call),
    ]);
    if (first instanceof Response) throw new Error(`the body was refused with ${first.status}`);
    expect(first.input).toMatchObject(forwarded ?? extra);
  });

  it("answers 400 BAD_REQUEST naming allowDownload for a body with physical true and allowDownload true", async () => {
    const { app, dispatcher } = buildHarness();
    const accepted = await Promise.race([
      postLeaseRequest(app, { ...defaultBody, physical: true }),
      waitForDispatch(dispatcher, "lease.request").then(() => "dispatched" as const),
    ]);
    expect(accepted).toBe("dispatched");

    const response = await Promise.race([
      postLeaseRequest(app, { ...defaultBody, allowDownload: true, physical: true }),
      waitForDispatch(dispatcher, "lease.request", 1).then(() => "dispatched" as const),
    ]);
    if (response === "dispatched") throw new Error("the body was dispatched instead of refused");

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("allowDownload");
  });

  it("builds an operator token's session as admin but never as the gateway's uplink, so §27a's owner gate still refuses it at the shared dispatcher (ADR §27a, H3)", async () => {
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

  it("answers a noWait request refused at the running limit with 503 and the capacity reason in the error body", async () => {
    const { app, dispatcher } = buildHarness();
    const responsePromise = postLeaseRequest(app, { ...defaultBody, noWait: true });
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.reject(
      new DispatchError("NO_CAPACITY", "No device capacity is currently available", {
        capacityReason: "platform-running-limit",
      }),
    );
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(await response.json()).toEqual({
      error: {
        capacityReason: "platform-running-limit",
        code: "NO_CAPACITY",
        message: "No device capacity is currently available",
      },
    });
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
    // why: `allowDownload: true` answers `201` once the request is stored, not before: a refusal the
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

  it("answers a lease request whose ttlMs is at the safe-integer edge: above it 400 BAD_REQUEST, at it the dispatcher's maxTtl message", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.request"] = (input) => {
      throw new DispatchError(
        "BAD_REQUEST",
        `ttlMs ${String((input as { ttlMs?: number }).ttlMs)} exceeds lease.maxTtlMs (120000)`,
      );
    };

    const beyond = await postLeaseRequest(app, { ...defaultBody, ttlMs: 1e16 });
    expect(beyond.status).toBe(400);
    const beyondBody = (await beyond.json()) as { error: { code: string; message: string } };
    expect(beyondBody.error.code).toBe("BAD_REQUEST");
    expect(beyondBody.error.message).not.toContain("exceeds lease.maxTtlMs");

    const edge = await postLeaseRequest(app, { ...defaultBody, ttlMs: 9_007_199_254_740_991 });
    expect(edge.status).toBe(400);
    const edgeBody = (await edge.json()) as { error: { code: string; message: string } };
    expect(edgeBody.error.code).toBe("BAD_REQUEST");
    expect(edgeBody.error.message).toContain("exceeds lease.maxTtlMs");
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

    expect((await responsePromise).status).toBe(201);
  });

  it("an HTTP body's metadata reaches the daemon's lease.request", async () => {
    const cases = [
      {
        body: { metadata: { project: "checkout-app", role: "ci" } },
        expected: { project: "checkout-app", role: "ci" },
      },
      { body: {}, expected: undefined },
    ] as const;
    for (const { body, expected } of cases) {
      const { app, dispatcher } = buildHarness();
      void postLeaseRequest(app, { ...defaultBody, ...body });
      const call = await waitForDispatch(dispatcher, "lease.request");
      expect((call.input as { metadata?: unknown }).metadata, JSON.stringify(body)).toEqual(
        expected,
      );
    }
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

describe("POST /v1/lease-requests leaseId", () => {
  it("passes a caller-chosen leaseId onto the dispatch input as sent, and no leaseId key when the body names none", async () => {
    const { app, dispatcher } = buildHarness();
    const withId = postLeaseRequest(app, { ...defaultBody, leaseId: "ad-7f3a" });
    const call = await waitForDispatch(dispatcher, "lease.request");
    expect(call.input).toMatchObject({ leaseId: "ad-7f3a" });
    call.resolve(makeGrant({ lease: { id: "ad-7f3a" } }));
    await withId;

    const withoutId = postLeaseRequest(app, defaultBody, otherAgentAuth);
    const second = await waitForDispatch(dispatcher, "lease.request", 1);
    expect(second.input).not.toHaveProperty("leaseId");
    second.resolve(makeGrant({ lease: { id: "lse_2" } }));
    await withoutId;
  });

  it("answers 400 BAD_REQUEST for a leaseId outside the pattern, without dispatching", async () => {
    const { app, dispatcher } = buildHarness();
    // why: A handler takes the call without the fake's own input parse, so only the route's schema
    // can keep a bad ID from reaching the dispatcher.
    dispatcher.handlers["lease.request"] = () => makeGrant({ lease: { id: "w1.myid" } });

    const response = await postLeaseRequest(app, { ...defaultBody, leaseId: "w1.myid" });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    expect(dispatcher.calls).toEqual([]);
  });

  it("answers 409 LEASE_ID_TAKEN with the ID in the body when the dispatcher refuses it", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.request"] = () => {
      throw new DispatchError("LEASE_ID_TAKEN", "lease ID ad-7f3a is already in use", {
        leaseId: "ad-7f3a",
      });
    };

    const response = await postLeaseRequest(app, { ...defaultBody, leaseId: "ad-7f3a" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "LEASE_ID_TAKEN",
        leaseId: "ad-7f3a",
        message: "lease ID ad-7f3a is already in use",
      },
    });
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
    await settle();
    dispatcher.calls[callIndex]?.session.onProgress?.({ etaMs: 10_000, stage: "provisioning" });
    const response = await waitPromise;
    const body = (await response.json()) as { request: { state: string } };
    expect(body.request.state).toBe("provisioning");
  });

  it("long-polls: ?wait returns the unchanged state once the timer elapses", async () => {
    const { app, clock, dispatcher } = buildHarness();
    const { id } = await createLeaseRequest(app, dispatcher);

    const waitPromise = Promise.resolve(
      app.request(`/v1/lease-requests/${id}?wait=5`, { headers: agentAuth }),
    );
    let answered = false;
    void waitPromise.then(() => {
      answered = true;
    });
    await settle();
    expect(answered).toBe(false);
    clock.advance(4_999);
    for (let turn = 0; turn < 50; turn += 1) await settle();
    expect(answered).toBe(false);
    clock.advance(1);
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
    const state = await openTestState();
    const load = () =>
      loadTestRegistry({
        clock,
        eventBus: new EventBus(clock),
        idGenerator: sequenceIdGenerator("stored"),
        state,
      });
    const before = await load();
    const device = await before.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "fake-1",
      provisionDuration: 0,
      spec: { model: "iPhone 17 Pro", osVersion: "26.5", physical: false, platform: "ios" },
    });
    const stored = await before.createLeaseRequest({
      ownerId: "tok_agent",
      request: { model: "iPhone 17 Pro", platform: "ios" },
      requesterId: "tok_agent",
    });
    await before.settleLeaseRequest(stored.id, {
      grant: makeGrant({ device: { id: device.id }, lease: { id: "lse_before_restart" } }),
      state: "granted",
    });

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
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: sequenceIdGenerator("stored"),
    });
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
  async function requestOwnedByOther(dispatcher: FakeDispatcher): Promise<string> {
    let id: string | undefined;
    void dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", platform: "ios", requesterId: "tok_agent" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
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
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_LEASE_REQUEST",
    );
  });

  it("204s when the request was still queued and cancellable, and a GET right after reads cancelled", async () => {
    const { app, dispatcher } = buildHarness();
    const { id, callIndex } = await createLeaseRequest(app, dispatcher);

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
    expect(dispatcher.calls.map((call) => call.operation)).not.toContain("lease.cancel");
  });
});
