import { describe, expect, it } from "vitest";
import { ScriptedProcessRunner } from "../ports/index.js";
import { grantFixture, leaseFixture, ScriptedWorkerClient } from "./test-support.js";
import { GATEWAY_REQUESTER_PREFIX, harness, session } from "./test-dispatcher.js";
import { connectWorker } from "./test-fleet.js";

describe("GatewayDispatcher: lease.request with a run id", () => {
  it("a run id reaches the worker, the lease index and the admission command, is listed, and is back in the index after a gateway restart; a request without one forwards none", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["/etc/simlock/policy.ts"], command: "bun" },
        result: { code: 0, stderr: "", stdout: "{}" },
      },
    ]);
    const { dispatcher, directory, leaseIndex, workers } = harness({
      admission: { command: ["bun", "/etc/simlock/policy.ts"], runner, timeoutMs: 5_000 },
    });
    const client = new ScriptedWorkerClient();
    // why: the worker's lease carries no run id, so the index entry's can only come from the request.
    const lease = { ...leaseFixture("lse_1", "dev_1"), ownerId: "tok_7f3a" };
    client.requestLeaseQueue.push({ grant: grantFixture({ lease }), kind: "grant" });
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    const agent = session({ principal: "tok_7f3a", role: "agent" });

    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17", noWait: true, platform: "ios", runId: "123-1" },
      agent,
    );

    expect(client.lastRequestLeaseInput).toMatchObject({ runId: "123-1" });
    expect(leaseIndex.resolve("wrk_a.lse_1")).toMatchObject({ runId: "123-1" });
    expect(JSON.parse(runner.calls[0]?.options.input ?? "").request).toMatchObject({
      runId: "123-1",
    });

    workers.refresh("wrk_a", {
      leases: [{ ...lease, requesterId: `${GATEWAY_REQUESTER_PREFIX}tok_7f3a`, runId: "123-1" }],
    });
    const listed = await dispatcher.dispatch("lease.list", {}, agent);
    expect(listed.leases).toMatchObject([{ id: "wrk_a.lse_1", runId: "123-1" }]);
    const got = await dispatcher.dispatch("lease.get", { leaseId: "wrk_a.lse_1" }, agent);
    expect(got.lease).toMatchObject({ runId: "123-1" });

    const restarted = harness();
    connectWorker(restarted.workers, "wrk_a");
    restarted.workers.refresh("wrk_a", {
      leases: [{ ...lease, requesterId: `${GATEWAY_REQUESTER_PREFIX}tok_7f3a`, runId: "123-1" }],
    });
    expect(restarted.leaseIndex.resolve("wrk_a.lse_1")).toMatchObject({ runId: "123-1" });

    const plain = harness();
    const plainClient = new ScriptedWorkerClient();
    plainClient.requestLeaseQueue.push({ grant: grantFixture({ lease }), kind: "grant" });
    plain.directory.add("wrk_a", plainClient);
    connectWorker(plain.workers, "wrk_a");
    await plain.dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17", noWait: true, platform: "ios" },
      agent,
    );
    expect(plainClient.lastRequestLeaseInput).not.toHaveProperty("runId");
    expect(plain.leaseIndex.resolve("wrk_a.lse_1")).not.toHaveProperty("runId");
  });
});
