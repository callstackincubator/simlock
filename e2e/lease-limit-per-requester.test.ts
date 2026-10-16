import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon } from "./helpers/index.js";
import type { TestEnv } from "./helpers/index.js";

const LEASE_ARGS = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;
const ROOM = { limits: { maxRunning: 4, ios: { maxDevices: 4, maxRunning: 4 } } };

async function startWith(maxPerRequester?: number, extra: Record<string, unknown> = {}) {
  const env = await withDaemon({
    configOverrides: {
      ...ROOM,
      ...(maxPerRequester === undefined ? {} : { lease: { maxPerRequester } }),
      ...extra,
    },
  });
  await env.driverScript.set({
    ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
  });
  return env;
}

async function leaseAs(
  env: TestEnv,
  agent: string,
): Promise<{ id: string; driverDeviceId: string }> {
  const result = await env.cli([...LEASE_ARGS, "--agent-id", agent, "--detach"]);
  expect(result.code, result.stderr).toBe(0);
  const grant = result.json as { lease: { id: string }; device: { driverDeviceId: string } };
  return { driverDeviceId: grant.device.driverDeviceId, id: grant.lease.id };
}

describe("a requester may hold up to lease.maxPerRequester leases", () => {
  it("simlock config get lease.maxPerRequester prints 1 when unset and the configured value when set", async () => {
    const unset = await startWith();
    const set = await startWith(3);

    const unsetValue = await unset.cli(["config", "get", "lease.maxPerRequester"]);
    const setValue = await set.cli(["config", "get", "lease.maxPerRequester"]);

    expect(unsetValue.code, unsetValue.stderr).toBe(0);
    expect(unsetValue.json).toBe(1);
    expect(setValue.json).toBe(3);
  });

  it("with lease.maxPerRequester 2, one agent id holds two leases and its third request is refused with exit 13, naming the limit and the earlier lease, and lease.rejected already-leased", async () => {
    const env = await startWith(2);

    const first = await leaseAs(env, "a");
    const second = await leaseAs(env, "a");
    const third = await env.cli([...LEASE_ARGS, "--agent-id", "a", "--detach"]);

    expect(second.id).not.toBe(first.id);
    expect(third.code).toBe(13);
    expect(third.error).toMatchObject({ code: "REQUESTER_ALREADY_LEASED" });
    expect(third.error?.message).toBe(
      `Requester a already holds 2 leases and lease.maxPerRequester is 2; release one (\`simlock release ${first.id}\`) before requesting another device`,
    );
    const rejected = (await env.events()).filter((event) => event.event === "lease.rejected");
    expect(rejected.map((event) => event.payload)).toMatchObject([{ reason: "already-leased" }]);
  });

  it("with the default limit, a second lease request of one agent id is refused with today's message", async () => {
    const env = await startWith();
    const first = await leaseAs(env, "a");

    const second = await env.cli([...LEASE_ARGS, "--agent-id", "a", "--detach"]);

    expect(second.code).toBe(13);
    expect(second.error?.message).toBe(
      `Requester a already holds lease ${first.id}; release it (\`simlock release ${first.id}\`) before requesting another device`,
    );
  });

  it("releasing one of two leases lets the agent id's next request through", async () => {
    const env = await startWith(2);
    const first = await leaseAs(env, "a");
    await leaseAs(env, "a");
    expect((await env.cli([...LEASE_ARGS, "--agent-id", "a", "--detach"])).code).toBe(13);

    const released = await env.cli(["release", first.id]);
    expect(released.code, released.stderr).toBe(0);

    await waitFor(
      async () => (await env.cli([...LEASE_ARGS, "--agent-id", "a", "--detach"])).code === 0,
      { label: "a's next request granted once a slot is free" },
    );
  });

  it("HTTP answers 409 REQUESTER_ALREADY_LEASED to the third lease request of one token at lease.maxPerRequester 2", async () => {
    const port = await freeLoopbackPort();
    const env = await startWith(2, { http: { enabled: true, host: "127.0.0.1", port } });
    const baseUrl = `http://127.0.0.1:${port}`;
    const minted = await env.cli(["token", "create", "--role", "agent"]);
    const headers = {
      authorization: `Bearer ${(minted.json as { secret: string }).secret}`,
      "content-type": "application/json",
    };
    await waitFor(
      async () => {
        try {
          return (await fetch(`${baseUrl}/v1/healthz`)).ok;
        } catch {
          return false;
        }
      },
      { label: "HTTP API accepting connections" },
    );
    const ask = () =>
      fetch(`${baseUrl}/v1/lease-requests`, {
        body: JSON.stringify({ device: "iPhone 16", os: "18.4", platform: "ios" }),
        headers,
        method: "POST",
      });
    const grant = async () => {
      const response = await ask();
      expect(response.status).toBeLessThan(300);
      const { request } = (await response.json()) as { request: { id: string } };
      await waitFor(
        async () => {
          const polled = await fetch(`${baseUrl}/v1/lease-requests/${request.id}`, { headers });
          const body = (await polled.json()) as { request: { state: string } };
          return body.request.state === "granted";
        },
        { label: `request ${request.id} granted` },
      );
    };

    await grant();
    await grant();
    const third = await ask();

    expect(third.status).toBe(409);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
      "REQUESTER_ALREADY_LEASED",
    );
  });

  it("after a restart with lease.maxPerRequester lowered from 3 to 1, an agent id's three running leases are all kept, and its next request is refused naming the earliest", async () => {
    const env = await startWith(3);
    const first = await leaseAs(env, "a");
    const second = await leaseAs(env, "a");
    const third = await leaseAs(env, "a");
    // why: a restart ends a lease whose device is not running (ADR 0019), and the fake driver forgets its devices.
    await env.driverScript.merge({
      ios: {
        managedReality: {
          devices: [first, second, third].map((lease) => ({
            deviceId: lease.driverDeviceId,
            runState: "running" as const,
          })),
        },
      },
    });

    await env.withConfig({ lease: { maxPerRequester: 1 } }, async () => {
      const leases = await env.cli(["list", "--leases"]);
      expect(leases.json as unknown[]).toHaveLength(3);
      const next = await env.cli([...LEASE_ARGS, "--agent-id", "a", "--detach"]);
      expect(next.code).toBe(13);
      expect(next.error?.message).toContain(first.id);
    });
  });
});
