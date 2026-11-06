import { describe, expect, it } from "vitest";
import type { EventBus, EventMap } from "../bus/index.js";
import type { LeaseRecord } from "../admin/index.js";
import { fromWireError, SimlockError } from "../contract/index.js";
import { promiseState } from "../test-support/promise-state.js";
import type { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import type { WorkerReportedLease } from "./lease-index.js";
import { RequesterAlreadyLeasedError } from "./queue.js";
import {
  catalogFixture,
  deviceFixture,
  grantFixture,
  leaseFixture,
  physicalDeviceFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import type { WorkerRegistry } from "./worker-registry.js";
import {
  GATEWAY_PREFIX,
  RecordingLogger,
  harness,
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
  type Fleet = ReturnType<typeof harness>;

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
    const fleet = harness();
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
      const fleet = harness();
      connectWorker(fleet.workers, "wrk_a");
      const requestId = await ask(fleet, {
        request: { ...REQUEST, model: "iPhone 99" },
        requesterId: "agent-9",
      });
      return { fleet, requestId, requester: "agent-9" };
    },
    "no-worker": async () => {
      const fleet = harness();
      const requestId = await ask(fleet, { requesterId: "agent-9" });
      return { fleet, requestId, requester: "agent-9" };
    },
    "already-leased": async () => {
      const fleet = await busyFleet();
      await ask(fleet, { requesterId: "agent-1" });
      return { fleet, requester: "agent-1" };
    },
    "lease-id-taken": async () => {
      const fleet = harness();
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
    cancelled: async () => {
      const fleet = await busyFleet();
      const requestId = await ask(fleet, { ownerId: "agent-2", requesterId: "agent-2" });
      await fleet.coordinator.cancelPending("agent-2");
      return { fleet, requestId, requester: "agent-2" };
    },
    "worker-failed": async () => {
      const fleet = harness();
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

  function oneWorker(overrides: Parameters<typeof harness>[0] = {}) {
    const fleet = harness(overrides);
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
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, leaseIndex, workers } = harness();
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
    function grantRacingAReport(overrides: Parameters<typeof harness>[0] = {}) {
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

describe("FleetLeaseCoordinator records every fleet request's outcome (ADR 0021)", () => {
  function oneWorker(overrides: Parameters<typeof harness>[0] = {}) {
    const fleet = harness(overrides);
    const client = new ScriptedWorkerClient();
    fleet.directory.add("wrk_a", client);
    connectWorker(fleet.workers, "wrk_a");
    return { ...fleet, client };
  }

  function record<Name extends keyof EventMap>(
    eventBus: EventBus,
    ...names: Name[]
  ): Array<{ name: Name; payload: EventMap[Name] }> {
    const seen: Array<{ name: Name; payload: EventMap[Name] }> = [];
    for (const name of names) {
      eventBus.subscribe(name, (envelope) =>
        seen.push({ name, payload: envelope.payload as EventMap[Name] }),
      );
    }
    return seen;
  }

  async function start(
    coordinator: FleetLeaseCoordinator,
    overrides: Parameters<typeof requestOptions>[0] = {},
  ) {
    let requestId: string | undefined;
    const outcome = coordinator.request(
      REQUEST,
      requestOptions({ ...overrides, onAdmitted: (id) => (requestId = id) }),
    );
    const ended = outcome.then(
      (grant) => grant as unknown,
      (error: unknown) => error,
    );
    const state = promiseState(outcome);
    await tick();
    return { ended, outcome, requestId: () => requestId, state };
  }

  it.each([
    ["a waiting caller", { noWait: false }],
    ["a noWait caller", { noWait: true }],
  ])("sends the gateway's request id as fleetRequestId, for %s", async (_label, caller) => {
    const { client, coordinator } = oneWorker();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { requestId } = await start(coordinator, caller);

    expect(requestId()).toMatch(/^req_/);
    expect(client.lastRequestLeaseInput).toMatchObject({
      fleetRequestId: requestId(),
      noWait: true,
    });
  });

  function twoWorkersAPreferred() {
    const fleet = harness();
    const preferred = new ScriptedWorkerClient();
    const other = new ScriptedWorkerClient();
    fleet.directory.add("wrk_a", preferred);
    fleet.directory.add("wrk_b", other);
    const capacity = statusFixture().capacity;
    connectWorker(fleet.workers, "wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    connectWorker(fleet.workers, "wrk_b");
    return { ...fleet, other, preferred };
  }

  it("sends the same fleetRequestId to the second worker when the first refuses NO_CAPACITY", async () => {
    const { coordinator, other, preferred } = twoWorkersAPreferred();
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { requestId } = await start(coordinator, { noWait: true });

    expect(
      [preferred, other].map(
        (client) =>
          (client.lastRequestLeaseInput as Record<string, unknown> | undefined)?.fleetRequestId,
      ),
    ).toEqual([requestId(), requestId()]);
  });

  it("emits one lease.rejected worker-failed with the caller's error code for a request whose dispatch fails after a progress push", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    const events = record(eventBus, "lease.rejected", "request.granted");
    client.requestLeaseQueue.push({
      error: new SimlockError("INTERNAL", "domain", "the worker broke", {}),
      kind: "error",
      progress: [{ etaMs: 1_000, stage: "booting" }],
    });

    const { ended, requestId } = await start(coordinator);

    expect(await ended).toMatchObject({ code: "INTERNAL" });
    expect(events).toEqual([
      {
        name: "lease.rejected",
        payload: {
          code: "INTERNAL",
          reason: "worker-failed",
          requestId: requestId(),
          requestSpec: REQUEST,
          requester: "agent-1",
          worker: "wrk_a",
        },
      },
    ]);
  });

  it.each([{ answer: null }, { answer: {} }, { answer: { lease: null } }])(
    "ends a request whose worker answers a malformed grant ($answer) in lease.rejected worker-failed, with no unhandled rejection",
    async ({ answer }) => {
      const { client, coordinator, eventBus } = oneWorker();
      const events = record(eventBus, "lease.rejected");
      client.requestLeaseQueue.push({ grant: answer as never, kind: "grant" });
      const unhandled: unknown[] = [];
      const listener = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", listener);
      try {
        const { ended, state } = await start(coordinator);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(state.state).toBe("rejected");
        await expect(ended).resolves.toMatchObject({ code: "INTERNAL" });
      } finally {
        process.off("unhandledRejection", listener);
      }

      expect(unhandled).toEqual([]);
      expect(events).toEqual([
        { name: "lease.rejected", payload: expect.objectContaining({ reason: "worker-failed" }) },
      ]);
    },
  );

  it.each([
    {
      elapseMs: 0,
      failure: "fails on a lost uplink",
      script: (client: ScriptedWorkerClient) =>
        client.requestLeaseQueue.push({
          error: new SimlockError(
            "DAEMON_CONNECTION_LOST",
            "transport",
            "Daemon connection is closed",
            {},
          ),
          kind: "error",
        }),
    },
    {
      elapseMs: 5_000,
      failure: "times out",
      script: (client: ScriptedWorkerClient) => client.requestLeaseQueue.push({ kind: "hang" }),
    },
  ])(
    "emits one lease.rejected worker-failed with code WORKER_UNREACHABLE, naming the worker, for a dispatch that $failure",
    async ({ elapseMs, script }) => {
      const { clock, client, coordinator, eventBus } = oneWorker({ leaseRequestTimeoutMs: 5_000 });
      const events = record(eventBus, "lease.rejected");
      script(client);

      const { ended } = await start(coordinator);
      clock.advance(elapseMs);
      await tick();

      expect(await ended).toMatchObject({ code: "WORKER_UNREACHABLE" });
      expect(events).toEqual([
        {
          name: "lease.rejected",
          payload: expect.objectContaining({
            code: "WORKER_UNREACHABLE",
            reason: "worker-failed",
            worker: "wrk_a",
          }),
        },
      ]);
    },
  );

  it("carries the failing worker's id, not the one that only refused, as worker on a worker-failed rejection", async () => {
    const { coordinator, eventBus, other } = twoWorkersAPreferred();
    const events = record(eventBus, "lease.rejected");
    other.requestLeaseQueue.push({
      error: new SimlockError("INTERNAL", "domain", "wrk_b broke", {}),
      kind: "error",
      progress: [{ etaMs: 1, stage: "booting" }],
    });

    await start(coordinator, { noWait: true });

    expect(events).toEqual([
      {
        name: "lease.rejected",
        payload: expect.objectContaining({ reason: "worker-failed", worker: "wrk_b" }),
      },
    ]);
  });

  it("ends a request never queued on a worker's cannot-serve refusal in one lease.rejected unresolvable-spec", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    const events = record(eventBus, "lease.rejected", "lease.queued");
    client.requestLeaseQueue.push({
      error: new SimlockError("RUNTIME_MISSING", "domain", "no such runtime", {
        downloadable: false,
        osVersion: "26.0",
        platform: "ios",
      }),
      kind: "error",
    });

    const { ended, requestId } = await start(coordinator);

    expect(await ended).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(events).toEqual([
      {
        name: "lease.rejected",
        payload: expect.objectContaining({ reason: "unresolvable-spec", requestId: requestId() }),
      },
    ]);
  });

  it("emits no lease.rejected for a request one worker refuses NO_CAPACITY and another grants", async () => {
    const { coordinator, eventBus, other } = twoWorkersAPreferred();
    const events = record(eventBus, "lease.rejected");
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { ended } = await start(coordinator, { noWait: true });

    expect(await ended).toMatchObject({ lease: { worker: { id: "wrk_b" } } });
    expect(events).toEqual([]);
  });

  it("emits one request.granted with worker and both lease ids, and no workerId in its payload, for a settled grant", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    const events = record(eventBus, "request.granted", "lease.rejected");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { ended, requestId } = await start(coordinator);

    expect(await ended).toMatchObject({ lease: { id: "wrk_a.lse_1" } });
    expect(events).toEqual([
      {
        name: "request.granted",
        payload: {
          leaseId: "wrk_a.lse_1",
          requestId: requestId(),
          worker: "wrk_a",
          workerLeaseId: "lse_1",
        },
      },
    ]);
    expect(events[0]?.payload).not.toHaveProperty("workerId");
  });

  it("emits lease.rejected lease-id-taken and no request.granted for a grant the lease index refuses", async () => {
    const { client, coordinator, eventBus, leaseIndex } = oneWorker();
    const events = record(eventBus, "request.granted", "lease.rejected");
    client.requestLeaseQueue.push({
      beforeGrant: () => {
        leaseIndex.rebuildFromWorker("wrk_b", [
          {
            grantedAt: 1,
            id: "myid",
            idChosenByRequester: true,
            ownerId: "agent-9",
            requesterId: `${GATEWAY_PREFIX}agent-9`,
          } as WorkerReportedLease,
        ]);
      },
      grant: grantFixture({
        lease: { ...grantFixture().lease, id: "myid", idChosenByRequester: true } as LeaseRecord,
      }),
      kind: "grant",
    });

    const { ended } = await start(coordinator, { leaseId: "myid" } as never);

    expect(await ended).toMatchObject({ code: "LEASE_ID_TAKEN" });
    expect(events).toEqual([
      { name: "lease.rejected", payload: expect.objectContaining({ reason: "lease-id-taken" }) },
    ]);
  });

  it("emits no request.granted for a grant that lands after dispose()", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    const events = record(eventBus, "request.granted", "lease.rejected");
    client.requestLeaseQueue.push({
      beforeGrant: () => coordinator.dispose(),
      grant: grantFixture(),
      kind: "grant",
    });

    const { ended } = await start(coordinator);

    expect(await ended).toMatchObject({ code: "DAEMON_STOPPING" });
    expect(events).toEqual([]);
  });

  it("emits no request.granted for a grant that lands after the dispatch timed out", async () => {
    const { clock, client, coordinator, eventBus } = oneWorker({ leaseRequestTimeoutMs: 5_000 });
    const events = record(eventBus, "request.granted");
    client.requestLeaseQueue.push({
      beforeGrant: async () => {
        await Promise.resolve();
        clock.advance(5_000);
      },
      grant: grantFixture(),
      kind: "grant",
    });

    const { ended } = await start(coordinator);

    expect(await ended).toMatchObject({ code: "WORKER_UNREACHABLE" });
    expect(events).toEqual([]);
  });

  it("emits no lease.rejected and no request.granted on dispose() with a queued and an in-flight request", async () => {
    const { client, coordinator, directory, eventBus, workers } = oneWorker();
    const events = record(eventBus, "lease.rejected", "request.granted");
    client.requestLeaseQueue.push({ kind: "hang" });
    const inFlight = await start(coordinator);
    const busy = new ScriptedWorkerClient();
    directory.add("wrk_b", busy);
    connectWorker(workers, "wrk_b", { capacity: saturatedIos(), models: ["iPhone 18"] });
    const queued = await start(coordinator, { ownerId: "agent-2", requesterId: "agent-2" });
    expect(inFlight.state.state).toBe("pending");
    expect(coordinator.queueDepth).toBe(1);

    coordinator.dispose();
    await tick();

    expect(await inFlight.ended).toMatchObject({ code: "DAEMON_STOPPING" });
    expect(await queued.ended).toMatchObject({ code: "DAEMON_STOPPING" });
    expect(events).toEqual([]);
  });

  it("emits no request.granted for a grant given back for a mismatched leaseId, and one for the retried grant", async () => {
    const { client, coordinator, eventBus, workers } = oneWorker();
    const events = record(eventBus, "request.granted");
    const chosen = (leaseId: string) =>
      grantFixture({
        lease: { ...grantFixture().lease, id: leaseId, idChosenByRequester: true } as LeaseRecord,
      });
    client.requestLeaseQueue.push(
      { grant: chosen("not-what-was-sent"), kind: "grant" },
      { grant: chosen("myid"), kind: "grant" },
    );

    const { ended, requestId } = await start(coordinator, { leaseId: "myid" } as never);
    expect(events).toEqual([]);

    workers.refresh("wrk_a", { capacity: roomierIos() });
    await tick();

    expect(await ended).toMatchObject({ lease: { id: "myid" } });
    expect(events).toEqual([
      {
        name: "request.granted",
        payload: {
          leaseId: "myid",
          requestId: requestId(),
          worker: "wrk_a",
          workerLeaseId: "myid",
        },
      },
    ]);
  });

  it.each([
    [
      "REQUESTER_ALREADY_LEASED",
      fromWireError("REQUESTER_ALREADY_LEASED", "already holds a lease", { requesterId: "gw" }),
    ],
    [
      "LEASE_ID_TAKEN",
      fromWireError("LEASE_ID_TAKEN", "lease ID myid is already in use", { leaseId: "myid" }),
    ],
  ])(
    "ends a request a worker refuses %s before any progress in lease.rejected worker-failed with that code, not the gateway's own lease-id-taken",
    async (code, error) => {
      const { client, coordinator, eventBus } = oneWorker();
      const events = record(eventBus, "lease.rejected");
      client.requestLeaseQueue.push({ error, kind: "error" });

      const { ended } = await start(coordinator);

      expect(await ended).toMatchObject({ code });
      expect(events).toEqual([
        {
          name: "lease.rejected",
          payload: expect.objectContaining({ code, reason: "worker-failed", worker: "wrk_a" }),
        },
      ]);
    },
  );
});

describe("FleetLeaseCoordinator: a requester may hold up to lease.maxPerRequester fleet leases (ADR 0023)", () => {
  const held = (id: string, grantedAt: number, requester = "agent-1") => ({
    grantedAt,
    id,
    ownerId: requester,
    requesterId: `${GATEWAY_PREFIX}${requester}`,
  });
  const atLimit = (held: number, limit: number, leaseId: string) =>
    `Requester agent-1 already holds ${String(held)} leases and lease.maxPerRequester is ${String(limit)}; release one (\`simlock release ${leaseId}\`) before requesting another device`;
  const waitingMessage =
    "Requester agent-1 already has a waiting request; wait for it to be granted or cancel it before requesting another device";

  async function withWaitingRequest(maxPerRequester?: number) {
    const built = harness(maxPerRequester === undefined ? {} : { maxPerRequester });
    connectWorker(built.workers, "wrk_a", { capacity: saturatedIos() });
    built.directory.add("wrk_a", new ScriptedWorkerClient());
    void built.coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
    await tick();
    expect(built.coordinator.queueDepth).toBe(1);
    return built;
  }

  it("with no limit set, a requester holding a fleet lease is refused with today's message, naming that lease", async () => {
    const { coordinator, leaseIndex } = harness();
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "wrk_a.lse_1",
      message:
        "Requester agent-1 already holds lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another device",
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with limit 2, a requester holding two fleet leases is refused, naming the earlier-granted one", async () => {
    const { coordinator, leaseIndex } = harness({ maxPerRequester: 2 });
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_9", 10), held("lse_1", 20)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "wrk_a.lse_9",
      message: atLimit(2, 2, "wrk_a.lse_9"),
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with limit 2, a requester holding one fleet lease is not refused", async () => {
    const { coordinator, directory, leaseIndex, workers } = harness({ maxPerRequester: 2 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1)]);

    await expect(coordinator.request(REQUEST, requestOptions())).resolves.toMatchObject({
      lease: expect.anything(),
    });
  });

  describe("per platform", () => {
    const ANDROID_REQUEST = {
      physical: false,
      model: "Pixel 9",
      osVersion: "26.0",
      platform: "android" as const,
    };
    const iosHeld = (): LeaseRecord => ({
      ...(leaseFixture("lse_1", "dev_1") as LeaseRecord),
      requesterId: `${GATEWAY_PREFIX}agent-1`,
    });
    const androidGrant = () => {
      const base = grantFixture();
      return grantFixture({
        device: {
          ...base.device,
          id: "dev_2",
          spec: { ...base.device.spec, model: "Pixel 9", platform: "android" },
        },
        lease: leaseFixture("lse_2", "dev_2") as LeaseRecord,
      });
    };
    const iosRefusal = (leaseId: string) =>
      `Requester agent-1 already holds iOS lease ${leaseId}; release it (\`simlock release ${leaseId}\`) before requesting another iOS device`;
    const twoWorkers = (built: ReturnType<typeof harness>, held: LeaseRecord[] = []) => {
      const ios = new ScriptedWorkerClient();
      const android = new ScriptedWorkerClient();
      built.directory.add("wrk_a", ios);
      built.directory.add("wrk_b", android);
      connectWorker(built.workers, "wrk_a", {
        devices: held.length === 0 ? [] : [deviceFixture("dev_1", "leased")],
        leases: held,
      });
      connectWorker(built.workers, "wrk_b", { models: ["Pixel 9"], platform: "android" });
      return { android, ios };
    };

    it("with lease.maxPerRequester per platform, a requester holding an iOS fleet lease is granted an Android one on another worker and refused a second iOS one, also once the index is rebuilt from worker views alone", async () => {
      const limit = { ios: 1, android: 1 };
      const live = harness({ maxPerRequester: limit });
      const liveWorkers = twoWorkers(live);
      liveWorkers.ios.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      liveWorkers.android.requestLeaseQueue.push({ grant: androidGrant(), kind: "grant" });
      await live.coordinator.request(REQUEST, requestOptions());

      const android = await live.coordinator.request(ANDROID_REQUEST, requestOptions());
      const second = await live.coordinator
        .request(REQUEST, requestOptions())
        .catch((e: unknown) => e);

      expect(android.lease.id).toBe("wrk_b.lse_2");
      expect(second).toMatchObject({
        existingLeaseId: "wrk_a.lse_1",
        message: iosRefusal("wrk_a.lse_1"),
        name: "RequesterAlreadyLeasedError",
      });

      const rebuilt = harness({ maxPerRequester: limit });
      const rebuiltWorkers = twoWorkers(rebuilt, [iosHeld()]);
      rebuiltWorkers.android.requestLeaseQueue.push({ grant: androidGrant(), kind: "grant" });

      const againIos = await rebuilt.coordinator
        .request(REQUEST, requestOptions())
        .catch((e: unknown) => e);
      const againAndroid = await rebuilt.coordinator.request(ANDROID_REQUEST, requestOptions());

      expect(againIos).toMatchObject({ message: iosRefusal("wrk_a.lse_1") });
      expect(againAndroid.lease.id).toBe("wrk_b.lse_2");
    });
  });

  it("with a numeric limit of 1, a requester holding an iOS and an Android fleet lease is refused with today's message, naming the earlier one", async () => {
    const { coordinator, leaseIndex } = harness({ maxPerRequester: 1 });
    leaseIndex.rebuildFromWorker(
      "wrk_a",
      [
        { ...held("lse_2", 20), deviceId: "dev_2" },
        { ...held("lse_1", 10), deviceId: "dev_1" },
      ],
      [
        { id: "dev_1", spec: { platform: "ios" } },
        { id: "dev_2", spec: { platform: "android" } },
      ],
    );

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message:
        "Requester agent-1 already holds lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another device",
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with lease.maxPerRequester per platform, a fleet lease whose device a worker view does not list counts against every platform", async () => {
    const { coordinator, leaseIndex } = harness({ maxPerRequester: { ios: 1, android: 1 } });
    leaseIndex.rebuildFromWorker("wrk_a", [{ ...held("lse_1", 10), deviceId: "dev_unlisted" }], []);

    const refusal = await coordinator
      .request({ ...REQUEST, model: "Pixel 9", platform: "android" }, requestOptions())
      .catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message:
        "Requester agent-1 already holds Android lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another Android device",
      name: "RequesterAlreadyLeasedError",
    });
  });

  describe("per platform, waiting", () => {
    it("with lease.maxPerRequester per platform, a requester may wait for an iOS and an Android lease at once but not two of one platform, and lease.cancel names which one to cancel", async () => {
      const built = harness({ maxPerRequester: { ios: 1, android: 1 } });
      const capacity = statusFixture().capacity;
      built.directory.add("wrk_a", new ScriptedWorkerClient());
      built.directory.add("wrk_b", new ScriptedWorkerClient());
      connectWorker(built.workers, "wrk_a", { capacity: saturatedIos() });
      connectWorker(built.workers, "wrk_b", {
        capacity: { ...capacity, android: { ...capacity.android, maxRunning: 0 } },
        models: ["Pixel 9"],
        platform: "android",
      });
      const androidRequest = {
        physical: false,
        model: "Pixel 9",
        osVersion: "26.0",
        platform: "android" as const,
      };
      void built.coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
      await tick();

      const android = built.coordinator.request(androidRequest, requestOptions());
      void android.catch(() => undefined);
      await tick();
      const secondIos = await Promise.race([
        built.coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e),
        tick().then(() => "admitted"),
      ]);
      const platformsWaiting = () =>
        built.coordinator
          .waitingRequests()
          .map((waiting) => waiting.spec.platform)
          .sort();

      expect(platformsWaiting()).toEqual(["android", "ios"]);
      expect(secondIos).toMatchObject({
        message:
          "Requester agent-1 already has a waiting iOS request; wait for it to be granted or cancel it before requesting another iOS device",
        name: "RequesterAlreadyLeasedError",
      });
      await expect(built.coordinator.cancelPending("agent-1", "android")).resolves.toBe(
        "cancelled",
      );
      expect(platformsWaiting()).toEqual(["ios"]);
    });
  });

  it("with limit 2, a requester with a waiting fleet request is refused with the waiting-request message", async () => {
    const { coordinator } = await withWaitingRequest(2);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message: waitingMessage,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with limit 2, a requester with a waiting fleet request that also holds two fleet leases gets the waiting-request message", async () => {
    const { coordinator, leaseIndex } = await withWaitingRequest(2);
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1), held("lse_2", 2)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message: waitingMessage,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with no limit set, a requester that holds a fleet lease and has a waiting request gets today's message naming that lease", async () => {
    const { coordinator, leaseIndex } = await withWaitingRequest();
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "wrk_a.lse_1",
      message:
        "Requester agent-1 already holds lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another device",
    });
  });
});

describe("FleetLeaseCoordinator lists why each worker cannot take a waiting request (#637)", () => {
  type Reasons = readonly { workerId: string; reason: string; capacityReason?: string }[];

  // why: holds a `lease.request` until `release` runs, so a test can change the fleet while the gateway's probe is in flight.
  class GatedClient extends ScriptedWorkerClient {
    release: () => void = () => {};
    readonly #gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });

    override async requestLease(
      input: Parameters<ScriptedWorkerClient["requestLease"]>[0],
      options?: Parameters<ScriptedWorkerClient["requestLease"]>[1],
    ) {
      await this.#gate;
      return super.requestLease(input, options);
    }
  }

  function atRamBudget(): ReturnType<typeof statusFixture>["capacity"] {
    const capacity = statusFixture().capacity;
    return { ...capacity, ios: { ...capacity.ios, atRamBudget: true } };
  }

  function noCapacity(details?: unknown) {
    return {
      error: new SimlockError("NO_CAPACITY", "domain", "full", details as never),
      kind: "error" as const,
    };
  }

  function fleet(
    ids: readonly string[],
    setup: (id: string) => Parameters<typeof connectWorker>[2] = () => ({}),
    gated: readonly string[] = [],
  ) {
    const fleetHarness = harness();
    const clients: Record<string, ScriptedWorkerClient> = {};
    for (const id of ids) {
      const client = gated.includes(id) ? new GatedClient() : new ScriptedWorkerClient();
      clients[id] = client;
      fleetHarness.directory.add(id, client);
      connectWorker(fleetHarness.workers, id, setup(id));
    }
    return { clients, ...fleetHarness };
  }

  async function ask(
    coordinator: FleetLeaseCoordinator,
    request: Parameters<FleetLeaseCoordinator["request"]>[0] = REQUEST,
    options: Parameters<typeof requestOptions>[0] = {},
  ) {
    const outcome = coordinator.request(request, requestOptions(options));
    const ended = outcome.catch((error: unknown) => error);
    const state = promiseState(outcome);
    await tick();
    return { ended, outcome, state };
  }

  const listed = (coordinator: FleetLeaseCoordinator, index = 0): Reasons | undefined =>
    (coordinator.waitingRequests()[index] as { workers?: Reasons } | undefined)?.workers;

  const saturatedExcept = (free: string) => (id: string) =>
    id === free ? {} : { capacity: saturatedIos() };

  it("lists, in worker id order, drained for a drained worker and full with platform-running-limit for one with no free iOS slot, also when it has no free global slot either", async () => {
    const capacity = statusFixture().capacity;
    const bothFull = {
      ...saturatedIos(),
      global: { ...capacity.global, maxRunning: 0 },
    };
    const { coordinator, workers } = fleet(["wrk_c", "wrk_b", "wrk_a"], (id) =>
      id === "wrk_b" ? { capacity: saturatedIos() } : id === "wrk_c" ? { capacity: bothFull } : {},
    );
    await workers.setDrained("wrk_a", true);

    await ask(coordinator);

    expect(listed(coordinator)).toEqual([
      { reason: "drained", workerId: "wrk_a" },
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_b" },
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_c" },
    ]);
  });

  it("lists full with global-running-limit for a worker with a free iOS slot and no free global slot", async () => {
    const capacity = statusFixture().capacity;
    const { coordinator } = fleet(["wrk_a", "wrk_b"], (id) =>
      id === "wrk_a"
        ? { capacity: { ...capacity, global: { ...capacity.global, maxRunning: 0 } } }
        : { capacity: saturatedIos() },
    );

    await ask(coordinator);

    expect(listed(coordinator)?.[0]).toEqual({
      capacityReason: "global-running-limit",
      reason: "full",
      workerId: "wrk_a",
    });
  });

  it("lists one entry for every known view, a disconnected and an incompatible one included, and none for a worker removed", async () => {
    const { coordinator, workers } = fleet(["wrk_a", "wrk_b"], (id) =>
      id === "wrk_a" ? { capacity: saturatedIos() } : {},
    );
    workers.incompatible(
      "wrk_c",
      undefined,
      { gateway: { max: 20, min: 20 }, worker: { max: 4, min: 4 } },
      "0.2.0",
    );
    workers.disconnected("wrk_b");

    await ask(coordinator);

    expect(listed(coordinator)).toEqual([
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_a" },
      { reason: "disconnected", workerId: "wrk_b" },
      { reason: "incompatible", workerId: "wrk_c" },
    ]);

    await workers.remove("wrk_b");
    await tick();

    expect(listed(coordinator)?.map((entry) => entry.workerId)).toEqual(["wrk_a", "wrk_c"]);
  });

  it.each([
    [
      "platform-running-limit",
      { capacityReason: "platform-running-limit" },
      "platform-running-limit",
    ],
    ["none", {}, undefined],
    ["bogus", { capacityReason: "bogus" }, undefined],
    ["a number", { capacityReason: 42 }, undefined],
  ])(
    "lists a worker that answered NO_CAPACITY with capacityReason %s as full, with the reason only when it is one of the four",
    async (_label, details, expected) => {
      const { clients, coordinator } = fleet(["wrk_a"]);
      clients["wrk_a"]?.requestLeaseQueue.push(noCapacity(details));

      await ask(coordinator);

      expect(listed(coordinator)).toEqual([
        {
          reason: "full",
          workerId: "wrk_a",
          ...(expected === undefined ? {} : { capacityReason: expected }),
        },
      ]);
    },
  );

  it.each([
    ["UNKNOWN_MODEL", "unknown-model"],
    ["RUNTIME_MISSING", "runtime-missing"],
    ["NO_DRIVER", "no-driver"],
    ["CAPABILITY_MISSING", "capability-missing"],
  ] as const)("lists a worker that answered %s before progress as %s", async (code, reason) => {
    const { clients, coordinator } = fleet(["wrk_a", "wrk_b"], saturatedExcept("wrk_a"));
    clients["wrk_a"]?.requestLeaseQueue.push({
      error: new SimlockError(code, "domain", "cannot serve", {} as never),
      kind: "error",
    });

    await ask(coordinator);

    expect(listed(coordinator)).toEqual([
      { reason, workerId: "wrk_a" },
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_b" },
    ]);
  });

  it("lists a worker that granted another lease id than the one asked for as plain full", async () => {
    const { clients, coordinator } = fleet(["wrk_a"]);
    clients["wrk_a"]?.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          id: "not-what-was-sent",
          idChosenByRequester: true,
        } as LeaseRecord,
      }),
      kind: "grant",
    });

    await ask(coordinator, REQUEST, { leaseId: "myid" } as never);

    expect(listed(coordinator)).toEqual([{ reason: "full", workerId: "wrk_a" }]);
  });

  it("after a NO_CAPACITY re-queue and before any view change, recomputes every entry: the refused worker is full with its reason, one drained meanwhile is drained, one that lost to it is not-chosen", async () => {
    const { clients, coordinator, workers } = fleet(["wrk_a", "wrk_b", "wrk_c"], () => ({}), [
      "wrk_a",
    ]);
    clients["wrk_a"]?.requestLeaseQueue.push(noCapacity({ capacityReason: "device-limit" }));

    await ask(coordinator);
    expect(coordinator.waitingRequests()[0]).toMatchObject({ stage: "starting" });
    await workers.setDrained("wrk_b", true);
    (clients["wrk_a"] as GatedClient).release();
    await tick();

    expect(coordinator.waitingRequests()[0]).toMatchObject({ stage: "queued" });
    expect(listed(coordinator)).toEqual([
      { capacityReason: "device-limit", reason: "full", workerId: "wrk_a" },
      { reason: "drained", workerId: "wrk_b" },
      { reason: "not-chosen", workerId: "wrk_c" },
    ]);
  });

  it("follows the latest walk: a worker drained lists drained, and once undrained and refused with no detail at its RAM budget it lists full with ram-budget", async () => {
    const { coordinator, workers } = fleet(["wrk_a", "wrk_b"], (id) =>
      id === "wrk_a" ? { capacity: atRamBudget() } : { capacity: saturatedIos() },
    );
    await workers.setDrained("wrk_a", true);

    await ask(coordinator);
    expect(listed(coordinator)?.[0]).toEqual({ reason: "drained", workerId: "wrk_a" });

    await workers.setDrained("wrk_a", false);
    await tick();

    expect(listed(coordinator)).toEqual([
      { capacityReason: "ram-budget", reason: "full", workerId: "wrk_a" },
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_b" },
    ]);
  });

  it("lists no workers for a starting request", async () => {
    const { clients, coordinator } = fleet(["wrk_a"]);
    clients["wrk_a"]?.requestLeaseQueue.push({ kind: "hang" });

    await ask(coordinator);

    expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "starting" })]);
    expect(coordinator.waitingRequests()[0]).not.toHaveProperty("workers");
  });

  it("lists a worker drained after it refused the request as drained, not as its remembered refusal", async () => {
    const { clients, coordinator, workers } = fleet(["wrk_a", "wrk_b"], saturatedExcept("wrk_a"));
    clients["wrk_a"]?.requestLeaseQueue.push(noCapacity({ capacityReason: "ram-budget" }));
    await ask(coordinator);
    expect(listed(coordinator)?.[0]).toEqual({
      capacityReason: "ram-budget",
      reason: "full",
      workerId: "wrk_a",
    });

    await workers.setDrained("wrk_a", true);
    await tick();

    expect(listed(coordinator)?.[0]).toEqual({ reason: "drained", workerId: "wrk_a" });
  });

  it("lists a refused worker whose view lost its free platform slot while the probe was in flight as full with platform-running-limit, not the reason it refused with", async () => {
    const { clients, coordinator, workers } = fleet(["wrk_a", "wrk_b"], saturatedExcept("wrk_a"), [
      "wrk_a",
    ]);
    clients["wrk_a"]?.requestLeaseQueue.push(noCapacity({ capacityReason: "ram-budget" }));
    await ask(coordinator);
    workers.refresh("wrk_a", { capacity: saturatedIos() });

    (clients["wrk_a"] as GatedClient).release();
    await tick();

    expect(listed(coordinator)?.[0]).toEqual({
      capacityReason: "platform-running-limit",
      reason: "full",
      workerId: "wrk_a",
    });
  });

  it("lists a worker claimed by an earlier request in the same walk as not-chosen for the later one, even at its RAM budget", async () => {
    const { clients, coordinator, workers } = fleet(["wrk_a"], () => ({
      capacity: saturatedIos(),
    }));
    clients["wrk_a"]?.requestLeaseQueue.push({ kind: "hang" });
    await ask(coordinator, REQUEST, { ownerId: "agent-1", requesterId: "agent-1" });
    await ask(coordinator, REQUEST, { ownerId: "agent-2", requesterId: "agent-2" });

    workers.refresh("wrk_a", { capacity: atRamBudgetRoomy() });
    await tick();

    expect(coordinator.waitingRequests().map((entry) => entry.stage)).toEqual([
      "starting",
      "queued",
    ]);
    expect(listed(coordinator, 1)).toEqual([{ reason: "not-chosen", workerId: "wrk_a" }]);

    function atRamBudgetRoomy() {
      const capacity = roomierIos();
      return { ...capacity, ios: { ...capacity.ios, atRamBudget: true } };
    }
  });

  it("lists no-free-physical for each worker of a physical request whose matching devices are not present, one entry per worker", async () => {
    const notPresent = (id: string) =>
      physicalDeviceFixture(id, "ready", { presence: { present: false, reason: "not-present" } });
    const { coordinator } = fleet(["wrk_a", "wrk_b"], (id) => ({
      devices: [notPresent(id === "wrk_a" ? "dev_p" : "dev_q")],
    }));

    await ask(coordinator, { physical: true, platform: "ios" });

    expect(listed(coordinator)).toEqual([
      { reason: "no-free-physical", workerId: "wrk_a" },
      { reason: "no-free-physical", workerId: "wrk_b" },
    ]);
  });

  it("lists disconnected for a target found unreachable at the attempt, after the request is queued again", async () => {
    const { coordinator, directory } = fleet(["wrk_a"]);
    directory.unreachable.add("wrk_a");

    await ask(coordinator);

    expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
    expect(listed(coordinator)).toEqual([{ reason: "disconnected", workerId: "wrk_a" }]);
  });

  describe("a worker that answers PROVISION_FAILED", () => {
    const provisionFailed = (message: string) => ({
      error: new SimlockError("PROVISION_FAILED", "domain", message, {}),
      kind: "error" as const,
    });

    it("is walked past: the next worker is asked and its grant settles the request", async () => {
      const { clients, coordinator } = fleet(["wrk_a", "wrk_b"]);
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));
      clients["wrk_b"]?.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      const { outcome, state } = await ask(coordinator);

      expect(state.state).toBe("fulfilled");
      expect((await outcome).lease.worker?.id).toBe("wrk_b");
    });

    it("rejects the request with PROVISION_FAILED and the last worker's message, and lists nothing, when every worker that could take it answered so", async () => {
      const { clients, coordinator } = fleet(["wrk_a", "wrk_b"]);
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));
      clients["wrk_b"]?.requestLeaseQueue.push(provisionFailed("worker b: boom"));

      const { ended, state } = await ask(coordinator);

      expect(state.state).toBe("rejected");
      expect(await ended).toMatchObject({ code: "PROVISION_FAILED", message: "worker b: boom" });
      expect(coordinator.waitingRequests()).toEqual([]);
      expect(coordinator.queueDepth).toBe(0);
    });

    it("leaves the request queued when the other worker is only full", async () => {
      const { clients, coordinator } = fleet(["wrk_a", "wrk_b"]);
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));
      clients["wrk_b"]?.requestLeaseQueue.push(noCapacity());

      const { state } = await ask(coordinator);

      expect(state.state).toBe("pending");
      expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
      expect(listed(coordinator)).toEqual([
        { reason: "not-chosen", workerId: "wrk_a" },
        { reason: "full", workerId: "wrk_b" },
      ]);
    });

    it.each([
      {
        build: () => {
          const built = fleet(["wrk_a"]);
          built.workers.connected("wrk_b", undefined, "0.3.0");
          return built;
        },
        row: "not ready, having read no capacity or catalog yet",
      },
      {
        build: () => {
          const built = fleet(["wrk_a", "wrk_b"]);
          built.workers.refresh("wrk_b", { health: "starting" });
          return built;
        },
        row: "unhealthy, still starting",
      },
      {
        build: () => fleet(["wrk_a", "wrk_b"], (id) => (id === "wrk_b" ? { queueDepth: 1 } : {})),
        row: "busy with a queue of its own",
      },
      {
        build: () => {
          const built = fleet(["wrk_a", "wrk_b"]);
          built.workers.refresh("wrk_b", {
            update: {
              forced: false,
              from: "0.3.0",
              stage: "installing",
              startedAt: 1,
              to: "0.4.0",
            },
          });
          return built;
        },
        row: "updating",
      },
    ])("leaves the request queued when the other worker is $row", async ({ build }) => {
      const { clients, coordinator } = build();
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));

      const { state } = await ask(coordinator);

      expect(state.state).toBe("pending");
      expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
    });

    it.each([
      {
        build: () => {
          const built = fleet(["wrk_a", "wrk_b"]);
          built.workers.disconnected("wrk_b");
          return built;
        },
        row: "disconnected",
      },
      {
        build: async () => {
          const built = fleet(["wrk_a", "wrk_b"]);
          await built.workers.setDrained("wrk_b", true);
          return built;
        },
        row: "drained",
      },
    ])(
      "rejects the request when the other worker is $row, which cannot take it",
      async ({ build }) => {
        const { clients, coordinator } = await build();
        clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));

        const { ended, state } = await ask(coordinator);

        expect(state.state).toBe("rejected");
        expect(await ended).toMatchObject({ code: "PROVISION_FAILED", message: "worker a: boom" });
      },
    );

    it("leaves the request queued when the other worker is full in its view, so the gateway never asks it", async () => {
      const { clients, coordinator } = fleet(["wrk_a", "wrk_b"], (id) =>
        id === "wrk_b" ? { capacity: saturatedIos() } : {},
      );
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));
      const untouched = noCapacity();
      clients["wrk_b"]?.requestLeaseQueue.push(untouched);

      const { state } = await ask(coordinator);

      expect(state.state).toBe("pending");
      expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
      expect(clients["wrk_b"]?.requestLeaseQueue).toEqual([untouched]);
    });

    it("leaves the request queued when the worker that is only full refused first and the one asked after a view change failed to provision", async () => {
      const { clients, coordinator, workers } = fleet(["wrk_a", "wrk_b"]);
      clients["wrk_a"]?.requestLeaseQueue.push(noCapacity());
      clients["wrk_b"]?.requestLeaseQueue.push(provisionFailed("worker b: boom"));
      const { state } = await ask(coordinator);

      workers.refresh("wrk_b", { capacity: roomierIos() });
      await tick();

      expect(state.state).toBe("pending");
      expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
    });
  });
});
