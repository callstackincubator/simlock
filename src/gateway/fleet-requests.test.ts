import { describe, expect, it } from "vitest";
import type { EventMap } from "../bus/index.js";
import type { LeaseRecord } from "../admin/index.js";
import { fromWireError, SimlockError } from "../contract/index.js";
import { ScriptedProcessRunner } from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";
import type { WorkerReportedLease } from "./lease-index.js";
import { RequesterAlreadyLeasedError } from "./queue.js";
import {
  catalogFixture,
  grantFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import type { WorkerRegistry } from "./worker-registry.js";
import {
  GATEWAY_PREFIX,
  RecordingLogger,
  buildFleet,
  connectWorker,
  tick,
  REQUEST,
  saturatedIos,
  roomierIos,
  requestOptions,
} from "./test-fleet.js";

// why: the coordinator's tests, split by subject; they assert the queue's `RequesterAlreadyLeasedError`, which index.ts does not export.
describe("FleetLeaseCoordinator: lease.rejected names its request", () => {
  type Reason = EventMap["lease.rejected"]["reason"];
  type Fleet = ReturnType<typeof buildFleet>;

  interface Outcome {
    readonly fleet: Fleet;
    readonly requester: string;
    readonly requestId?: string | undefined;
  }

  async function ask(
    fleet: Fleet,
    overrides: Parameters<typeof requestOptions>[0] & { readonly request?: typeof REQUEST },
  ): Promise<string | undefined> {
    let requestId: string | undefined;
    const { request = REQUEST, ...options } = overrides;
    void fleet.coordinator
      .request(request, requestOptions({ ...options, onAdmitted: (id) => (requestId = id) }))
      .catch(() => undefined);
    await tick();
    return requestId;
  }

  const holderGrant = () => ({ grant: grantFixture(), kind: "grant" as const });

  async function busyFleet(): Promise<Fleet> {
    const fleet = buildFleet();
    const client = new ScriptedWorkerClient();
    fleet.directory.add("wrk_a", client);
    connectWorker(fleet.workers, "wrk_a");
    client.requestLeaseQueue.push(holderGrant());
    await fleet.coordinator.request(REQUEST, requestOptions());
    connectWorker(fleet.workers, "wrk_a", { capacity: saturatedIos() });
    return fleet;
  }

  const cases: Record<Reason, (() => Promise<Outcome>) | "worker"> = {
    timeout: async () => {
      const fleet = await busyFleet();
      const requestId = await ask(fleet, {
        ownerId: "agent-2",
        requesterId: "agent-2",
        timeoutMs: 60_000,
      });
      fleet.clock.advance(60_000);
      await tick();
      return { fleet, requestId, requester: "agent-2" };
    },
    "no-wait": async () => {
      const fleet = await busyFleet();
      const requestId = await ask(fleet, {
        noWait: true,
        ownerId: "agent-2",
        requesterId: "agent-2",
      });
      return { fleet, requestId, requester: "agent-2" };
    },
    "unresolvable-spec": async () => {
      const fleet = buildFleet();
      connectWorker(fleet.workers, "wrk_a");
      const requestId = await ask(fleet, {
        request: { ...REQUEST, model: "iPhone 99" },
        requesterId: "agent-9",
      });
      return { fleet, requestId, requester: "agent-9" };
    },
    "no-worker": async () => {
      const fleet = buildFleet();
      const requestId = await ask(fleet, { requesterId: "agent-9" });
      return { fleet, requestId, requester: "agent-9" };
    },
    "already-leased": async () => {
      const fleet = await busyFleet();
      await ask(fleet, { requesterId: "agent-1" });
      return { fleet, requester: "agent-1" };
    },
    "lease-id-taken": async () => {
      const fleet = buildFleet();
      const client = new ScriptedWorkerClient();
      fleet.directory.add("wrk_a", client);
      connectWorker(fleet.workers, "wrk_a");
      client.requestLeaseQueue.push({
        grant: grantFixture({ lease: { ...grantFixture().lease, id: "myid" } }),
        kind: "grant",
      });
      await fleet.coordinator.request(REQUEST, requestOptions({ leaseId: "myid" }));
      await ask(fleet, { leaseId: "myid", ownerId: "agent-2", requesterId: "agent-2" });
      return { fleet, requester: "agent-2" };
    },
    "lease-ended": async () => {
      const fleet = buildFleet();
      const client = new ScriptedWorkerClient();
      fleet.directory.add("wrk_a", client);
      connectWorker(fleet.workers, "wrk_a");
      client.requestLeaseQueue.push({
        grant: grantFixture({ lease: { ...grantFixture().lease, id: "myid" } }),
        kind: "grant",
      });
      await fleet.coordinator.request(REQUEST, requestOptions({ leaseId: "myid" }));
      fleet.leaseIndex.remove("myid");
      await ask(fleet, { leaseId: "myid", ownerId: "agent-2", requesterId: "agent-2" });
      return { fleet, requester: "agent-2" };
    },
    "admission-denied": async () => {
      const runner = new ScriptedProcessRunner([
        {
          match: { args: [], command: "policy" },
          result: { code: 0, stderr: "", stdout: '{"deny":"no"}' },
        },
      ]);
      const fleet = buildFleet({ admission: { command: ["policy"], runner, timeoutMs: 5_000 } });
      await ask(fleet, { requesterId: "agent-9" });
      return { fleet, requester: "agent-9" };
    },
    "admission-failed": async () => {
      const runner = new ScriptedProcessRunner([
        { match: { args: [], command: "policy" }, result: { code: 1, stderr: "", stdout: "" } },
      ]);
      const fleet = buildFleet({ admission: { command: ["policy"], runner, timeoutMs: 5_000 } });
      await ask(fleet, { requesterId: "agent-9" });
      return { fleet, requester: "agent-9" };
    },
    cancelled: async () => {
      const fleet = await busyFleet();
      const requestId = await ask(fleet, { ownerId: "agent-2", requesterId: "agent-2" });
      await fleet.coordinator.cancelPending("agent-2");
      return { fleet, requestId, requester: "agent-2" };
    },
    "worker-failed": async () => {
      const fleet = buildFleet();
      const client = new ScriptedWorkerClient();
      fleet.directory.add("wrk_a", client);
      connectWorker(fleet.workers, "wrk_a");
      client.requestLeaseQueue.push({
        error: new SimlockError("INTERNAL", "domain", "the worker broke", {}),
        kind: "error",
        progress: [{ etaMs: 1_000, stage: "booting" }],
      });
      const requestId = await ask(fleet, { requesterId: "agent-9" });
      return { fleet, requestId, requester: "agent-9" };
    },
    "boot-timeout": "worker",
    killed: "worker",
    updating: "worker",
    "daemon-restarted": "worker",
  };

  const gatewayReasons = (Object.keys(cases) as Reason[]).filter(
    (reason) => cases[reason] !== "worker",
  );

  it.each(gatewayReasons)(
    "includes the request id and the requester when it rejects with %s",
    async (reason) => {
      const run = cases[reason];
      if (run === "worker") throw new Error(`${reason} is the worker's`);
      const events: Array<EventMap["lease.rejected"]> = [];

      const outcome = await (async () => {
        const result = await run();
        for (const event of result.fleet.eventBus.replay()) {
          if (event.event === "lease.rejected") events.push(event.payload as never);
        }
        return result;
      })();

      const rejections = events.filter((payload) => payload.reason === reason);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toMatchObject({
        requestId: outcome.requestId ?? expect.stringMatching(/^req_/),
        requester: outcome.requester,
      });
    },
  );

  it("gives a request refused as already-leased the id it would have been stored under, and no lease.requested precedes it", async () => {
    const fleet = await busyFleet();
    const requested: string[] = [];
    fleet.eventBus.subscribe("lease.requested", (envelope) =>
      requested.push(envelope.payload.requestId),
    );
    const rejected: Array<EventMap["lease.rejected"]> = [];
    fleet.eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

    await ask(fleet, { requesterId: "agent-1" });
    const admittedId = await ask(fleet, { ownerId: "agent-2", requesterId: "agent-2" });

    expect(rejected).toEqual([
      expect.objectContaining({ reason: "already-leased", requester: "agent-1" }),
    ]);
    expect(requested).toEqual([admittedId]);
    expect(rejected[0]?.requestId).toMatch(/^req_/);
    expect(rejected[0]?.requestId).not.toBe(admittedId);
    expect(Number(rejected[0]?.requestId.replace("req_", ""))).toBe(
      Number(admittedId?.replace("req_", "")) - 1,
    );
  });
});

describe("FleetLeaseCoordinator caller-chosen lease IDs", () => {
  function chosenGrant(leaseId: string) {
    return grantFixture({
      lease: { ...grantFixture().lease, id: leaseId, idChosenByRequester: true } as LeaseRecord,
    });
  }

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  function forwardedLeaseId(client: ScriptedWorkerClient): unknown {
    return (client.lastRequestLeaseInput as Record<string, unknown> | undefined)?.leaseId;
  }

  function refreshWorker(workers: WorkerRegistry, capacity: ReturnType<typeof roomierIos>): void {
    workers.refresh("wrk_a", {
      capacity,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      devices: [],
      downloads: { policy: "on-request" },
      health: "running",
      leases: [],
      queueDepth: 0,
    });
  }

  function oneWorker(overrides: Parameters<typeof buildFleet>[0] = {}) {
    const fleet = buildFleet(overrides);
    const client = new ScriptedWorkerClient();
    fleet.directory.add("wrk_a", client);
    connectWorker(fleet.workers, "wrk_a");
    return { ...fleet, client };
  }

  function chosen(leaseId: string, overrides: Parameters<typeof requestOptions>[0] = {}) {
    return { ...requestOptions(overrides), leaseId } as ReturnType<typeof requestOptions>;
  }

  it("through a gateway, a caller-chosen ID comes back with no worker prefix", async () => {
    const { client, coordinator } = oneWorker();
    client.requestLeaseQueue.push({ grant: chosenGrant("ad-7f3a"), kind: "grant" });

    const grant = await coordinator.request(REQUEST, chosen("ad-7f3a"));

    expect(forwardedLeaseId(client)).toBe("ad-7f3a");
    expect(grant.lease.id).toBe("ad-7f3a");
  });

  it("through a gateway, a request without leaseId gets <worker>.lse_ as today", async () => {
    const { client, coordinator } = oneWorker();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grant = await coordinator.request(REQUEST, requestOptions());

    expect(client.lastRequestLeaseInput).not.toHaveProperty("leaseId");
    expect(grant.lease.id).toBe("wrk_a.lse_1");
  });

  it("through a gateway, renew and release by a caller-chosen ID reach the right worker", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b", { capacity: roomierIos() });
    clientB.requestLeaseQueue.push({ grant: chosenGrant("ad-7f3a"), kind: "grant" });
    await coordinator.request(REQUEST, chosen("ad-7f3a"));

    await coordinator.renew("ad-7f3a", undefined);
    await coordinator.release("ad-7f3a");

    expect(clientB.calls).toEqual(
      expect.arrayContaining(["lease.renew:ad-7f3a", "lease.release:ad-7f3a"]),
    );
    expect(clientA.calls.filter((call) => /^lease\.(renew|release)/.test(call))).toEqual([]);
    const callsAfterRelease = clientB.calls.length;
    await expect(coordinator.renew("ad-7f3a", undefined)).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });
    expect(clientB.calls).toHaveLength(callsAfterRelease);
  });

  it("when two workers report the same caller-chosen ID on rebuild, renew of that ID reaches the first worker", async () => {
    const { coordinator, directory, leaseIndex, workers } = buildFleet();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b");
    const reported = (ownerId: string) => ({
      grantedAt: 1,
      id: "myid",
      idChosenByRequester: true,
      ownerId,
      requesterId: `${GATEWAY_PREFIX}${ownerId}`,
    });

    leaseIndex.rebuildFromWorker("wrk_a", [reported("agent-1")]);
    leaseIndex.rebuildFromWorker("wrk_b", [reported("agent-2")]);
    await coordinator.renew("myid", undefined);

    expect(clientA.calls).toContain("lease.renew:myid");
    expect(clientB.calls.filter((call) => call.startsWith("lease.renew"))).toEqual([]);
  });

  it("through a gateway, a request whose requester already holds a lease fails with REQUESTER_ALREADY_LEASED, not LEASE_ID_TAKEN, when it names that lease's own ID", async () => {
    const { client, coordinator } = oneWorker();
    client.requestLeaseQueue.push({ grant: chosenGrant("myid"), kind: "grant" });
    await coordinator.request(REQUEST, chosen("myid"));

    const refusal = await coordinator.request(REQUEST, chosen("myid")).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((refusal as RequesterAlreadyLeasedError).existingLeaseId).toBe("myid");
  });

  it("through a gateway, a second request for an ID held by a gateway lease fails with LEASE_ID_TAKEN, emits lease.rejected with reason lease-id-taken, and is not forwarded", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    client.requestLeaseQueue.push({ grant: chosenGrant("myid"), kind: "grant" });
    await coordinator.request(REQUEST, chosen("myid"));
    const rejected: unknown[] = [];
    eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

    const second = coordinator.request(
      REQUEST,
      chosen("myid", { ownerId: "agent-2", requesterId: "agent-2" }),
    );
    const secondState = promiseState(second);
    const refusal = second.catch((error: unknown) => error);
    await tick();

    expect(secondState.state).toBe("rejected");
    expect(await refusal).toMatchObject({
      code: "LEASE_ID_TAKEN",
      details: { leaseId: "myid" },
      message: "lease ID myid is already in use",
    });
    expect(rejected).toEqual([
      expect.objectContaining({ reason: "lease-id-taken", requester: "agent-2" }),
    ]);
    expect(leaseRequests(client)).toHaveLength(1);
  });

  it("through a gateway, a second request for an ID held by a waiting gateway request fails with LEASE_ID_TAKEN and is not forwarded", async () => {
    const { client, coordinator, directory, workers } = oneWorker();
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    directory.add("wrk_a", client);
    void coordinator.request(REQUEST, chosen("myid")).catch(() => undefined);
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    const second = coordinator.request(
      REQUEST,
      chosen("myid", { ownerId: "agent-2", requesterId: "agent-2" }),
    );
    const secondState = promiseState(second);
    const refusal = second.catch((error: unknown) => error);
    await tick();

    expect(secondState.state).toBe("rejected");
    expect(await refusal).toMatchObject({ code: "LEASE_ID_TAKEN" });
    expect(leaseRequests(client)).toEqual([]);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("through a gateway, a worker's LEASE_ID_TAKEN is passed to the caller and no other worker is tried", async () => {
    const { client, coordinator, directory, workers } = oneWorker();
    const other = new ScriptedWorkerClient();
    directory.add("wrk_b", other);
    connectWorker(workers, "wrk_b");
    const taken = fromWireError("LEASE_ID_TAKEN", "lease ID myid is already in use", {
      leaseId: "myid",
    });
    for (const scripted of [client, other]) {
      scripted.requestLeaseQueue.push(
        { error: taken, kind: "error" },
        { grant: chosenGrant("myid"), kind: "grant" },
      );
    }

    await expect(coordinator.request(REQUEST, chosen("myid"))).rejects.toMatchObject({
      code: "LEASE_ID_TAKEN",
      details: { leaseId: "myid" },
    });

    expect(leaseRequests(client).length + leaseRequests(other).length).toBe(1);
  });

  it("a worker grant whose lease ID differs from the forwarded leaseId is released on the worker, never enters the gateway index, and the request is queued again", async () => {
    const logger = new RecordingLogger();
    const { client, coordinator } = oneWorker({ logger });
    client.requestLeaseQueue.push({ grant: chosenGrant("not-what-was-sent"), kind: "grant" });
    const outcome = promiseState(coordinator.request(REQUEST, chosen("myid")));
    await tick();

    expect(client.calls).toContain("lease.release:not-what-was-sent");
    await expect(coordinator.renew("not-what-was-sent", undefined)).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });
    expect(client.calls).not.toContain("lease.renew:not-what-was-sent");
    expect(outcome.state).toBe("pending");
    expect(coordinator.queueDepth).toBe(1);
    expect(JSON.stringify(logger.warnings)).toContain("wrk_a");
  });

  it("a worker that answered a grant under another ID is not asked again until its view changes, then is, and the right grant settles the request", async () => {
    const { client, coordinator, workers } = oneWorker();
    client.requestLeaseQueue.push(
      { grant: chosenGrant("not-what-was-sent"), kind: "grant" },
      { grant: chosenGrant("myid"), kind: "grant" },
    );
    const request = coordinator.request(REQUEST, chosen("myid"));
    const outcome = promiseState(request);
    await tick();
    expect(leaseRequests(client)).toHaveLength(1);

    refreshWorker(workers, statusFixture().capacity);
    await tick();
    expect(leaseRequests(client)).toHaveLength(1);

    refreshWorker(workers, roomierIos());
    await tick();
    expect(outcome.state).toBe("fulfilled");
    await expect(request).resolves.toMatchObject({ lease: { id: "myid" } });
    expect(leaseRequests(client)).toHaveLength(2);
  });

  it("the gateway answers UNKNOWN_LEASE for a renew of an ID missing from its index", async () => {
    const { coordinator } = oneWorker();

    await expect(coordinator.renew("myid", undefined)).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
      details: { leaseId: "myid" },
    });
  });

  describe("a grant for a bare ID the index maps to another worker", () => {
    function grantRacingAReport(overrides: Parameters<typeof buildFleet>[0] = {}) {
      const fleet = oneWorker(overrides);
      fleet.client.requestLeaseQueue.push({
        beforeGrant: () => {
          fleet.leaseIndex.rebuildFromWorker("wrk_b", [
            {
              grantedAt: 1,
              id: "myid",
              idChosenByRequester: true,
              ownerId: "agent-9",
              requesterId: `${GATEWAY_PREFIX}agent-9`,
            } as WorkerReportedLease,
          ]);
        },
        grant: chosenGrant("myid"),
        kind: "grant",
      });
      return fleet;
    }

    it("is released on the new worker and answers LEASE_ID_TAKEN, and the first entry stays routed", async () => {
      const { client, coordinator, directory, eventBus } = grantRacingAReport();
      const reported = new ScriptedWorkerClient();
      directory.add("wrk_b", reported);
      const rejected: unknown[] = [];
      eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

      await expect(coordinator.request(REQUEST, chosen("myid"))).rejects.toMatchObject({
        code: "LEASE_ID_TAKEN",
        details: { leaseId: "myid" },
      });

      expect(client.calls).toContain("lease.release:myid");
      await coordinator.renew("myid", undefined);
      expect(reported.calls).toContain("lease.renew:myid");
      expect(client.calls.filter((call) => call.startsWith("lease.renew"))).toEqual([]);
      expect(rejected).toEqual([
        expect.objectContaining({ reason: "lease-id-taken", requester: "agent-1" }),
      ]);
    });

    it("logs a release the worker refuses, naming the worker and the lease, and still answers LEASE_ID_TAKEN", async () => {
      const logger = new RecordingLogger();
      const { client, coordinator } = grantRacingAReport({ logger });
      client.releaseLeaseQueue.push({ error: new Error("worker said no"), kind: "error" });

      await expect(coordinator.request(REQUEST, chosen("myid"))).rejects.toMatchObject({
        code: "LEASE_ID_TAKEN",
      });
      await tick();

      expect(logger.warnings).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({ workerId: "wrk_a", workerLeaseId: "myid" }),
          message: "Failed to release a lease the gateway will not route",
        }),
      ]);
    });
  });
});
