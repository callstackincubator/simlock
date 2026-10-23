import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiPath, createApiClient, type Fetch, RequestTimeoutError } from "./api";

function answering(status: number, body: unknown = {}) {
  const calls: { readonly input: string; readonly init: RequestInit }[] = [];
  const fetch: Fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetch };
}

const hanging: Fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("createApiClient", () => {
  it("the fetch helper signs out on a 401", async () => {
    const signOut = vi.fn();
    const unauthorized = createApiClient({
      fetch: answering(401, { error: { code: "UNAUTHENTICATED", message: "Unknown bearer token" } })
        .fetch,
      signOut,
      token: () => "slk_revoked",
    });
    const forbidden = createApiClient({
      fetch: answering(403).fetch,
      signOut,
      token: () => "slk_agent",
    });

    const refusal = unauthorized.getJson("/v1/workers");
    await expect(refusal).rejects.toBeInstanceOf(ApiError);
    await expect(refusal).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(signOut).toHaveBeenCalledTimes(1);
    await expect(forbidden.getJson("/v1/workers")).rejects.toMatchObject({ status: 403 });
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("tells a 401 or 403 that is not Simlock's from a Simlock 401", async () => {
    const refused = async (status: number, body: unknown) => {
      const onRefused = vi.fn();
      const api = createApiClient({
        fetch: answering(status, body).fetch,
        onRefused,
        token: () => undefined,
      });
      await api.getJson("/v1/workers").catch(() => undefined);
      return onRefused.mock.calls.map(([failure]) => failure);
    };
    const simlock = { error: { code: "UNAUTHENTICATED", message: "refused" } };

    expect(await refused(401, {})).toEqual(["not-simlock"]);
    expect(await refused(403, {})).toEqual(["not-simlock"]);
    expect(await refused(401, simlock)).toEqual(["unauthorized"]);
    expect(await refused(403, simlock)).toEqual([]);
  });

  it("the fetch helper gives up after 10 seconds", async () => {
    vi.useFakeTimers();
    const api = createApiClient({ fetch: hanging, signOut: () => {}, token: () => "slk_op" });

    const outcome = api.getJson("/v1/workers").then(
      () => "answered",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(9_999);
    const before = await Promise.race([outcome, Promise.resolve("pending")]);
    await vi.advanceTimersByTimeAsync(1);

    expect(before).toBe("pending");
    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
  });

  it("the 10 seconds cover reading the body, not only the headers", async () => {
    vi.useFakeTimers();
    // why: headers at once, then a body that never ends, as a real fetch's body does until its
    // request is aborted.
    const stalledBody: Fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 },
      );
    const api = createApiClient({ fetch: stalledBody, signOut: () => {}, token: () => "slk_op" });

    const outcome = api.getJson("/v1/workers").then(
      () => "answered",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBeInstanceOf(
      RequestTimeoutError,
    );
  });

  it("sends the token only as a bearer header, to a relative /v1 path", async () => {
    const { calls, fetch } = answering(200, { workers: [] });
    const api = createApiClient({ fetch, signOut: () => {}, token: () => "slk_op" });

    expect(await api.getJson("/v1/workers")).toEqual({ workers: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/v1/workers");
    expect(calls[0]?.init.headers).toEqual({ Authorization: "Bearer slk_op" });
    expect(calls[0]?.init.credentials).toBe("same-origin");
    // why: never answered from the browser's cache: what the daemon holds now is the answer.
    expect(calls[0]?.init.cache).toBe("no-store");
    await expect(api.getJson("//elsewhere.example/v1/workers" as ApiPath)).rejects.toThrow(
      "Not an API path",
    );
    expect(calls).toHaveLength(1);
  });

  it("a write sends its method and path with the token, maps an error body to ApiError, sends a 401 to the session, and on a network error throws without calling refuse", async () => {
    const sent = answering(202, { released: true });
    const writer = createApiClient({ fetch: sent.fetch, token: () => "slk_operator" });

    await writer.write("DELETE", "/v1/leases/lse_1");
    await writer.write("POST", "/v1/workers/wrk_1/drain");

    expect(sent.calls.map(({ input, init }) => [input, init.method])).toEqual([
      ["/v1/leases/lse_1", "DELETE"],
      ["/v1/workers/wrk_1/drain", "POST"],
    ]);
    expect(sent.calls[0]?.init.credentials).toBe("same-origin");
    expect(sent.calls[0]?.init.headers).toEqual({ Authorization: "Bearer slk_operator" });

    const conflict = createApiClient({
      fetch: answering(409, {
        error: { code: "WORKER_CONNECTED", message: "Stop the worker first" },
      }).fetch,
      token: () => "slk_operator",
    });
    const refused = conflict.write("DELETE", "/v1/workers/wrk_1");
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({
      code: "WORKER_CONNECTED",
      message: "Stop the worker first",
      status: 409,
    });

    const onRefused = vi.fn();
    const signedOut = createApiClient({
      fetch: answering(401, { error: { code: "UNAUTHENTICATED", message: "Unknown bearer token" } })
        .fetch,
      onRefused,
      token: () => "slk_revoked",
    });
    await expect(signedOut.write("DELETE", "/v1/leases/lse_1")).rejects.toMatchObject({
      status: 401,
    });
    expect(onRefused.mock.calls).toEqual([["unauthorized"]]);

    const unreachable: Fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    const readRefused = vi.fn();
    const reader = createApiClient({
      fetch: unreachable,
      onRefused: readRefused,
      token: () => "slk_operator",
    });
    await expect(reader.getJson("/v1/leases")).rejects.toBeInstanceOf(TypeError);
    expect(readRefused.mock.calls).toEqual([["not-simlock"]]);
    const writeRefused = vi.fn();
    const unanswered = createApiClient({
      fetch: unreachable,
      onRefused: writeRefused,
      token: () => "slk_operator",
    });
    await expect(unanswered.write("DELETE", "/v1/leases/lse_1")).rejects.toBeInstanceOf(TypeError);
    expect(writeRefused).not.toHaveBeenCalled();
  });

  it("an action sends its body: write sends a JSON body with its content type, resolves the parsed answer or undefined, and waits as long as asked", async () => {
    const sent = answering(202, { started: true });
    const writer = createApiClient({ fetch: sent.fetch, token: () => "slk_operator" });

    const answer = await writer.write("POST", "/v1/workers/wrk_1/update", {
      body: { force: true },
    });

    expect(answer).toEqual({ started: true });
    expect(sent.calls[0]?.init.body).toBe('{"force":true}');
    expect(sent.calls[0]?.init.headers).toEqual({
      Authorization: "Bearer slk_operator",
      "Content-Type": "application/json",
    });
    await writer.write("DELETE", "/v1/leases/lse_1");
    expect(sent.calls[1]?.init.body).toBeUndefined();
    expect(sent.calls[1]?.init.headers).toEqual({ Authorization: "Bearer slk_operator" });

    const empty = createApiClient({
      fetch: async () => new Response(null, { status: 204 }),
      token: () => "slk_operator",
    });
    expect(await empty.write("DELETE", "/v1/leases/lse_1")).toBeUndefined();

    vi.useFakeTimers();
    const slow = createApiClient({ fetch: hanging, signOut: () => {}, token: () => "slk_op" });
    const outcome = slow
      .write("POST", "/v1/workers/wrk_1/update", { body: {}, timeoutMs: 100_000 })
      .then(
        () => "answered",
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(99_999);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
  });

  it("a read hands back the response's Date header with its body", async () => {
    const date = "Fri, 02 Oct 2026 12:00:00 GMT";
    const fetch: Fetch = async () =>
      new Response(JSON.stringify({ workers: [] }), { headers: { Date: date }, status: 200 });
    const api = createApiClient({ fetch, signOut: () => {}, token: () => "slk_op" });

    expect(await api.get("/v1/workers")).toEqual({ body: { workers: [] }, date });
  });

  it("/v1/healthz is asked with no token, and only a success status counts as up", async () => {
    const date = "Fri, 02 Oct 2026 12:00:00 GMT";
    const up = answering(200, { ok: true });
    const down = answering(503);
    const api = (fetch: Fetch) =>
      createApiClient({ fetch, signOut: () => {}, token: () => "slk_op" }).healthz();

    expect((await api(up.fetch)).body).toBe(true);
    expect((await api(down.fetch)).body).toBe(false);
    expect(up.calls[0]?.input).toBe("/v1/healthz");
    expect(up.calls[0]?.init.headers).toEqual({});
    const dated: Fetch = async () => new Response("{}", { headers: { Date: date } });
    expect((await api(dated)).date).toBe(date);
  });

  it("a stream refused with a 401 signs out, and any refusal rejects with the daemon's code", async () => {
    const signOut = vi.fn();
    const refusing = (status: number) =>
      createApiClient({
        fetch: answering(status, { error: { code: "UNAUTHENTICATED", message: "Unknown" } }).fetch,
        signOut,
        token: () => "slk_op",
      }).stream("/v1/events/stream", new AbortController().signal);

    await expect(refusing(401)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(signOut).toHaveBeenCalledTimes(1);
    await expect(refusing(500)).rejects.toBeInstanceOf(ApiError);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("a stream's Date header comes back with its body", async () => {
    const date = "Fri, 02 Oct 2026 12:00:00 GMT";
    const fetch: Fetch = async () => new Response("", { headers: { Date: date }, status: 200 });
    const api = createApiClient({ fetch, signOut: () => {}, token: () => "slk_op" });

    expect((await api.stream("/v1/events/stream", new AbortController().signal)).date).toBe(date);
  });

  it("a stream given its own bound waits that long for its headers, and no longer", async () => {
    vi.useFakeTimers();
    const api = createApiClient({ fetch: hanging, signOut: () => {}, token: () => "slk_op" });

    const outcome = api
      .stream("/v1/stream/leases/lse_1", new AbortController().signal, 90_000)
      .then(
        () => "answered",
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(89_999);
    const before = await Promise.race([outcome, Promise.resolve("pending")]);
    await vi.advanceTimersByTimeAsync(1);

    expect(before).toBe("pending");
    const error = await outcome;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toContain("within 90 seconds");
  });

  it("aborting a stream's signal closes its body after the headers arrived", async () => {
    vi.useFakeTimers();
    let closedWith: unknown;
    const fetch: Fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => {
              closedWith = init.signal?.reason;
              controller.error(init.signal?.reason);
            });
          },
        }),
        { status: 200 },
      );
    const api = createApiClient({ fetch, signOut: () => {}, token: () => "slk_op" });
    const controller = new AbortController();

    const { body } = await api.stream("/v1/events/stream", controller.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closedWith).toBeUndefined();

    controller.abort();

    expect(closedWith).toBeDefined();
    await expect(body.getReader().read()).rejects.toBeDefined();
  });
});
