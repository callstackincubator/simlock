import { describe, expect, it } from "vitest";
import { runDispatch } from "../daemon/dispatch.js";
import { DispatchError } from "../daemon/dispatcher.js";
import {
  agentAuth,
  type App,
  buildHarness,
  createLeaseRequest,
  defaultBody,
  operatorAuth,
  postLeaseRequest,
  settle,
} from "./test-app.js";
import { makeDevice, makeLease, waitForDispatch } from "./test-fakes.js";

describe("hardening from review", () => {
  it("400s an oversized Idempotency-Key as BAD_REQUEST, where a 200-character key is accepted", async () => {
    const { app, dispatcher } = buildHarness();
    const accepted = await Promise.race([
      postLeaseRequest(app, defaultBody, { ...agentAuth, "Idempotency-Key": "x".repeat(200) }),
      waitForDispatch(dispatcher, "lease.request").then(() => "dispatched" as const),
    ]);
    if (accepted instanceof Response) expect(accepted.status).toBe(201);
    else expect(accepted).toBe("dispatched");

    const response = await postLeaseRequest(app, defaultBody, {
      ...agentAuth,
      "Idempotency-Key": "x".repeat(201),
    });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toContain("idempotencyKey");
  });

  it("clamps an oversized ?wait to the 60s ceiling", async () => {
    const { app, clock, dispatcher } = buildHarness();
    const { id } = await createLeaseRequest(app, dispatcher);

    const waitPromise = Promise.resolve(
      app.request(`/v1/lease-requests/${id}?wait=999999`, { headers: agentAuth }),
    );
    let answered = false;
    void waitPromise.then(() => {
      answered = true;
    });
    await settle();
    clock.advance(59_999);
    for (let turn = 0; turn < 50; turn += 1) await settle();
    expect(answered).toBe(false);
    clock.advance(1);
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
describe("POST /v1/update", () => {
  const answer = (overrides: Record<string, unknown> = {}) => ({
    started: false,
    upToDate: false,
    resolved: null,
    version: "0.3.0",
    health: "running",
    update: null,
    lastUpdateFailure: null,
    latestVersion: null,
    ...overrides,
  });
  const post = (app: App, body?: unknown, headers: Record<string, string> = operatorAuth) =>
    Promise.resolve(
      app.request("/v1/update", {
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  it("answers 202 when the call began the update and 200 when it followed one or nothing was needed, dispatches daemon.update with the body, refuses an agent and a bad body", async () => {
    const { app, dispatcher } = buildHarness();
    // why: `daemon.update`'s own role check runs through the contract's real pipeline; the route adds none.
    let reply: Record<string, unknown> = answer({ started: true, resolved: "0.4.0" });
    dispatcher.handlers["daemon.update"] = (input, session) =>
      runDispatch("daemon.update", input, session, {
        handlers: { "daemon.update": () => reply },
      });

    const started = await post(app, { version: "0.4.0", force: true });
    expect({ status: started.status, body: await started.json() }).toEqual({
      status: 202,
      body: reply,
    });
    expect(dispatcher.calls.map(({ operation, input }) => ({ operation, input }))).toEqual([
      { operation: "daemon.update", input: { version: "0.4.0", force: true } },
    ]);

    for (const [name, following] of [
      [
        "follows a running update",
        answer({
          update: { stage: "installing", from: "0.3.0", to: "0.4.0", forced: false, startedAt: 1 },
        }),
      ],
      ["nothing to do", answer({ upToDate: true, resolved: "0.3.0" })],
    ] as const) {
      reply = following;
      const response = await post(app);
      expect({ name, status: response.status }).toEqual({ name, status: 200 });
      expect(await response.json()).toEqual(following);
    }
    expect(dispatcher.calls.at(-1)?.input).toEqual({});

    const emptyJson = await app.request("/v1/update", {
      headers: { ...operatorAuth, "content-type": "application/json" },
      method: "POST",
      body: "",
    });
    expect(emptyJson.status).toBe(200);
    expect(dispatcher.calls.at(-1)?.input).toEqual({});

    const asAgent = await post(app, {}, agentAuth);
    expect(asAgent.status).toBe(403);
    expect(((await asAgent.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");

    const callsBefore = dispatcher.calls.length;
    for (const body of [{ version: "latest" }, { query: true }, { force: "yes" }]) {
      const refused = await post(app, body);
      expect({ body, status: refused.status }).toEqual({ body, status: 400 });
    }
    expect(dispatcher.calls).toHaveLength(callsBefore);
  });
});

describe("POST /v1/workers/{id}/update", () => {
  const answer = (overrides: Record<string, unknown> = {}) => ({
    started: false,
    upToDate: false,
    resolved: null,
    version: "0.3.0",
    health: "running",
    update: null,
    lastUpdateFailure: null,
    latestVersion: null,
    workerId: "wrk_1",
    ...overrides,
  });

  it("answers 202 when the call began the update and 200 when it followed one, dispatches worker.update with the id from the path and the body, refuses an agent and a bad body", async () => {
    const { app, dispatcher } = buildHarness();
    let reply: Record<string, unknown> = answer({ started: true, resolved: "0.4.0" });
    dispatcher.handlers["worker.update"] = (input, session) =>
      runDispatch("worker.update", input, session, {
        handlers: { "worker.update": () => reply },
      });
    const post = (body?: unknown, headers: Record<string, string> = operatorAuth) =>
      Promise.resolve(
        app.request("/v1/workers/wrk_1/update", {
          headers: {
            ...headers,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          method: "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );

    const started = await post({ version: "0.4.0", force: true });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual(reply);
    expect(dispatcher.calls.map(({ operation, input }) => ({ operation, input }))).toEqual([
      { operation: "worker.update", input: { force: true, version: "0.4.0", workerId: "wrk_1" } },
    ]);

    reply = answer({ upToDate: true, resolved: "0.3.0" });
    const following = await post();
    expect(following.status).toBe(200);
    expect(dispatcher.calls.at(-1)?.input).toEqual({ workerId: "wrk_1" });

    const asAgent = await post({}, agentAuth);
    expect(asAgent.status).toBe(403);

    const callsBefore = dispatcher.calls.length;
    for (const body of [{ version: "latest" }, { query: true }, { force: "yes" }]) {
      const refused = await post(body);
      expect({ body, status: refused.status }).toEqual({ body, status: 400 });
    }
    expect(dispatcher.calls).toHaveLength(callsBefore);

    for (const [code, status] of [
      ["WORKER_NOT_CONNECTED", 409],
      ["UPDATE_UNSUPPORTED_INSTALL", 409],
      ["UPDATE_SHARED_INSTALL", 409],
      ["UPDATE_RESOLVE_FAILED", 502],
      ["UNKNOWN_WORKER", 404],
    ] as const) {
      dispatcher.handlers["worker.update"] = () => {
        throw new DispatchError(code, "refused");
      };
      const refusal = await post();
      expect({ code, status: refusal.status }).toEqual({ code, status });
      expect(((await refusal.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });
});
