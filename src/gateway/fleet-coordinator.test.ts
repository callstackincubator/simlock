import { describe, expect, it } from "vitest";
import type { EventBus, EventMap } from "../bus/index.js";
import type { LeaseRecord } from "../admin/index.js";
import { SimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { promiseState } from "../test-support/promise-state.js";
import type { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import { RequesterAlreadyLeasedError } from "./queue.js";
import { createRoutingPolicy } from "./index.js";
import {
  deviceFixture,
  grantFixture,
  leaseFixture,
  noCapacityError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import type { WorkerRegistry } from "./worker-registry.js";
import {
  GATEWAY_PREFIX,
  harness,
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
      const { coordinator, directory, eventBus, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");

    await coordinator.request({ ...REQUEST, ...mode }, requestOptions());

    expect(client.lastRequestLeaseInput).toMatchObject(mode);
  });

  it("forwards no mode when the request named none, so the worker's default applies", async () => {
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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

  it("reads a request back through its in-memory book once the fleet grants it, and names it on lease.requested", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
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

describe("FleetLeaseCoordinator dispatch", () => {
  it("grants a queued request from whichever worker frees first -- never dispatching to the one routing did not prefer", async () => {
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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
    const { clock, coordinator, directory, workers } = harness({ leaseRequestTimeoutMs: 5_000 });
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
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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
    const { clock, coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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
      const { coordinator, directory, eventBus, workers } = harness();
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

  it("bounds a forwarded lease.request against gateway.leaseRequestTimeoutMs when the worker never answers at all (P2, round 2 review)", async () => {
    const { clock, coordinator, directory, workers } = harness({ leaseRequestTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ kind: "hang" });

    const request = coordinator.request(REQUEST, requestOptions());
    const requestState = promiseState(request);
    const rejection = request.catch((error: unknown) => error);
    await tick();
    expect(coordinator.queueDepth).toBe(0);
    expect(directory.refreshCalls).toEqual([]);

    clock.advance(4_999);
    await tick();
    expect(requestState.state).toBe("pending");

    clock.advance(1);
    await tick();
    expect(requestState.state).toBe("rejected");
    const error = await rejection;

    expect(error).toBeInstanceOf(DispatchError);
    expect((error as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect(coordinator.queueDepth).toBe(0);
  });

  it("does not emit request.dispatched for a progress push that arrives after gateway.leaseRequestTimeoutMs already rejected the waiter (P4, round 3 review)", async () => {
    const { clock, coordinator, directory, eventBus, workers } = harness({
      leaseRequestTimeoutMs: 5_000,
    });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ kind: "hang" });
    const events: string[] = [];
    eventBus.subscribe("request.dispatched", () => events.push("request.dispatched"));
    eventBus.subscribe("lease.rejected", () => events.push("lease.rejected"));

    const request = coordinator.request(REQUEST, requestOptions());
    const requestState = promiseState(request);
    const rejection = request.catch((error: unknown) => error);
    await tick();

    clock.advance(5_000);
    await tick();
    expect(requestState.state).toBe("rejected");
    const error = await rejection;
    expect((error as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect(events).toEqual(["lease.rejected"]);

    client.lastRequestLeaseOptions?.onProgress?.({ etaMs: 5_000, stage: "provisioning" });
    await tick();

    expect(events).toEqual(["lease.rejected"]);
  });

  it("passes over a request only a busy worker can serve instead of blocking behind it, and never lets a brand-new admission jump an older, equally-eligible waiter still queued behind it (C2, round 3 review)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_ios", client);
    directory.add("wrk_android", new ScriptedWorkerClient());
    client.requestLeaseQueue.push({ kind: "hang" });

    const capacity = statusFixture().capacity;
    connectWorker(workers, "wrk_ios", { capacity: saturatedIos() });
    connectWorker(workers, "wrk_android", {
      capacity: { ...capacity, android: { ...capacity.android, maxRunning: 0 } },
      models: ["Pixel 9"],
      platform: "android",
    });
    const androidPromise = coordinator.request(
      { model: "Pixel 9", platform: "android" },
      requestOptions({ ownerId: "agent-android", requesterId: "agent-android" }),
    );
    const oldFirstPromise = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-old-1", requesterId: "agent-old-1" }),
    );
    const oldSecondPromise = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-old-2", requesterId: "agent-old-2" }),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(3);

    workers.refresh("wrk_ios", { capacity: statusFixture().capacity });
    await tick();
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    let androidSettled = false;
    void androidPromise.then(
      () => {
        androidSettled = true;
      },
      () => {
        androidSettled = true;
      },
    );
    await tick();
    expect(androidSettled).toBe(false);

    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const newPromise = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-new", requesterId: "agent-new" }),
    );
    await tick();

    const leaseRequests = client.calls.filter((call) => call.startsWith("lease.request"));
    expect(leaseRequests.length).toBeGreaterThanOrEqual(2);
    expect(leaseRequests[1]).toContain("agent-old-2");

    const oldSecondGrant = await oldSecondPromise;
    expect(oldSecondGrant.lease.worker?.id).toBe("wrk_ios");
    expect(androidSettled).toBe(false);
    void oldFirstPromise;
    void newPromise;
  });

  it("indexes a fresh grant under the ownerId it forwarded, not the worker's own echo of it (H6)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          ownerId: "worker-rewrote-this",
        },
      }),
      kind: "grant",
    });

    const grant = await coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-1", requesterId: "agent-1" }),
    );

    expect(coordinator.ownerId(grant.lease.id)).toBe("agent-1");
    expect(grant.lease.ownerId).toBe("agent-1");
  });

  it("emits request.dispatched on the worker's first progress push even when the request never settles at all (§11, C4 round 2 review)", async () => {
    const { coordinator, eventBus, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      kind: "hang",
      progress: [{ etaMs: 5_000, stage: "provisioning" }],
    });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    let settled = false;
    void coordinator.request(REQUEST, requestOptions()).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await tick();

    expect(settled).toBe(false);
    expect(dispatched).toEqual([
      {
        model: "iPhone 17",
        platform: "ios",
        queuedMs: expect.any(Number) as number,
        reason: "free-capacity",
        requestId: expect.any(String) as string,
        requesterId: "agent-1",
        stage: "free-capacity",
        workerId: "wrk_a",
      },
    ]);
  });

  it("emits request.dispatched exactly once, on the worker's first progress push, not again when the grant lands afterward (§11)", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture(),
      kind: "grant",
      progress: [
        { etaMs: 5_000, stage: "provisioning" },
        { etaMs: 1_000, stage: "booting" },
      ],
    });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    const grant = await coordinator.request(REQUEST, requestOptions());

    expect(dispatched).toEqual([
      {
        model: "iPhone 17",
        platform: "ios",
        queuedMs: expect.any(Number) as number,
        reason: "free-capacity",
        requestId: expect.any(String) as string,
        requesterId: "agent-1",
        stage: "free-capacity",
        workerId: "wrk_a",
      },
    ]);
    expect(grant.lease.worker?.id).toBe("wrk_a");
  });

  it.each(["full", "slim"] as const)(
    "request.dispatched carries the requested mode %s",
    async (mode) => {
      const { coordinator, directory, eventBus, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      client.requestLeaseQueue.push({
        grant: grantFixture(),
        kind: "grant",
        progress: [{ etaMs: 5_000, stage: "provisioning" }],
      });
      const dispatched: unknown[] = [];
      eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

      await coordinator.request({ ...REQUEST, mode }, requestOptions());

      expect(dispatched).toEqual([expect.objectContaining({ mode })]);
    },
  );

  it("request.dispatched carries no mode and no physical key for a plain virtual request", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const dispatched: object[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    await coordinator.request(REQUEST, requestOptions());

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).not.toHaveProperty("mode");
    expect(dispatched[0]).not.toHaveProperty("physical");
  });

  it("relays a worker's downloading pushes to the requester unchanged", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    const pushed = [
      { component: "26.4", stage: "downloading", waiting: true },
      { component: "26.4", stage: "downloading", waiting: false },
      { component: "26.4", percent: 41, stage: "downloading", waiting: false },
      { etaMs: 5_000, stage: "provisioning" },
    ] as const;
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant", progress: pushed });
    const heard: unknown[] = [];

    await coordinator.request(
      REQUEST,
      requestOptions({ allowDownload: true, onProgress: (progress) => heard.push(progress) }),
    );

    expect(heard).toEqual(pushed);
  });

  it("emits request.dispatched when a grant lands with no progress push at all -- the ADR §11 rule's other half", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    await coordinator.request(REQUEST, requestOptions());

    expect(dispatched).toEqual([
      {
        model: "iPhone 17",
        platform: "ios",
        queuedMs: expect.any(Number) as number,
        reason: "free-capacity",
        requestId: expect.any(String) as string,
        requesterId: "agent-1",
        stage: "free-capacity",
        workerId: "wrk_a",
      },
    ]);
  });

  it("reports request.dispatched's reason as warm-hit when routing picked the worker for an unleased ready device, and queuedMs as the real wait (C2, round 2 review)", async () => {
    const { clock, coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    const noFree = { ...statusFixture().capacity.ios, maxRunning: 0, running: 0 };
    connectWorker(workers, "wrk_a", { capacity: { ...statusFixture().capacity, ios: noFree } });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    clock.advance(2_500);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    workers.refresh("wrk_a", {
      capacity: { ...statusFixture().capacity, ios: { ...noFree, maxRunning: 5 } },
      devices: [deviceFixture("dev_1", "ready")],
    });

    await grantPromise;

    expect(dispatched).toEqual([
      {
        model: "iPhone 17",
        platform: "ios",
        queuedMs: 2_500,
        reason: "warm-hit",
        requestId: expect.any(String) as string,
        requesterId: "agent-1",
        stage: "warm-hit",
        workerId: "wrk_a",
      },
    ]);
  });

  it("request.dispatched carries the routing decision's stage name and reason", async () => {
    const { coordinator, directory, eventBus, workers } = harness({
      routing: () => ({
        assess: () => ({ kind: "route-or-wait" }),
        explain: () => [],
        select: (_request, views) =>
          views[0] === undefined
            ? undefined
            : { reason: "warm-hit", stage: "test-rank", workerId: views[0].id },
      }),
    });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    await coordinator.request(REQUEST, requestOptions());

    expect(dispatched).toEqual([
      expect.objectContaining({ reason: "warm-hit", stage: "test-rank", workerId: "wrk_a" }),
    ]);
  });

  it("does not emit request.dispatched for a stale-view NO_CAPACITY -- the request stayed queued, never actually dispatched", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    void coordinator.request(REQUEST, requestOptions());
    await tick();

    expect(dispatched).toEqual([]);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("handles a worker's DAEMON_UPDATING answer as NO_CAPACITY: the view is read again, the request stays queued and is placed once the view changes", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      error: new SimlockError("DAEMON_UPDATING", "domain", "The daemon is updating", {}),
      kind: "error",
    });
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const outcome = coordinator.request(REQUEST, requestOptions());
    const state = promiseState(outcome);
    await tick();

    expect(state.state).toBe("pending");
    expect(coordinator.queueDepth).toBe(1);
    expect(directory.refreshCalls).toEqual(["wrk_a"]);

    workers.refresh("wrk_a", {
      update: { forced: false, from: "0.3.0", stage: "installing", startedAt: 1, to: "0.4.0" },
    });
    await tick();
    expect(state.state).toBe("pending");

    workers.refresh("wrk_a", { update: null });
    await tick();

    expect((await outcome).lease.worker?.id).toBe("wrk_a");
  });

  it("forwards device.exec with the namespaced requesterId reaching the scripted worker client", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          id: "lse_9",
          ownerId: "agent-1",
          requesterId: `${GATEWAY_PREFIX}agent-1`,
        },
      }),
      kind: "grant",
    });

    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ exitCode: 0, kind: "ok" });

    await coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent-1",
        role: "agent",
      },
    );

    expect(client.calls).toContain(`device.exec:${GATEWAY_PREFIX}agent-1`);
  });

  it("announces started from the worker's own push, before any output (ADR §19a)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({
      exitCode: 0,
      kind: "ok",
      output: [{ chunk: "hi", stream: "stdout" }],
      started: true,
    });

    const order: string[] = [];
    await coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onOutput: () => {
          order.push("output");
        },
        onStarted: () => {
          order.push("started");
        },
        principal: "agent-1",
        role: "agent",
      },
    );

    expect(order).toEqual(["started", "output"]);
    expect(client.calls).toContain(`device.exec:${GATEWAY_PREFIX}agent-1`);
  });

  it.each([
    ["an empty queue", 0],
    ["another request queued", 1],
  ] as const)(
    "rejects a noWait request refused by its only worker with NO_CAPACITY and lease.rejected no-wait, refreshes that worker's view, and never queues it (no lease.queued, no queued progress), with %s -- the answer does not depend on queue depth (ADR §10, architecture rule 10)",
    async (_queue, queued) => {
      const { coordinator, directory, eventBus, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      if (queued > 0) {
        client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
        await coordinator.request(REQUEST, requestOptions());
        void coordinator.request(
          REQUEST,
          requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
        );
        await tick();
      }
      expect(coordinator.queueDepth).toBe(queued);
      const rejected: unknown[] = [];
      eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
      const events: string[] = [];
      eventBus.subscribe("lease.queued", () => events.push("lease.queued"));
      eventBus.subscribe("lease.rejected", () => events.push("lease.rejected"));
      const progress: string[] = [];
      const refreshesBefore = directory.refreshCalls.length;

      const refused = coordinator.request(
        REQUEST,
        requestOptions({
          noWait: true,
          onProgress: (update) => progress.push(update.stage),
          ownerId: "agent-3",
          requesterId: "agent-3",
        }),
      );
      const refusedState = promiseState(refused);
      await tick();

      expect(refusedState.state).toBe("rejected");
      await expect(refused).rejects.toMatchObject({ code: "NO_CAPACITY" });
      expect(client.calls).toContain(`lease.request:${GATEWAY_PREFIX}agent-3`);
      expect(rejected).toEqual([expect.objectContaining({ reason: "no-wait" })]);
      expect(events).toEqual(["lease.rejected"]);
      expect(progress).toEqual([]);
      expect(directory.refreshCalls.slice(refreshesBefore)).toEqual(["wrk_a"]);
      expect(coordinator.queueDepth).toBe(queued);
    },
  );

  it("relays the worker's own started push for a silent command that never answers (ADR §19a/§19b/§19e)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ kind: "hang", started: true });

    let started = false;
    void coordinator.exec(
      { args: ["install", "/path/to.app"], leaseId: grant.lease.id, tool: "simctl" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onStarted: () => {
          started = true;
        },
        principal: "agent-1",
        role: "agent",
      },
    );
    await tick();

    expect(started).toBe(true);
  });

  it("does not announce started for a command the worker refuses before any process exists -- a pre-process refusal keeps its own real status (ADR §19a′)", async () => {
    const { clock, coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({
      error: new SimlockError("FORBIDDEN", "domain", "Lease belongs to a different requester", {}),
      kind: "error",
    });

    let started = false;
    const rejection = await coordinator
      .exec(
        { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
        {
          manageEventSubscription: () => undefined,
          via: "socket",
          onStarted: () => {
            started = true;
          },
          principal: "agent-1",
          role: "agent",
        },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("FORBIDDEN");
    expect(started).toBe(false);

    clock.advance(10_000);
    expect(started).toBe(false);
  });

  it("times out a forwarded device.exec after gateway.execTimeoutMs when the worker never answers at all (P5)", async () => {
    const { clock, coordinator, directory, workers } = harness({ execTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          id: "lse_9",
          ownerId: "agent-1",
          requesterId: `${GATEWAY_PREFIX}agent-1`,
        },
      }),
      kind: "grant",
    });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ kind: "hang" });

    const execution = coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent-1",
        role: "agent",
      },
    );
    const executionState = promiseState(execution);
    const rejection = execution.catch((error: unknown) => error);
    await tick();
    clock.advance(4_999);
    await tick();
    expect(executionState.state).toBe("pending");

    clock.advance(1);
    await tick();
    expect(executionState.state).toBe("rejected");
    const error = await rejection;
    expect(error).toBeInstanceOf(DispatchError);
    expect((error as DispatchError).code).toBe("EXEC_TIMEOUT");
  });

  it("times out a forwarded device.rotate after gateway.execTimeoutMs when the worker never answers", async () => {
    const { clock, coordinator, directory, workers } = harness({ execTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.hangingCalls.add("device.rotate");

    const rotation = coordinator.rotate(
      { leaseId: grant.lease.id, orientation: "landscape_left" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent-1",
        role: "agent",
      },
    );
    const rotationState = promiseState(rotation);
    const rejection = rotation.catch((error: unknown) => error);
    await tick();
    clock.advance(4_999);
    await tick();
    expect(rotationState.state).toBe("pending");

    clock.advance(1);
    await tick();
    expect(rotationState.state).toBe("rejected");
    const error = await rejection;
    expect(error).toBeInstanceOf(DispatchError);
    expect((error as DispatchError).code).toBe("EXEC_TIMEOUT");
  });

  it("stops relaying a worker's device.exec output once gateway.execTimeoutMs has already rejected the call (H4, round 3 review)", async () => {
    const { clock, coordinator, directory, workers } = harness({ execTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          id: "lse_9",
          ownerId: "agent-1",
          requesterId: `${GATEWAY_PREFIX}agent-1`,
        },
      }),
      kind: "grant",
    });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ kind: "hang" });

    const relayed: Array<{ stream: string; chunk: string }> = [];
    const execution = coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onOutput: (stream, chunk) => {
          relayed.push({ chunk, stream });
        },
        principal: "agent-1",
        role: "agent",
      },
    );
    const executionState = promiseState(execution);
    const rejection = execution.catch((error: unknown) => error);
    await tick();
    clock.advance(5_000);
    await tick();
    expect(executionState.state).toBe("rejected");
    const error = await rejection;
    expect((error as DispatchError).code).toBe("EXEC_TIMEOUT");

    client.lastExecOptions?.onOutput?.({ chunk: "late output", stream: "stdout" });
    await tick();

    expect(relayed).toEqual([]);
  });

  it("does not announce started from a worker frame that arrives after gateway.execTimeoutMs already rejected the call (H4, round 6 review)", async () => {
    const { clock, coordinator, directory, workers } = harness({ execTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ kind: "hang" });

    let startedCount = 0;
    const execution = coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onStarted: () => {
          startedCount += 1;
        },
        principal: "agent-1",
        role: "agent",
      },
    );
    const executionState = promiseState(execution);
    const rejection = execution.catch((error: unknown) => error);
    await tick();
    clock.advance(5_000);
    await tick();
    expect(executionState.state).toBe("rejected");
    const error = await rejection;
    expect((error as DispatchError).code).toBe("EXEC_TIMEOUT");

    client.lastExecOptions?.onStarted?.();
    await tick();

    expect(startedCount).toBe(0);
  });

  it("announces started once even if the worker sends the frame more than once", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ exitCode: 0, kind: "ok", started: true });

    let startedCount = 0;
    await coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onStarted: () => {
          startedCount += 1;
        },
        principal: "agent-1",
        role: "agent",
      },
    );
    client.lastExecOptions?.onStarted?.();
    await tick();

    expect(startedCount).toBe(1);
  });

  it("runs another pass for a view change raised from inside the walk, rather than dropping it (round 4 finding 6, round 6 review)", async () => {
    let selectCalls = 0;
    const { coordinator, directory, workers } = harness({
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
      const { coordinator, directory, workers } = harness();
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
      const { coordinator, directory, workers, leaseIndex } = harness();
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
      const { coordinator, directory, workers, leaseIndex } = harness();
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
    const { coordinator, directory, workers, leaseIndex } = harness();
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
    const { coordinator, directory, workers } = harness();
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
    const { coordinator, directory, workers } = harness();
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
      const { coordinator, directory, workers, leaseIndex } = harness();
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
    const { coordinator, directory, workers, leaseIndex } = harness();
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

describe("drain and unreachable lifecycle (ADR §9/§28/§29, #119)", () => {
  async function excludedWorkerKeepsLeaseButGetsNoNewDispatch(
    exclude: (workers: WorkerRegistry) => unknown,
  ): Promise<void> {
    const { coordinator, directory, leaseIndex, workers } = harness();
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
    expect(leaseIndex.resolve(firstGrant.lease.id)).toBeDefined();

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

  it("keeps a drained worker's existing lease and sends it no new dispatch, while an undrained sibling serves the next request (§9)", async () => {
    await excludedWorkerKeepsLeaseButGetsNoNewDispatch((workers) =>
      workers.setDrained("wrk_b", true),
    );
  });

  it("keeps a disconnected worker's existing lease and sends it no new dispatch, while a connected sibling serves the next request (§6/§28)", async () => {
    await excludedWorkerKeepsLeaseButGetsNoNewDispatch((workers) => workers.disconnected("wrk_b"));
  });

  it("answers WORKER_UNREACHABLE for a forwarded device.exec on a worker the directory reports unreachable, never a success (§28)", async () => {
    const { coordinator, directory, workers, leaseIndex } = harness();
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
    const { coordinator, directory, workers } = harness();
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
    const { clock, coordinator, directory, leaseIndex, workers } = harness();
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
    expect(leaseIndex.resolve("wrk_a.lse_old")).toMatchObject({
      requesterId: "agent-1",
      workerId: "wrk_a",
    });

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
    const { coordinator, eventBus } = harness();
    expect(depths(eventBus)).toEqual([]);

    coordinator.start();

    expect(depths(eventBus)).toEqual([0]);
  });

  it("emits queue.changed for the fleet queue when a request joins it and when it leaves, with the new depth", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
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
