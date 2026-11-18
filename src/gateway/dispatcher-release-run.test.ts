import { describe, expect, it } from "vitest";
import { ScriptedWorkerClient } from "./test-support.js";
import { harness, session } from "./test-dispatcher.js";
import { connectWorker } from "./test-fleet.js";

describe("GatewayDispatcher: lease.release-run", () => {
  it("releases each index entry of the run on its worker for the caller, every owner's for an admin, and answers their ids", async () => {
    const { dispatcher, directory, leaseIndex, workers } = harness();
    const clients = { wrk_a: new ScriptedWorkerClient(), wrk_b: new ScriptedWorkerClient() };
    for (const [workerId, client] of Object.entries(clients)) {
      directory.add(workerId, client);
      connectWorker(workers, workerId);
    }
    const entry = (workerId: "wrk_a" | "wrk_b", ownerId: string, runId: string) => {
      const gatewayLeaseId = `${workerId}.${ownerId}-${runId}`;
      leaseIndex.add({
        gatewayLeaseId,
        grantedAt: 1,
        ownerId,
        requesterId: ownerId,
        runId,
        workerId,
        workerLeaseId: `${ownerId}-${runId}`,
      });
      clients[workerId].releaseLeaseQueue.push({ kind: "ok" });
      return gatewayLeaseId;
    };
    const mineA = entry("wrk_a", "tok_ci", "nightly-7");
    const mineB = entry("wrk_b", "tok_ci", "nightly-7");
    const otherRun = entry("wrk_a", "tok_ci", "nightly-8");
    const theirs = entry("wrk_b", "tok_other", "nightly-7");

    const agent = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_ci", role: "agent" }),
    );
    expect(new Set(agent.leaseIds)).toEqual(new Set([mineA, mineB]));
    expect(agent.requestIds).toEqual([]);
    expect(clients.wrk_a.calls.filter((call) => call.startsWith("lease.release"))).toHaveLength(1);
    expect(clients.wrk_a.calls).toContainEqual(expect.stringContaining("tok_ci-nightly-7"));

    const admin = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_admin", role: "admin" }),
    );
    expect(admin).toEqual({ leaseIds: [theirs], requestIds: [] });
    expect(leaseIndex.all().map((held) => held.gatewayLeaseId)).toEqual([otherRun]);
  });
});
