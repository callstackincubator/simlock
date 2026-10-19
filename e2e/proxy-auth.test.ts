import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createTestKey, keySetBody, type TestKey } from "../src/auth/testing.js";
import {
  freeLoopbackPort,
  waitFor,
  withDaemon,
  withHttpDaemon,
  type TestEnv,
} from "./helpers/index.js";

const ISSUER = "https://team.cloudflareaccess.com";
const AUDIENCE = "4f1c0e";
const HEADER = "cf-access-jwt-assertion";

interface Gateway {
  readonly env: TestEnv;
  readonly baseUrl: string;
  readonly port: number;
}

const keyServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    keyServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startKeyServer(key: TestKey): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(keySetBody(key));
  });
  keyServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/keys`;
}

async function gatewayTrusting(jwksUrl: string): Promise<Gateway> {
  const { env, port } = await withHttpDaemon((port) => ({
    configOverrides: {
      mode: "gateway",
      http: {
        enabled: true,
        host: "127.0.0.1",
        port,
        proxyAuth: { header: HEADER, jwksUrl, issuer: ISSUER, audience: AUDIENCE },
      },
    },
    driver: "none",
  }));
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  await waitFor(
    async () => {
      try {
        return (await fetch(`${baseUrl}/v1/healthz`)).ok;
      } catch {
        return false;
      }
    },
    { label: "HTTP listener accepting connections" },
  );
  return { env, baseUrl, port };
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "7f3a",
    email: "alice@team.dev",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

function identity(gateway: Gateway, headers: Record<string, string>): Promise<Response> {
  return fetch(`${gateway.baseUrl}/v1/identity`, { headers });
}

describe("sign-in proxy JWT against a real gateway", () => {
  it("GET /v1/identity names the person a good JWT signs in, and refuses an expired one with its reason", async () => {
    const key = await createTestKey("ES256", "k1");
    const gateway = await gatewayTrusting(await startKeyServer(key));

    const good = await identity(gateway, { [HEADER]: await key.sign(claims()) });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({
      principal: `proxy:${ISSUER}#7f3a`,
      name: "alice@team.dev",
      role: "admin",
      via: "proxy",
    });

    const expired = await identity(gateway, {
      [HEADER]: await key.sign(claims({ exp: Math.floor(Date.now() / 1000) - 120 })),
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED",
        message: "Sign-in proxy identity refused: expired",
        reason: "expired",
      },
    });
  });

  it("a gateway whose key server is never started answers a good JWT with 401 keys-unavailable", async () => {
    const key = await createTestKey("ES256", "k1");
    const deadPort = await freeLoopbackPort();
    const gateway = await gatewayTrusting(`http://127.0.0.1:${String(deadPort)}/keys`);

    const response = await identity(gateway, { [HEADER]: await key.sign(claims()) });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED",
        message: "Sign-in proxy identity refused: keys-unavailable",
        reason: "keys-unavailable",
      },
    });
  });

  it("with proxy sign-in on, a minted agent token still answers as that token and a worker still joins with its join token", async () => {
    const key = await createTestKey("ES256", "k1");
    const gateway = await gatewayTrusting(await startKeyServer(key));
    const agent = await gateway.env.cli(["token", "create", "--role", "agent", "--label", "ci"]);
    expect(agent.code, agent.stderr).toBe(0);
    const { secret, token } = agent.json as { secret: string; token: { id: string } };

    const asToken = await identity(gateway, { authorization: `Bearer ${secret}` });
    expect(asToken.status).toBe(200);
    expect(await asToken.json()).toEqual({
      principal: token.id,
      name: "ci",
      role: "agent",
      via: "token",
    });

    const minted = await gateway.env.cli(["token", "create", "--role", "worker"]);
    expect(minted.code, minted.stderr).toBe(0);
    await withDaemon({
      configOverrides: {
        gateway: {
          label: "mac-mini",
          token: (minted.json as { secret: string }).secret,
          url: `ws://127.0.0.1:${String(gateway.port)}`,
        },
      },
    });
    await waitFor(
      async () => {
        const listed = await gateway.env.cli(["worker", "list", "--json"]);
        if (listed.code !== 0) return false;
        const workers = (listed.json as { workers: { label?: string; connection: string }[] })
          .workers;
        return workers.some(
          (worker) => worker.label === "mac-mini" && worker.connection === "connected",
        );
      },
      { label: "the worker joined the gateway", timeout: 30_000 },
    );
  });

  it("GET /v1/healthz answers with no credential, and simlock config get http.proxyAuth.issuer prints the configured issuer", async () => {
    const key = await createTestKey("ES256", "k1");
    const gateway = await gatewayTrusting(await startKeyServer(key));

    const health = await fetch(`${gateway.baseUrl}/v1/healthz`);
    const issuer = await gateway.env.cli(["config", "get", "http.proxyAuth.issuer"]);

    expect(health.status).toBe(200);
    expect(issuer.code, issuer.stderr).toBe(0);
    expect(issuer.stdout.trim()).toBe(JSON.stringify(ISSUER));
  });
});
