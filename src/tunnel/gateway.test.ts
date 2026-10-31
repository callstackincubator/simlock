import { describe, expect, it, vi } from "vitest";

import type { GatewayModule, ModuleLease, ModuleLeaseSocketAccept } from "../modules/index.js";
import { fakeGatewayContext } from "../modules/testing.js";
import { MemoryLeaseSocket } from "../ports/index.js";
import { tunnelModule } from "./index.js";

const IDENTITY = { principal: "tok_holder", role: "agent" } as const;
const LEASE: ModuleLease = {
  deviceId: "dev_1",
  id: "L-42",
  workerId: "w1",
  workerLeaseId: "L-7",
};

const REMOVED = {
  gatewayLeaseId: "L-42",
  grantedAt: 0,
  ownerId: "tok_holder",
  requesterId: "gw:gw-test:tok_holder",
  workerId: "w1",
  workerLeaseId: "L-7",
};

// why: a relay that answers nothing until the gateway gives up on it, as a worker that never sends a head does.
function silentRelay(request: Request): Promise<never> {
  return new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  });
}

async function gatewayWith(facts: Parameters<typeof fakeGatewayContext>[2]) {
  const fake = await fakeGatewayContext("tunnel", {}, facts);
  const loaded = await tunnelModule.loadGateway?.();
  const gateway: GatewayModule | undefined = loaded?.createGateway(fake.ctx);
  if (gateway?.socket === undefined) throw new Error("the tunnel module has no gateway socket");
  return { clock: fake.clock, removeLease: fake.removeLease, socket: gateway.socket };
}

// why: the worker's end of a relay: `toGateway` writes what the worker sends, and the gateway's own writes go nowhere.
function relayPair() {
  const toGateway = new TransformStream<Uint8Array, Uint8Array>();
  const fromGateway = new TransformStream<Uint8Array, Uint8Array>();
  return {
    relay: {
      headers: new Headers(),
      readable: toGateway.readable,
      status: 200,
      writable: fromGateway.writable,
    },
    worker: toGateway.writable.getWriter(),
  };
}

// why: the worker's close frame written out by hand (`[len u32][0xF1][json]`), so the test does not read it with the code it tests.
function closeFrame(code: number, reason: string): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ code, reason }));
  return Uint8Array.from([0, 0, (json.length + 1) >> 8, (json.length + 1) & 0xff, 0xf1, ...json]);
}

async function attached() {
  const pair = relayPair();
  const built = await gatewayWith({ relayTwoWay: () => Promise.resolve(pair.relay) });
  const accept = await built.socket.open(new Request("http://simlock/tunnel"), IDENTITY, LEASE);
  if (typeof accept !== "function") throw new Error("the socket was refused");
  const client = new MemoryLeaseSocket();
  (accept as ModuleLeaseSocketAccept)(client);
  return { ...built, client, worker: pair.worker };
}

describe("a gateway's tunnel bridge", () => {
  it("bounds every wait on the worker: no head in 10 s, a relay that ends, a lease removed with no worker close in 2 s", async () => {
    const { clock, socket } = await gatewayWith({ relayTwoWay: silentRelay });
    let outcome: unknown;
    void socket.open(new Request("http://simlock/tunnel"), IDENTITY, LEASE).then((answer) => {
      outcome = answer;
    });
    clock.advance(9_999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outcome).toBeUndefined();
    clock.advance(1);
    await vi.waitFor(() => expect(outcome).toBeInstanceOf(Response));
    const refusal = outcome as Response;
    expect(refusal.status).toBe(503);
    expect(await refusal.json()).toEqual({
      error: {
        code: "WORKER_UNREACHABLE",
        message: "Worker w1 did not answer the tunnel socket within 10 s",
      },
    });

    const ended = await attached();
    await ended.worker.close();
    await vi.waitFor(() =>
      expect(ended.client.closed).toEqual({ code: 1011, reason: "Worker w1 stopped answering" }),
    );

    const reasoned = await attached();
    reasoned.removeLease(REMOVED);
    reasoned.clock.advance(1_999);
    expect(reasoned.client.closed).toBeUndefined();
    await reasoned.worker.write(closeFrame(4001, "expired"));
    await vi.waitFor(() =>
      expect(reasoned.client.closed).toEqual({ code: 4001, reason: "expired" }),
    );

    const silent = await attached();
    silent.removeLease(REMOVED);
    silent.clock.advance(1_999);
    expect(silent.client.closed).toBeUndefined();
    silent.clock.advance(1);
    expect(silent.client.closed).toEqual({ code: 4001, reason: "lease ended" });
  });
});
