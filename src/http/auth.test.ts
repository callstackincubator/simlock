import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { type AuthEnv, requireAuth, requireOwnership } from "./auth.js";
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

function appWithAuth(tokens: FakeTokens, minRole?: "operator") {
  const app = new Hono<AuthEnv>();
  app.onError((error, c) => errorResponse(c, error));
  app.get("/resource", requireAuth(tokens, minRole), (c) =>
    c.json({ identity: c.get("identity") }),
  );
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

  it("admits a known agent token when no minimum role is required", async () => {
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

  it("403s an agent token against an operator-only route", async () => {
    const tokens = new FakeTokens();
    tokens.register("slk_agent", { requesterId: "tok_agent", role: "agent" });
    const response = await appWithAuth(tokens, "operator").request("/resource", {
      headers: { authorization: "Bearer slk_agent" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "FORBIDDEN", message: expect.any(String) },
    });
  });

  it("admits an operator token on an operator-only route", async () => {
    const tokens = new FakeTokens();
    tokens.register("slk_op", { requesterId: "tok_op", role: "operator" });
    const response = await appWithAuth(tokens, "operator").request("/resource", {
      headers: { authorization: "Bearer slk_op" },
    });
    expect(response.status).toBe(200);
  });
});

describe("requireOwnership", () => {
  it("allows a requester to access its own resource", () => {
    expect(() => requireOwnership({ requesterId: "tok_a", role: "agent" }, "tok_a")).not.toThrow();
  });

  it("throws 403 when an agent reaches another requester's resource", () => {
    expect(() => requireOwnership({ requesterId: "tok_a", role: "agent" }, "tok_b")).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
    );
  });

  it("allows an operator to access any requester's resource", () => {
    expect(() =>
      requireOwnership({ requesterId: "tok_op", role: "operator" }, "tok_b"),
    ).not.toThrow();
  });
});
