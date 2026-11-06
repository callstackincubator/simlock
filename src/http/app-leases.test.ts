import { createHash, randomFillSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { UnknownLeaseError, SerializedDecision } from "../core/index.js";
import { loadTestRegistry, openTestState } from "../core/testing.js";
import {
  NoCapacityError,
  RequesterAlreadyLeasedError,
  LeaseRequestBook,
  RequestCancelledError,
} from "../leasing/index.js";
import { DispatchError } from "../daemon/dispatcher.js";
import { describeLeaseRequestFailure } from "../daemon/error-code.js";
import { createLeaseFiles, type LeaseFilesLimits } from "../lease-files/index.js";
import { FakeClock, NodeFilesystem } from "../ports/index.js";
import {
  agentAuth,
  type App,
  buildHarness,
  createLeaseRequest,
  defaultBody,
  operatorAuth,
  otherAgentAuth,
  postLeaseRequest,
  readSseFrames,
  settle,
} from "./test-app.js";
import {
  FakeDispatcher,
  makeDevice,
  makeGrant,
  makeLease,
  sequenceIdGenerator,
  waitForDispatch,
} from "./test-fakes.js";

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
    dispatcher.handlers["lease.get"] = () => ({
      lease: {
        ...makeLease({ deviceId: "dev_1", id: "wrk_b.lse_1", ownerId: "tok_agent" }),
        worker: { id: "wrk_b", label: "mac-b" },
        workerId: "wrk_b",
      },
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

  it("GET /v1/leases/:id keeps a simulator's mode on the lease object", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1", mode: "slim" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];

    const response = await app.request("/v1/leases/lse_1", { headers: agentAuth });

    expect(((await response.json()) as { lease: unknown }).lease).toMatchObject({ mode: "slim" });
  });

  it("GET /v1/leases/:id answers a lease on a physical device with no mode, on a worker", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [
      {
        createdAt: 0,
        driverData: undefined,
        driverDeviceId: "00008110-001A2B3C4D5E",
        enrolledApps: [],
        id: "dev_phys",
        physical: true,
        spec: {
          class: "phone",
          model: "iPhone 15 Pro",
          osVersion: "18.4",
          physical: true,
          platform: "ios",
        },
        state: "leased",
      },
    ];
    registry.leases = [makeLease({ deviceId: "dev_phys", id: "lse_p", ownerId: "tok_agent" })];

    const response = await app.request("/v1/leases/lse_p", { headers: agentAuth });

    expect(response.status).toBe(200);
    const { lease } = (await response.json()) as { lease: Record<string, unknown> };
    expect(lease).toMatchObject({
      device: "iPhone 15 Pro",
      deviceId: "dev_phys",
      os: "18.4",
      udid: "00008110-001A2B3C4D5E",
    });
    expect(lease).not.toHaveProperty("mode");
  });

  it("GET /v1/leases/:id answers a lease on a physical device with no mode, on a gateway", async () => {
    const { app, dispatcher } = buildHarness({
      registry: {
        snapshot: {
          devices: [
            {
              driverDeviceId: "00008110-001A2B3C4D5E",
              id: "dev_phys",
              spec: { model: "iPhone 15 Pro", osVersion: "18.4", platform: "ios" },
              workerId: "wrk_a",
            },
          ],
        },
      },
    });
    dispatcher.handlers["lease.get"] = () => ({
      lease: {
        ...makeLease({ deviceId: "dev_phys", id: "wrk_a.lse_p", ownerId: "tok_agent" }),
        worker: { id: "wrk_a" },
        workerId: "wrk_a",
      },
    });

    const response = await app.request("/v1/leases/wrk_a.lse_p", { headers: agentAuth });

    expect(response.status).toBe(200);
    const { lease } = (await response.json()) as { lease: Record<string, unknown> };
    expect(lease).toMatchObject({ deviceId: "dev_phys", udid: "00008110-001A2B3C4D5E" });
    expect(lease).not.toHaveProperty("mode");
  });

  it("names an Android emulator's adb serial as address, beside its AVD name as udid, on the lease object the POST, the request poll and GET /v1/leases/:id answer", async () => {
    const emulator = {
      address: "emulator-5554",
      driverDeviceId: "simlock_3f9a2c1e",
      id: "dev_and",
      spec: { model: "Pixel 8", osVersion: "35", physical: false, platform: "android" },
    } as const;
    const { app, dispatcher, registry } = buildHarness();
    const posted = postLeaseRequest(app, { device: "Pixel 8", platform: "android" });
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.resolve(makeGrant({ device: emulator, lease: { deviceId: "dev_and", id: "lse_and" } }));
    const created = (await (await posted).json()) as { request: { id: string; lease: unknown } };
    registry.devices = [makeDevice(emulator)];
    registry.leases = [makeLease({ deviceId: "dev_and", id: "lse_and", ownerId: "tok_agent" })];

    const polled = await app.request(`/v1/lease-requests/${created.request.id}`, {
      headers: agentAuth,
    });
    const read = await app.request("/v1/leases/lse_and", { headers: agentAuth });

    const named = { address: "emulator-5554", udid: "simlock_3f9a2c1e" };
    expect({
      get: ((await read.json()) as { lease: unknown }).lease,
      poll: ((await polled.json()) as { request: { lease: unknown } }).request.lease,
      post: created.request.lease,
    }).toMatchObject({ get: named, poll: named, post: named });
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
      { attempts: 1, deviceId: "dev_1", duration: 500, leaseId: "lse_1", platform: "ios" },
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

  it.each([
    ["renew", "/v1/leases/lse_1/renew", '{"ttlMs":60000}', "lease.renew"],
    ["exec", "/v1/leases/lse_1/exec", '{"args":["list"],"tool":"simctl"}', "device.exec"],
    [
      "install",
      "/v1/components/install",
      '{"platform":"android","version":"35"}',
      "component.install",
    ],
  ])(
    "a caller sends the %s body without a JSON content type and gets 415 UNSUPPORTED_MEDIA_TYPE; with application/json it reaches the dispatcher",
    async (_route, path, body, operation) => {
      const { app, dispatcher } = buildHarness();
      dispatcher.handlers["lease.renew"] = () => ({
        deviceId: "dev_1",
        grantedAt: 1_000,
        id: "lse_1",
        ownerId: "tok_agent",
        requesterId: "tok_agent",
        ttlDeadline: 2_000,
      });
      dispatcher.handlers["device.exec"] = () => ({ exitCode: 0 });
      dispatcher.handlers["component.install"] = () => ({
        component: "35",
        outcome: "installed",
        platform: "android",
        version: "35",
      });
      const send = (contentType: string | undefined) =>
        app.request(path, {
          body,
          headers: {
            ...agentAuth,
            ...(contentType === undefined ? {} : { "content-type": contentType }),
          },
          method: "POST",
        });

      for (const contentType of [undefined, "text/plain"]) {
        const refused = await send(contentType);
        expect(refused.status).toBe(415);
        expect(await refused.json()).toEqual({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "Content-Type must be application/json",
          },
        });
      }
      expect(dispatcher.calls.filter((call) => call.operation === operation)).toEqual([]);

      const accepted = await send("application/json");
      expect(accepted.status).toBe(200);
      expect(dispatcher.calls.filter((call) => call.operation === operation)).toHaveLength(1);
    },
  );

  it("a caller sends a bad wait or renew body and gets 400 with today's message; a renew with no body, an empty body under any content type or an extra key renews", async () => {
    const { app, dispatcher } = buildHarness();
    const { id } = await createLeaseRequest(app, dispatcher);
    const renewals: unknown[] = [];
    dispatcher.handlers["lease.renew"] = (input) => {
      renewals.push(input);
      return {
        deviceId: "dev_1",
        grantedAt: 1_000,
        id: "lse_1",
        ownerId: "tok_agent",
        requesterId: "tok_agent",
        ttlDeadline: 2_000,
      };
    };
    const renew = (
      body: string | undefined,
      contentType: string | undefined = "application/json",
    ) =>
      app.request("/v1/leases/lse_1/renew", {
        ...(body === undefined ? {} : { body }),
        headers: {
          ...agentAuth,
          ...(contentType === undefined ? {} : { "content-type": contentType }),
        },
        method: "POST",
      });
    const refusedWait = "wait must be a non-negative number of seconds";

    const refusals: [string, Response | Promise<Response>, string][] = [
      [
        "wait=-1",
        app.request(`/v1/lease-requests/${id}?wait=-1`, { headers: agentAuth }),
        refusedWait,
      ],
      [
        "wait=abc",
        app.request(`/v1/lease-requests/${id}?wait=abc`, { headers: agentAuth }),
        refusedWait,
      ],
      [
        "wait=-1 on an unknown request",
        app.request("/v1/lease-requests/unknown?wait=-1", { headers: agentAuth }),
        refusedWait,
      ],
      ["ttlMs a string", renew('{"ttlMs":"60s"}'), "ttlMs must be a number"],
      ["ttlMs negative", renew('{"ttlMs":-1}'), "ttlMs must be a positive number"],
      ["ttlMs zero", renew('{"ttlMs":0}'), "ttlMs must be a positive number"],
      ["a number", renew("5"), "Body must be a JSON object"],
      ["an array", renew("[]"), "Body must be a JSON object"],
      ["malformed JSON", renew("{"), "Invalid JSON body"],
    ];
    for (const [name, pending, message] of refusals) {
      const response = await pending;
      expect(response.status, name).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "BAD_REQUEST", message } });
    }
    expect(renewals).toEqual([]);

    for (const response of [
      await renew(undefined, undefined),
      await renew("", "application/json"),
      await renew("", "text/plain"),
      await renew("", "application/x-www-form-urlencoded"),
      await renew('{"ttlMs":60000,"note":"x"}'),
    ]) {
      expect(response.status).toBe(200);
    }
    expect(renewals).toEqual([
      { leaseId: "lse_1" },
      { leaseId: "lse_1" },
      { leaseId: "lse_1" },
      { leaseId: "lse_1" },
      { leaseId: "lse_1", ttlMs: 60_000 },
    ]);
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
      expect(call.input).toEqual({ args: ["list"], leaseId: "lse_1", tool: "simctl" });

      // why: The stream opens when the process starts, not when it first speaks (ADR 0005 §19e).
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
      // why: An SSE response cannot take back its status code, so ownership and the refusal list
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
      // why: Requester identity is never client-declared over HTTP: the token is the identity,
      // except for an operator token proxying for someone (ADR 0005 §19b/§27). Round 4, F4: this route used to decide on its own
      // that an agent token may not supply `requesterId` at all, which left that rule living
      // only in the HTTP transport (ADR 0003 §2 puts a contract operation's answer in the
      // dispatcher). The rule moved into `device.exec`'s own `authorize` hook -- exercised
      // directly in `dispatcher-exec.test.ts` -- so this route now forwards `requesterId` exactly
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

      // why: Forwarded exactly the same way for an agent token -- the route makes no distinction
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

      // why: A `null` for either optional is the documented example's own spelling, and normalizes
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
      // why: Which wrappers exist is the drivers' answer: `bash` is a tool this host does not wrap
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
        { args: [], requesterId: "a\u001b[2Jb", tool: "simctl" },
        { args: [], requesterId: "x".repeat(257), tool: "simctl" },
        { args: [], stdin: "A".repeat(8_388_609), tool: "simctl" },
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
      // why: ADR 0005 §19e: a command that prints nothing for nine minutes still gets its `200` and
      // its keepalives, and an `EXEC_TIMEOUT` therefore always arrives as the stream's terminal
      // event rather than as a status the client can no longer be given.
      //
      // C3 (round 3 review): this only proves that half of the route's *own* logic given a
      // dispatcher that calls `onStarted` when told to (`call.session.onStarted?.()` below is
      // this test driving that by hand) -- it says nothing about when a real dispatcher actually
      // calls it, and cannot notice a dispatcher that stops calling it for a genuinely silent,
      // long-running command. That is the gateway's own job (`FleetForwarding.exec` in
      // `src/gateway/fleet-forwarding.ts`); the invariant this comment describes is guarded end
      // to end there, not here -- see `fleet-coordinator.test.ts`'s "relays the worker's own
      // started push for a silent command that never answers (ADR §19a/§19b/§19e)".
      const { app, clock, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      call.session.onStarted?.();
      const response = await responsePromise;
      expect(response.status).toBe(200);

      const framesPromise = readSseFrames(response, 1);
      await Promise.resolve();
      clock.advance(15_000);
      call.reject(new DispatchError("EXEC_TIMEOUT", "exceeded exec.timeoutMs (600000ms)"));
      const frames = await framesPromise;
      expect(frames).toEqual([
        { data: { error: { code: "EXEC_TIMEOUT", message: expect.any(String) } }, event: "error" },
      ]);
    });

    it("stalls the command when the client stops reading, instead of buffering for it", async () => {
      // why: ADR 0005 §19e end to end. The route hands each chunk's SSE write back through
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
        // why: A delivery that has not settled after the microtask queue drains is the stream
        // refusing more, which is the state this test exists to reach.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!settled.includes(index)) {
          pending = index;
          void delivery;
        }
      }
      expect(pending, "the unread stream never applied backpressure").toBeDefined();

      // why: Reading again lets the queued writes through, and the stalled delivery completes --
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
      // why: The command runs on deliberately, so chunks keep arriving at a route with nowhere to
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

      expect(call.session.onOutput).toBeDefined();
      const chunk = "x".repeat(1_024);
      for (let index = 0; index < 1_000; index += 1) call.session.onOutput?.("stdout", chunk);

      // why: The relay is dropped, not merely detached: a chunk after the disconnect is discarded
      // outright, which is observable as the delivery no longer being something to wait for.
      // (Without the `relay.drop()` in the route's unsubscribe, this returns the pending write
      // of a stream nobody will ever read.)
      const onOutput = call.session.onOutput;
      if (onOutput === undefined) throw new Error("the exec dispatch has no onOutput");
      expect(onOutput("stdout", chunk)).toBeUndefined();

      call.resolve({ exitCode: 0 });
      await settle();
      await expect(reader?.read()).resolves.toMatchObject({ done: true });
    });
  });

  it("DELETE /v1/leases/:id releases and answers 202 with the device's post-release state", async () => {
    const { app, dispatcher, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1", state: "leased" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];
    dispatcher.handlers["lease.release"] = (input) => {
      const leaseId = (input as { leaseId: string }).leaseId;
      registry.leases = registry.leases.filter((lease) => lease.id !== leaseId);
      // why: Not `reclaiming`: that is also the route's default for a device it cannot find, so only
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

const filesRoots: string[] = [];

afterEach(async () => {
  await Promise.all(filesRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

// why: a worker's HTTP app over a real lease-files store in a temporary folder, with lease `lse_1` held by `tok_agent`.
async function filesRig(
  options: {
    readonly limits?: LeaseFilesLimits;
    readonly filesystem?: NodeFilesystem;
    readonly diskPressureThreshold?: number;
  } = {},
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "simlock-lease-files-"));
  filesRoots.push(dataDirectory);
  const rig = buildHarness({
    leaseFiles: ({ clock, logger }) =>
      createLeaseFiles({
        clock,
        dataDirectory,
        diskPressureThreshold: options.diskPressureThreshold ?? 0,
        filesystem: options.filesystem ?? new NodeFilesystem(),
        findGrant: (leaseId) =>
          leaseId === "lse_1" ? { grantedAt: 1_000, id: leaseId, platform: "ios" } : undefined,
        idGenerator: sequenceIdGenerator("up"),
        logger,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      }),
  });
  rig.registry.leases = [makeLease({ id: "lse_1", ownerId: "tok_agent" })];
  const put = (name: string, body: BodyInit, headers: Record<string, string> = agentAuth) =>
    rig.app.request(`/v1/leases/lse_1/files/${name}`, { body, headers, method: "PUT" });
  const get = (name: string, headers: Record<string, string> = agentAuth) =>
    rig.app.request(`/v1/leases/lse_1/files/${name}`, { headers });
  const remove = (name: string, headers: Record<string, string> = agentAuth) =>
    rig.app.request(`/v1/leases/lse_1/files/${name}`, { headers, method: "DELETE" });
  const list = (headers: Record<string, string> = agentAuth) =>
    rig.app.request("/v1/leases/lse_1/files", { headers });
  const leaseFolder = join(
    dataDirectory,
    "lease-files",
    `${Buffer.from("lse_1").toString("hex")}-1000`,
  );
  return { ...rig, dataDirectory, get, leaseFolder, list, put, remove };
}

// why: what a lease folder holds, temporary upload files included, so "nothing stored" means nothing on disk.
async function folderEntries(folder: string): Promise<string[]> {
  return readdir(folder).catch(() => []);
}

// why: a request body the test feeds by hand: `push` resolves once the upload has taken the bytes and asks for more, so a test acts only after the store has seen them.
function liveBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let waiting: (() => void)[] = [];
  let pulled!: () => void;
  const firstPull = new Promise<void>((resolve) => {
    pulled = resolve;
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        pulled();
        for (const resume of waiting.splice(0)) resume();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    fail: (error: Error) => controller.error(error),
    finish: () => controller.close(),
    firstPull,
    push: (bytes: Uint8Array) =>
      new Promise<void>((resolve) => {
        controller.enqueue(bytes);
        waiting = [...waiting, resolve];
      }),
    stream,
  };
}

// why: a request the code under test must answer; when it never does, the assertion on `undefined` fails by name where an await would time the whole test out.
function answered(response: Promise<Response> | Response): Promise<Response | undefined> {
  return Promise.race([
    Promise.resolve(response),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
  ]);
}

class LowDiskFilesystem extends NodeFilesystem {
  override diskFree(): Promise<number> {
    return Promise.resolve(5 * 1024 ** 3);
  }
}

// why: comparing megabytes with `toEqual` walks them one by one and takes seconds; their digests say the same.
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("a lease's files on a worker", () => {
  it("a lease holder PUTs a file and gets 201 with its name and size; a GET returns the same bytes", async () => {
    const { get, put } = await filesRig();
    const patterned = (length: number): Uint8Array<ArrayBuffer> => {
      const bytes = new Uint8Array(length);
      randomFillSync(bytes.subarray(0, Math.min(length, 1 << 20)));
      for (let at = 1 << 20; at < length; at += 1 << 20) bytes.copyWithin(at, 0, 1 << 20);
      return bytes;
    };
    const cases: [string, Uint8Array<ArrayBuffer>][] = [
      ["fixture.tar", patterned(3 * 1024 * 1024)],
      ["fixture.tar", patterned(1000)],
      ["empty.bin", new Uint8Array(0)],
      ["big.bin", patterned(70_000_000)],
    ];

    for (const [name, bytes] of cases) {
      const response = await put(name, bytes);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ name, size: bytes.length });
      const download = await get(name);
      expect(download.status).toBe(200);
      expect(sha256(new Uint8Array(await download.arrayBuffer()))).toBe(sha256(bytes));
    }
  });

  it("a lease holder PUTs a bad file name and gets 400 BAD_REQUEST with the name rule", async () => {
    const { get, put, app } = await filesRig();
    const accepted = [
      "fixture.tar",
      "app-release.apk",
      "Documents.tar.deflate",
      "A",
      "a".repeat(128),
    ];
    const refused = [
      ["a".repeat(129), "a".repeat(129)],
      [".hidden", ".hidden"],
      ["-rf", "-rf"],
      ["my%20file.tar", "my file.tar"],
      ["a%2Fb.tar", "a/b.tar"],
      ["za%C5%BC%C3%B3%C5%82%C4%87.txt", "zażółć.txt"],
    ] as const;

    for (const name of accepted) expect((await put(name, "x")).status).toBe(201);
    for (const [encoded, decoded] of refused) {
      for (const response of [await put(encoded, "x"), await get(encoded)]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: {
            code: "BAD_REQUEST",
            message: `File ${decoded} must be 1 to 128 letters, digits, '.', '_' or '-', starting with a letter or digit`,
          },
        });
      }
    }
    expect((await app.request("/v1/leases/lse_1/files/..", { headers: agentAuth })).status).toBe(
      404,
    );
  });

  it("a lease holder PUTs past a limit and gets the limit's code, with nothing stored and the previous file kept", async () => {
    const limits = { fileBytes: 10, leaseBytes: 100, silenceMs: 330_000 };
    const big = new Uint8Array(11);
    const rig = await filesRig({ limits });
    const refusal = async (response: Response) =>
      (await response.json()) as { error: { code: string; message: string } };
    const text = async (response: Response) =>
      new TextDecoder().decode(await response.arrayBuffer());

    expect((await rig.put("kept.bin", "12345")).status).toBe(201);
    const tooBig = await rig.put("kept.bin", big);
    expect(tooBig.status).toBe(413);
    expect((await refusal(tooBig)).error).toEqual({
      code: "FILE_TOO_LARGE",
      message: "File kept.bin is over the 2 GiB limit for one file",
      name: "kept.bin",
    });
    expect(await text(await rig.get("kept.bin"))).toBe("12345");
    expect(await folderEntries(rig.leaseFolder)).toEqual(["kept.bin"]);

    let pulled = false;
    const unread = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled = true;
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const declared = await rig.app.request("/v1/leases/lse_1/files/declared.bin", {
      body: unread,
      duplex: "half",
      headers: { ...agentAuth, "content-length": "11" },
      method: "PUT",
    } as RequestInit);
    expect(declared.status).toBe(413);
    expect((await refusal(declared)).error.code).toBe("FILE_TOO_LARGE");
    expect(pulled).toBe(false);
    expect(await folderEntries(rig.leaseFolder)).toEqual(["kept.bin"]);

    const roomy = { fileBytes: 1000, leaseBytes: 100, silenceMs: 330_000 };
    const full = await filesRig({ limits: roomy });
    await mkdir(full.leaseFolder, { recursive: true });
    await writeFile(join(full.leaseFolder, "my file.png"), new Uint8Array(60));
    expect((await full.put("fits.bin", new Uint8Array(40))).status).toBe(201);
    await rm(join(full.leaseFolder, "fits.bin"));
    for (const headers of [agentAuth, { ...agentAuth, "content-length": "50" }]) {
      const over = await full.put("over.bin", new Uint8Array(50), headers);
      expect(over.status).toBe(413);
      expect((await refusal(over)).error).toEqual({
        code: "LEASE_FILES_FULL",
        leaseId: "lse_1",
        message: "Lease lse_1 holds 60 bytes of files; this upload would pass the 4 GiB limit",
        usedBytes: 60,
      });
      expect(await folderEntries(full.leaseFolder)).toEqual(["my file.png"]);
    }

    const together = await filesRig({ limits: roomy });
    const first = liveBody();
    const running = together.app.request("/v1/leases/lse_1/files/a.bin", {
      body: first.stream,
      duplex: "half",
      headers: agentAuth,
      method: "PUT",
    } as RequestInit);
    await first.push(new Uint8Array(60));
    const second = await together.put("b.bin", new Uint8Array(60));
    expect(second.status).toBe(413);
    expect((await refusal(second)).error.code).toBe("LEASE_FILES_FULL");
    first.finish();
    expect((await running).status).toBe(201);
    expect(await folderEntries(together.leaseFolder)).toEqual(["a.bin"]);

    const replacing = await filesRig({ limits: roomy });
    expect((await replacing.put("x.bin", new Uint8Array(80))).status).toBe(201);
    expect((await replacing.put("x.bin", new Uint8Array(80))).status).toBe(201);

    const lowDisk = await filesRig({
      diskPressureThreshold: 10 * 1024 ** 3,
      filesystem: new LowDiskFilesystem(),
    });
    const noDisk = await lowDisk.put("fixture.tar", "x");
    expect(noDisk.status).toBe(422);
    expect((await refusal(noDisk)).error).toEqual({
      availableBytes: 5 * 1024 ** 3,
      code: "INSUFFICIENT_DISK_SPACE",
      message:
        "Not enough free disk space to store fixture.tar: the worker keeps 10.0 GiB free, only 5.0 GiB available",
      platform: "ios",
      requiredBytes: 10 * 1024 ** 3,
    });
    expect(await folderEntries(lowDisk.leaseFolder)).toEqual([]);
  });

  it("a lease holder whose PUT is cut or goes silent keeps the previous file or none; a second PUT to a name being uploaded gets 409 FILE_BUSY", async () => {
    const rig = await filesRig();
    const uploading = (name: string, body: ReadableStream<Uint8Array>) =>
      rig.app.request(`/v1/leases/lse_1/files/${name}`, {
        body,
        duplex: "half",
        headers: agentAuth,
        method: "PUT",
      } as RequestInit);
    const text = async (response: Response) =>
      new TextDecoder().decode(await response.arrayBuffer());
    const bytes = new TextEncoder().encode("new");

    const cutFresh = liveBody();
    const cutting = uploading("fresh.bin", cutFresh.stream);
    await cutFresh.push(bytes);
    cutFresh.fail(new Error("socket hang up"));
    expect(await answered(cutting)).toBeDefined();
    expect(await folderEntries(rig.leaseFolder)).toEqual([]);

    expect((await rig.put("kept.bin", "old")).status).toBe(201);
    const cutKept = liveBody();
    const cuttingKept = uploading("kept.bin", cutKept.stream);
    await cutKept.push(bytes);
    cutKept.fail(new Error("socket hang up"));
    expect(await answered(cuttingKept)).toBeDefined();
    expect(await folderEntries(rig.leaseFolder)).toEqual(["kept.bin"]);
    expect(await text(await rig.get("kept.bin"))).toBe("old");

    const silent = liveBody();
    const silentRequest = uploading("kept.bin", silent.stream);
    await silent.push(bytes);
    rig.clock.advance(330_000);
    const stalled = await answered(silentRequest);
    expect(stalled?.status).toBe(408);
    expect(await stalled?.json()).toEqual({
      error: {
        code: "UPLOAD_STALLED",
        message: "No bytes of kept.bin arrived for 330 s",
        name: "kept.bin",
      },
    });
    expect(await folderEntries(rig.leaseFolder)).toEqual(["kept.bin"]);
    expect(await text(await rig.get("kept.bin"))).toBe("old");

    const mute = liveBody();
    const muteRequest = uploading("mute.bin", mute.stream);
    await mute.firstPull;
    rig.clock.advance(330_000);
    expect((await answered(muteRequest))?.status).toBe(408);

    const moving = liveBody();
    const movingRequest = uploading("moving.bin", moving.stream);
    for (const chunk of ["a", "b", "c"]) {
      await moving.push(new TextEncoder().encode(chunk));
      rig.clock.advance(200_000);
    }
    moving.finish();
    expect((await movingRequest).status).toBe(201);
    expect(await text(await rig.get("moving.bin"))).toBe("abc");

    for (const [firstName, secondName] of [
      ["x.bin", "x.bin"],
      ["A.tar", "a.tar"],
    ] as const) {
      const running = liveBody();
      const runningRequest = uploading(firstName, running.stream);
      await running.push(bytes);
      const refused = await rig.put(secondName, "other");
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: {
          code: "FILE_BUSY",
          message: `File ${secondName} is being uploaded by another request`,
          name: secondName,
        },
      });
      running.finish();
      expect((await runningRequest).status).toBe(201);
    }
  });

  it("a lease holder lists the lease's files and deletes one", async () => {
    const { leaseFolder, list, put, remove } = await filesRig();
    const files = async () => ((await (await list()).json()) as { files: unknown[] }).files;

    expect((await list()).status).toBe(200);
    expect(await files()).toEqual([]);

    expect((await put("b.txt", "bb")).status).toBe(201);
    expect((await put("a.txt", "a")).status).toBe(201);
    await mkdir(join(leaseFolder, "sub"));
    await writeFile(join(leaseFolder, "sub", "inner.txt"), "x");
    await writeFile(join(leaseFolder, "my file.png"), "x");
    expect(await files()).toEqual([
      { name: "a.txt", size: 1 },
      { name: "b.txt", size: 2 },
    ]);

    const removed = await remove("a.txt");
    expect(removed.status).toBe(204);
    expect(await files()).toEqual([{ name: "b.txt", size: 2 }]);

    const unknown = await remove("a.txt");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { code: "UNKNOWN_FILE", message: "No file a.txt in this lease", name: "a.txt" },
    });
  });

  it("a lease holder's file names match ignoring case", async () => {
    const { get, leaseFolder, list, put, remove } = await filesRig();
    const text = async (response: Response) =>
      new TextDecoder().decode(await response.arrayBuffer());
    const names = async () =>
      ((await (await list()).json()) as { files: { name: string }[] }).files.map(
        (file) => file.name,
      );

    expect((await put("A.tar", "upper")).status).toBe(201);
    expect(await text(await get("a.tar"))).toBe("upper");

    expect((await put("a.tar", "lower")).status).toBe(201);
    expect(await folderEntries(leaseFolder)).toEqual(["a.tar"]);
    expect(await names()).toEqual(["a.tar"]);
    expect(await text(await get("A.TAR"))).toBe("lower");

    expect((await remove("A.TAR")).status).toBe(204);
    expect(await names()).toEqual([]);

    await writeFile(join(leaseFolder, "A.tar"), "first");
    await writeFile(join(leaseFolder, "a.tar"), "second");
    if ((await folderEntries(leaseFolder)).length === 2) {
      expect(await text(await get("a.tar"))).toBe("second");
      expect(await text(await get("A.TAR"))).toBe("first");
      expect(await names()).toEqual(["A.tar", "a.tar"]);
    }
  });

  it("a lease holder GETs a file and gets it whole or the range it asked for", async () => {
    const { get, put } = await filesRig();
    const thousand = Uint8Array.from({ length: 1000 }, (_, index) => index % 251);
    expect((await put("thousand.bin", thousand)).status).toBe(201);
    expect((await put("empty.bin", "")).status).toBe(201);
    const ranged = (name: string, range: string) => get(name, { ...agentAuth, range });
    const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

    const whole = await get("thousand.bin");
    expect(whole.status).toBe(200);
    expect(Object.fromEntries(whole.headers)).toMatchObject({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": "1000",
      "content-type": "application/octet-stream",
      "simlock-content-length": "1000",
    });
    expect(await bytesOf(whole)).toEqual(thousand);

    const partial = [
      ["bytes=0-99", 0, 99],
      ["bytes=900-", 900, 999],
      ["bytes=-100", 900, 999],
      ["bytes=990-5000", 990, 999],
      ["bytes=-5000", 0, 999],
    ] as const;
    for (const [range, start, end] of partial) {
      const response = await ranged("thousand.bin", range);
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/1000`);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      expect(response.headers.get("simlock-content-length")).toBe(String(end - start + 1));
      expect(await bytesOf(response)).toEqual(thousand.subarray(start, end + 1));
    }

    for (const [name, range] of [
      ["thousand.bin", "bytes=1000-"],
      ["thousand.bin", "bytes=-0"],
      ["empty.bin", "bytes=-5"],
    ] as const) {
      const response = await ranged(name, range);
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(
        `bytes */${name === "empty.bin" ? 0 : 1000}`,
      );
    }

    for (const range of ["bytes=0-1,5-9", "bytes=9-5", "items=0-9", "bytes=abc", "bytes=-"]) {
      const response = await ranged("thousand.bin", range);
      expect(response.status).toBe(200);
      expect(await bytesOf(response)).toEqual(thousand);
    }

    const unknown = await get("missing.bin");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: {
        code: "UNKNOWN_FILE",
        message: "No file missing.bin in this lease",
        name: "missing.bin",
      },
    });
  });

  it("a caller that does not hold the lease gets 404 UNKNOWN_LEASE on every file route, and an operator is served", async () => {
    const { app, put, list, get } = await filesRig();
    expect((await put("mine.bin", "mine")).status).toBe(201);
    const routes = (leaseId: string, headers: Record<string, string>) => [
      () =>
        app.request(`/v1/leases/${leaseId}/files/mine.bin`, { body: "x", headers, method: "PUT" }),
      () => app.request(`/v1/leases/${leaseId}/files/mine.bin`, { headers }),
      () => app.request(`/v1/leases/${leaseId}/files`, { headers }),
      () => app.request(`/v1/leases/${leaseId}/files/mine.bin`, { headers, method: "DELETE" }),
    ];

    for (const [leaseId, headers] of [
      ["lse_1", otherAgentAuth],
      ["lse_unknown", agentAuth],
    ] as const) {
      for (const response of await Promise.all(routes(leaseId, headers).map((call) => call()))) {
        expect(response.status).toBe(404);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          "UNKNOWN_LEASE",
        );
      }
    }
    expect(await (await list()).json()).toEqual({ files: [{ name: "mine.bin", size: 4 }] });
    expect(new TextDecoder().decode(await (await get("mine.bin")).arrayBuffer())).toBe("mine");

    const statuses: number[] = [];
    for (const call of routes("lse_1", operatorAuth)) statuses.push((await call()).status);
    expect(statuses).toEqual([201, 200, 200, 204]);
  });
});
