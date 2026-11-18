import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { leaseFixture, ScriptedWorkerClient } from "./test-support.js";
import { harness, session } from "./test-dispatcher.js";
import { connectWorker } from "./test-fleet.js";

describe("GatewayDispatcher: lease.release-run", () => {
  it("releases each index entry of the run on its worker for the caller, every owner's for an admin, keeps a joined worker's own lease, and answers their ids", async () => {
    const { dispatcher, directory, leaseIndex, workers } = harness();
    const clients = { wrk_a: new ScriptedWorkerClient(), wrk_b: new ScriptedWorkerClient() };
    for (const [workerId, client] of Object.entries(clients)) {
      directory.add(workerId, client);
      // why: a joined worker's own lease of the run, made on its own socket: the gateway never issued it, so it is not in the index.
      connectWorker(workers, workerId, {
        leases: [
          {
            ...leaseFixture(`${workerId}-own`, "dev_own"),
            ownerId: "tok_ci",
            runId: "nightly-7",
          },
        ],
      });
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

  it("counts a worker's UNKNOWN_LEASE as released, fails WORKER_UNREACHABLE after the rest when a worker is unreachable", async () => {
    const { dispatcher, directory, leaseIndex, workers } = harness();
    const clients = { wrk_a: new ScriptedWorkerClient(), wrk_b: new ScriptedWorkerClient() };
    directory.add("wrk_a", clients.wrk_a);
    directory.add("wrk_b", clients.wrk_b);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b");
    const entry = (workerId: string, workerLeaseId: string) => {
      leaseIndex.add({
        gatewayLeaseId: `${workerId}.${workerLeaseId}`,
        grantedAt: 1,
        ownerId: "tok_ci",
        requesterId: "tok_ci",
        runId: "nightly-7",
        workerId,
        workerLeaseId,
      });
      return `${workerId}.${workerLeaseId}`;
    };
    const zombie = entry("wrk_a", "lse_zombie");
    const reachable = entry("wrk_b", "lse_1");
    entry("wrk_c", "lse_2");
    clients.wrk_a.releaseLeaseQueue.push({
      error: new SimlockError("UNKNOWN_LEASE", "domain", "Unknown lease: lse_zombie", {
        leaseId: "lse_zombie",
      }),
      kind: "error",
    });
    clients.wrk_b.releaseLeaseQueue.push({ kind: "ok" });

    const failure = await dispatcher
      .dispatch("lease.release-run", { runId: "nightly-7" }, session({ principal: "tok_ci" }))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "WORKER_UNREACHABLE",
      details: { releasedLeaseIds: [zombie, reachable] },
    });
    expect(leaseIndex.all().map((held) => held.gatewayLeaseId)).toEqual(["wrk_c.lse_2"]);
  });
});
