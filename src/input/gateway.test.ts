import { describe, expect, it, vi } from "vitest";

import type { GatewayModule, ModuleLease } from "../modules/index.js";
import { fakeGatewayContext } from "../modules/testing.js";
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
  return { clock: fake.clock, socket: gateway.socket };
}

describe("a gateway's input socket", () => {
  it("answers 503 WORKER_UNREACHABLE when the worker gives no head in 10 s", async () => {
    const { clock, socket } = await gatewayWith({ relayTwoWay: silentRelay });
    let outcome: unknown;
    void socket.open(new Request("http://simlock/input"), IDENTITY, LEASE).then((answer) => {
      outcome = answer;
    });

    clock.advance(9_999);
    await Promise.resolve();
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
});
