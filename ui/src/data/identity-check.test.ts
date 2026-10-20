import { describe, expect, it, vi } from "vitest";

import type { Fetch } from "./api";
import { checkIdentity, type IdentityOutcome } from "./identity-check";

const HTML = "<html><body>Sign in to continue</body></html>";
const NETWORK_ERROR = Symbol("network error");

type Answer = Response | typeof NETWORK_ERROR;

function asking(identity: Answer, healthz: Answer = new Response('{"ok":true}', { status: 200 })) {
  const calls: { readonly input: string; readonly init: RequestInit }[] = [];
  const fetch: Fetch = async (input, init) => {
    calls.push({ input, init });
    const answer = input === "/v1/healthz" ? healthz : identity;
    if (answer === NETWORK_ERROR) throw new TypeError("Failed to fetch");
    return answer.clone();
  };
  return { calls, fetch };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const simlock = (code: string, reason?: string) => ({
  error: { code, message: "refused", ...(reason === undefined ? {} : { reason }) },
});

describe("checkIdentity", () => {
  it("answers who the proxy signed in, or that nobody is, from what the daemon says", async () => {
    const cases: readonly (readonly [Answer, IdentityOutcome])[] = [
      [
        json(200, {
          name: "Alice",
          principal: "proxy:https://idp#u1",
          role: "admin",
          signOutUrl: "https://idp/logout",
          via: "proxy",
        }),
        { kind: "proxy", name: "Alice", signOutUrl: "https://idp/logout" },
      ],
      [
        json(200, { name: "Bob", principal: "proxy:https://idp#u2", role: "admin", via: "proxy" }),
        { kind: "proxy", name: "Bob" },
      ],
      [json(401, simlock("UNAUTHENTICATED", "expired")), { kind: "refused", reason: "expired" }],
      [
        json(200, { name: "ci", principal: "tok_1", role: "agent", via: "token" }),
        { kind: "none" },
      ],
      [json(401, simlock("UNAUTHENTICATED")), { kind: "none" }],
      [json(403, simlock("FORBIDDEN")), { kind: "none" }],
      [json(503, simlock("UNAVAILABLE")), { kind: "none" }],
    ];

    const outcomes = [];
    for (const [answer] of cases) outcomes.push(await checkIdentity(asking(answer).fetch));

    expect(outcomes).toEqual(cases.map(([, outcome]) => outcome));
  });

  it("after a loss, a 5xx from the identity check counts as unreachable, not none", async () => {
    const outcome = await checkIdentity(asking(json(503, simlock("UNAVAILABLE"))).fetch, true);

    expect(outcome).toEqual({ kind: "unreachable" });
  });

  it("asks /v1/healthz when the answer is not Simlock's, and says the proxy's session ended when that answers", async () => {
    const notSimlock: readonly Answer[] = [
      NETWORK_ERROR,
      new Response(HTML, { headers: { "Content-Type": "text/html" }, status: 403 }),
      new Response(HTML, { headers: { "Content-Type": "text/html" }, status: 401 }),
    ];

    for (const identity of notSimlock) {
      const answering = asking(identity);
      expect(await checkIdentity(answering.fetch)).toEqual({ kind: "ended" });
      expect(answering.calls.map((call) => call.input)).toEqual(["/v1/identity", "/v1/healthz"]);
      const down = asking(identity, NETWORK_ERROR);
      expect(await checkIdentity(down.fetch)).toEqual({ kind: "unreachable" });
      const failing = asking(identity, new Response("down", { status: 503 }));
      expect(await checkIdentity(failing.fetch)).toEqual({ kind: "unreachable" });
    }
  });

  it("asks nothing more of a Simlock answer", async () => {
    const answering = asking(json(403, simlock("FORBIDDEN")));

    await checkIdentity(answering.fetch);

    expect(answering.calls.map((call) => call.input)).toEqual(["/v1/identity"]);
  });

  it("sends no Authorization and credentials same-origin", async () => {
    const answering = asking(json(401, simlock("UNAUTHENTICATED")));

    await checkIdentity(answering.fetch);

    const [identity] = answering.calls;
    expect(identity?.input).toBe("/v1/identity");
    expect(identity?.init.credentials).toBe("same-origin");
    expect(new Headers(identity?.init.headers).has("Authorization")).toBe(false);
  });

  it("answers nobody, and asks nothing more, when the identity request times out", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const fetch: Fetch = (input, init) => {
        calls.push(input);
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        });
      };

      const outcome = checkIdentity(fetch);
      await vi.advanceTimersByTimeAsync(10_001);

      expect(await outcome).toEqual({ kind: "none" });
      expect(calls).toEqual(["/v1/identity"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
