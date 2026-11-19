import { describe, expect, it } from "vitest";
import { FakeAgentDevice } from "./testing.js";
import { track } from "./test-edge.js";
import { scope, type Envelope, sleep, hex } from "./test-support.js";

describe("FakeAgentDevice as agent-device behaves", () => {
  const udid = "00000000-0000-0000-0000-000000000001";

  function call(
    fake: FakeAgentDevice,
    method: string,
    params: Record<string, unknown>,
    tenant: string | null = "tok_a",
  ): Promise<Response> {
    return fake.fetch(
      new Request(`${fake.baseUrl}/rpc`, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        headers: {
          authorization: `Bearer ${fake.token}`,
          "content-type": "application/json",
          ...(tenant === null ? {} : { "x-agent-device-tenant": tenant }),
        },
        method: "POST",
      }),
    );
  }

  const allocation = (n: number, extra: Record<string, unknown> = {}) => ({
    ...scope,
    deviceKey: "key-1",
    leaseId: hex(n),
    platform: "ios",
    udid,
    ...extra,
  });

  it("refuses a release missing the tenant, the run ID, the lease provider, the client ID or the device key with LEASE_SCOPE_REQUIRED, and one with a different client ID with LEASE_SCOPE_MISMATCH, as agent-device does", async () => {
    const fake = new FakeAgentDevice();
    await call(fake, "agent_device.lease.allocate", allocation(1));
    const full = { ...allocation(1), tenantId: "tok_a" };
    delete (full as Record<string, unknown>)["platform"];
    delete (full as Record<string, unknown>)["udid"];

    const accepted = (await (
      await call(fake, "agent_device.lease.release", full)
    ).json()) as Envelope;
    expect(accepted.result).toMatchObject({ released: true });
    await call(fake, "agent_device.lease.allocate", allocation(1));

    const reasonOf = async (params: Record<string, unknown>, tenant: string | null = "tok_a") => {
      const answer = (await (
        await call(fake, "agent_device.lease.release", params, tenant)
      ).json()) as {
        readonly error?: { readonly data?: { readonly details?: { readonly reason?: string } } };
      };
      return answer.error?.data?.details?.reason;
    };
    const { tenantId: _tenantId, ...untenanted } = full;
    expect(await reasonOf(untenanted, null)).toBe("LEASE_SCOPE_REQUIRED");
    for (const missing of ["runId", "leaseProvider", "clientId", "deviceKey"]) {
      const partial = { ...full } as Record<string, unknown>;
      delete partial[missing];
      expect(await reasonOf(partial), missing).toBe("LEASE_SCOPE_REQUIRED");
    }
    expect(await reasonOf({ ...full, clientId: "client-2" })).toBe("LEASE_SCOPE_MISMATCH");
  });

  it("answers an allocate for a device a live lease holds with DEVICE_IN_USE, and a release of a lease with a held command only after the command is let go", async () => {
    const fake = new FakeAgentDevice();
    const codeOf = async (response: Response) =>
      ((await response.json()) as Envelope).error?.data?.code;
    expect(
      await codeOf(await call(fake, "agent_device.lease.allocate", allocation(1))),
    ).toBeUndefined();
    expect(
      await codeOf(
        await call(fake, "agent_device.lease.allocate", allocation(2, { udid: "other-device" })),
      ),
    ).toBeUndefined();

    expect(await codeOf(await call(fake, "agent_device.lease.allocate", allocation(3)))).toBe(
      "DEVICE_IN_USE",
    );

    fake.holdCommand();
    const running = track(
      call(fake, "agent_device.command", { command: "snapshot", meta: { leaseId: hex(1) } }),
    );
    await sleep(20);
    const full = { ...allocation(1), tenantId: "tok_a" };
    const releasing = track(call(fake, "agent_device.lease.release", full));
    await sleep(50);

    expect(releasing.done()).toBe(false);
    expect(await codeOf(await call(fake, "agent_device.lease.allocate", allocation(3)))).toBe(
      "DEVICE_IN_USE",
    );
    fake.releaseCommand();
    await running.promise;
    expect(((await (await releasing.promise).json()) as Envelope).result).toMatchObject({
      released: true,
    });
    expect(
      await codeOf(await call(fake, "agent_device.lease.allocate", allocation(3))),
    ).toBeUndefined();
  });
});
