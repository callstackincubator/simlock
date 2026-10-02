import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

/**
 * `GET /v1/tokens` answers `token.list` over HTTP, so the console can name a lease's holder by
 * its token's label. A real daemon and a real `tokens.json`, so what is proven is what reaches
 * the wire, not what a handler returns before the contract's output schema has had its say.
 */

interface TokenRecord {
  readonly id: string;
  readonly role: string;
  readonly label?: string;
  readonly createdAt: number;
}

interface Minted {
  readonly secret: string;
  readonly token: TokenRecord;
}

interface HttpDaemon {
  readonly env: TestEnv;
  readonly baseUrl: string;
}

/** A daemon in `mode` with HTTP on, once its listener answers. */
async function httpDaemon(mode: "worker" | "gateway"): Promise<HttpDaemon> {
  const port = await freeLoopbackPort();
  const http = { enabled: true, host: "127.0.0.1", port };
  const env = await withDaemon(
    mode === "gateway"
      ? { configOverrides: { http, mode: "gateway" }, driver: "none" }
      : { configOverrides: { http } },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  // Any CLI call starts the daemon; the listener comes up with it.
  expect((await env.cli(["status", "--json"])).code).toBe(0);
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
  return { baseUrl, env };
}

async function mint(env: TestEnv, role: string, label?: string): Promise<Minted> {
  const minted = await env.cli([
    "token",
    "create",
    "--role",
    role,
    ...(label === undefined ? [] : ["--label", label]),
  ]);
  expect(minted.code, minted.stderr).toBe(0);
  return minted.json as Minted;
}

function getTokens(daemon: HttpDaemon, secret: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}/v1/tokens`, { headers: { authorization: `Bearer ${secret}` } });
}

describe("GET /v1/tokens", () => {
  it("GET /v1/tokens answers every token's id, role, label and createdAt for an operator", async () => {
    const daemon = await httpDaemon("worker");
    const operator = await mint(daemon.env, "operator", "console");
    const agent = await mint(daemon.env, "agent", "ci-runner-3");
    const unlabelled = await mint(daemon.env, "agent");
    const worker = await mint(daemon.env, "worker", "join");

    const response = await getTokens(daemon, operator.secret);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tokens: TokenRecord[] };
    expect(body.tokens).toHaveLength(4);
    expect(body.tokens).toEqual(
      expect.arrayContaining([operator.token, agent.token, unlabelled.token, worker.token]),
    );
    // The records `token create` printed, and nothing beside them.
    expect(agent.token).toEqual({
      createdAt: expect.any(Number),
      id: expect.stringMatching(/^tok_/),
      label: "ci-runner-3",
      role: "agent",
    });
    expect(unlabelled.token).not.toHaveProperty("label");
  });

  it("GET /v1/tokens never answers a secret or a hash", async () => {
    const daemon = await httpDaemon("worker");
    const operator = await mint(daemon.env, "operator");
    const agent = await mint(daemon.env, "agent", "ci-runner-3");
    const stored = JSON.parse(await readFile(join(daemon.env.home, "tokens.json"), "utf8")) as {
      hash: string;
    }[];
    expect(stored).toHaveLength(2);

    const response = await getTokens(daemon, operator.secret);

    expect(response.status).toBe(200);
    const raw = await response.text();
    for (const secret of [operator.secret, agent.secret]) expect(raw).not.toContain(secret);
    for (const { hash } of stored) expect(raw).not.toContain(hash);
    const { tokens } = JSON.parse(raw) as { tokens: Record<string, unknown>[] };
    expect(tokens).toHaveLength(2);
    for (const token of tokens) {
      for (const key of Object.keys(token)) {
        expect(["createdAt", "id", "label", "role"]).toContain(key);
      }
    }
  });

  it("GET /v1/tokens answers 403 for an agent token", async () => {
    const daemon = await httpDaemon("worker");
    const agent = await mint(daemon.env, "agent", "ci-runner-3");

    const response = await getTokens(daemon, agent.secret);

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("GET /v1/tokens works on a gateway and on a worker", async () => {
    for (const mode of ["gateway", "worker"] as const) {
      const daemon = await httpDaemon(mode);
      const operator = await mint(daemon.env, "operator");
      const agent = await mint(daemon.env, "agent", `${mode}-agent`);

      const response = await getTokens(daemon, operator.secret);

      expect(response.status, mode).toBe(200);
      const body = (await response.json()) as { tokens: TokenRecord[] };
      expect(body.tokens, mode).toEqual(expect.arrayContaining([operator.token, agent.token]));
      expect(body.tokens, mode).toHaveLength(2);
    }
  });
});
