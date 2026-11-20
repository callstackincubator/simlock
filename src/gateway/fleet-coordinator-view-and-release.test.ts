import { describe, expect, it } from "vitest";
import type { LeaseRecord } from "../admin/index.js";
import { SimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import type { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import { RequesterAlreadyLeasedError } from "./queue.js";
import { createRoutingPolicy } from "./index.js";
import { grantFixture, leaseFixture, ScriptedWorkerClient, statusFixture } from "./test-support.js";
import {
  GATEWAY_PREFIX,
  buildFleet,
  connectWorker,
  tick,
  REQUEST,
  saturatedIos,
  requestOptions,
} from "./test-fleet.js";

describe("FleetLeaseCoordinator dispatch", () => {
  it("runs another pass for a view change raised from inside the walk, rather than dropping it (round 4 finding 6, round 6 review)", async () => {
    let selectCalls = 0;
    const { coordinator, directory, workers } = buildFleet({
      routing: (registry) => {
        const real = createRoutingPolicy("warm-then-free");
        return {
          assess: real.assess,
          explain: real.explain,
          select(request, workerViews) {
            selectCalls += 1;
            if (selectCalls === 2) {
              registry.refresh("wrk_a", {});
              return undefined;
            }
            return real.select(request, workerViews);
          },
        };
      },
    });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();

    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(selectCalls).toBe(3);
    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(coordinator.queueDepth).toBe(0);
  });

  it.each([
    {
      code: "WORKER_UNREACHABLE",
      details: { workerId: "wrk_a" },
      error: new SimlockError(
        "DAEMON_CONNECTION_LOST",
        "transport",
        "Daemon connection is closed",
        {},
      ),
      row: "a lost connection",
    },
    {
      code: "WORKER_UNREACHABLE",
      details: { workerId: "wrk_a" },
      error: new SimlockError("DAEMON_STOPPING", "transport", "The daemon is stopping", {}),
      row: "a stopping daemon (#514)",
    },
    {
      code: "INTERNAL",
      details: undefined,
      error: new TypeError("boom"),
      row: "a non-SimlockError (H1, round 2 review)",
    },
  ])(
    "maps $row on a forwarded lease.request to $code, never the uplink client's own error code verbatim (P4)",
    async ({ code, details, error }) => {
      const { coordinator, directory, workers } = buildFleet();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      client.requestLeaseQueue.push({ error, kind: "error" });

      const rejection = await coordinator
        .request(REQUEST, requestOptions())
        .catch((caught: unknown) => caught);
      expect(rejection).toBeInstanceOf(DispatchError);
      expect(rejection).toMatchObject({ code, ...(details === undefined ? {} : { details }) });
    },
  );

  it.each([
    {
      code: "WORKER_UNREACHABLE",
      error: new SimlockError(
        "DAEMON_CONNECTION_LOST",
        "transport",
        "Daemon connection is closed",
        {},
      ),
      row: "a transport failure",
    },
    {
      code: "INTERNAL",
      error: new TypeError("boom"),
      row: "a non-SimlockError (H1, round 2 review)",
    },
  ])(
    "maps $row on a forwarded lease.renew to $code, never the other (P4)",
    async ({ code, error }) => {
      const { coordinator, directory, workers, leaseIndex } = buildFleet();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      leaseIndex.add({
        gatewayLeaseId: "wrk_a.lse_1",
        grantedAt: 1,
        ownerId: "agent-1",
        requesterId: "agent-1",
        workerId: "wrk_a",
        workerLeaseId: "lse_1",
      });
      client.renewLeaseQueue.push({ error, kind: "error" });

      const rejection = await coordinator
        .renew("wrk_a.lse_1", undefined)
        .catch((caught: unknown) => caught);
      expect(rejection).toBeInstanceOf(DispatchError);
      expect((rejection as DispatchError).code).toBe(code);
    },
  );

  it.each([
    {
      answer: (client: ScriptedWorkerClient, error: SimlockError<"UNKNOWN_LEASE">) =>
        client.releaseLeaseQueue.push({ error, kind: "error" }),
      call: (coordinator: FleetLeaseCoordinator) => coordinator.release("wrk_a.lse_1"),
      verb: "release",
    },
    {
      answer: (client: ScriptedWorkerClient, error: SimlockError<"UNKNOWN_LEASE">) =>
        client.renewLeaseQueue.push({ error, kind: "error" }),
      call: (coordinator: FleetLeaseCoordinator) => coordinator.renew("wrk_a.lse_1", undefined),
      verb: "renew",
    },
  ])(
    "drops its own index entry when the worker answers UNKNOWN_LEASE to a $verb, instead of leaving a zombie behind (C3)",
    async ({ answer, call }) => {
      const { coordinator, directory, workers, leaseIndex } = buildFleet();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      leaseIndex.add({
        gatewayLeaseId: "wrk_a.lse_1",
        grantedAt: 1,
        ownerId: "agent-1",
        requesterId: "agent-1",
        workerId: "wrk_a",
        workerLeaseId: "lse_1",
      });
      answer(
        client,
        new SimlockError("UNKNOWN_LEASE", "domain", "Unknown lease: lse_1", { leaseId: "lse_1" }),
      );

      await expect(call(coordinator)).rejects.toMatchObject({ code: "UNKNOWN_LEASE" });

      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      await expect(coordinator.request(REQUEST, requestOptions())).resolves.toBeDefined();
    },
  );

  it("release-all treats a worker's UNKNOWN_LEASE as already-released rather than a failure that blocks every future call (C3)", async () => {
    const { coordinator, directory, workers, leaseIndex } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    leaseIndex.add({
      gatewayLeaseId: "wrk_a.lse_zombie",
      grantedAt: 1,
      ownerId: "agent-1",
      requesterId: "agent-1",
      workerId: "wrk_a",
      workerLeaseId: "lse_zombie",
    });
    client.releaseLeaseQueue.push({
      error: new SimlockError("UNKNOWN_LEASE", "domain", "Unknown lease: lse_zombie", {
        leaseId: "lse_zombie",
      }),
      kind: "error",
    });

    await expect(coordinator.releaseAll()).resolves.toEqual(["wrk_a.lse_zombie"]);
    await expect(coordinator.releaseAll()).resolves.toEqual([]);
  });

  it("does not evict a lease on one worker when only a different worker's view changes repeatedly (C1, round 2 review)", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b");
    clientA.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grant = await coordinator.request(REQUEST, requestOptions());
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(workers.view("wrk_a")?.leases).toEqual([]);

    workers.refresh("wrk_b", {});
    workers.refresh("wrk_b", {});

    const retry = await coordinator
      .request(REQUEST, requestOptions({ noWait: true }))
      .catch((error: unknown) => error);
    expect(retry).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((retry as RequesterAlreadyLeasedError).existingLeaseId).toBe(grant.lease.id);
  });

  it("grants a requester's next lease when a worker view read before its release lands after it (#898)", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const first = await coordinator.request(REQUEST, requestOptions());
    client.releaseLeaseQueue.push({ kind: "ok" });
    await coordinator.release(first.lease.id);

    workers.refresh("wrk_a", {
      leases: [{ ...leaseFixture("lse_1", "dev_1"), requesterId: `${GATEWAY_PREFIX}agent-1` }],
    });
    workers.refresh("wrk_a", { leases: [] });

    client.requestLeaseQueue.push({
      grant: grantFixture({ lease: leaseFixture("lse_2", "dev_1") as LeaseRecord }),
      kind: "grant",
    });
    const second = await coordinator
      .request(REQUEST, requestOptions({ noWait: true }))
      .catch((error: unknown) => error);
    expect(second).toMatchObject({ lease: { id: "wrk_a.lse_2" } });
  });

  it.each(["release", "releaseAll"] as const)(
    "grants the next lease when %s's relayed event came before the worker's answer and a stale view follows (#898)",
    async (how) => {
      const { coordinator, directory, workers, leaseIndex } = buildFleet();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      const first = await coordinator.request(REQUEST, requestOptions());
      client.onReleaseLease = (leaseId) => leaseIndex.removeByWorkerLease("wrk_a", leaseId);
      if (how === "release") await coordinator.release(first.lease.id);
      else await coordinator.releaseAll();

      workers.refresh("wrk_a", {
        leases: [{ ...leaseFixture("lse_1", "dev_1"), requesterId: `${GATEWAY_PREFIX}agent-1` }],
      });
      workers.refresh("wrk_a", { leases: [] });

      client.requestLeaseQueue.push({
        grant: grantFixture({ lease: leaseFixture("lse_2", "dev_1") as LeaseRecord }),
        kind: "grant",
      });
      const second = await coordinator
        .request(REQUEST, requestOptions({ noWait: true }))
        .catch((error: unknown) => error);
      expect(second).toMatchObject({ lease: { id: "wrk_a.lse_2" } });
    },
  );

  it("release-all attaches the leases it already released to a later failure's own details (H8)", async () => {
    const { coordinator, directory, workers, leaseIndex } = buildFleet();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b");
    leaseIndex.add({
      gatewayLeaseId: "wrk_a.lse_1",
      grantedAt: 1,
      ownerId: "agent-1",
      requesterId: "agent-1",
      workerId: "wrk_a",
      workerLeaseId: "lse_1",
    });
    leaseIndex.add({
      gatewayLeaseId: "wrk_b.lse_1",
      grantedAt: 1,
      ownerId: "agent-2",
      requesterId: "agent-2",
      workerId: "wrk_b",
      workerLeaseId: "lse_1",
    });
    clientA.releaseLeaseQueue.push({ kind: "ok" });
    directory.unreachable.add("wrk_b");

    const rejection = await coordinator.releaseAll().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect((rejection as DispatchError).details).toMatchObject({
      releasedLeaseIds: ["wrk_a.lse_1"],
    });
    await expect(coordinator.renew("wrk_a.lse_1", undefined)).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });
    expect(clientA.calls.filter((call) => call.startsWith("lease.renew"))).toEqual([]);
    await expect(coordinator.renew("wrk_b.lse_1", undefined)).rejects.toMatchObject({
      code: "WORKER_UNREACHABLE",
    });
  });
});
