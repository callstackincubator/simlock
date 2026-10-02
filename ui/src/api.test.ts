import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiPath, createApiClient, type Fetch, RequestTimeoutError } from "./api";

/** A fetch that records what it was asked and answers `status`. */
function answering(status: number, body: unknown = {}) {
  const calls: { readonly input: string; readonly init: RequestInit }[] = [];
  const fetch: Fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetch };
}

/** A fetch that never answers, and rejects only when its request is aborted. */
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
    // Any other refusal leaves the operator signed in.
    await expect(forbidden.getJson("/v1/workers")).rejects.toMatchObject({ status: 403 });
    expect(signOut).toHaveBeenCalledTimes(1);
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

  it("sends the token only as a bearer header, to a relative /v1 path", async () => {
    const { calls, fetch } = answering(200, { workers: [] });
    const api = createApiClient({ fetch, signOut: () => {}, token: () => "slk_op" });

    expect(await api.getJson("/v1/workers")).toEqual({ workers: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/v1/workers");
    expect(calls[0]?.init.headers).toEqual({ Authorization: "Bearer slk_op" });
    expect(calls[0]?.init.credentials).toBe("omit");
    // Never answered from the browser's cache: what the daemon holds now is the answer.
    expect(calls[0]?.init.cache).toBe("no-store");
    await expect(api.getJson("//elsewhere.example/v1/workers" as ApiPath)).rejects.toThrow(
      "Not an API path",
    );
    expect(calls).toHaveLength(1);
  });
});
