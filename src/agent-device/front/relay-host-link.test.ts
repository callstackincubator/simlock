import { describe, expect, it, vi } from "vitest";

import type { TokenIdentity } from "../../http/token-store.js";
import { FakeClock } from "../../ports/index.js";
import {
  RelayHostLink,
  type FleetPort,
  type FleetWorker,
  type PlacedLease,
} from "./relay-host-link.js";

const agent: TokenIdentity = { requesterId: "tok_a", role: "agent" };
const worker: FleetWorker = { id: "w1", leaseMaxTtlMs: 1_000, platforms: ["ios"] };
const maxTtlMs = 120_000;

function setUp() {
  const clock = new FakeClock(1_000);
  const index = new Map<string, PlacedLease>();
  let removed: ((lease: PlacedLease & { readonly leaseId: string }) => void) | undefined;
  const relay = vi.fn((_worker: string, _request: Request, _tenant: string, _lease?: string) =>
    Promise.resolve(new Response("relayed")),
  );
  const fleet: FleetPort = {
    capableWorkers: () => [worker],
    holder: () => worker,
    instanceId: "gw1",
    leaseOf: (leaseId) => index.get(leaseId),
    onLeaseRemoved: (listener) => {
      removed = listener;
    },
    relay,
  };
  const link = new RelayHostLink({ clock, fleet, leaseMaxTtlMs: maxTtlMs });
  const drop = (leaseId: string) => {
    const lease = index.get(leaseId);
    if (lease === undefined) throw new Error("no such lease");
    index.delete(leaseId);
    removed?.({ ...lease, leaseId });
  };
  return { clock, drop, index, link, relay };
}

function request(path = "/rpc"): Request {
  return new Request(`http://gateway.test/v1/agent-device${path}`, {
    body: JSON.stringify({ id: 7, jsonrpc: "2.0", method: "agent_device.command", params: {} }),
    method: "POST",
  });
}

describe("RelayHostLink", () => {
  it.each([
    { principal: "tok.a b/é:x", row: "characters agent-device refuses" },
    { principal: "t".repeat(300), row: "a 300 character ID" },
    { principal: "tok_a", row: "an underscore" },
  ])(
    "sends agent-device a tenant of 1 to 128 letters, digits, dots, underscores and hyphens for a token with $row, and relays it",
    async ({ principal }) => {
      const { index, link, relay } = setUp();
      index.set("L", { ownerId: principal, workerId: "w1" });

      await link.forward(request(), { requesterId: principal, role: "agent" }, "L");

      expect(relay).toHaveBeenCalledTimes(1);
      expect(relay.mock.calls[0]?.[2]).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    },
  );

  it("sends agent-device different tenants for different tokens, even when they differ only in characters it refuses or past the 128th", async () => {
    const { index, link, relay } = setUp();
    const principals = ["a b", "a_b", "a.b", "a:b", "t".repeat(300), `${"t".repeat(299)}u`];
    for (const principal of principals) {
      index.set("L", { ownerId: principal, workerId: "w1" });
      await link.forward(request(), { requesterId: principal, role: "agent" }, "L");
    }

    const tenants = relay.mock.calls.map((call) => call[2]);
    expect(new Set(tenants).size).toBe(principals.length);
  });

  it("relays a lease the token holds to its worker under the tenant `gw.<gateway instance id>.<principal>`", async () => {
    const { index, link, relay } = setUp();
    index.set("L", { ownerId: "tok_a", workerId: "w1" });

    await link.forward(request(), agent, "L");

    expect(relay).toHaveBeenCalledWith("w1", expect.any(Request), "gw.gw1.tok_5f_a", "L");
  });

  it("answers the flat refusal shape for a request that is not an rpc call", async () => {
    const { link } = setUp();

    const answer = await link.forward(request("/upload/preflight"), agent);

    expect(await answer.json()).toEqual({
      code: "INVALID_ARGS",
      error: "refused: this agent-device is too old to use through a gateway; update it",
      ok: false,
    });
  });

  it("refuses a bare GET that is not /health, and relays nothing", async () => {
    const { link, relay } = setUp();

    const answer = await link.forward(
      new Request("http://gateway.test/v1/agent-device/artifacts/a1"),
      agent,
    );

    expect(await answer.json()).toEqual({
      code: "INVALID_ARGS",
      error: "refused: this agent-device is too old to use through a gateway; update it",
      ok: false,
    });
    expect(relay).not.toHaveBeenCalled();
  });

  it("answers a body that is not JSON under a null id", async () => {
    const { link } = setUp();
    const broken = new Request("http://gateway.test/v1/agent-device/rpc", {
      body: "not json",
      method: "POST",
    });

    const answer = await link.forward(broken, agent);

    expect(await answer.json()).toMatchObject({ id: null });
  });

  it("fails a health probe when no capable worker is left between the status and the forward", async () => {
    const { link } = setUp();
    const none = new RelayHostLink({
      clock: new FakeClock(0),
      fleet: {
        capableWorkers: () => [],
        holder: () => undefined,
        instanceId: "gw1",
        leaseOf: () => undefined,
        onLeaseRemoved: () => undefined,
        relay: () => Promise.reject(new Error("never")),
      },
      leaseMaxTtlMs: maxTtlMs,
    });

    await expect(
      none.forward(new Request("http://gateway.test/v1/agent-device/health"), agent),
    ).rejects.toThrow("no worker connected to this gateway can serve agent-device");
    expect((await link.status()).state).toBe("running");
  });

  it("reports the holder's ceiling only for a lease it can place and the token owns", async () => {
    const { index, link } = setUp();
    index.set("L", { ownerId: "tok_a", workerId: "w1" });

    expect(await link.status("L", agent)).toMatchObject({ leaseMaxTtlMs: 86_400_000 });
    expect(await link.status("L", { ...agent, requesterId: "tok_b" })).not.toHaveProperty(
      "leaseMaxTtlMs",
    );
    expect(await link.status()).not.toHaveProperty("leaseMaxTtlMs");
  });

  it("keeps routing a lease the index dropped until the gateway's lease.maxTtlMs has passed, then forgets it, and its sweep stops with nothing kept", async () => {
    const { clock, drop, index, link, relay } = setUp();
    index.set("L", { ownerId: "tok_a", workerId: "w1" });
    drop("L");
    expect(clock.pendingTimerCount).toBe(1);

    clock.advance(maxTtlMs);
    await link.forward(request(), agent, "L");
    expect(relay).toHaveBeenCalledTimes(1);

    clock.advance(60_000);
    expect(clock.pendingTimerCount).toBe(0);
    const answer = await link.forward(request(), agent, "L");
    expect(answer.status).toBe(403);
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it("cancels its sweep when disposed", () => {
    const { clock, drop, index, link } = setUp();
    index.set("L", { ownerId: "tok_a", workerId: "w1" });
    drop("L");

    link.dispose();

    expect(clock.pendingTimerCount).toBe(0);
  });
});
