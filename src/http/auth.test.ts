import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  type Auth,
  type Identity,
  type AuthStrategyDefinition,
  createAuth,
  type StrategyAnswer,
} from "../auth/index.js";
import { createAuthWith, fakeAuth, tokenIdentity } from "../auth/testing.js";
import { CryptoTokenSecrets, FakeClock, MemoryFilesystem, NoopLogger } from "../ports/index.js";
import { type AuthEnv, requireAuth } from "./auth.js";
import { errorResponse } from "./errors.js";

function appWithAuth(identities: Map<string, Identity>) {
  const app = new Hono<AuthEnv>();
  app.onError((error, c) => errorResponse(c, error));
  app.get("/resource", requireAuth(fakeAuth(identities)), (c) =>
    c.json({ identity: c.get("identity") }),
  );
  return app;
}

describe("requireAuth", () => {
  it("401s with no Authorization header", async () => {
    const response = await appWithAuth(new Map()).request("/resource");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: expect.any(String) },
    });
  });

  it("401s on a malformed Authorization header (no Bearer prefix)", async () => {
    const response = await appWithAuth(new Map()).request("/resource", {
      headers: { authorization: "slk_secret" },
    });
    expect(response.status).toBe(401);
  });

  it("401s on an unknown bearer token", async () => {
    const response = await appWithAuth(new Map()).request("/resource", {
      headers: { authorization: "Bearer slk_unknown" },
    });
    expect(response.status).toBe(401);
  });

  it("admits a known agent token and stores its identity", async () => {
    const agent = tokenIdentity("tok_agent", "agent");
    const response = await appWithAuth(new Map([["slk_agent", agent]])).request("/resource", {
      headers: { authorization: "Bearer slk_agent" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identity: agent });
  });

  it("admits a known operator token too -- role gating is the shared dispatcher's job now, not this middleware's", async () => {
    const operator = tokenIdentity("tok_op", "operator");
    const response = await appWithAuth(new Map([["slk_op", operator]])).request("/resource", {
      headers: { authorization: "Bearer slk_op" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identity: operator });
  });
});

describe("requireAuth over src/auth", () => {
  const options = {
    config: { enabled: true, host: "127.0.0.1", port: 4700 },
    dataDirectory: "/home/agent/.simlock",
    filesystem: new MemoryFilesystem(),
    secrets: new CryptoTokenSecrets(),
    idGenerator: { generate: () => "id" },
    clock: new FakeClock(1_000),
    logger: new NoopLogger(),
  };

  function refusing(answer: StrategyAnswer): AuthStrategyDefinition {
    return {
      name: "fake",
      enabled: () => true,
      create: () => ({ authenticate: async () => answer }),
    };
  }

  function appWithAuthFrom(auth: Auth) {
    const app = new Hono<AuthEnv>();
    app.onError((error, c) => errorResponse(c, error));
    app.get("/resource", requireAuth(auth), (c) => c.json({ ok: true }));
    return app;
  }

  it("answers an AuthError 401 as UNAUTHENTICATED with its message and details, and a 403 as FORBIDDEN", async () => {
    const rejected = await appWithAuthFrom(
      createAuthWith(
        [refusing({ kind: "rejected", message: "Token expired", details: { expiredAt: 5 } })],
        options,
      ),
    ).request("/resource");
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Token expired", details: { expiredAt: 5 } },
    });

    const forbidden = await appWithAuthFrom(
      createAuthWith([refusing({ kind: "forbidden", message: "No authority here" })], options),
    ).request("/resource");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: { code: "FORBIDDEN", message: "No authority here" },
    });
  });

  it("answers a token's 401 with only code and message", async () => {
    const response = await appWithAuthFrom(createAuth(options)).request("/resource", {
      headers: { authorization: "Bearer slk_unknown" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Unknown bearer token" },
    });
  });

  it("lets an error that is not an AuthError through as a 500, never a 401 or 403", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(options.dataDirectory);
    await filesystem.writeFileAtomic(`${options.dataDirectory}/tokens.json`, "{ not valid json");

    const response = await appWithAuthFrom(createAuth({ ...options, filesystem })).request(
      "/resource",
      { headers: { authorization: "Bearer slk_any" } },
    );

    expect(response.status).toBe(500);
  });
});
