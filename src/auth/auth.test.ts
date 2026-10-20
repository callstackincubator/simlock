import { describe, expect, it } from "vitest";

import { OPERATIONS } from "../contract/index.js";
import {
  FakeClock,
  FakeKeySetFetcher,
  MemoryFilesystem,
  NoopLogger,
  type TokenSecrets,
} from "../ports/index.js";
import { AdminAuthenticationFailedError, AuthError, createAuth, type TokenRole } from "./index.js";
import { TokenStoreError } from "./token-store.js";
import { authStrategies } from "./strategies/index.js";
import type { AuthConfig, AuthStrategyDefinition, StrategyAnswer } from "./strategy.js";
import { createAuthWith, proxyAuthConfig } from "./testing.js";

const dataDirectory = "/home/agent/.simlock";
const config: AuthConfig = { enabled: true, host: "127.0.0.1", port: 4700 };

class FakeTokenSecrets implements TokenSecrets {
  #next = 0;

  generateSecret(): string {
    this.#next += 1;
    return `slk_generated-${this.#next}`;
  }

  hash(secret: string): string {
    return `hash:${secret}`;
  }
}

interface SeedToken {
  readonly id: string;
  readonly secret: string;
  readonly role: TokenRole;
  readonly label?: string;
}

const seeds: readonly SeedToken[] = [
  { id: "tok_agent", secret: "slk_agent", role: "agent", label: "ci-runner" },
  { id: "tok_bare", secret: "slk_bare", role: "agent" },
  { id: "tok_operator", secret: "slk_operator", role: "operator", label: "ops" },
  { id: "tok_worker", secret: "slk_worker", role: "worker", label: "mac-mini" },
];

async function options() {
  const filesystem = new MemoryFilesystem();
  const secrets = new FakeTokenSecrets();
  await filesystem.mkdirp(dataDirectory);
  await filesystem.writeFileAtomic(
    `${dataDirectory}/tokens.json`,
    JSON.stringify(
      seeds.map(({ id, secret, role, label }) => ({
        id,
        hash: secrets.hash(secret),
        role,
        ...(label === undefined ? {} : { label }),
        createdAt: 1,
      })),
    ),
    { mode: 0o600 },
  );
  return {
    config,
    dataDirectory,
    filesystem,
    secrets,
    idGenerator: { generate: () => "id" },
    clock: new FakeClock(1_000),
    logger: new NoopLogger(),
    keySetFetcher: new FakeKeySetFetcher(),
  };
}

function headers(authorization?: string): Headers {
  return new Headers(authorization === undefined ? {} : { authorization });
}

describe("authenticateRequest with the token strategy", () => {
  it.each([
    { authorization: undefined, status: 401, message: "Missing bearer token" },
    { authorization: "Basic x", status: 401, message: "Missing bearer token" },
    { authorization: "Bearer ", status: 401, message: "Missing bearer token" },
    { authorization: "bearer slk_agent", status: 401, message: "Missing bearer token" },
    { authorization: "Bearer slk_unknown", status: 401, message: "Unknown bearer token" },
    { authorization: "Bearer abc", status: 401, message: "Unknown bearer token" },
    {
      authorization: "Bearer slk_worker",
      status: 403,
      message: "A worker join token can only open an uplink, not call the HTTP API",
    },
  ])("answers $status $message for Authorization $authorization", async (row) => {
    const auth = createAuth(await options());

    const refusal = await auth.authenticateRequest(headers(row.authorization)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(AuthError);
    expect(refusal).toMatchObject({ status: row.status, message: row.message });
    expect((refusal as AuthError).details).toBeUndefined();
  });

  it("trims the bearer value before reading it, as the HTTP check does today", async () => {
    const auth = createAuth(await options());

    await expect(auth.authenticateRequest(headers("Bearer   slk_agent  "))).resolves.toMatchObject({
      principal: "tok_agent",
    });
    await expect(auth.authenticateRequest(headers("Bearer    "))).rejects.toMatchObject({
      message: "Missing bearer token",
    });
  });

  it("identifies a known slk_ token with its id as principal, its label as name, its role, via token, not ambient", async () => {
    const auth = createAuth(await options());

    await expect(auth.authenticateRequest(headers("Bearer slk_agent"))).resolves.toEqual({
      principal: "tok_agent",
      name: "ci-runner",
      role: "agent",
      via: "token",
      ambient: false,
    });
    await expect(auth.authenticateRequest(headers("Bearer slk_bare"))).resolves.toMatchObject({
      principal: "tok_bare",
      name: "tok_bare",
    });
    await expect(auth.authenticateRequest(headers("Bearer slk_operator"))).resolves.toMatchObject({
      principal: "tok_operator",
      role: "operator",
    });
  });
});

describe("authenticateRequest over several strategies", () => {
  const identity = {
    principal: "p",
    name: "n",
    role: "agent",
    via: "second",
    ambient: false,
  } as const;

  function fake(
    name: string,
    answer: StrategyAnswer,
    asked: string[],
    enabled = true,
  ): AuthStrategyDefinition {
    return {
      name,
      enabled: () => enabled,
      create: () => ({
        authenticate: async () => {
          asked.push(name);
          return answer;
        },
      }),
    };
  }

  it("lets the second strategy identify when the first answers not-mine", async () => {
    const asked: string[] = [];
    const auth = createAuthWith(
      [
        fake("first", { kind: "not-mine", sawCredential: false }, asked),
        fake("second", { kind: "identified", identity }, asked),
      ],
      await options(),
    );

    await expect(auth.authenticateRequest(headers("Bearer x"))).resolves.toEqual(identity);
    expect(asked).toEqual(["first", "second"]);
  });

  it("stops at a rejected answer, never asks the second, and uses its message and details", async () => {
    const asked: string[] = [];
    const auth = createAuthWith(
      [
        fake("first", { kind: "rejected", message: "Token expired", details: { at: 5 } }, asked),
        fake("second", { kind: "identified", identity }, asked),
      ],
      await options(),
    );

    await expect(auth.authenticateRequest(headers("Bearer x"))).rejects.toMatchObject({
      status: 401,
      message: "Token expired",
      details: { at: 5 },
    });
    expect(asked).toEqual(["first"]);
  });

  it("stops at a forbidden answer, never asks the second, and uses its message", async () => {
    const asked: string[] = [];
    const auth = createAuthWith(
      [
        fake("first", { kind: "forbidden", message: "No authority" }, asked),
        fake("second", { kind: "identified", identity }, asked),
      ],
      await options(),
    );

    await expect(auth.authenticateRequest(headers("Bearer x"))).rejects.toMatchObject({
      status: 403,
      message: "No authority",
    });
    expect(asked).toEqual(["first"]);
  });

  it("never asks a definition whose enabled(config) is false", async () => {
    const asked: string[] = [];
    const auth = createAuthWith(
      [
        fake(
          "first",
          { kind: "identified", identity: { ...identity, via: "first" } },
          asked,
          false,
        ),
        fake("second", { kind: "identified", identity }, asked),
      ],
      await options(),
    );

    await expect(auth.authenticateRequest(headers("Bearer x"))).resolves.toEqual(identity);
    expect(asked).toEqual(["second"]);
  });
});

describe("the registry", () => {
  it("has a contract schema under configSchema.http for every definition that owns a config key", () => {
    const contractHttp = OPERATIONS["config.get"].output.shape.http.shape as Record<
      string,
      { safeParse(value: unknown): { success: boolean; data?: unknown } } | undefined
    >;
    const owning = authStrategies.flatMap((definition) =>
      definition.config === undefined ? [] : [definition.config],
    );

    const samples: Record<string, readonly unknown[]> = {
      proxyAuth: [
        proxyAuthConfig,
        { ...proxyAuthConfig, signOutUrl: "https://team.example/logout" },
        { ...proxyAuthConfig, audience: undefined },
        { ...proxyAuthConfig, issuer: 7 },
        "x",
      ],
    };

    expect(authStrategies.map((definition) => definition.name)).toEqual(["token", "proxy"]);
    expect(owning.map(({ key }) => key)).toContain("proxyAuth");
    for (const { key, schema, defaults } of owning) {
      const mirrored = contractHttp[key];
      expect(mirrored, key).toBeDefined();
      if (defaults !== undefined) {
        expect(mirrored?.safeParse(defaults)).toEqual(schema.safeParse(defaults));
      }
      for (const sample of samples[key] ?? []) {
        expect(mirrored?.safeParse(sample).success, `${key} ${JSON.stringify(sample)}`).toBe(
          schema.safeParse(sample).success,
        );
      }
    }
    expect(
      owning.find(({ key }) => key === "proxyAuth")?.schema.safeParse(proxyAuthConfig).success,
    ).toBe(true);
  });
});

describe("resolveHelloRole", () => {
  it("resolves agent with no credential, admin for an operator token and for the admin secret, and refuses anything else", async () => {
    const opts = await options();
    const auth = createAuth(opts);
    await auth.adminSecret.persist();
    const adminSecret = (await opts.filesystem.readFile(`${dataDirectory}/admin.token`)).trim();

    await expect(auth.resolveHelloRole({})).resolves.toBe("agent");
    await expect(auth.resolveHelloRole({ principal: "someone" })).resolves.toBe("agent");
    await expect(auth.resolveHelloRole({ credential: "slk_operator" })).resolves.toBe("admin");
    await expect(auth.resolveHelloRole({ credential: adminSecret })).resolves.toBe("admin");
    await expect(auth.resolveHelloRole({ credential: "slk_agent" })).rejects.toThrow(
      AdminAuthenticationFailedError,
    );
    await expect(auth.resolveHelloRole({ credential: "not-a-secret" })).rejects.toThrow(
      AdminAuthenticationFailedError,
    );
  });

  it("checks the token store before the admin secret, so a corrupt store fails loudly even for the admin secret", async () => {
    const opts = await options();
    const auth = createAuth(opts);
    await auth.adminSecret.persist();
    const adminSecret = (await opts.filesystem.readFile(`${dataDirectory}/admin.token`)).trim();
    await opts.filesystem.writeFileAtomic(`${dataDirectory}/tokens.json`, "{ not valid json");

    await expect(auth.resolveHelloRole({ credential: adminSecret })).rejects.toThrow(
      TokenStoreError,
    );
  });
});

describe("authenticateUplink", () => {
  it("answers unauthenticated for none and unknown, forbidden for a token that is not a worker's, accept with the token id for a worker token", async () => {
    const auth = createAuth(await options());

    await expect(auth.authenticateUplink(undefined)).resolves.toBe("unauthenticated");
    await expect(auth.authenticateUplink("slk_unknown")).resolves.toBe("unauthenticated");
    await expect(auth.authenticateUplink("slk_operator")).resolves.toBe("forbidden");
    await expect(auth.authenticateUplink("slk_agent")).resolves.toBe("forbidden");
    await expect(auth.authenticateUplink("slk_worker")).resolves.toEqual({
      outcome: "accept",
      tokenId: "tok_worker",
    });
  });
});
