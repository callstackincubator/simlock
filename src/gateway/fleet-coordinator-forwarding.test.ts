import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { promiseState } from "../test-support/promise-state.js";
import {
  deviceFixture,
  grantFixture,
  noCapacityError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import {
  buildFleet,
  connectWorker,
  tick,
  REQUEST,
  saturatedIos,
  requestOptions,
} from "./test-fleet.js";

describe("FleetLeaseCoordinator dispatch", () => {
  it("bounds a forwarded lease.request against gateway.leaseRequestTimeoutMs when the worker never answers at all (P2, round 2 review)", async () => {
    const { clock, coordinator, directory, workers } = buildFleet({ leaseRequestTimeoutMs: 5_000 });
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
    const { clock, coordinator, directory, eventBus, workers } = buildFleet({
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, eventBus, directory, workers } = buildFleet();
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
    const { coordinator, directory, eventBus, workers } = buildFleet();
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
      const { coordinator, directory, eventBus, workers } = buildFleet();
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
    const { coordinator, directory, eventBus, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, eventBus, workers } = buildFleet();
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
    const { clock, coordinator, directory, eventBus, workers } = buildFleet();
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
    const { coordinator, directory, eventBus, workers } = buildFleet({
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
    const { coordinator, directory, eventBus, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
});
