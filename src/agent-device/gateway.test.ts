import { describe, expect, it } from "vitest";

import type { WorkerView } from "../modules/index.js";
import { fakeGatewayContext } from "../modules/testing.js";
import { agentDeviceModule } from "./definition.js";

const noWorker = "no worker connected to this gateway can serve agent-device";

function viewOf(overrides: Record<string, unknown> = {}): WorkerView {
  return {
    capabilities: [{ name: "agent-device", state: "available" }],
    catalog: [],
    catalogReadAt: 1_000,
    connection: "connected",
    drained: false,
    id: "w-1",
    label: "w1",
    lease: { maxTtlMs: 600_000 },
    ...overrides,
  } as unknown as WorkerView;
}

async function healthThroughGateway(served: readonly WorkerView[]) {
  const { ctx, relayed } = await fakeGatewayContext(
    "agent-device",
    agentDeviceModule.config.defaults,
    {
      relay: () => Response.json({ ok: true, service: "agent-device-proxy" }),
      serving: served,
    },
  );
  const loaded = await agentDeviceModule.loadGateway?.();
  const module = loaded?.createGateway(ctx);
  const handler = module?.mount?.({ dispatch: () => Promise.reject(new Error("unused")) });
  const answer = await handler?.(new Request("http://gateway.test/v1/agent-device/health"), {
    principal: "tok_one",
    role: "agent",
  });
  return { body: await answer?.text(), relayed };
}

describe("agent-device's gateway side", () => {
  it("a worker whose view has no lease.maxTtlMs is not served by agent-device's fleet port, while the same view with it is", async () => {
    const served = await healthThroughGateway([viewOf()]);
    expect(served.relayed.map((call) => call.workerId)).toEqual(["w-1"]);
    expect(served.body).toContain("agent-device-proxy");

    const unknown = await healthThroughGateway([viewOf({ lease: undefined })]);

    expect(unknown.relayed).toEqual([]);
    expect(unknown.body).toContain(noWorker);
  });

  it("a worker whose catalog is unread, and a drained one, are not relayed a bare health request, while the same worker read and not drained is", async () => {
    expect((await healthThroughGateway([viewOf()])).relayed).toHaveLength(1);

    const unread = await healthThroughGateway([viewOf({ catalogReadAt: undefined })]);
    const drained = await healthThroughGateway([viewOf({ drained: true })]);

    expect([unread.relayed, drained.relayed]).toEqual([[], []]);
    expect([unread.body, drained.body]).toEqual([
      expect.stringContaining(noWorker),
      expect.stringContaining(noWorker),
    ]);
  });
});
