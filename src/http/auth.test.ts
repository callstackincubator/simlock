import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  type Auth,
  type AuthStrategyDefinition,
  createAuth,
  type StrategyAnswer,
} from "../auth/index.js";
import { tokensOwner } from "../auth/index.js";
import { createAuthWith, openMemoryStateDatabase } from "../auth/testing.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeKeySetFetcher,
  MemoryFilesystem,
  NoopLogger,
} from "../ports/index.js";
import { type AuthEnv, requireAuth } from "./auth.js";
import { errorResponse } from "./errors.js";

describe("requireAuth over src/auth", () => {
  async function authOptions() {
    const { database } = await openMemoryStateDatabase([tokensOwner]);
    return {
      database,
      config: { enabled: true, host: "127.0.0.1", port: 4700 },
      dataDirectory: "/home/agent/.simlock",
      filesystem: new MemoryFilesystem(),
      secrets: new CryptoTokenSecrets(),
      idGenerator: { generate: () => "id" },
      clock: new FakeClock(1_000),
      logger: new NoopLogger(),
      keySetFetcher: new FakeKeySetFetcher(),
    };
  }

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
        await authOptions(),
      ),
    ).request("/resource");
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Token expired", details: { expiredAt: 5 } },
    });

    const forbidden = await appWithAuthFrom(
      createAuthWith(
        [refusing({ kind: "forbidden", message: "No authority here" })],
        await authOptions(),
      ),
    ).request("/resource");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: { code: "FORBIDDEN", message: "No authority here" },
    });
  });

  it("answers a token's 401 with only code and message", async () => {
    const response = await appWithAuthFrom(createAuth(await authOptions())).request("/resource", {
      headers: { authorization: "Bearer slk_unknown" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Unknown bearer token" },
    });
  });

  it("lets an error that is not an AuthError through as a 500, never a 401 or 403", async () => {
    const options = await authOptions();
    vi.spyOn(options.database, "prepare").mockImplementation(() => {
      throw new Error("database is locked");
    });

    const response = await appWithAuthFrom(createAuth(options)).request("/resource", {
      headers: { authorization: "Bearer slk_any" },
    });

    expect(response.status).toBe(500);
  });
});
