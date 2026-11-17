import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { promiseState } from "../test-support/promise-state.js";
import {
  grantFixture,
  noCapacityError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
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
  it("grants a queued request from whichever worker frees first -- never dispatching to the one routing did not prefer", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    const noFree = { ...statusFixture().capacity.android, maxRunning: 0, running: 0 };
    connectWorker(workers, "wrk_a", {
      capacity: { ...statusFixture().capacity, ios: { ...noFree, maxRunning: 5, running: 5 } },
    });
    connectWorker(workers, "wrk_b", {
      capacity: { ...statusFixture().capacity, ios: noFree },
    });

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    clientB.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    workers.refresh("wrk_b", {
      capacity: { ...statusFixture().capacity, ios: { ...noFree, maxRunning: 5, running: 0 } },
    });

    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_b");
    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });

  it("issues exactly one lease.request for a waiter still in flight, even when another worker's view changes mid-flight", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    clientA.requestLeaseQueue.push({ kind: "hang" });

    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    void coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();
    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    connectWorker(workers, "wrk_b", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, maxRunning: 10 },
      },
    });
    await tick();

    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
  });

  it("dispatches at most one queued waiter per worker per pass, rather than sending every queued waiter at a single over-reporting worker at once (H6, round 3 review)", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    const p1 = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-1", requesterId: "agent-1" }),
    );
    const p2 = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );
    const p3 = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-3", requesterId: "agent-3" }),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(3);

    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();

    const leaseRequests = client.calls.filter((call) => call.startsWith("lease.request"));
    expect(leaseRequests).toHaveLength(2);
    expect(leaseRequests[1]).toContain("agent-2");

    await expect(p1).resolves.toBeDefined();
    const outcome = await Promise.race([
      Promise.allSettled([p2, p3]).then(() => "settled" as const),
      tick(6).then(() => "still-pending" as const),
    ]);
    expect(outcome).toBe("still-pending");
    expect(coordinator.queueDepth).toBe(2);
    expect(directory.refreshCalls).toEqual(["wrk_a", "wrk_a"]);
  });

  it("gives a waiter passed over by the per-pass cap a guaranteed next look once the claiming attempt settles terminally, even when that failure produces no worker-side event at all (C1, round 3 review)", async () => {
    const { clock, coordinator, directory, workers } = buildFleet({ leaseRequestTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ kind: "hang" });
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    const w1Request = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-1", requesterId: "agent-1" }),
    );
    const w1State = promiseState(w1Request);
    const w1 = w1Request.catch((error: unknown) => error);
    const w2 = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(2);

    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    clock.advance(5_000);
    await tick();
    expect(w1State.state).toBe("rejected");
    const w1Error = await w1;
    expect(w1Error).toBeInstanceOf(DispatchError);
    expect((w1Error as DispatchError).code).toBe("WORKER_UNREACHABLE");

    const outcome = await Promise.race([
      w2.then(
        () => "resolved" as const,
        () => "resolved" as const,
      ),
      tick(6).then(() => "still-pending" as const),
    ]);
    expect(outcome).toBe("resolved");
    const w2Grant = await w2;
    expect(w2Grant.lease.worker?.id).toBe("wrk_a");
    expect(directory.refreshCalls).toEqual(["wrk_a"]);
  });

  it("re-dispatches a waiter whose attempt found a reachable-but-not-yet-connected target, instead of parking it forever", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    directory.reachableButNoClient.add("wrk_a");

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();

    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
    expect(coordinator.queueDepth).toBe(1);

    directory.reachableButNoClient.delete("wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    workers.refresh("wrk_a", {}); // any refresh re-runs dispatch, exactly as a real one would

    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(coordinator.queueDepth).toBe(0);
  });

  it("leaves a request queued after NO_CAPACITY, refreshes that worker's view, and tries it once more when a refresh changes its capacity", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();

    expect(coordinator.queueDepth).toBe(1);
    expect(directory.refreshCalls).toEqual(["wrk_a"]);

    const capacity = statusFixture().capacity;
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    workers.refresh("wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 3 } },
    });

    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(2);
  });

  it("sends a worker that keeps answering NO_CAPACITY with an unchanged view one lease.request for that request", async () => {
    const { clock, coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");

    void coordinator.request(REQUEST, requestOptions());
    await tick();
    for (let refresh = 0; refresh < 3; refresh += 1) {
      clock.advance(1_000); // a new lastSeenAt on every refresh, as a real one has
      workers.refresh("wrk_a", { capacity: statusFixture().capacity });
      await tick();
    }

    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("tries another eligible worker in the pass that follows a refusal", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const preferred = new ScriptedWorkerClient();
    const other = new ScriptedWorkerClient();
    directory.add("wrk_a", preferred);
    directory.add("wrk_b", other);
    const capacity = statusFixture().capacity;
    connectWorker(workers, "wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    connectWorker(workers, "wrk_b");
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(other.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);

    workers.refresh("wrk_a", {});

    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_b");
    expect(preferred.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });

  it("does not exclude a worker for another request because it refused one", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");

    void coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );

    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toEqual([
      `lease.request:${GATEWAY_PREFIX}agent-1`,
      `lease.request:${GATEWAY_PREFIX}agent-2`,
    ]);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("leaves a request queued when the worker that refused it left the views before the refusal arrived", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    const target = directory.target.bind(directory);
    directory.target = (workerId) => {
      const found = target(workerId);
      if (found === undefined) return undefined;
      return {
        ...found,
        client: () => {
          workers.disconnected(workerId);
          void workers.remove(workerId);
          return found.client();
        },
      };
    };

    void coordinator.request(REQUEST, requestOptions());
    await tick();

    expect(workers.views()).toEqual([]);
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("sends a queued noWait request refused by one worker to only one other worker in the next walk", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const first = new ScriptedWorkerClient();
    const second = new ScriptedWorkerClient();
    const third = new ScriptedWorkerClient();
    directory.add("wrk_a", first);
    directory.add("wrk_b", second);
    directory.add("wrk_c", third);
    const capacity = statusFixture().capacity;
    connectWorker(workers, "wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 6 } },
    });
    connectWorker(workers, "wrk_b", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    connectWorker(workers, "wrk_c", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    directory.reachableButNoClient.add("wrk_a");
    second.requestLeaseQueue.push({ kind: "hang" });
    third.requestLeaseQueue.push({ kind: "hang" });

    void coordinator.request(REQUEST, requestOptions({ noWait: true }));
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    directory.reachableButNoClient.delete("wrk_a");
    workers.refresh("wrk_a", {});
    await tick();

    const leaseRequests = (client: ScriptedWorkerClient) =>
      client.calls.filter((call) => call.startsWith("lease.request")).length;
    expect(leaseRequests(first)).toBe(1);
    expect(leaseRequests(second) + leaseRequests(third)).toBe(1);
  });

  it("grants a noWait request refused by one worker from another in the next walk", async () => {
    const { coordinator, directory, workers } = buildFleet();
    const preferred = new ScriptedWorkerClient();
    const other = new ScriptedWorkerClient();
    directory.add("wrk_a", preferred);
    directory.add("wrk_b", other);
    const capacity = statusFixture().capacity;
    connectWorker(workers, "wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    connectWorker(workers, "wrk_b");
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grant = await coordinator.request(REQUEST, requestOptions({ noWait: true }));

    expect(grant.lease.worker?.id).toBe("wrk_b");
    expect(preferred.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });

  it.each([
    { code: "NO_CAPACITY", error: noCapacityError() },
    {
      code: "RUNTIME_MISSING",
      error: new SimlockError("RUNTIME_MISSING", "domain", "no such runtime", {
        downloadable: false,
        osVersion: "26.0",
        platform: "ios",
      }),
    },
  ])(
    "terminally rejects, rather than re-queuing or asking another worker, a $code that arrives after progress already fired (P1, round 2 review)",
    async ({ code, error }) => {
      const { coordinator, directory, eventBus, workers } = buildFleet();
      const client = new ScriptedWorkerClient();
      const other = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      directory.add("wrk_b", other);
      connectWorker(workers, "wrk_a");
      connectWorker(workers, "wrk_b");
      client.requestLeaseQueue.push({
        error,
        kind: "error",
        progress: [{ etaMs: 5_000, stage: "reclaiming" }],
      });
      other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      const dispatched: unknown[] = [];
      eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

      const rejection = await coordinator
        .request(REQUEST, requestOptions())
        .catch((caught: unknown) => caught);

      expect(dispatched).toHaveLength(1);
      expect(rejection).toBeInstanceOf(DispatchError);
      expect((rejection as DispatchError).code).toBe(code);
      expect(coordinator.queueDepth).toBe(0);
      expect(directory.refreshCalls).toEqual([]);
      expect(other.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
    },
  );
});
