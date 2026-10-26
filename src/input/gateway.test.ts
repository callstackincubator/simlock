import { describe, expect, it, vi } from "vitest";

import type { GatewayModule, ModuleLease, ModuleLeaseSocketAccept } from "../modules/index.js";
import { fakeGatewayContext } from "../modules/testing.js";
import { MemoryLeaseSocket } from "../ports/index.js";
import { inputModule } from "./index.js";

const IDENTITY = { principal: "tok_holder", role: "agent" } as const;
const LEASE: ModuleLease = {
  deviceId: "dev_1",
  id: "L-42",
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
  const fake = await fakeGatewayContext("input", {}, facts);
  const loaded = await inputModule.loadGateway?.();
  const gateway: GatewayModule | undefined = loaded?.createGateway(fake.ctx);
  if (gateway?.socket === undefined) throw new Error("the input module has no gateway socket");
  return { clock: fake.clock, gateway, removeLease: fake.removeLease, socket: gateway.socket };
}

const REMOVED = {
  gatewayLeaseId: "L-42",
  grantedAt: 0,
  ownerId: "tok_holder",
  requesterId: "gw:gw-test:tok_holder",
  workerId: "w1",
  workerLeaseId: "L-7",
};

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

async function attached(workerId: string, options: { readonly leaseWorker?: string } = {}) {
  const pair = relayPair();
  const built = await gatewayWith({ relayTwoWay: () => Promise.resolve(pair.relay) });
  const accept = await built.socket.open(new Request("http://simlock/input"), IDENTITY, {
    ...LEASE,
    workerId: options.leaseWorker ?? workerId,
  });
  if (typeof accept !== "function") throw new Error("the socket was refused");
  const client = new MemoryLeaseSocket();
  (accept as ModuleLeaseSocketAccept)(client);
  return { ...built, client, worker: pair.worker };
}

describe("a gateway's input socket", () => {
  it("answers 503 WORKER_UNREACHABLE when the worker gives no head in 10 s", async () => {
    const { clock, socket } = await gatewayWith({ relayTwoWay: silentRelay });
    let outcome: unknown;
    void socket.open(new Request("http://simlock/input"), IDENTITY, LEASE).then((answer) => {
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
        message: "Worker w1 did not answer the input socket within 10 s",
      },
    });
  });

  it("closes the client's socket when the worker relay ends or says something it may not, or the lease goes", async () => {
    const ended = await attached("w1");
    await ended.worker.close();
    await vi.waitFor(() =>
      expect(ended.client.closed).toEqual({ code: 1011, reason: "Worker w1 stopped answering" }),
    );

    for (const [code, reason] of [
      [1001, "Simlock is stopping"],
      [1000, "done"],
      [5000, "out of range"],
    ] as const) {
      const closing = await attached("w1");
      await closing.worker.write(closeFrame(code, reason));
      await vi.waitFor(() =>
        expect(closing.client.closed).toEqual({
          code: 1011,
          reason: "Worker w1 stopped answering",
        }),
      );
    }

    const longId = "w".repeat(128);
    const long = await attached(longId);
    await long.worker.abort(new Error("the uplink dropped"));
    await vi.waitFor(() => expect(long.client.closed?.code).toBe(1011));
    expect(long.client.closed?.reason).toBe(`Worker ${"w".repeat(116)}`);

    const reasoned = await attached("w1");
    reasoned.removeLease(REMOVED);
    reasoned.clock.advance(1_999);
    expect(reasoned.client.closed).toBeUndefined();
    await reasoned.worker.write(closeFrame(4001, "expired"));
    await vi.waitFor(() =>
      expect(reasoned.client.closed).toEqual({ code: 4001, reason: "expired" }),
    );

    const silent = await attached("w1");
    silent.removeLease(REMOVED);
    silent.clock.advance(1_999);
    expect(silent.client.closed).toBeUndefined();
    silent.clock.advance(1);
    expect(silent.client.closed).toEqual({ code: 4001, reason: "lease ended" });
  });

  it("aborts the worker relay of a socket that never reaches the client", async () => {
    const pair = relayPair();
    let signal: AbortSignal | undefined;
    const { socket } = await gatewayWith({
      relayTwoWay: (request) => {
        signal = request.signal;
        return Promise.resolve(pair.relay);
      },
    });
    const accept = await socket.open(new Request("http://simlock/input"), IDENTITY, LEASE);
    if (typeof accept !== "function") throw new Error("the socket was refused");
    expect(signal?.aborted).toBe(false);

    accept.abandon?.();
    expect(signal?.aborted).toBe(true);
  });
});
