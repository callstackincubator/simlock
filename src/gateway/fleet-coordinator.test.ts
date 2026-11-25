import { describe, expect, it } from "vitest";
import type { EventBus, EventMap } from "../bus/index.js";
import { SimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { RequesterAlreadyLeasedError } from "./queue.js";
import {
  deviceFixture,
  grantFixture,
  leaseFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import type { WorkerRegistry } from "./worker-registry.js";
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

describe("FleetLeaseCoordinator device mode", () => {
  it.each([
    ["full", "wrk_a_cold", "free-capacity"],
    ["slim", "wrk_z_slim", "warm-hit"],
  ] as const)(
    "routes a %s request to %s by the %s stage when the only warm device is slim and another worker has more room",
    async (mode, expectedWorker, expectedStage) => {
      const { coordinator, directory, eventBus, workers } = buildFleet();
      for (const id of ["wrk_a_cold", "wrk_z_slim"]) {
        const client = new ScriptedWorkerClient();
        client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
        directory.add(id, client);
      }
      connectWorker(workers, "wrk_a_cold", { capacity: roomierIos() });
      connectWorker(workers, "wrk_z_slim", {
        devices: [deviceFixture("dev_slim", "ready", "slim")],
      });
      const dispatched: { workerId: string; stage: string }[] = [];
      eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

      await coordinator.request({ ...REQUEST, mode }, requestOptions());

      expect(dispatched).toEqual([
        expect.objectContaining({ stage: expectedStage, workerId: expectedWorker }),
      ]);
    },
  );

  it.each([
    ["slim", { mode: "slim" as const }],
    ["full", { mode: "full" as const }],
  ])("forwards a request's mode %s to the worker unchanged", async (_label, mode) => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");

    await coordinator.request({ ...REQUEST, ...mode }, requestOptions());

    expect(client.lastRequestLeaseInput).toMatchObject(mode);
  });

  it("forwards no mode when the request named none, so the worker's default applies", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");

    await coordinator.request(REQUEST, requestOptions());

    expect(client.lastRequestLeaseInput).not.toHaveProperty("mode");
  });
});

describe("FleetLeaseCoordinator stored requests", () => {
  it("answers a repeat under the same key with the first grant, forwarding nothing a second time", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");
    const keyed = requestOptions({ idempotencyKey: "key-1" });

    const first = await coordinator.request(REQUEST, keyed);
    const repeat = await coordinator.request(REQUEST, keyed);

    expect(repeat.lease.id).toBe(first.lease.id);
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });

  it("keeps a request out of the granted state in its book until the granting worker's view has been read", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");
    let finishRead: () => void = () => {};
    directory.refreshGates.set("wrk_a", new Promise<void>((resolve) => (finishRead = resolve)));
    let requestId: string | undefined;

    const granting = coordinator.request(
      REQUEST,
      requestOptions({ onAdmitted: (id) => (requestId = id) }),
    );
    await tick();

    if (requestId === undefined) throw new Error("expected the request to be admitted");
    expect(coordinator.requests.get(requestId)?.record.state).not.toBe("granted");
    finishRead();
    await granting;
    await tick();
    expect(coordinator.requests.get(requestId)?.record.state).toBe("granted");
  });

  it("reads a request back through its in-memory book once the fleet grants it, and names it on lease.requested", async () => {
    const { coordinator, directory, eventBus, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");
    let requestId: string | undefined;

    const grant = await coordinator.request(
      REQUEST,
      requestOptions({ onAdmitted: (id) => (requestId = id) }),
    );
    await tick();

    if (requestId === undefined) throw new Error("expected the request to be admitted");
    expect(coordinator.requests.get(requestId)?.record).toMatchObject({
      grant: { lease: { id: grant.lease.id } },
      state: "granted",
    });
    expect(coordinator.requests.requestIdForLease(grant.lease.id)).toBe(requestId);
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "lease.requested")
        .map((event) => event.payload),
    ).toMatchObject([{ requestId }]);
  });
});

describe("drain and unreachable lifecycle (ADR §9/§28/§29, #119)", () => {
  async function excludedWorkerKeepsLeaseButGetsNoNewDispatch(
    exclude: (workers: WorkerRegistry) => unknown,
  ): Promise<void> {
    const { coordinator, directory, workers } = buildFleet();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    const saturated = { ...statusFixture().capacity.ios, maxRunning: 0, running: 0 };
    connectWorker(workers, "wrk_a", { capacity: { ...statusFixture().capacity, ios: saturated } });
    connectWorker(workers, "wrk_b");
    clientB.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const firstGrant = await coordinator.request(REQUEST, requestOptions());
    expect(firstGrant.lease.worker?.id).toBe("wrk_b");
    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    await exclude(workers);
    await coordinator.release(firstGrant.lease.id);
    expect(clientB.calls).toContain(`lease.release:${firstGrant.lease.id.replace("wrk_b.", "")}`);

    workers.refresh("wrk_a", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, maxRunning: 1 },
      },
    });
    clientA.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    clientB.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const secondGrant = await coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );

    expect(secondGrant.lease.worker?.id).toBe("wrk_a");
    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  }

  it.each([
    ["drained", (workers: WorkerRegistry) => workers.setDrained("wrk_b", true)],
    ["disconnected", (workers: WorkerRegistry) => workers.disconnected("wrk_b")],
  ] as const)(
    "keeps a %s worker's existing lease and sends it no new dispatch, while a sibling serves the next request (§9/§6/§28)",
    async (_label, exclude) => {
      await excludedWorkerKeepsLeaseButGetsNoNewDispatch(exclude);
    },
  );

  it("answers WORKER_UNREACHABLE for a forwarded device.exec on a worker the directory reports unreachable, never a success (§28)", async () => {
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
    directory.unreachable.add("wrk_a");

    const rejection = await coordinator
      .exec(
        { args: ["devices"], leaseId: "wrk_a.lse_1", tool: "adb" },
        {
          manageEventSubscription: () => undefined,
          via: "socket",
          principal: "agent-1",
          role: "agent",
        },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect(client.calls.filter((call) => call.startsWith("device.exec"))).toEqual([]);
  });

  it("a request dispatched to a worker whose uplink then drops: the client sees WORKER_UNREACHABLE, and the lease is not silently double-granted once the worker's view catches up (§29)", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      error: new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Connection lost", {}),
      kind: "error",
    });

    const rejection = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect(coordinator.queueDepth).toBe(0);

    workers.refresh("wrk_a", {
      leases: [
        {
          ...leaseFixture("lse_ghost", "dev_ghost"),
          ownerId: "agent-1",
          requesterId: `${GATEWAY_PREFIX}agent-1`,
        },
      ],
    });

    const rebuiltLeaseId = "wrk_a.lse_ghost";

    const retry = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    expect(retry).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((retry as RequesterAlreadyLeasedError).existingLeaseId).toBe(rebuiltLeaseId);
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });

  it("grants a requester a new lease once its only lease, on a disconnected worker, is past its last reported deadline (not one ms before it), still counts a lease past its deadline on a connected worker, and keeps the lease routable to its worker, and still counts a lease its worker's last view does not list (#984)", async () => {
    const { clock, coordinator, directory, leaseIndex, workers } = buildFleet();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a", {
      leases: [
        {
          ...leaseFixture("lse_old", "dev_old"),
          requesterId: `${GATEWAY_PREFIX}agent-1`,
          ttlDeadline: 900_001,
        },
      ],
    });
    connectWorker(workers, "wrk_b");
    connectWorker(workers, "wrk_c", {
      leases: [
        {
          ...leaseFixture("lse_conn", "dev_conn"),
          requesterId: `${GATEWAY_PREFIX}agent-2`,
          ttlDeadline: 1,
        },
      ],
    });
    workers.disconnected("wrk_a");
    directory.unreachable.add("wrk_a");

    clientB.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    clock.advance(900_000 - clock.now());
    const beforeDeadline = await coordinator
      .request(REQUEST, requestOptions({ noWait: true }))
      .catch((error: unknown) => error);
    expect(beforeDeadline).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((beforeDeadline as RequesterAlreadyLeasedError).existingLeaseId).toBe("wrk_a.lse_old");
    const connected = await coordinator
      .request(
        REQUEST,
        requestOptions({ noWait: true, ownerId: "agent-2", requesterId: "agent-2" }),
      )
      .catch((error: unknown) => error);
    expect(connected).toBeInstanceOf(RequesterAlreadyLeasedError);

    clock.advance(1);
    clientB.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const afterDeadline = await coordinator
      .request(REQUEST, requestOptions({ noWait: true }))
      .catch((error: unknown) => error);

    expect(afterDeadline).toMatchObject({ lease: { id: "wrk_b.lse_1", worker: { id: "wrk_b" } } });
    const routed = await coordinator.release("wrk_a.lse_old").catch((error: unknown) => error);
    expect(routed).toBeInstanceOf(DispatchError);
    expect((routed as DispatchError).code).toBe("WORKER_UNREACHABLE");

    connectWorker(workers, "wrk_d");
    leaseIndex.add({
      gatewayLeaseId: "wrk_d.lse_unlisted",
      grantedAt: 1,
      ownerId: "agent-3",
      requesterId: "agent-3",
      workerId: "wrk_d",
      workerLeaseId: "lse_unlisted",
    });
    workers.disconnected("wrk_d");
    const unlisted = await coordinator
      .request(
        REQUEST,
        requestOptions({ noWait: true, ownerId: "agent-3", requesterId: "agent-3" }),
      )
      .catch((error: unknown) => error);
    expect(unlisted).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((unlisted as RequesterAlreadyLeasedError).existingLeaseId).toBe("wrk_d.lse_unlisted");
  });
});

describe("FleetLeaseCoordinator: queue.changed", () => {
  function depths(eventBus: EventBus): number[] {
    return eventBus
      .replay()
      .filter((event) => event.event === "queue.changed")
      .map((event) => (event.payload as EventMap["queue.changed"]).depth);
  }

  it("emits queue.changed once when started, with the depth then", () => {
    const { coordinator, eventBus } = buildFleet();
    expect(depths(eventBus)).toEqual([]);

    coordinator.start();

    expect(depths(eventBus)).toEqual([0]);
  });

  it("emits queue.changed for the fleet queue when a request joins it and when it leaves, with the new depth", async () => {
    const { coordinator, directory, eventBus, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    coordinator.start();

    void coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
    await tick();
    expect(depths(eventBus)).toEqual([0, 1]);

    await coordinator.cancelPending("agent-1");

    expect(depths(eventBus)).toEqual([0, 1, 0]);
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "queue.changed")
        .map((event) => event.module),
    ).toEqual(["fleet-lease-coordinator", "fleet-lease-coordinator", "fleet-lease-coordinator"]);
  });
});
