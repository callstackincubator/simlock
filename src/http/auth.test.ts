import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { type AuthEnv, requireAuth } from "./auth.js";
import { errorResponse } from "./errors.js";
import type { TokenIdentity } from "./token-store.js";

class FakeTokens {
  readonly #identities = new Map<string, TokenIdentity>();

  register(secret: string, identity: TokenIdentity): void {
    this.#identities.set(secret, identity);
  }

  async verify(secret: string): Promise<TokenIdentity | undefined> {
    return this.#identities.get(secret);
  }
}

function appWithAuth(tokens: FakeTokens) {
  const app = new Hono<AuthEnv>();
  app.onError((error, c) => errorResponse(c, error));
  app.get("/resource", requireAuth(tokens), (c) => c.json({ identity: c.get("identity") }));
  return app;
}

describe("requireAuth", () => {
  it("401s with no Authorization header", async () => {
    const response = await appWithAuth(new FakeTokens()).request("/resource");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: expect.any(String) },
    });
  });

  it("401s on a malformed Authorization header (no Bearer prefix)", async () => {
    const response = await appWithAuth(new FakeTokens()).request("/resource", {
      headers: { authorization: "slk_secret" },
    });
    expect(response.status).toBe(401);
  });

  it("401s on an unknown bearer token", async () => {
    const response = await appWithAuth(new FakeTokens()).request("/resource", {
      headers: { authorization: "Bearer slk_unknown" },
    });
    expect(response.status).toBe(401);
  });

  it("admits a known agent token and stores its identity", async () => {
    const tokens = new FakeTokens();
    tokens.register("slk_agent", { requesterId: "tok_agent", role: "agent" });
    const response = await appWithAuth(tokens).request("/resource", {
      headers: { authorization: "Bearer slk_agent" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      identity: { requesterId: "tok_agent", role: "agent" },
    });
  });

  it("admits a known operator token too -- role gating is the shared dispatcher's job now, not this middleware's", async () => {
    const tokens = new FakeTokens();
    tokens.register("slk_op", { requesterId: "tok_op", role: "operator" });
    const response = await appWithAuth(tokens).request("/resource", {
      headers: { authorization: "Bearer slk_op" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      identity: { requesterId: "tok_op", role: "operator" },
    });
  });

  it("403s a worker join token: it can open an uplink and nothing else (ADR 0005 §25)", async () => {
    const tokens = new FakeTokens();
    tokens.register("slk_join", { requesterId: "tok_join", role: "worker" });
    const response = await appWithAuth(tokens).request("/resource", {
      headers: { authorization: "Bearer slk_join" },
    });
    // 403, not 401: the token is real and was recognized, it just has no authority here.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "FORBIDDEN", message: expect.any(String) },
    });
  });
});
