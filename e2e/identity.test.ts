import { describe, expect, it } from "vitest";

import { waitFor, withHttpDaemon, type TestEnv } from "./helpers/index.js";

interface HttpDaemon {
  readonly env: TestEnv;
  readonly baseUrl: string;
}

async function httpDaemon(mode: "worker" | "gateway"): Promise<HttpDaemon> {
  const { env, port } = await withHttpDaemon((port) => {
    const http = { enabled: true, host: "127.0.0.1", port };
    return mode === "gateway"
      ? { agentId: "claude-1", configOverrides: { http, mode: "gateway" }, driver: "none" }
      : { agentId: "claude-1", configOverrides: { http } };
  });
  const baseUrl = `http://127.0.0.1:${port}`;
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

async function mint(
  env: TestEnv,
  role: string,
  label?: string,
): Promise<{ readonly secret: string; readonly token: { readonly id: string } }> {
  const minted = await env.cli([
    "token",
    "create",
    "--role",
    role,
    ...(label === undefined ? [] : ["--label", label]),
  ]);
  expect(minted.code, minted.stderr).toBe(0);
  return minted.json as { secret: string; token: { id: string } };
}

function getIdentity(daemon: HttpDaemon, secret: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}/v1/identity`, { headers: { authorization: `Bearer ${secret}` } });
}

describe("identity.get", () => {
  it("simlock whoami prints the four labelled lines for the CLI's own session, and --json prints the same as one object, on a worker and on a gateway", async () => {
    for (const mode of ["worker", "gateway"] as const) {
      const { env } = await httpDaemon(mode);

      const text = await env.cli(["whoami"]);
      expect(text.code, `${mode}: ${text.stderr}`).toBe(0);
      expect(text.stdout.trimEnd().split("\n"), mode).toEqual([
        "Principal: claude-1",
        "Name:      claude-1",
        "Role:      admin",
        "Via:       socket",
      ]);

      const json = await env.cli(["whoami", "--json"]);
      expect(json.code, `${mode}: ${json.stderr}`).toBe(0);
      expect(json.json, mode).toEqual({
        name: "claude-1",
        principal: "claude-1",
        role: "admin",
        via: "socket",
      });
    }
  });

  it("GET /v1/identity with a minted agent token answers that token's id, its label and role agent, and a worker token is refused with 403, on a worker and on a gateway", async () => {
    for (const mode of ["worker", "gateway"] as const) {
      const daemon = await httpDaemon(mode);
      const agent = await mint(daemon.env, "agent", "ci-runner");
      const worker = await mint(daemon.env, "worker", "join");

      const answered = await getIdentity(daemon, agent.secret);
      expect(answered.status, mode).toBe(200);
      expect(await answered.json(), mode).toEqual({
        name: "ci-runner",
        principal: agent.token.id,
        role: "agent",
        via: "token",
      });

      const refused = await getIdentity(daemon, worker.secret);
      expect(refused.status, mode).toBe(403);
    }
  });
});
