import { describe, expect, it } from "vitest";

import { identityGet, runDispatch } from "../daemon/dispatch.js";
import { DispatchError } from "../daemon/dispatcher.js";
import { testConfig } from "../core/testing.js";
import { streamModule } from "../stream/index.js";
// why: the stream index exports only the definition, so a registry reads no module code; the real mount is reached through `testing.ts` to prove the listed route against the real handler.
import { createStreamMount } from "../stream/testing.js";
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
import { makeDevice, makeLease, waitForDispatch } from "./test-fakes.js";

describe("GET /v1/healthz", () => {
  it("answers without authentication", async () => {
    const { app } = buildHarness();
    const response = await app.request("/v1/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("GET /v1/identity", () => {
  it("answers the token's id as principal, its label as name, its role and via token; an unlabelled operator token's name is its id; no token is a 401 Missing bearer token", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["identity.get"] = identityGet;

    const labelled = await app.request("/v1/identity", {
      headers: { authorization: "Bearer slk_labelled" },
    });
    expect(labelled.status).toBe(200);
    expect(await labelled.json()).toEqual({
      name: "ci-runner",
      principal: "tok_9f2c",
      role: "agent",
      via: "token",
    });

    const operator = await app.request("/v1/identity", { headers: operatorAuth });
    expect(operator.status).toBe(200);
    expect(await operator.json()).toEqual({
      name: "tok_operator",
      principal: "tok_operator",
      role: "admin",
      via: "token",
    });

    const anonymous = await app.request("/v1/identity");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: { message: "Missing bearer token" } });
  });
});

describe("authentication and role/ownership (via the shared dispatcher)", () => {
  it("403s an agent reaching another requester's lease request (HTTP-only tracker resource guard)", async () => {
    const { app, dispatcher } = buildHarness();
    const { id } = await createLeaseRequest(app, dispatcher);

    const response = await app.request(`/v1/lease-requests/${id}`, { headers: otherAgentAuth });
    expect(response.status).toBe(403);
  });

  it.each([
    ["GET /v1/leases/{id}", "/v1/leases/lse_1"],
    ["GET /v1/leases/{id}/events", "/v1/leases/lse_1/events"],
  ])(
    "%s finds the lease with lease.get under the caller's session, and a lease.get that answers UNKNOWN_LEASE is a 404",
    async (_route, path) => {
      const { app, dispatcher, registry } = buildHarness();
      registry.devices = [makeDevice({ id: "dev_1" })];
      registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];

      const found = await app.request(path, { headers: agentAuth });
      expect(found.status).toBe(200);
      expect(dispatcher.calls).toEqual([
        expect.objectContaining({
          input: { leaseId: "lse_1" },
          operation: "lease.get",
          session: expect.objectContaining({ principal: "tok_agent", role: "agent" }),
        }),
      ]);

      registry.leases = [];
      const missing = await app.request(path, { headers: agentAuth });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
        "UNKNOWN_LEASE",
      );
    },
  );

  it("404s (not 403) an agent fetching another requester's lease -- ownership is lease.get's own answer, not a separate check", async () => {
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
});

describe("a query to a System route", () => {
  it.each([
    ["/v1/catalog?platform=windows", 400, "platform must be ios or android", undefined],
    ["/v1/components?platform=windows", 400, "platform must be ios or android", undefined],
    ["/v1/catalog?platform=ios&platform=android", 200, undefined, { platform: "ios" }],
    ["/v1/stats?ledger=2", 400, "ledger must be 1", undefined],
    [
      "/v1/stats?since=1h&from=2026-10-15T00:00Z",
      400,
      "stats takes since or from, not both",
      undefined,
    ],
  ])("%s gets today's answer", async (url, status, message, dispatched) => {
    const { app, dispatcher } = buildHarness();
    const seen: unknown[] = [];
    dispatcher.handlers["catalog.get"] = (input) => {
      seen.push(input);
      return { platforms: [] };
    };
    dispatcher.handlers["usage.get"] = (input) => {
      seen.push(input);
      return {};
    };
    dispatcher.handlers["component.list"] = (input) => {
      seen.push(input);
      return { components: [] };
    };

    const response = await app.request(url, { headers: operatorAuth });

    expect(response.status).toBe(status);
    if (message === undefined) {
      expect(seen).toEqual([dispatched]);
    } else {
      expect(await response.json()).toEqual({ error: { code: "BAD_REQUEST", message } });
      expect(seen).toEqual([]);
    }
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
});

describe("POST /v1/devices and DELETE /v1/devices/{id}", () => {
  const enrolled = {
    appCount: 2,
    class: "phone",
    driverDeviceId: "00008110-001A2B3C4D5E",
    id: "dev_1",
    model: "iPhone 15 Pro",
    osVersion: "18.4",
    platform: "ios",
    reenrolled: false,
  };

  it("dispatches device.add with the body's platform and id, and answers its result as JSON", async () => {
    const { app, dispatcher } = buildHarness();
    const seen: unknown[] = [];
    dispatcher.handlers["device.add"] = (input) => {
      seen.push(input);
      return enrolled;
    };

    const response = await app.request("/v1/devices", {
      body: JSON.stringify({ id: "00008110-001A2B3C4D5E", platform: "ios" }),
      headers: { ...operatorAuth, "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toEqual(enrolled);
    expect(seen).toEqual([{ id: "00008110-001A2B3C4D5E", platform: "ios" }]);
  });

  it.each([
    ["a field it does not declare", { id: "A", platform: "ios", worker: "w1" }],
    ["no platform", { id: "A" }],
    ["an id that is not a string", { id: 7, platform: "ios" }],
  ])("400s a body with %s, before the device is read", async (_case, body) => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["device.add"] = () => {
      throw new Error("should not be called");
    };

    const response = await app.request("/v1/devices", {
      body: JSON.stringify(body),
      headers: { ...operatorAuth, "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it.each([
    [
      "no content type, with a body",
      undefined,
      '{"id":"A","platform":"ios"}',
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json",
    ],
    [
      "text/plain",
      "text/plain",
      '{"id":"A","platform":"ios"}',
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json",
    ],
    [
      "application/json; charset=utf-8",
      "application/json; charset=utf-8",
      '{"id":"A","platform":"ios"}',
      200,
      undefined,
      undefined,
    ],
    [
      "application/json with malformed JSON",
      "application/json",
      '{"id":',
      400,
      "BAD_REQUEST",
      "Invalid JSON body",
    ],
  ])(
    "POST /v1/devices with %s answers 415 without a JSON content type, 400 for malformed JSON, else the dispatcher",
    async (_case, contentType, body, status, code, message) => {
      const { app, dispatcher } = buildHarness();
      const seen: unknown[] = [];
      dispatcher.handlers["device.add"] = (input) => {
        seen.push(input);
        return enrolled;
      };

      const response = await app.request("/v1/devices", {
        body: new TextEncoder().encode(body),
        headers: {
          ...operatorAuth,
          ...(contentType === undefined ? {} : { "content-type": contentType }),
        },
        method: "POST",
      });

      expect(response.status).toBe(status);
      if (code === undefined) {
        expect(seen).toEqual([{ id: "A", platform: "ios" }]);
      } else {
        expect(await response.json()).toEqual({ error: { code, message } });
        expect(seen).toEqual([]);
      }
    },
  );

  it("dispatches device.remove with the path's id, and answers its result as JSON", async () => {
    const { app, dispatcher } = buildHarness();
    const seen: unknown[] = [];
    dispatcher.handlers["device.remove"] = (input) => {
      seen.push(input);
      return { driverDeviceId: "00008110-001A2B3C4D5E", id: "00008110-001A2B3C4D5E" };
    };

    const response = await app.request("/v1/devices/00008110-001A2B3C4D5E", {
      headers: operatorAuth,
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      driverDeviceId: "00008110-001A2B3C4D5E",
      id: "00008110-001A2B3C4D5E",
    });
    expect(seen).toEqual([{ id: "00008110-001A2B3C4D5E" }]);
  });
});

describe("/v1/baselines", () => {
  const entry = {
    mode: "full",
    model: "Pixel 9",
    name: "checkout",
    osVersion: "36",
    platform: "android",
    savedAt: "2026-11-02T13:40:00.000Z",
    version: 1,
  };

  it("POST dispatches baseline.save with the body, GET baseline.list and DELETE baseline.remove with the path's name and the workerId query, each as the caller's role, and answers the result as JSON", async () => {
    const { app, dispatcher } = buildHarness();
    const seen: { input: unknown; operation: string; role: string }[] = [];
    const answers = {
      "baseline.list": { baselines: [entry] },
      "baseline.remove": { deletedDevices: [], name: "checkout", versions: [1] },
      "baseline.save": { baseline: entry, leaseId: "L1" },
    } as const;
    for (const operation of Object.keys(answers) as (keyof typeof answers)[]) {
      dispatcher.handlers[operation] = (input, session) => {
        seen.push({ input, operation, role: session.role });
        return answers[operation];
      };
    }

    const saved = await app.request("/v1/baselines", {
      body: JSON.stringify({ leaseId: "L1", name: "checkout", note: "app 4.2" }),
      headers: { ...operatorAuth, "content-type": "application/json" },
      method: "POST",
    });
    const listed = await app.request("/v1/baselines", { headers: agentAuth });
    const removed = await app.request("/v1/baselines/checkout", {
      headers: operatorAuth,
      method: "DELETE",
    });
    const onWorker = await app.request("/v1/baselines/checkout?workerId=wrk_a", {
      headers: operatorAuth,
      method: "DELETE",
    });
    const longWorker = await app.request(`/v1/baselines/checkout?workerId=${"w".repeat(129)}`, {
      headers: operatorAuth,
      method: "DELETE",
    });
    const emptyWorker = await app.request("/v1/baselines/checkout?workerId=", {
      headers: operatorAuth,
      method: "DELETE",
    });
    const agentSave = await app.request("/v1/baselines", {
      body: JSON.stringify({ leaseId: "L2", name: "mine" }),
      headers: { ...agentAuth, "content-type": "application/json" },
      method: "POST",
    });
    const stray = await app.request("/v1/baselines", {
      body: JSON.stringify({ leaseId: "L1", name: "checkout", workerId: "w1" }),
      headers: { ...operatorAuth, "content-type": "application/json" },
      method: "POST",
    });

    expect([
      saved.status,
      listed.status,
      removed.status,
      onWorker.status,
      agentSave.status,
    ]).toEqual([200, 200, 200, 200, 200]);
    expect([longWorker.status, emptyWorker.status]).toEqual([400, 400]);
    expect(await saved.json()).toEqual(answers["baseline.save"]);
    expect(await listed.json()).toEqual(answers["baseline.list"]);
    expect(await removed.json()).toEqual(answers["baseline.remove"]);
    expect(stray.status).toBe(400);
    expect(seen).toEqual([
      {
        input: { leaseId: "L1", name: "checkout", note: "app 4.2" },
        operation: "baseline.save",
        role: "admin",
      },
      { input: {}, operation: "baseline.list", role: "agent" },
      { input: { name: "checkout" }, operation: "baseline.remove", role: "admin" },
      {
        input: { name: "checkout", workerId: "wrk_a" },
        operation: "baseline.remove",
        role: "admin",
      },
      { input: { leaseId: "L2", name: "mine" }, operation: "baseline.save", role: "agent" },
    ]);
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

/**
 * why: ADR 0010 §6's HTTP frontend: one dispatched `component.install` turned into a stream of
 * `progress` events and one terminal `result` or `error`. What the install does is the
 * dispatcher's and the installer's business (`daemon/dispatcher-components.test.ts`).
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
      return [makeDevice({ id: "dev_1" }), makeDevice({ id: "dev_2" })];
    };

    const response = await app.request("/v1/devices", { headers: operatorAuth });
    const body = (await response.json()) as { devices: Array<{ id: string }> };
    expect(body.devices.map((device) => device.id).sort()).toEqual(["dev_1", "dev_2"]);
  });

  it("GET /v1/events replays via events.replay, translating ?since in seconds or days to an absolute sinceTs", async () => {
    const { app, clock, dispatcher } = buildHarness();
    const seen: Array<number | undefined> = [];
    dispatcher.handlers["events.replay"] = (input) => {
      const sinceTs = (input as { sinceTs?: number }).sinceTs;
      seen.push(sinceTs);
      if (sinceTs === undefined) return [{ event: "daemon.started" }, { event: "daemon.stopping" }];
      return [{ event: "daemon.stopping" }];
    };

    const all = await app.request("/v1/events", { headers: operatorAuth });
    expect(((await all.json()) as { events: unknown[] }).events).toHaveLength(2);

    for (const [since, windowMs] of [
      ["5s", 5_000],
      ["2d", 2 * 24 * 60 * 60 * 1000],
    ] as const) {
      const recent = await app.request(`/v1/events?since=${since}`, { headers: operatorAuth });
      const recentBody = (await recent.json()) as { events: Array<{ event: string }> };
      expect(recentBody.events).toEqual([{ event: "daemon.stopping" }]);
      expect(seen.at(-1)).toBe(clock.now() - windowMs);
    }
  });

  it("GET /v1/events with before and limit dispatches events.replay with beforeId and limit, and answers HISTORY_NOT_KEPT with 422 and oldestTs in the body and HISTORY_UNAVAILABLE with 503", async () => {
    const { app, dispatcher } = buildHarness();
    const asked: unknown[] = [];
    dispatcher.handlers["events.replay"] = (input) => {
      asked.push(input);
      throw new DispatchError("HISTORY_NOT_KEPT", "The history does not hold that event.", {
        oldestTs: 1_234,
      });
    };
    const notKept = await app.request("/v1/events?before=evt_abc&limit=50&worker=w1", {
      headers: operatorAuth,
    });
    dispatcher.handlers["events.replay"] = () => {
      throw new DispatchError("HISTORY_UNAVAILABLE", "The history could not be read.");
    };
    const unavailable = await app.request("/v1/events?before=evt_abc", { headers: operatorAuth });

    expect(asked).toEqual([{ beforeId: "evt_abc", limit: 50, workerId: "w1" }]);
    expect(notKept.status).toBe(422);
    expect(await notKept.json()).toMatchObject({
      error: { code: "HISTORY_NOT_KEPT", oldestTs: 1_234 },
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: "HISTORY_UNAVAILABLE" } });
  });

  it.each([
    ["before=evt_abc&limit=0", "limit must be a whole number from 1 to 500"],
    ["before=evt_abc&limit=501", "limit must be a whole number from 1 to 500"],
    ["before=evt_abc&limit=x", "limit must be a whole number from 1 to 500"],
    ["before=not-an-id", "before must be an event id"],
    ["since=abc", "Invalid duration: abc"],
    ["before=evt_abc&since=1h", "before and since cannot be used together"],
    ["limit=50&since=1h", "limit and since cannot be used together"],
    ["worker=", "worker must be a worker id of 1 to 128 characters"],
    [`worker=${"w".repeat(129)}`, "worker must be a worker id of 1 to 128 characters"],
  ])("GET /v1/events?%s answers 400 BAD_REQUEST before dispatching", async (query, message) => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["events.replay"] = () => {
      throw new Error("should not be called");
    };

    const response = await app.request(`/v1/events?${query}`, { headers: operatorAuth });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST", message } });
  });

  describe("GET /v1/stats", () => {
    const NOW = Date.parse("2026-10-16T12:00:00Z");
    const HOUR = 3_600_000;

    function statsHarness() {
      const harness = buildHarness();
      harness.clock.advance(NOW - harness.clock.now());
      const asked: { from: number; to: number; includeLedger?: boolean }[] = [];
      harness.dispatcher.handlers["usage.get"] = (input) => {
        asked.push(input as never);
        return { window: input };
      };
      const get = (query: string) =>
        harness.app.request(`/v1/stats${query}`, { headers: operatorAuth });
      return { ...harness, asked, get };
    }

    it("dispatches usage.get for since back from now, from to to, from to now, and the last 24 hours with no parameter", async () => {
      const { asked, get } = statsHarness();

      const answered = await get("?since=1h");
      await get("?from=2026-10-15T00:00Z&to=2026-10-16T00:00Z");
      await get("?from=2026-10-15T00:00Z");
      await get("");

      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ window: { from: NOW - HOUR, to: NOW } });
      expect(asked.map(({ from, to }) => ({ from, to }))).toEqual([
        { from: NOW - HOUR, to: NOW },
        { from: Date.parse("2026-10-15T00:00Z"), to: Date.parse("2026-10-16T00:00Z") },
        { from: Date.parse("2026-10-15T00:00Z"), to: NOW },
        { from: NOW - 24 * HOUR, to: NOW },
      ]);
    });

    it("answers 400 with the Inputs table's message for since with from, to without from, from not before to, a bad duration, the times 1, 2026, 10/15/2026, no zone and an unencoded +, and ledger other than 1, each after the same query without the fault answered 200, and answers 200 for %2B02:00", async () => {
      const { asked, get } = statsHarness();
      const time = "from=2026-10-15T00:00Z";
      const timeMessage = (value: string) =>
        `Invalid time: ${value} (use ISO 8601 with Z or an offset)`;
      const cases: readonly (readonly [string, string, string])[] = [
        [`?since=1h&${time}`, "?since=1h", "stats takes since or from, not both"],
        ["?to=2026-10-16T00:00Z", `?${time}&to=2026-10-16T00:00Z`, "to needs from"],
        [
          "?from=2026-10-16T00:00Z&to=2026-10-15T00:00Z",
          "?from=2026-10-15T00:00Z&to=2026-10-16T00:00Z",
          "from must be earlier than to, or than now when to is left out",
        ],
        ["?since=fortnight", "?since=1h", "Invalid duration: fortnight"],
        ["?from=1", `?${time}`, timeMessage("1")],
        ["?from=2026", `?${time}`, timeMessage("2026")],
        ["?from=10/15/2026", `?${time}`, timeMessage("10/15/2026")],
        ["?from=2026-10-15T00:00", `?${time}`, timeMessage("2026-10-15T00:00")],
        ["?from=2026-10-15T00:00+02:00", `?${time}`, timeMessage("2026-10-15T00:00 02:00")],
        ["?since=1h&ledger=yes", "?since=1h&ledger=1", "ledger must be 1"],
      ];

      for (const [bad, good, message] of cases) {
        expect((await get(good)).status, good).toBe(200);
        const dispatched = asked.length;
        const refused = await get(bad);
        expect(refused.status, bad).toBe(400);
        expect(await refused.json(), bad).toMatchObject({
          error: { code: "BAD_REQUEST", message },
        });
        expect(asked, bad).toHaveLength(dispatched);
      }
      const offset = await get("?from=2026-10-15T00:00%2B02:00");
      expect(offset.status).toBe(200);
      expect(asked.at(-1)).toEqual({ from: Date.parse("2026-10-14T22:00:00Z"), to: NOW });
    });

    it("passes includeLedger: true only for ledger=1", async () => {
      const { asked, get } = statsHarness();

      await get("?since=1h");
      await get("?since=1h&ledger=1");

      expect(asked.map((input) => input.includeLedger === true)).toEqual([false, true]);
    });
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

  it("GET /v1/events/stream writes a comment or retry line as soon as it opens, before any keepalive is due", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["events.subscribe"] = (_input, session) => ({
      subscribed: true,
      subscriptionId: session.manageEventSubscription(true),
    });
    const response = await app.request("/v1/events/stream", { headers: operatorAuth });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("response has no body");
    let written = "nothing written";
    void reader.read().then(({ value, done }) => {
      written = done ? "stream ended" : new TextDecoder().decode(value);
    });
    for (let turn = 0; turn < 50; turn += 1) await settle();
    const writtenBeforeCancel = written;
    await reader.cancel();

    expect(writtenBeforeCancel).toMatch(/^(:[^\n]*|retry: ?\d+)\n\n$/);
  });
});

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

describe("worker routes", () => {
  function gatewayHarness() {
    return buildHarness();
  }

  it("are routes on a worker too (ADR 0012 §3), each dispatching its operation", async () => {
    const { app, dispatcher } = buildHarness();
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

  it("GET /v1/inbox dispatches inbox.get for the caller and answers its items", async () => {
    const { app, dispatcher } = gatewayHarness();
    const item = {
      condition: "disconnected",
      group: "Broken",
      key: "wrk_1/disconnected",
      worker: {
        connection: "disconnected",
        drained: false,
        heldLeases: 0,
        id: "wrk_1",
        lastSeenAt: 1,
        leasedDevices: 0,
      },
    };
    dispatcher.handlers["inbox.get"] = () => ({ items: [item] });

    const response = await app.request("/v1/inbox", { headers: operatorAuth });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [item] });
    expect(dispatcher.calls.map((call) => [call.operation, call.session.role])).toEqual([
      ["inbox.get", "admin"],
    ]);
  });

  it("GET /v1/config dispatches config.get for the caller and answers the config; an agent token is a 403, no token a 401", async () => {
    const { app, dispatcher } = gatewayHarness();
    const config = testConfig({ update: { check: false } }, "gateway");
    // why: `config.get`'s own role check runs through the contract's real pipeline; the route adds none.
    dispatcher.handlers["config.get"] = (input, session) =>
      runDispatch("config.get", input, session, {
        handlers: {
          "config.get": (configInput) => {
            expect(configInput).toEqual({});
            return config;
          },
        },
      });

    const asOperator = await app.request("/v1/config", { headers: operatorAuth });
    const asAgent = await app.request("/v1/config", { headers: agentAuth });
    const anonymous = await app.request("/v1/config");

    expect(asOperator.status).toBe(200);
    expect(await asOperator.json()).toMatchObject({ mode: "gateway", update: { check: false } });
    expect(asAgent.status).toBe(403);
    expect(((await asAgent.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(anonymous.status).toBe(401);
    expect(dispatcher.calls.map((call) => [call.operation, call.session.role])).toEqual([
      ["config.get", "admin"],
      ["config.get", "agent"],
    ]);
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

describe("the stream mount's listed route", () => {
  it("is the route its handler answers: the listed path gets a status the definition lists, and /v1/stream/x gets its listed 404", async () => {
    const route = streamModule.http?.routes[0];
    if (route === undefined) throw new Error("the stream definition lists no route");
    const link = {
      serve: () =>
        Promise.resolve({
          body: new ReadableStream<Uint8Array>(),
          close: () => Promise.resolve(),
          meta: { codec: "h264" as const, fps: 30, height: 720, width: 330 },
        }),
    };
    const { app } = buildHarness({
      mounts: [{ prefix: "stream", ...createStreamMount({ link }) }],
    });
    const listed = Object.keys(route.statuses).map(Number);
    const answer = (path: string, method = "GET") =>
      app.request(path, { headers: agentAuth, method });

    const listedPath = route.path.replace("{workerId}", "w1").replace("{deviceId}", "dev_1");
    const found = await answer(listedPath);
    const other = await answer("/v1/stream/x");
    const wrongMethod = await answer(listedPath, "POST");

    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toBe("application/vnd.simlock.stream+h264");
    expect([other.status, wrongMethod.status]).toEqual([404, 405]);
    expect(listed).toEqual(
      expect.arrayContaining([found.status, other.status, wrongMethod.status]),
    );
    expect(await other.json()).toMatchObject({ error: { code: "UNKNOWN_DEVICE" } });
    await found.body?.cancel();
  });
});

describe("ETag on a JSON read under /v1", () => {
  it("304 and no body for an unchanged read, 200 for a stale tag, a new ETag once the data changes, no ETag on a 404 or a mount", async () => {
    const tokens: { id: string }[] = [{ id: "tok_1" }];
    const { app, dispatcher, eventBus } = buildHarness({
      mounts: [
        {
          prefix: "json-mount",
          handle: () => Response.json({ ok: true }),
        },
      ] as never,
    });
    dispatcher.handlers["token.list"] = () => ({ tokens: [...tokens] });
    dispatcher.handlers["events.subscribe"] = (_input, session) => ({
      subscribed: true,
      subscriptionId: session.manageEventSubscription(true),
    });
    const read = (path: string, headers: Record<string, string> = {}) =>
      app.request(path, { headers: { ...operatorAuth, ...headers } });

    const first = await read("/v1/tokens");
    const tag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(tag).toMatch(/^"[^"]+"$/);

    const unchanged = await read("/v1/tokens", { "If-None-Match": tag ?? "" });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(tag);

    const stale = await read("/v1/tokens", { "If-None-Match": '"stale"' });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("etag")).toBe(tag);

    tokens.push({ id: "tok_2" });
    const changed = await read("/v1/tokens", { "If-None-Match": tag ?? "" });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);

    const missing = await read("/v1/leases/lse_none");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("etag")).toBeNull();

    const mount = await read("/v1/json-mount/x");
    expect(mount.status).toBe(200);
    expect(mount.headers.get("content-type")).toContain("application/json");
    expect(mount.headers.get("etag")).toBeNull();

    const streamOrStall = await Promise.race([
      read("/v1/events/stream"),
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 500)),
    ]);
    if (streamOrStall === "stalled") expect.fail("the event stream was buffered, not answered");
    const stream = streamOrStall;
    expect(stream.headers.get("etag")).toBeNull();
    const framesPromise = readSseFrames(stream, 1);
    await Promise.resolve();
    eventBus.emit("daemon.stopping", { reason: "live" }, "test");
    expect((await framesPromise)[0]?.event).toBe("daemon.stopping");
  });
});

describe("Cache-Control on a JSON answer under /v1", () => {
  it("a JSON read, its 304, a JSON error and /v1/healthz each carry Cache-Control: no-store, so a CDN never stores an answer, and a mount's answer keeps the Cache-Control it set", async () => {
    const { app, dispatcher } = buildHarness({
      mounts: [
        { prefix: "json-mount", handle: () => Response.json({ ok: true }) },
        {
          prefix: "cached-mount",
          handle: () => Response.json({ ok: true }, { headers: { "Cache-Control": "max-age=60" } }),
        },
      ] as never,
    });
    dispatcher.handlers["token.list"] = () => ({ tokens: [{ id: "tok_1" }] });
    const read = (path: string, headers: Record<string, string> = {}) =>
      app.request(path, { headers: { ...operatorAuth, ...headers } });

    const first = await read("/v1/tokens");
    const unchanged = await read("/v1/tokens", {
      "If-None-Match": first.headers.get("etag") ?? "",
    });
    const missing = await read("/v1/leases/lse_none");
    const health = await app.request("/v1/healthz");
    const plainMount = await read("/v1/json-mount");
    const cachedMount = await read("/v1/cached-mount");

    expect([first.status, unchanged.status, missing.status, health.status]).toEqual([
      200, 304, 404, 200,
    ]);
    expect({
      plain: plainMount.headers.get("cache-control"),
      cached: cachedMount.headers.get("cache-control"),
    }).toEqual({ plain: null, cached: "max-age=60" });
    expect({
      read: first.headers.get("cache-control"),
      notModified: unchanged.headers.get("cache-control"),
      error: missing.headers.get("cache-control"),
      healthz: health.headers.get("cache-control"),
    }).toEqual({
      read: "no-store",
      notModified: "no-store",
      error: "no-store",
      healthz: "no-store",
    });
  });
});
