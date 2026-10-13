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
  it("refuses a token whose tenant would pass the relay's 300 characters, and relays nothing", async () => {
    const { index, link, relay } = setUp();
    index.set("L", { ownerId: "t".repeat(300), workerId: "w1" });
    const long: TokenIdentity = { requesterId: "t".repeat(300), role: "agent" };

    const answer = await link.forward(request(), long, "L");

    expect(await answer.json()).toMatchObject({
      error: { message: "refused: this token cannot be used through a gateway" },
      id: 7,
    });
    expect(relay).not.toHaveBeenCalled();
  });

  it("relays a lease the token holds to its worker under the prefixed tenant", async () => {
    const { index, link, relay } = setUp();
    index.set("L", { ownerId: "tok_a", workerId: "w1" });

    await link.forward(request(), agent, "L");

    expect(relay).toHaveBeenCalledWith("w1", expect.any(Request), "gw:gw1:tok_a", "L");
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
