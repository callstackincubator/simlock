import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { RequestCancelledError } from "../leasing/index.js";
import { grantFixture, leaseFixture, ScriptedWorkerClient } from "./test-support.js";
import { harness, session } from "./test-dispatcher.js";
import { connectWorker, GatedRunner, saturatedIos, tick } from "./test-fleet.js";

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

  it("cancels the run's fleet requests queued in the gateway for the caller and lists their ids, and keeps another owner's and another run's", async () => {
    const { coordinator, dispatcher, directory, eventBus, workers } = harness();
    directory.add("wrk_a", new ScriptedWorkerClient());
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    const rejected: unknown[] = [];
    eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
    const queue = (principal: string, runId: string) =>
      dispatcher
        .dispatch(
          "lease.request",
          { model: "iPhone 17", platform: "ios", requesterId: `${principal}-${runId}`, runId },
          session({ principal }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    const mine = queue("tok_ci", "nightly-7");
    const otherRun = queue("tok_ci", "nightly-8");
    const otherOwner = queue("tok_other", "nightly-7");
    await tick();
    const waiting = (requesterId: string) =>
      coordinator.waitingRequests().find((request) => request.requesterId.endsWith(requesterId))
        ?.id;
    const myRequestId = waiting("tok_ci-nightly-7");
    expect(coordinator.waitingRequests()).toHaveLength(3);

    const result = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_ci", role: "agent" }),
    );

    expect(result).toEqual({ leaseIds: [], requestIds: [myRequestId] });
    expect(await mine).toBeInstanceOf(RequestCancelledError);
    expect(coordinator.waitingRequests().map((request) => request.requesterId)).toHaveLength(2);
    expect(rejected).toMatchObject([{ reason: "cancelled", requestId: myRequestId }]);

    await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-8" },
      session({ principal: "tok_ci" }),
    );
    await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_other" }),
    );
    expect(await otherRun).toBeInstanceOf(RequestCancelledError);
    expect(await otherOwner).toBeInstanceOf(RequestCancelledError);
  });

  it("cancels the run's requests still waiting on the admission command, lists none of them, and keeps another owner's and another run's", async () => {
    const runner = new GatedRunner();
    const { coordinator, dispatcher, directory, eventBus, workers } = harness({
      admission: { command: ["bun", "/etc/simlock/policy.ts"], runner, timeoutMs: 5_000 },
    });
    directory.add("wrk_a", new ScriptedWorkerClient());
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    const rejected: unknown[] = [];
    eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
    const ask = (principal: string, runId: string) =>
      dispatcher
        .dispatch(
          "lease.request",
          { model: "iPhone 17", platform: "ios", requesterId: `${principal}-${runId}`, runId },
          session({ principal }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    // why: a request still pending when the test ends must not make it wait, so the ends are read by flag, not awaited.
    const ended: Record<string, unknown> = {};
    const track = (name: string, principal: string, runId: string) =>
      void ask(principal, runId).then((error) => (ended[name] = error));
    track("mine", "tok_ci", "nightly-7");
    track("otherRun", "tok_ci", "nightly-8");
    track("otherOwner", "tok_other", "nightly-7");
    await tick();
    expect(runner.calls).toHaveLength(3);

    const result = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_ci", role: "agent" }),
    );

    expect(result).toEqual({ leaseIds: [], requestIds: [] });
    await tick();
    expect(ended.mine).toBeInstanceOf(RequestCancelledError);
    expect(rejected).toMatchObject([{ reason: "cancelled" }]);
    runner.answer(1, "{}");
    runner.answer(2, "{}");
    await tick();
    expect(ended).not.toHaveProperty("otherRun");
    expect(ended).not.toHaveProperty("otherOwner");
    expect(coordinator.waitingRequests()).toHaveLength(2);
  });

  it("marks a request already dispatched to a worker to release at its grant: the caller gets the lease, the worker is told to release it, and the id is listed", async () => {
    const { coordinator, dispatcher, directory, leaseIndex, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    let openGrant = (): void => undefined;
    const gate = new Promise<void>((resolve) => (openGrant = resolve));
    client.requestLeaseQueue.push({
      beforeGrant: () => gate,
      grant: grantFixture(),
      kind: "grant",
    });
    const granted = dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17", platform: "ios", requesterId: "ci", runId: "nightly-7" },
      session({ principal: "tok_ci" }),
    );
    await tick();
    expect(client.calls).toContain("lease.request:gw:instance-1:ci");
    const dispatchedId = coordinator.waitingRequests()[0]?.id;
    expect(dispatchedId).toBeDefined();

    const result = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_ci", role: "agent" }),
    );
    expect(result.leaseIds).toEqual([]);
    expect(result.requestIds).toEqual([dispatchedId]);
    expect(client.calls.filter((call) => call.startsWith("lease.release"))).toEqual([]);

    openGrant();
    const grant = await granted;
    expect(grant.lease.id).toBe("wrk_a.lse_1");
    await tick();
    expect(client.calls).toContain("lease.release:lse_1");
    expect(leaseIndex.all()).toEqual([]);
  });
});
