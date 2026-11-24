import { describe, expect, it } from "vitest";
import { grantFixture, leaseFixture, ScriptedWorkerClient } from "./test-support.js";
import { GATEWAY_REQUESTER_PREFIX, harness, session } from "./test-dispatcher.js";
import { connectWorker } from "./test-fleet.js";

describe("GatewayDispatcher: lease.request with a label", () => {
  it("a label reaches the worker as sent, a request without one forwards none, and the gateway's lease.get, lease.list and status.get carry the worker's label", async () => {
    const { dispatcher, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    const lease = { ...leaseFixture("lse_1", "dev_1"), ownerId: "tok_7f3a" };
    client.requestLeaseQueue.push({ grant: grantFixture({ lease }), kind: "grant" });
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    const agent = session({ principal: "tok_7f3a", role: "agent" });

    await dispatcher.dispatch(
      "lease.request",
      { label: "feature-x", model: "iPhone 17", noWait: true, platform: "ios" },
      agent,
    );
    expect(client.lastRequestLeaseInput).toMatchObject({ label: "feature-x" });

    workers.refresh("wrk_a", {
      leases: [
        { ...lease, label: "feature-x", requesterId: `${GATEWAY_REQUESTER_PREFIX}tok_7f3a` },
      ],
    });
    const listed = await dispatcher.dispatch("lease.list", {}, agent);
    expect(listed.leases).toMatchObject([{ id: "wrk_a.lse_1", label: "feature-x" }]);
    const got = await dispatcher.dispatch("lease.get", { leaseId: "wrk_a.lse_1" }, agent);
    expect(got.lease).toMatchObject({ label: "feature-x" });
    const status = await dispatcher.dispatch("status.get", {}, agent);
    expect(status.leases).toMatchObject([{ id: "wrk_a.lse_1", label: "feature-x" }]);

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
    expect(plainClient.lastRequestLeaseInput).not.toHaveProperty("label");
  });
});
