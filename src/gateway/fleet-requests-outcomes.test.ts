import { describe, expect, it } from "vitest";
import type { EventBus, EventMap } from "../bus/index.js";
import type { LeaseRecord } from "../admin/index.js";
import { fromWireError, SimlockError } from "../contract/index.js";
import { promiseState } from "../test-support/promise-state.js";
import type { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import type { WorkerReportedLease } from "./lease-index.js";
import { grantFixture, leaseFixture, ScriptedWorkerClient, statusFixture } from "./test-support.js";
import {
  GATEWAY_PREFIX,
  buildFleet,
  connectWorker,
  tick,
  REQUEST,
  saturatedIos,
  roomierIos,
  requestOptions,
} from "./test-fleet.js";

describe("FleetLeaseCoordinator records every fleet request's outcome (ADR 0021)", () => {
  function oneWorker(overrides: Parameters<typeof buildFleet>[0] = {}) {
    const fleet = buildFleet(overrides);
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
    const fleet = buildFleet();
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

describe("FleetLeaseCoordinator: a lease.cancel sent right after its lease.request (#1492)", () => {
  it.each([
    { fleetHas: "no room, so the request would queue", room: false },
    { fleetHas: "a free worker, so the request would be dispatched", room: true },
  ])(
    "with $fleetHas, answers cancelled, rejects the request as cancelled, and leaves nothing waiting and nothing dispatched",
    async ({ room }) => {
      const fleet = buildFleet();
      const client = new ScriptedWorkerClient();
      fleet.directory.add("wrk_a", client);
      connectWorker(fleet.workers, "wrk_a");
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      await fleet.coordinator.request(REQUEST, requestOptions());
      connectWorker(fleet.workers, "wrk_a", { capacity: room ? roomierIos() : saturatedIos() });
      client.requestLeaseQueue.push({
        grant: grantFixture({ lease: leaseFixture("lease-2", "dev_2") }),
        kind: "grant",
      });

      const request = fleet.coordinator
        .request(REQUEST, requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }))
        .then(
          () => "granted",
          (error: unknown) => error,
        );
      const cancel = fleet.coordinator.cancelPending("agent-2");

      await expect(cancel).resolves.toBe("cancelled");
      await expect(request).resolves.toMatchObject({ name: "RequestCancelledError" });
      await tick();
      expect(fleet.coordinator.waitingRequests()).toEqual([]);
      expect(
        client.calls.filter((call) => call === `lease.request:${GATEWAY_PREFIX}agent-2`),
      ).toEqual([]);
    },
  );
});
