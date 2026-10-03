import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

/**
 * A worker answers the fleet operations as a fleet of one: `worker list` and `GET /v1/workers`
 * show the host itself, and the operations that act on a gateway's workers refuse with
 * `UNSUPPORTED_IN_WORKER_MODE` rather than `UNKNOWN_REQUEST` or `404`.
 */

/** The id this host presents to a gateway, as its own `instance.json` stores it. */
async function instanceId(env: TestEnv): Promise<string> {
  const stored = JSON.parse(await readFile(join(env.home, "instance.json"), "utf8")) as {
    instanceId: string;
  };
  return stored.instanceId;
}

interface HttpHost {
  readonly env: TestEnv;
  readonly baseUrl: string;
  readonly operatorAuth: { readonly authorization: string };
  readonly agentAuth: { readonly authorization: string };
}

/** A single host with HTTP on, an operator token and an agent token, once it answers. */
async function httpHost(): Promise<HttpHost> {
  const port = await freeLoopbackPort();
  const env = await withDaemon({
    configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const bearer = async (role: string) => {
    const minted = await env.cli(["token", "create", "--role", role]);
    expect(minted.code).toBe(0);
    return { authorization: `Bearer ${(minted.json as { secret: string }).secret}` };
  };
  const operatorAuth = await bearer("operator");
  const agentAuth = await bearer("agent");
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
  return { agentAuth, baseUrl, env, operatorAuth };
}

describe("a single host as a fleet of one", () => {
  it("simlock worker list against a worker prints that worker", async () => {
    const env = await withDaemon({ configOverrides: { gateway: { label: "mac-mini-1" } } });
    const id = await instanceId(env);

    const text = await env.cli(["worker", "list"]);
    const json = await env.cli(["worker", "list", "--json"]);

    expect(text.code).toBe(0);
    const lines = text.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^${id} \\(mac-mini-1\\): connected -- `));
    expect(json.code).toBe(0);
    expect(json.json).toMatchObject({
      workers: [{ connection: "connected", drained: false, id, label: "mac-mini-1" }],
    });
  });

  it("simlock worker drain against a worker exits 2 with UNSUPPORTED_IN_WORKER_MODE", async () => {
    const env = await withDaemon();
    const id = await instanceId(env);

    const result = await env.cli(["worker", "drain", id]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.error?.code).toBe("UNSUPPORTED_IN_WORKER_MODE");
  });

  it("GET /v1/workers on a worker answers 200 with one worker for an operator token", async () => {
    const host = await httpHost();
    const id = await instanceId(host.env);
    const status = (await host.env.cli(["status", "--json"])).json as {
      capacity: unknown;
      host: unknown;
    };

    const response = await fetch(`${host.baseUrl}/v1/workers`, { headers: host.operatorAuth });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { workers: Record<string, unknown>[] };
    expect(body.workers).toHaveLength(1);
    expect(body.workers[0]).toMatchObject({
      capacity: status.capacity,
      connection: "connected",
      drained: false,
      host: status.host,
      id,
    });
  });

  it("GET /v1/workers on a worker answers 403 for an agent token", async () => {
    const host = await httpHost();

    const response = await fetch(`${host.baseUrl}/v1/workers`, { headers: host.agentAuth });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("POST /v1/workers/{id}/drain on a worker answers 501 UNSUPPORTED_IN_WORKER_MODE", async () => {
    const host = await httpHost();
    const id = await instanceId(host.env);

    const response = await fetch(`${host.baseUrl}/v1/workers/${id}/drain`, {
      headers: host.operatorAuth,
      method: "POST",
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: {
        code: "UNSUPPORTED_IN_WORKER_MODE",
        message: expect.any(String),
        operation: "worker.drain",
      },
    });
  });

  it("POST /v1/components/install with workers on a worker answers 501", async () => {
    const host = await httpHost();
    await host.env.driverLog.clear();

    const response = await fetch(`${host.baseUrl}/v1/components/install`, {
      body: JSON.stringify({ platform: "ios", version: "26.0", workers: "all" }),
      headers: { ...host.operatorAuth, "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: { code: "UNSUPPORTED_IN_WORKER_MODE", operation: "worker.install-component" },
    });
    const calls = await host.env.driverLog.calls();
    expect(calls.some((call) => call.operation === "installComponent")).toBe(false);
  });
});
