import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { SimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { FakeClock } from "../ports/index.js";
import type { WorkerDirectory, WorkerDispatchTarget } from "./fleet-ports.js";
import { FleetLeaseCoordinator, NoCapacityError } from "./fleet-coordinator.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { RequesterAlreadyLeasedError } from "./queue.js";
import { createRoutingPolicy } from "./routing.js";
import {
  catalogFixture,
  deviceFixture,
  grantFixture,
  noCapacityError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { WorkerRegistry } from "./worker-registry.js";

const GATEWAY_PREFIX = "gw:instance-1:";

/** A `WorkerDirectory` a test populates by hand: one `ScriptedWorkerClient` per worker id, with
 * `reachable` and the `refresh()` call count independently controllable. */
class FakeDirectory implements WorkerDirectory {
  readonly clients = new Map<string, ScriptedWorkerClient>();
  readonly unreachable = new Set<string>();
  readonly refreshCalls: string[] = [];

  add(workerId: string, client: ScriptedWorkerClient): void {
    this.clients.set(workerId, client);
  }

  target(workerId: string): WorkerDispatchTarget | undefined {
    const client = this.clients.get(workerId);
    if (client === undefined) return undefined;
    const reachable = !this.unreachable.has(workerId);
    return {
      client: () => (reachable ? client.asClient() : undefined),
      reachable,
      refresh: async () => {
        this.refreshCalls.push(workerId);
      },
      workerId,
    };
  }
}

function harness() {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const workers = new WorkerRegistry({
    clock,
    eventBus,
    // ADR §15: the gateway's own cap, which `WorkerRegistry` warns against when a worker
    // reports a lower one. Nothing in this file exercises that warning -- the value only has
    // to exist, and is set high enough that no fixture here trips it.
    leaseMaxTtlMs: 4 * 60 * 60_000,
    retentionMs: 24 * 60 * 60_000,
  });
  const directory = new FakeDirectory();
  const leaseIndex = new FleetLeaseIndex(GATEWAY_PREFIX);
  const coordinator = new FleetLeaseCoordinator({
    clock,
    directory,
    eventBus,
    idGenerator: {
      generate: (() => {
        let next = 1;
        return () => `${next++}`;
      })(),
    },
    leaseIndex,
    routing: createRoutingPolicy("warm-then-free"),
    views: workers,
  });
  return { clock, coordinator, directory, eventBus, leaseIndex, workers };
}

/** Connects a worker with a catalog, capacity, and devices a test can override -- everything
 * defaults to "eligible for an iOS iPhone 17 request with free capacity". */
function connectWorker(
  workers: WorkerRegistry,
  workerId: string,
  overrides: {
    readonly label?: string;
    readonly models?: readonly string[];
    readonly platform?: "ios" | "android";
    readonly capacity?: ReturnType<typeof statusFixture>["capacity"];
    readonly devices?: ReturnType<typeof deviceFixture>[];
  } = {},
): void {
  workers.connected(workerId, overrides.label, "0.3.0");
  workers.refresh(workerId, {
    capacity: overrides.capacity ?? statusFixture().capacity,
    catalog: catalogFixture([
      {
        models: [...(overrides.models ?? ["iPhone 17"])],
        platform: overrides.platform ?? "ios",
        runtimes: ["26.0"],
      },
    ]).platforms,
    devices: overrides.devices ?? [],
    downloads: { policy: "on-request" },
    health: "running",
    leases: [],
    queueDepth: 0,
  });
}

/** Flushes enough microtasks for `SerializedDecision.run`'s chain (admission) and a fire-and-
 * forget dispatch attempt's own synchronous-until-the-RPC portion to have run, without waiting on
 * a real timer -- everything in this module is driven by `FakeClock` and in-memory promises, so
 * there is nothing a real clock tick would advance that this does not already cover. */
async function tick(times = 8): Promise<void> {
  for (let iteration = 0; iteration < times; iteration += 1) await Promise.resolve();
}

const REQUEST = { model: "iPhone 17", osVersion: "26.0", platform: "ios" as const };

function requestOptions(overrides: Partial<Parameters<FleetLeaseCoordinator["request"]>[1]> = {}) {
  return {
    allowDownload: false,
    noWait: false,
    ownerId: "agent-1",
    requesterId: "agent-1",
    ...overrides,
  };
}

describe("FleetLeaseCoordinator dispatch", () => {
  it("grants a queued request from whichever worker frees first -- never dispatching to the one routing did not prefer", async () => {
    const { coordinator, directory, workers } = harness();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    // Both start at zero free capacity, so the first look finds nobody and the request waits.
    // Worker A offers *more* running capacity than B -- if both had free room, routing would
    // prefer A (more free capacity wins the tie-break).
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

    // Worker B frees up (A stays saturated) -- the pass-over that grants it.
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
    // Worker A never answers -- the attempt this waiter is dispatched to stays in flight.
    clientA.requestLeaseQueue.push({ kind: "hang" });

    // No worker connected yet: admission's own first look finds nobody, so this waiter genuinely
    // enters the queue (`queue.list()`) rather than settling on the fast admission-time path --
    // exactly the shape a *second* dispatch pass (triggered below) would otherwise re-scan.
    void coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    connectWorker(workers, "wrk_a");
    await tick();
    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    // Worker B connects (also eligible for this request) *while A's attempt is still hanging* --
    // with strictly *more* free capacity than A, so routing would prefer B outright on a second
    // look. A dispatch loop that only checks `waiter.state !== "queued"` (and not
    // `#dispatchTargets`, or one that never left the waiter `processing` in the first place)
    // would pick the same still-visible waiter up again here and send it to B.
    connectWorker(workers, "wrk_b", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, maxRunning: 10 },
      },
    });
    await tick();

    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
  });

  it("leaves a request queued after a stale-view NO_CAPACITY even when the caller asked noWait: true, and refreshes that worker's view", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });

    const grantPromise = coordinator.request(REQUEST, requestOptions({ noWait: true }));
    let settled = false;
    void grantPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await tick();

    expect(settled).toBe(false);
    expect(coordinator.queueDepth).toBe(1);
    expect(directory.refreshCalls).toEqual(["wrk_a"]);

    // The refreshed view now has capacity, and this time the worker grants it.
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    workers.refresh("wrk_a", {}); // any refresh re-runs dispatch, exactly as a real one would

    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_a");
  });

  it("answers REQUESTER_ALREADY_LEASED naming the existing lease id, for an index built purely via rebuildFromWorker", async () => {
    const { coordinator, leaseIndex } = harness();
    // Simulates a gateway restart's reconnect rebuild (§30): this lease was never granted
    // through `coordinator.request` in this process at all.
    leaseIndex.rebuildFromWorker("wrk_a", [
      {
        grantedAt: 1,
        id: "lse_1",
        ownerId: "agent-9",
        requesterId: `${GATEWAY_PREFIX}agent-9`,
      },
    ]);

    const rejection = await coordinator
      .request(REQUEST, requestOptions({ ownerId: "agent-9", requesterId: "agent-9" }))
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((rejection as RequesterAlreadyLeasedError).existingLeaseId).toBe("wrk_a.lse_1");
  });

  it("passes over a request no worker can serve instead of blocking behind it, preserving queue order", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_ios", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    // Both requests are admitted with *no* worker connected yet, so both genuinely enter the
    // queue (oldest first: android, then iOS) rather than settling on the fast admission-time
    // path -- the single dispatch pass triggered below has to walk both in one go, which is
    // what actually exercises "passed over, not blocked on" (ADR §11).
    const androidPromise = coordinator.request(
      { model: "Pixel 9", platform: "android" },
      requestOptions({ ownerId: "agent-android", requesterId: "agent-android" }),
    );
    const iosPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(2);

    // The one worker that connects can only ever serve the iOS request -- an android-then-iOS
    // dispatch loop that gives up (or blocks) on the android waiter's own "no worker" answer
    // would never reach the iOS one behind it in this same pass.
    connectWorker(workers, "wrk_ios", { platform: "ios", models: ["iPhone 17"] });

    const iosGrant = await iosPromise;
    expect(iosGrant.lease.worker?.id).toBe("wrk_ios");

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
    expect(coordinator.queueDepth).toBe(1);
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
      { manageEventSubscription: () => undefined, principal: "agent-1", role: "agent" },
    );

    expect(client.calls).toContain(`device.exec:${GATEWAY_PREFIX}agent-1`);
  });

  it("rejects a no-wait request immediately with NoCapacityError when no worker is eligible at all", async () => {
    const { coordinator } = harness();

    await expect(
      coordinator.request(REQUEST, requestOptions({ noWait: true })),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("forwards a worker's own terminal refusal verbatim, as the worker's own error code", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      error: new SimlockError("RUNTIME_MISSING", "domain", "no such runtime", {
        downloadable: false,
        osVersion: "99.0",
        platform: "ios",
      }),
      kind: "error",
    });

    const rejection = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("RUNTIME_MISSING");
  });
});
