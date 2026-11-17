import { describe, expect, it } from "vitest";
import { identityGet } from "../daemon/dispatch.js";
import { DispatchError } from "../daemon/dispatcher.js";
import {
  agentAuth,
  type App,
  buildHarness,
  createLeaseRequest,
  operatorAuth,
  otherAgentAuth,
  readSseFrames,
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

describe("GET /v1/session without an upgrade", () => {
  it("answers 426 to a plain GET, and 404 to an upgrade on a host with no session acceptor", async () => {
    const { app } = buildHarness();

    const plain = await app.request("/v1/session", { headers: agentAuth });
    expect(plain.status).toBe(426);
    expect(plain.headers.get("upgrade")).toBe("websocket");
    expect(await plain.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });

    const upgrade = await app.session(
      new Request("http://127.0.0.1:4700/v1/session", {
        headers: { ...agentAuth, upgrade: "websocket" },
      }),
    );
    expect("response" in upgrade && upgrade.response.status).toBe(404);
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
