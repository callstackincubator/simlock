import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

/**
 * Reserves a free TCP port by binding to port 0 and releasing it immediately. Config
 * validation rejects `http.port: 0` (it requires 1-65535, see `docs/CONFIGURATION.md`),
 * so the daemon itself can't pick its own ephemeral port -- this is the test's own
 * stand-in for that. There is a small window between release and the daemon binding
 * the same port, same as any "reserve a port for a subprocess" approach; nothing else
 * on this machine is expected to be racing for it during a test run.
 */
async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (address === null || typeof address === "string") {
          reject(new Error("failed to reserve a port: no AddressInfo"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

interface RequestResource {
  readonly id: string;
  readonly state: string;
  readonly createdAt: string;
  readonly lease?: LeasePayload;
  readonly error?: { readonly code: string; readonly message: string };
}

interface LeasePayload {
  readonly id: string;
  readonly requestId?: string;
  readonly platform: string;
  readonly device: string;
  readonly os: string;
  readonly udid: string;
  readonly deviceId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ttlMs: number;
  readonly dataPlane: null;
}

describe("HTTP API", () => {
  it("token create -> healthz -> catalog -> lease-request -> granted -> renew -> release, with auth enforced throughout", async () => {
    const port = await reservePort();
    const env = await withDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Mint an agent token via the CLI, against the same SIMLOCK_HOME the daemon reads
    //    tokens.json from -- no daemon round-trip for `token create` (see src/cli/index.ts).
    const tokenResult = await env.cli(["token", "create", "--role", "agent"]);
    expect(tokenResult.code).toBe(0);
    const { secret } = tokenResult.json as { secret: string };
    const agentAuth = { authorization: `Bearer ${secret}` };

    // 2. The gateway is started only after the daemon's own startup convergence
    //    finishes (see the comment in src/daemon/main.ts), strictly after the unix
    //    socket already answers `daemon start` -- so the first HTTP call must tolerate
    //    a connection refused for a brief window rather than assume the port is live
    //    the instant `withDaemon()` returns.
    await waitFor(
      async () => {
        try {
          const response = await fetch(`${baseUrl}/v1/healthz`);
          return response.ok;
        } catch {
          return false;
        }
      },
      { label: "HTTP gateway accepting connections" },
    );
    const healthz = await fetch(`${baseUrl}/v1/healthz`);
    expect(healthz.status).toBe(200);
    expect(await healthz.json()).toEqual({ ok: true });

    // 3. `GET /v1/catalog` requires auth; unauthenticated and wrong-token requests
    //    both come back 401 UNAUTHENTICATED.
    const catalogNoAuth = await fetch(`${baseUrl}/v1/catalog`);
    expect(catalogNoAuth.status).toBe(401);
    expect(((await catalogNoAuth.json()) as { error: { code: string } }).error.code).toBe(
      "UNAUTHENTICATED",
    );

    const catalogWrongToken = await fetch(`${baseUrl}/v1/catalog`, {
      headers: { authorization: "Bearer slk_not-a-real-token" },
    });
    expect(catalogWrongToken.status).toBe(401);
    expect(((await catalogWrongToken.json()) as { error: { code: string } }).error.code).toBe(
      "UNAUTHENTICATED",
    );

    const catalog = await fetch(`${baseUrl}/v1/catalog`, { headers: agentAuth });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      platforms: expect.arrayContaining([
        expect.objectContaining({ platform: "ios", models: ["iPhone 16"], defaultRuntime: "18.4" }),
      ]),
    });

    // 4. An operator-only route rejects an agent token with 403, not 401 -- the token
    //    is valid, it just doesn't carry the role this route requires.
    const operatorRouteAsAgent = await fetch(`${baseUrl}/v1/leases`, { headers: agentAuth });
    expect(operatorRouteAsAgent.status).toBe(403);
    expect(((await operatorRouteAsAgent.json()) as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN",
    );

    // 5. `POST /v1/lease-requests` enqueues a request resource; poll it (via the `wait`
    //    long-poll param) until it reaches its terminal `granted` state.
    const created = await fetch(`${baseUrl}/v1/lease-requests`, {
      method: "POST",
      headers: { ...agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ platform: "ios", device: "iPhone 16", os: "18.4" }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toMatch(/^\/v1\/lease-requests\/req_/);
    const createdBody = (await created.json()) as { request: RequestResource };
    const requestId = createdBody.request.id;

    let polled = createdBody.request;
    while (
      polled.state !== "granted" &&
      polled.state !== "failed" &&
      polled.state !== "cancelled"
    ) {
      const response = await fetch(`${baseUrl}/v1/lease-requests/${requestId}?wait=10`, {
        headers: agentAuth,
      });
      expect(response.status).toBe(200);
      polled = ((await response.json()) as { request: RequestResource }).request;
    }
    expect(polled.state, `lease request ${requestId} did not reach granted`).toBe("granted");
    const lease = polled.lease as LeasePayload;
    expect(lease).toMatchObject({
      platform: "ios",
      device: "iPhone 16",
      os: "18.4",
      requestId,
      dataPlane: null,
    });

    // 6. A second lease request from the same requester (same token) while the first
    //    is still held is rejected -- 409, naming the existing lease id -- rather than
    //    queueing a second device for one agent.
    const secondRequest = await fetch(`${baseUrl}/v1/lease-requests`, {
      method: "POST",
      headers: { ...agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ platform: "ios", device: "iPhone 16", os: "18.4" }),
    });
    expect(secondRequest.status).toBe(409);
    const secondRequestError = (await secondRequest.json()) as {
      error: { code: string; existingLeaseId?: string };
    };
    expect(secondRequestError.error.code).toBe("REQUESTER_ALREADY_LEASED");
    expect(secondRequestError.error.existingLeaseId).toBe(lease.id);

    // 7. Renew resets the deadline; the fetched lease also survives a `GET` re-fetch.
    const refetched = await fetch(`${baseUrl}/v1/leases/${lease.id}`, { headers: agentAuth });
    expect(refetched.status).toBe(200);
    expect(((await refetched.json()) as { lease: LeasePayload }).lease.id).toBe(lease.id);

    const renewed = await fetch(`${baseUrl}/v1/leases/${lease.id}/renew`, {
      method: "POST",
      headers: { ...agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ ttlMs: 120_000 }),
    });
    expect(renewed.status).toBe(200);
    const renewedBody = (await renewed.json()) as {
      leaseId: string;
      expiresAt: string;
      notices: unknown[];
    };
    expect(renewedBody).toMatchObject({ leaseId: lease.id, notices: [] });
    expect(renewedBody.expiresAt).not.toBe(lease.expiresAt);

    // 8. Release: 202, purge continues in the background (existing release semantics).
    const released = await fetch(`${baseUrl}/v1/leases/${lease.id}`, {
      method: "DELETE",
      headers: agentAuth,
    });
    expect(released.status).toBe(202);
    expect(await released.json()).toMatchObject({ released: true, device: { id: lease.deviceId } });

    const afterRelease = await fetch(`${baseUrl}/v1/leases/${lease.id}`, { headers: agentAuth });
    expect(afterRelease.status).toBe(404);
  });
});
