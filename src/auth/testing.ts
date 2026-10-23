import { base64url, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

import {
  CryptoTokenSecrets,
  MemoryFilesystem,
  NodeFilesystem,
  NodeSqliteOpener,
  NoopLogger,
} from "../ports/index.js";
import type { SqliteOpener, SqliteSchemaOwner } from "../ports/index.js";
import { openStateDatabase, type StateDatabase } from "../state/index.js";
import { tokensOwner } from "./token-store.js";
import type { TokenRole } from "./tokens.js";
import { type Auth, type AuthOptions, createAuthFrom } from "./index.js";
import type { Identity } from "./identity.js";
import { AuthError, type AuthConfig, type AuthStrategyDefinition } from "./strategy.js";

export function createAuthWith(
  definitions: readonly AuthStrategyDefinition[],
  options: AuthOptions,
): Auth {
  return createAuthFrom(definitions, options);
}

export function fakeAuth(identities: ReadonlyMap<string, Identity>): Auth {
  const unused = async (): Promise<never> => {
    throw new Error("fakeAuth only authenticates requests");
  };
  return {
    authenticateRequest: async (headers) => {
      const value = headers.get("authorization");
      const secret = value?.startsWith("Bearer ") ? value.slice(7).trim() : "";
      if (secret === "") throw new AuthError(401, "Missing bearer token");
      const identity = identities.get(secret);
      if (identity === undefined) throw new AuthError(401, "Unknown bearer token");
      return identity;
    },
    resolveHelloRole: unused,
    authenticateUplink: unused,
    tokens: { create: unused, list: unused, revoke: unused, verify: unused },
    adminSecret: { persist: unused, remove: unused },
  };
}

export function tokenIdentity(principal: string, role: Identity["role"] = "agent"): Identity {
  return { principal, name: principal, role, via: "token", ambient: false };
}

export const PROXY_NOW = 1_800_000_000_000;
const KEYS_URL = "https://keys.proxy.test/certs";

export const proxyAuthConfig = {
  header: "cf-access-jwt-assertion",
  jwksUrl: KEYS_URL,
  issuer: "iss1",
  audience: "aud1",
};

export interface TestKey {
  readonly kid: string;
  readonly alg: "ES256" | "RS256";
  readonly publicJwk: JWK;
  sign(payload: Record<string, unknown>): Promise<string>;
}

export async function createTestKey(alg: "ES256" | "RS256", kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return {
    kid,
    alg,
    publicJwk,
    sign: (payload) => new SignJWT(payload).setProtectedHeader({ alg, kid }).sign(privateKey),
  };
}

export function keySetBody(...keys: readonly TestKey[]): string {
  return JSON.stringify({ keys: keys.map((key) => key.publicJwk) });
}

export function personClaims(
  overrides: Record<string, unknown> = {},
  nowMs: number = PROXY_NOW,
): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    iss: proxyAuthConfig.issuer,
    aud: proxyAuthConfig.audience,
    sub: "u1",
    email: "a@x",
    exp: Math.floor(nowMs / 1000) + 300,
    ...overrides,
  };
  for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];
  return claims;
}

export function signWithHmac(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode("a-shared-secret-of-at-least-32-bytes"));
}

export function unsigned(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => base64url.encode(JSON.stringify(value));
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

export function withAlteredSignature(jwt: string): string {
  // why: the last base64url character of a signature carries padding bits, so changing it can leave the bytes unchanged; the first one is all data.
  const start = jwt.lastIndexOf(".") + 1;
  const first = jwt.at(start) === "A" ? "B" : "A";
  return `${jwt.slice(0, start)}${first}${jwt.slice(start + 1)}`;
}

export function proxyRequest(jwt: string, header: string = proxyAuthConfig.header): Headers {
  return new Headers({ [header]: jwt });
}

export function authConfigWith(proxyAuth: Record<string, unknown> = proxyAuthConfig): AuthConfig {
  return { enabled: true, host: "127.0.0.1", port: 4700, proxyAuth } as AuthConfig;
}

// why: the real adapter on SQLite's in-memory database, whatever path the state module asks for.
const memorySqlite: SqliteOpener = {
  open: (_path, options) => new NodeSqliteOpener().open(":memory:", options),
};

export function openMemoryStateDatabase(
  owners: readonly SqliteSchemaOwner[],
): Promise<StateDatabase> {
  return openStateDatabase({
    dataDirectory: "/memory",
    filesystem: new MemoryFilesystem(),
    logger: new NoopLogger(),
    oldFiles: [],
    owners,
    sqlite: memorySqlite,
    upgradeStep: "",
  });
}

/** why: the daemon opens `state.db` itself, so a test that starts one with known tokens writes them to the file first. */
export async function seedTokensDatabase(
  directory: string,
  records: readonly (readonly [id: string, secret: string, role: TokenRole, label?: string])[],
): Promise<void> {
  const hasher = new CryptoTokenSecrets();
  const state = await openStateDatabase({
    dataDirectory: directory,
    filesystem: new NodeFilesystem(),
    logger: new NoopLogger(),
    oldFiles: [],
    owners: [tokensOwner],
    sqlite: new NodeSqliteOpener(),
    upgradeStep: "",
  });
  try {
    for (const [id, secret, role, label] of records) {
      state.database
        .prepare(
          "INSERT OR REPLACE INTO tokens (id, hash, role, label, created_at) VALUES (?, ?, ?, ?, 0)",
        )
        .run(id, hasher.hash(secret), role, label ?? null);
    }
  } finally {
    state.close();
  }
}
