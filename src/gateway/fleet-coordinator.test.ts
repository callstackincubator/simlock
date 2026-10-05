import { describe, expect, it } from "vitest";

import { EventBus, type EventMap } from "../bus/index.js";
import { SimlockError } from "../contract/index.js";
import { QueueTimeoutError } from "../core/wait-queue.js";
import { DispatchError } from "../daemon/dispatch.js";
import { FakeClock, type Logger } from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";
import type { WorkerDirectory, WorkerDispatchTarget } from "./fleet-ports.js";
import { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { RequesterAlreadyLeasedError } from "./queue.js";
import { createRoutingPolicy, type RoutingPolicy } from "./routing.js";
import {
  catalogFixture,
  deviceFixture,
  grantFixture,
  leaseFixture,
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
  /** C1 (round 2 review): a worker id in here answers `reachable: true` but `client()`
   * `undefined` -- the real window `WorkerLink#reachable`/`#client` can disagree in, between a
   * reconnecting link's `#closed` clearing and its own handshake finishing (`#client` is not
   * assigned until `start()` completes). Distinct from `unreachable` above, which models
   * `reachable: false` instead -- a different code path in `#attempt`/`#forwardToWorker` that no
   * test previously exercised the *first* of the two ways. */
  readonly reachableButNoClient = new Set<string>();
  readonly refreshCalls: string[] = [];
  /** The workers whose refresh asked for the catalog too, in call order. */
  readonly catalogRefreshCalls: string[] = [];
  /** Workers whose refresh rejects. */
  readonly failingRefresh = new Set<string>();

  add(workerId: string, client: ScriptedWorkerClient): void {
    this.clients.set(workerId, client);
  }

  target(workerId: string): WorkerDispatchTarget | undefined {
    const client = this.clients.get(workerId);
    if (client === undefined) return undefined;
    const reachable = !this.unreachable.has(workerId);
    const hasClient = reachable && !this.reachableButNoClient.has(workerId);
    return {
      client: () => (hasClient ? client.asClient() : undefined),
      reachable,
      refresh: async (options) => {
        this.refreshCalls.push(workerId);
        if (options?.includeCatalog === true) this.catalogRefreshCalls.push(workerId);
        if (this.failingRefresh.has(workerId)) throw new Error("refresh failed");
      },
      workerId,
    };
  }
}

/** Records every `warn` call -- for H6's own test, which asserts a mismatched ownerId echo is
 * logged rather than silently swallowed. */
class RecordingLogger implements Logger {
  readonly warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  readonly debugs: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  debug(message: string, fields?: Record<string, unknown>): void {
    this.debugs.push(fields === undefined ? { message } : { fields, message });
  }
  info(): void {}
  warn(message: string, fields?: Record<string, unknown>): void {
    this.warnings.push(fields === undefined ? { message } : { fields, message });
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

function harness(
  overrides: {
    readonly execTimeoutMs?: number;
    readonly leaseRequestTimeoutMs?: number;
    readonly logger?: Logger;
    /** Built with the registry so a stub can change the views from inside the dispatch walk --
     * the one way to reach `#dispatch`'s re-entrancy guard. Defaults to the real policy. */
    readonly routing?: (workers: WorkerRegistry) => RoutingPolicy;
  } = {},
) {
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
    describeFailure: (error) => ({
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    }),
    leaseRequestLimits: { maxRecords: 10_000, retentionMs: 600_000 },
    eventBus,
    // Deliberately large by default -- P5's own test overrides this to something the FakeClock
    // can advance past inside the test, without every other test in this file needing to know
    // gateway.execTimeoutMs exists.
    execTimeoutMs: overrides.execTimeoutMs ?? 11 * 60_000,
    idGenerator: {
      generate: (() => {
        let next = 1;
        return () => `${next++}`;
      })(),
    },
    leaseIndex,
    // Deliberately large by default -- P2's own test overrides this the same way P5 does for
    // execTimeoutMs above.
    leaseRequestTimeoutMs: overrides.leaseRequestTimeoutMs ?? 5 * 60_000,
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    routing: overrides.routing?.(workers) ?? createRoutingPolicy("warm-then-free"),
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
async function tick(times = 16): Promise<void> {
  for (let iteration = 0; iteration < times; iteration += 1) await Promise.resolve();
}

const REQUEST = { model: "iPhone 17", osVersion: "26.0", platform: "ios" as const };

/** Capacity with no free iOS slot: a worker that can serve an iPhone 17 request and is busy. */
function saturatedIos(): ReturnType<typeof statusFixture>["capacity"] {
  const capacity = statusFixture().capacity;
  return { ...capacity, ios: { ...capacity.ios, maxRunning: 0 } };
}

/** Free iOS capacity that differs from the default, so a refresh with it is a changed view that
 * still takes requests -- unlike a queued waiter or a saturated slot, which a filter drops. */
function roomierIos(): ReturnType<typeof statusFixture>["capacity"] {
  const capacity = statusFixture().capacity;
  return { ...capacity, ios: { ...capacity.ios, maxRunning: 3 } };
}

function requestOptions(overrides: Partial<Parameters<FleetLeaseCoordinator["request"]>[1]> = {}) {
  return {
    allowDownload: false,
    noWait: false,
    ownerId: "agent-1",
    requesterId: "agent-1",
    ...overrides,
  };
}

describe("FleetLeaseCoordinator device mode", () => {
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

    // Worker A is connected but has no free slot: admission's own first look finds nobody to
    // send it to, so this waiter genuinely enters the queue (`queue.list()`) rather than settling
    // on the fast admission-time path -- exactly the shape a *second* dispatch pass (triggered
    // below) would otherwise re-scan.
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    void coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();
    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    // Worker B connects (also eligible for this request) *while A's attempt is still hanging* --
    // with strictly *more* free capacity than A, so routing would prefer B outright on a second
    // look. A dispatch loop that only checks `waiter.state !== "queued"` (and one that never
    // left the waiter `processing` in the first place, i.e. `#beginAttempt` calling
    // `queue.markProcessing` before the RPC starts) would pick the same still-visible waiter up
    // again here and send it to B. Round 2 review (C2): this test alone proves the state check
    // is what suppresses the second dispatch, not a second guard beside it -- reverting just
    // `queue.markProcessing(waiter)` in `#beginAttempt` (leaving the state check in `#dispatch`
    // untouched) makes this assertion fail.
    connectWorker(workers, "wrk_b", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, maxRunning: 10 },
      },
    });
    await tick();

    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
  });

  it("dispatches at most one queued waiter per worker per pass, rather than sending every queued waiter at a single over-reporting worker at once (H6, round 3 review)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    // Exactly one grant scripted -- every other forwarded lease.request answers
    // `requestLeaseDefault`'s own NO_CAPACITY, modelling a worker whose reported free capacity
    // (two full slots below) does not match what it can actually grant right now.
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    // Three requests queue up behind a worker with no free slot -- all genuinely `queued`, not
    // settled at admission.
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

    // The refresh below reports two free iOS slots -- on paper, room for two of
    // the three queued waiters above. Without the per-pass cap, `#dispatch`'s single pass would
    // run `routing.select` against this same unchanged view for every one of the three, pick
    // worker A for every one of them, and fire three concurrent `lease.request`s in this one pass.
    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();

    // Capped at one dispatch *per pass* -- but C1 (round 3 review) guarantees a fresh pass the
    // moment p1's own attempt settles, so p2 gets its own look right behind it (in this same
    // tick), rather than being stranded until "the next real view change" this test used to have
    // to wait forever for. p2's attempt still reads the same stale view (routing has no way to
    // know p1 already used the worker's one real slot) and is refused NO_CAPACITY in turn --
    // exactly the self-limiting RPC storm the module doc describes, not a second bug.
    const leaseRequests = client.calls.filter((call) => call.startsWith("lease.request"));
    expect(leaseRequests).toHaveLength(2);
    expect(leaseRequests[1]).toContain("agent-2");

    await expect(p1).resolves.toBeDefined();
    // p2's own attempt above already failed and re-queued it -- it is genuinely `queued` again,
    // not stuck `processing`. p3 was passed over by that *same* pass (only one worker, already
    // claimed for it once p2 claimed it) and is waiting for its own turn next -- neither granted
    // nor rejected, and never even attempted yet.
    const outcome = await Promise.race([
      Promise.allSettled([p2, p3]).then(() => "settled" as const),
      tick(6).then(() => "still-pending" as const),
    ]);
    expect(outcome).toBe("still-pending");
    expect(coordinator.queueDepth).toBe(2);
    // p2's own stale-view retry really ran the ordinary NO_CAPACITY path (refreshing the
    // worker's view), not merely stayed queued from before.
    expect(directory.refreshCalls).toEqual(["wrk_a"]);
  });

  it("gives a waiter passed over by the per-pass cap a guaranteed next look once the claiming attempt settles terminally, even when that failure produces no worker-side event at all (C1, round 3 review)", async () => {
    // The finding's own reproduction: a terminal failure other than an immediate NO_CAPACITY
    // (WORKER_UNREACHABLE here, via `leaseRequestTimeoutMs`) hits `#attempt`'s `queue.reject`
    // branch directly -- no `refresh()`, no worker event, nothing that `#staleView`'s own
    // self-heal depends on. Before this fix, nothing else ever scheduled another `#dispatch`
    // pass, so a waiter passed over in the same pass (H6's per-worker-per-pass cap) stalled
    // forever, reachable only by the unrelated 30s worker-refresh tick.
    const { clock, coordinator, directory, workers } = harness({ leaseRequestTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    // w1's own forwarded RPC never answers at all.
    client.requestLeaseQueue.push({ kind: "hang" });
    // w2's own eventual attempt, once it gets its turn.
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
    // H6's own per-pass cap: only w1 was attempted this pass, w2 passed over.
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    // w1's RPC settles terminally with WORKER_UNREACHABLE, never an immediate NO_CAPACITY -- so
    // `#staleView`'s own refresh-triggered self-heal never runs for it, and this test never
    // triggers any worker-view change of its own either.
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
    // The self-heal here is `#attempt`'s own guaranteed next pass, not a worker-view refresh.
    expect(directory.refreshCalls).toEqual([]);
  });

  it("re-dispatches a waiter whose attempt found a reachable-but-not-yet-connected target, instead of parking it forever", async () => {
    // C1 (round 2 review): the routine trigger is a worker reconnect -- `GatewayService#accept`
    // sets the new link in `#links` and calls `start()` before the handshake's `#client` is
    // assigned, so `directory.target(id)` answers `reachable: true` with `client()` still
    // `undefined` for a real window. `FakeDirectory#reachableButNoClient` reproduces exactly
    // that window without a real `WorkerLink`.
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    directory.reachableButNoClient.add("wrk_a");

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();

    // The attempt found no client to call at all -- nothing was ever sent to the worker, and the
    // waiter is back in the queue, not stuck `processing`.
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
    expect(coordinator.queueDepth).toBe(1);

    // The handshake finishes and a later view change re-runs dispatch, exactly as a real
    // `WorkerLink#start()` completing (or any subsequent refresh) would trigger. On the pre-fix
    // code this waiter is invisible to `#dispatch` forever from here on: its own leaked
    // dispatch-target mark keeps failing `#dispatch`'s guard even though its queue state is
    // genuinely `queued` again.
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

    // The refreshed view now has capacity, and this time the worker grants it.
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
    // wrk_a has more free slots, so free-capacity picks it first.
    connectWorker(workers, "wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    connectWorker(workers, "wrk_b");
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(other.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);

    // A refresh of wrk_a that changes nothing load-bearing runs the next pass.
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
    // The worker goes away between routing and its answer: its view is gone by the time the
    // NO_CAPACITY lands, so there is no view left to remember the refusal against.
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
    // The refused waiter is already in the queue (it first met a worker with no client yet), so
    // the walk must not offer it twice: once in its queue position and once as the candidate.
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

  it("terminally rejects, rather than re-queuing, a NO_CAPACITY that arrives after progress already fired (P1, round 2 review)", async () => {
    // ADR §11: "an *immediate* NO_CAPACITY is the only answer that leaves it queued" -- one
    // reached *after* a progress push means device work had already begun (the worker's own
    // `#evictManaged` failure path can answer this way, after `provisioning`/`reclaiming`), so
    // this request was already dispatched and a NO_CAPACITY past that point is its own terminal
    // failure, not a stale view to retry.
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      error: noCapacityError(),
      kind: "error",
      progress: [{ etaMs: 5_000, stage: "reclaiming" }],
    });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    const rejection = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);

    // It really was announced -- proving this is the "already dispatched" branch, not the
    // ordinary immediate-refusal one.
    expect(dispatched).toHaveLength(1);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("NO_CAPACITY");
    expect(coordinator.queueDepth).toBe(0);
    expect(directory.refreshCalls).toEqual([]);
  });

  it("bounds a forwarded lease.request against gateway.leaseRequestTimeoutMs when the worker never answers at all (P2, round 2 review)", async () => {
    // ADR §10: timeoutMs/QUEUE_TIMEOUT and lease.cancel are enforced on the gateway's own queue
    // -- which only holds while a waiter is `queued`, never while it is `processing` a forwarded
    // RPC. Before this fix, a forwarded `lease.request` had no timeout of its own, so a worker
    // whose handler wedged left the request `processing` forever: neither a deadline nor
    // `lease.cancel` could ever reach it again.
    const { clock, coordinator, directory, workers } = harness({ leaseRequestTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ kind: "hang" });

    const request = coordinator.request(REQUEST, requestOptions());
    const requestState = promiseState(request);
    const rejection = request.catch((error: unknown) => error);
    await tick();
    // Not stuck forever, and not answerable by a stale-view refresh either -- the waiter must
    // come back to a state the queue's own machinery can act on.
    expect(coordinator.queueDepth).toBe(0);
    expect(directory.refreshCalls).toEqual([]);

    clock.advance(5_000);
    await tick();
    expect(requestState.state).toBe("rejected");
    const error = await rejection;

    expect(error).toBeInstanceOf(DispatchError);
    expect((error as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect(coordinator.queueDepth).toBe(0);
  });

  it("does not emit request.dispatched for a progress push that arrives after gateway.leaseRequestTimeoutMs already rejected the waiter (P4, round 3 review)", async () => {
    // H4's own reasoning, applied to the sibling timeout P2 added in the same round and left
    // undetached: `#withLeaseRequestTimeout` settling `WORKER_UNREACHABLE` only stops the
    // returned promise from being awaited -- the worker's own still-pending `lease.request` RPC
    // is never cancelled, and its `onProgress` closure stays live for as long as the worker cares
    // to keep pushing. `docs/internal/EVENTS.md` defines `request.dispatched` as "the gateway's fleet queue
    // sent a queued request to a worker ... and the worker took it" -- a false past-tense fact for
    // a request the caller has already been told is `WORKER_UNREACHABLE`.
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
    expect(events).toEqual([]);

    // The worker, unaware this gateway already gave up, pushes progress on the RPC it still
    // thinks is live -- exactly as `client.exec`'s own late `onOutput` chunk does in H4's test.
    client.lastRequestLeaseOptions?.onProgress?.({ etaMs: 5_000, stage: "provisioning" });
    await tick();

    expect(events).toEqual([]);
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

  it("passes over a request only a busy worker can serve instead of blocking behind it, and never lets a brand-new admission jump an older, equally-eligible waiter still queued behind it (C2, round 3 review)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_ios", client);
    directory.add("wrk_android", new ScriptedWorkerClient());
    // `oldFirst`'s own attempt claims the worker for the whole test and never settles -- what
    // matters here is which *other* waiter gets a look at the worker's nominal second slot next,
    // not what `oldFirst` itself resolves to.
    client.requestLeaseQueue.push({ kind: "hang" });

    // Both workers are connected and busy, so every request below waits (a request no worker
    // could ever serve would fail at once instead). Admitted oldest first: an android request
    // whose worker stays busy for the whole test, then two iOS waiters.
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

    // The iOS worker frees two slots. An android-then-iOS dispatch loop that gives up (or
    // blocks) on android's own "no worker" answer would never reach either iOS waiter behind it
    // in this same pass. Its reported capacity (two free slots) is on paper room for both
    // `oldFirst` and `oldSecond`, but H6's own per-worker-per-pass cap intentionally leaves
    // `oldSecond` passed over here -- genuinely `queued`, not the bug this test targets.
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

    // A brand-new iOS waiter arrives after `oldSecond`, with no worker-view change since --
    // `routing.select` is a pure function of the current views, so the very same stale view that
    // already left `oldSecond` queued still nominally reports the same free capacity. ADR
    // §10/§11's FIFO is oldest-first: that capacity belongs to `oldSecond`, which has been queued
    // and eligible the whole time, never to a brand-new admission that only got a look because
    // `#admit` took its own out-of-order peek instead of deferring to `#dispatch`.
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const newPromise = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-new", requesterId: "agent-new" }),
    );
    await tick();

    // The second `lease.request` this test ever sends must be `oldSecond`'s own, not the
    // brand-new admission's -- regardless of what either eventually settles to.
    const leaseRequests = client.calls.filter((call) => call.startsWith("lease.request"));
    expect(leaseRequests.length).toBeGreaterThanOrEqual(2);
    expect(leaseRequests[1]).toContain("agent-old-2");

    const oldSecondGrant = await oldSecondPromise;
    expect(oldSecondGrant.lease.worker?.id).toBe("wrk_ios");
    expect(androidSettled).toBe(false);
    void oldFirstPromise;
    void newPromise;
  });

  it("indexes a fresh grant under the ownerId it forwarded, not the worker's own echo of it, and logs a mismatch (H6)", async () => {
    const logger = new RecordingLogger();
    const { coordinator, directory, leaseIndex, workers } = harness({ logger });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          // A worker that ignores or rewrites the field it was asked to store verbatim --
          // exactly the case this gateway must not trust for a fresh grant, even though
          // `FleetLeaseIndex#rebuildFromWorker` (the reconnect path) has no better source and
          // must trust it there.
          ownerId: "worker-rewrote-this",
        },
      }),
      kind: "grant",
    });

    const grant = await coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-1", requesterId: "agent-1" }),
    );

    expect(leaseIndex.ownerId(grant.lease.id)).toBe("agent-1");
    expect(grant.lease.ownerId).toBe("agent-1");
    expect(
      logger.warnings.some(
        (entry) =>
          entry.fields?.echoedOwnerId === "worker-rewrote-this" &&
          entry.fields.forwardedOwnerId === "agent-1",
      ),
    ).toBe(true);
  });

  // C4 (round 2 review): the test below titled around "the worker's first progress push"
  // asserted nothing that a progress push specifically causes -- the grant path emits
  // `request.dispatched` right after `client.requestLease` resolves regardless of whether
  // `progress` fired first, so deleting `announceDispatched()` from `#attempt`'s `onProgress`
  // callback entirely left every test in this file passing. This one scripts a request that is
  // genuinely dispatched (a `progress` push fires) and then never settles at all, so the *only*
  // way `request.dispatched` can appear is the progress-driven call -- proving it fires before,
  // not merely alongside, settlement (there is none, ever, in this scenario).
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

  // H10 (round 2 review): `request.dispatched` had no test at all -- not its payload, not
  // emit-once, not §11's "first progress push counts as dispatched" rule. `progress` on
  // `RequestLeaseOutcome` (`test-support.ts`) was added for exactly this and was dead code until
  // these three tests started using it.
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

    // C2 (round 2 review): the full self-contained payload `docs/internal/EVENTS.md` specifies -- not
    // just the gateway-internal `requestId`/`workerId` pair.
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
    // Sanity: the request really did land where the event says it did.
    expect(grant.lease.worker?.id).toBe("wrk_a");
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
    // No free capacity yet -- the request genuinely queues instead of settling on the fast
    // admission-time path, so `queuedMs` has something real to measure.
    const noFree = { ...statusFixture().capacity.ios, maxRunning: 0, running: 0 };
    connectWorker(workers, "wrk_a", { capacity: { ...statusFixture().capacity, ios: noFree } });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    clock.advance(2_500);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    // The worker now reports the requested device itself sitting ready -- a warm hit, not a
    // free-capacity pick, once capacity frees up too.
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
    // A stage name no shipped policy has, and a reason that does not follow from it, so both
    // payload fields can only have come from the decision itself.
    const { coordinator, directory, eventBus, workers } = harness({
      routing: () => ({
        assess: () => ({ kind: "route-or-wait" }),
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

  // C3 (round 2 review): `session.onStarted` used to fire before `client.exec` even went out --
  // committing an HTTP caller's `200` before this gateway had any idea whether the worker would
  // accept the command at all, including a worker-side `FORBIDDEN` (§19a', the one place `admin`
  // does not bypass ownership) and the driver's own `PASSTHROUGH_REFUSED` / a bad `tool`. These
  // two tests exercise `FleetLeaseCoordinator#exec` itself, the actual chokepoint -- not just
  // `http/app.ts`'s own route logic, which was already correct given whatever a dispatcher told
  // it (see `http/app.test.ts`'s "answers a failure that lands before any output with its own
  // status, not a stream").
  it("announces started from the worker's own push, before any output, and never before client.exec is sent (ADR §19a)", async () => {
    // The signal is the worker's `started` frame and nothing else -- not the first output chunk
    // (which cannot fire for a silent command) and not a timer (which cannot tell a slow worker
    // from a refusing one). This asserts the ordering that matters to a transport: `started`
    // lands before the first chunk, and never before the forward actually goes out.
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

  it("never calls onStarted for a worker-side FORBIDDEN that produced no output at all -- the HTTP route must still be free to answer 403, not a committed 200 (C3, round 2 review)", async () => {
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
    // §19a': the worker's own ownership check disagreeing with what this gateway forwarded --
    // exactly the answer that must still reach an HTTP caller as its own status code, not as an
    // already-committed 200 + SSE `error`.
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
  });

  it("a noWait request refused while other requests are queued emits no lease.queued and no queued progress -- it never entered the queue (ADR §10, architecture rule 10)", async () => {
    // `noWait` used to be enforced twice: once in `#admit`'s own direct look and once after an
    // enqueue-then-dispatch. The second path committed queue membership *before* it knew the
    // answer, and `WaitQueue#enqueue` pushes a `queued` progress frame and `#enqueue` emits
    // `lease.queued` -- so the same request produced different observable facts depending on
    // whether *unrelated* requests happened to be queued at the time. ADR §10 requires "the same
    // codes and progress states a worker uses", and a worker's own `#defer` rejects a `noWait`
    // waiter before it enqueues.
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");

    // Occupy the worker and leave a waiter in the queue, so the queue is non-empty.
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    await coordinator.request(REQUEST, requestOptions());
    void coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    const events: string[] = [];
    eventBus.subscribe("lease.queued", () => events.push("lease.queued"));
    eventBus.subscribe("lease.rejected", () => events.push("lease.rejected"));
    const progress: string[] = [];

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
    expect(events).toEqual(["lease.rejected"]);
    expect(progress).toEqual([]);
    expect(coordinator.queueDepth).toBe(1);
  });

  it.each([
    ["an empty queue", 0],
    ["another request queued", 1],
  ] as const)(
    "rejects a noWait request refused by its only worker with NO_CAPACITY and lease.rejected no-wait, and refreshes that worker's view, with %s -- the answer does not depend on queue depth",
    async (_queue, queued) => {
      // Deciding on `waiter.state === "queued"` could not tell "never attempted" from "attempted
      // and refused inside the same pass", so the answer used to flip with unrelated queue depth.
      const { coordinator, directory, eventBus, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      if (queued > 0) {
        client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
        await coordinator.request(REQUEST, requestOptions());
        // Refused by wrk_a and left queued, so the queue is non-empty.
        void coordinator.request(
          REQUEST,
          requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
        );
        await tick();
      }
      expect(coordinator.queueDepth).toBe(queued);
      const rejected: unknown[] = [];
      eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
      const refreshesBefore = directory.refreshCalls.length;

      const refused = coordinator.request(
        REQUEST,
        requestOptions({ noWait: true, ownerId: "agent-3", requesterId: "agent-3" }),
      );
      const refusedState = promiseState(refused);
      await tick();

      // Answered, not left waiting in the queue: a noWait caller never asked to wait.
      expect(refusedState.state).toBe("rejected");
      await expect(refused).rejects.toMatchObject({ code: "NO_CAPACITY" });
      expect(client.calls).toContain(`lease.request:${GATEWAY_PREFIX}agent-3`);
      expect(rejected).toEqual([expect.objectContaining({ reason: "no-wait" })]);
      expect(directory.refreshCalls.slice(refreshesBefore)).toEqual(["wrk_a"]);
      expect(coordinator.queueDepth).toBe(queued);
    },
  );

  it("relays the worker's own started push for a silent, long-running command -- no output, no answer, still a 200 through a gateway (ADR §19a/§19b/§19e)", async () => {
    // ADR §19e/§19b: "a command that prints nothing for nine minutes still gets its 200 and its
    // keepalives" -- `simctl install <path>` (§19b's own worked example) is exactly such a
    // command. Deferring `onStarted` to the first output chunk never fires for one, so a
    // gateway-fronted caller got no `200`, no keepalives, and eventually a `504` instead of the
    // stream's own terminal `EXEC_TIMEOUT`. The worker knows the moment and now sends it, so
    // this asserts the relay and nothing about timing: no clock is advanced anywhere below.
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    // The process exists on the worker -- it says so -- and then writes nothing and never
    // settles, which is the whole shape of a silent long-running command.
    client.execQueue.push({ kind: "hang", started: true });

    let started = false;
    void coordinator.exec(
      { args: ["install", "/path/to.app"], leaseId: grant.lease.id, tool: "simctl" },
      {
        manageEventSubscription: () => undefined,
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

    // There is no timer to fire any more -- advancing the clock well past where one used to be
    // must not fire a stray `onStarted` for a call that is already over.
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
      { manageEventSubscription: () => undefined, principal: "agent-1", role: "agent" },
    );
    const executionState = promiseState(execution);
    const rejection = execution.catch((error: unknown) => error);
    await tick();
    clock.advance(5_000);
    await tick();
    expect(executionState.state).toBe("rejected");
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
    // Never settles -- exactly the "worker never answers at all" case `EXEC_TIMEOUT` exists for
    // -- but the underlying RPC is never cancelled, so a real worker's own `onOutput` pushes can
    // still arrive on it after this gateway has already given up.
    client.execQueue.push({ kind: "hang" });

    const relayed: Array<{ stream: string; chunk: string }> = [];
    const execution = coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
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

    // The worker, unaware this gateway already timed the call out, keeps streaming -- this is
    // exactly the closure `client.exec` was given, invoked exactly as the worker's own RPC
    // handling would invoke it in production, well after `EXEC_TIMEOUT` already settled.
    client.lastExecOptions?.onOutput?.({ chunk: "late output", stream: "stdout" });
    await tick();

    expect(relayed).toEqual([]);
  });

  // Round 6 review: `#raceTimeout`'s own doc claims no late frame "reaches `session.onOutput`
  // (or spuriously fires `onStarted`) once that has happened", but only the `onOutput` half was
  // tested -- both `detached` guards were deletable with the whole suite green. HTTP survives a
  // spurious `onStarted` only because `OutputRelay` swallows it, which is the transport saving
  // this class again: exactly the reasoning H4 rejected for `onOutput`.
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

    // The worker finally spawns the process and says so -- the same closure `client.exec` was
    // given, well after this gateway answered `EXEC_TIMEOUT`.
    client.lastExecOptions?.onStarted?.();
    await tick();

    expect(startedCount).toBe(0);
  });

  it("announces started once even if the worker sends the frame more than once", async () => {
    // A `started` push is request-scoped and should arrive once, but nothing on the wire stops a
    // worker from sending it twice, and a transport that has already chosen its response shape
    // cannot un-choose it. The dedupe is what makes the signal idempotent for every consumer.
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

  // Round 6 review: `#dispatch`'s re-entrancy guard and its `#passRequested` deferral were
  // deletable with the whole suite green, and instrumenting the `#dispatchDepth > 0` branch
  // showed *zero* hits across every test in the repo -- round 4 finding 6's fix ("defer instead
  // of dropping") was a green light wired to nothing.
  //
  // It takes a synchronous view change raised from inside the walk to reach, which no production
  // path does today (`WorkerLink#refresh` mutates only past its first await). That is precisely
  // why it needs a test rather than deletion: the guard exists so that a future caller which
  // *does* mutate synchronously cannot silently reintroduce C1's stall, and nothing but this
  // test would notice if the deferral were removed again.
  it("runs another pass for a view change raised from inside the walk, rather than dropping it (round 4 finding 6, round 6 review)", async () => {
    // Call 1 is the admission look (worker still carries the wrong model, so the real policy
    // refuses and the waiter queues). Call 2 is the pass the single refresh below triggers --
    // that is the one that injects. Call 3 can only happen if the nested change was deferred
    // rather than dropped.
    let selectCalls = 0;
    const { coordinator, directory, workers } = harness({
      routing: (registry) => {
        const real = createRoutingPolicy("warm-then-free");
        return {
          assess: real.assess,
          select(request, workerViews) {
            selectCalls += 1;
            if (selectCalls === 2) {
              // A view change *during* the walk: re-enters `#dispatch`, which cannot run a pass
              // now (one is already walking a snapshot) and must therefore remember to run one
              // when this one unwinds.
              registry.refresh("wrk_a", {});
              // ...and this waiter finds nothing this pass, so only that next pass can serve it.
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

    // Connected, but with no free slot -- so the waiter queues behind a busy worker, and the
    // worker is already fully connected. That matters: `connectWorker` raises *two* view changes
    // (`connected`, then `refresh`), and a second top-level dispatch would serve the waiter on
    // its own, masking whether the deferred pass did anything at all. Getting the worker
    // connected before the request leaves exactly one trigger below.
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    // The single trigger: one refresh that frees a slot. Pass 1 refuses the waiter
    // and raises a nested view change; only the deferred pass 2 can dispatch it. Asserted on the
    // forwarded RPC rather than by awaiting the grant, so dropping the deferral fails here on a
    // named assertion instead of by timing out (testing rule 2).
    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();

    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    // Three looks: admission, the injecting pass, and the deferred pass that actually dispatched.
    expect(selectCalls).toBe(3);
    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(coordinator.queueDepth).toBe(0);
  });

  it("rejects a no-wait request immediately with NO_CAPACITY when no worker is eligible at all", async () => {
    const { coordinator } = harness();

    await expect(
      coordinator.request(REQUEST, requestOptions({ noWait: true })),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });
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

  it("maps a transport failure on lease.request to WORKER_UNREACHABLE, never the uplink client's own error code verbatim (P4)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    // What the admin client's own wire rejects an in-flight call with when *its* connection to
    // the worker dies mid-call (`src/simlock-client/wire.ts`) -- `kind: "transport"` names the
    // uplink itself, not a worker fact, and forwarding it verbatim would tell the fleet client
    // its own connection to *this gateway* was lost, which never happened.
    client.requestLeaseQueue.push({
      error: new SimlockError(
        "DAEMON_CONNECTION_LOST",
        "transport",
        "Daemon connection is closed",
        {},
      ),
      kind: "error",
    });

    const rejection = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect((rejection as DispatchError).details).toMatchObject({ workerId: "wrk_a" });
  });

  it("maps a transport failure on a forwarded lease.renew to WORKER_UNREACHABLE the same way (P4)", async () => {
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
    client.renewLeaseQueue.push({
      error: new SimlockError(
        "DAEMON_CONNECTION_LOST",
        "transport",
        "Daemon connection is closed",
        {},
      ),
      kind: "error",
    });

    const rejection = await coordinator
      .renew("wrk_a.lse_1", undefined)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
  });

  it("reports a non-SimlockError from a forwarded renew as INTERNAL, never as WORKER_UNREACHABLE (H1, round 2 review)", async () => {
    // A raw TypeError here is this coordinator's own bug, not a fact about the worker -- every
    // real transport failure already arrives as a `kind: "transport"` SimlockError (the test
    // above). Answering WORKER_UNREACHABLE for a value like this would misreport a gateway-side
    // crash as "the machine is unreachable".
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
    client.renewLeaseQueue.push({ error: new TypeError("boom"), kind: "error" });

    const rejection = await coordinator
      .renew("wrk_a.lse_1", undefined)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("INTERNAL");
  });

  it("reports a non-SimlockError from a forwarded lease.request as INTERNAL too, the same shape of failure #attempt answers directly (H1, round 2 review)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ error: new TypeError("boom"), kind: "error" });

    const rejection = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("INTERNAL");
  });

  it("drops its own index entry when the worker answers UNKNOWN_LEASE to a release, instead of leaving a zombie behind (C3)", async () => {
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
    client.releaseLeaseQueue.push({
      error: new SimlockError("UNKNOWN_LEASE", "domain", "Unknown lease: lse_1", {
        leaseId: "lse_1",
      }),
      kind: "error",
    });

    await expect(coordinator.release("wrk_a.lse_1")).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });

    // The gateway's own record was provably wrong (the worker has no idea what this lease is) --
    // it must not survive to block `agent-1`'s next request with REQUESTER_ALREADY_LEASED
    // naming a lease that exists nowhere.
    expect(leaseIndex.resolve("wrk_a.lse_1")).toBeUndefined();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    await expect(coordinator.request(REQUEST, requestOptions())).resolves.toBeDefined();
  });

  it("drops its own index entry when the worker answers UNKNOWN_LEASE to a renew too (C3)", async () => {
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
    client.renewLeaseQueue.push({
      error: new SimlockError("UNKNOWN_LEASE", "domain", "Unknown lease: lse_1", {
        leaseId: "lse_1",
      }),
      kind: "error",
    });

    await expect(coordinator.renew("wrk_a.lse_1", undefined)).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });
    expect(leaseIndex.resolve("wrk_a.lse_1")).toBeUndefined();
  });

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

    // Without C3's fix this single zombie entry throws on *every* future release-all -- proven
    // by calling it twice.
    await expect(coordinator.releaseAll()).resolves.toEqual(["wrk_a.lse_zombie"]);
    expect(leaseIndex.resolve("wrk_a.lse_zombie")).toBeUndefined();
    await expect(coordinator.releaseAll()).resolves.toEqual([]);
  });

  it("does not evict a lease on one worker when only a different worker's view changes repeatedly (C1, round 2 review)", async () => {
    // Reproduces the round 2 finding exactly: a grant lands on wrk_a, but wrk_a's own cached
    // view never gets refreshed with the new lease in this test (nothing here calls
    // `workers.refresh("wrk_a", { leases: [...] })`, exactly the race where a real
    // `WorkerLink`'s post-grant refresh is still in flight). Unrelated churn on wrk_b must never
    // be able to evict wrk_a's lease -- before the fix, `#onViewsChanged` reconciled *every*
    // view (including wrk_a's stale, lease-less one) on every notification, so two view changes
    // on wrk_b alone were enough to walk wrk_a's entry through both halves of
    // `rebuildFromWorker`'s two-consecutive-misses rule and forget it.
    const { coordinator, directory, workers, leaseIndex } = harness();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b");
    clientA.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grant = await coordinator.request(REQUEST, requestOptions());
    expect(grant.lease.worker?.id).toBe("wrk_a");
    // wrk_a's own view still reports no leases at all -- the stale-cache race this finding
    // describes, not a hypothetical.
    expect(workers.view("wrk_a")?.leases).toEqual([]);

    // Two unrelated view changes on wrk_b -- neither one is about wrk_a.
    workers.refresh("wrk_b", {});
    workers.refresh("wrk_b", {});

    expect(leaseIndex.resolve(grant.lease.id)).toBeDefined();
    expect(leaseIndex.existingLeaseId("agent-1")).toBe(grant.lease.id);
  });

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
    // What already succeeded stays released regardless of the answer's own shape.
    expect(leaseIndex.resolve("wrk_a.lse_1")).toBeUndefined();
    expect(leaseIndex.resolve("wrk_b.lse_1")).toBeDefined();
  });
});

/**
 * #119: drain and disconnect lifecycle, and the `WORKER_UNREACHABLE` paths §28/§29 name.
 * `routing.test.ts` already proves eligibility is a pure function that drops a drained or
 * disconnected worker; what these tests add is the coordinator-level proof that the exclusion
 * actually starves that worker's own client of calls while an eligible sibling keeps serving --
 * a call-count assertion, not just "the grant landed on the other one".
 */
describe("drain and unreachable lifecycle (ADR §9/§28/§29, #119)", () => {
  /**
   * H2 (round 1 review, #119): the drain and disconnect tests below were ~40-line near-clones
   * differing in three lines -- the exclusion action, and which ADR section it cites. Shared
   * here so the one real difference between them is what each `it` block shows, not buried in
   * two copies of the setup and assertions around it.
   *
   * wrk_a starts saturated so the first request is forced onto wrk_b -- which one ends up
   * excluded is deliberate, not incidental to routing's own tie-break. After `exclude` runs,
   * wrk_a is given *less* free capacity than wrk_b's own (unchanged) view still reports: if
   * exclusion did not drop wrk_b outright, warm-then-free's free-capacity tie-break would still
   * prefer B (more free capacity wins). The second request landing on A anyway, despite being
   * the worse capacity pick, is what proves the exclusion -- not the capacity numbers -- is what
   * kept B out. wrk_b's client is scripted with a spare grant too (C2, round 1 review): without
   * it, a routing regression that let the excluded worker back into eligibility would route
   * there, its empty queue would answer `NO_CAPACITY`, the coordinator would read that as a
   * stale view (§11) and re-enqueue forever, and this test would time out instead of failing the
   * wrong-worker assertion below.
   */
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

    // Excluded mid-service: its existing lease must stay exactly where it is (§9's "keeps its
    // existing leases" / §6).
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
    // The real assertion: the excluded worker's own call count never grew past the one lease it
    // already held before its exclusion -- not merely "the second grant's worker id is wrk_a".
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
        { manageEventSubscription: () => undefined, principal: "agent-1", role: "agent" },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
    // Never reached the worker at all -- a call that then failed would still show up here.
    // P1 (round 1 review, #119): this does *not* pin the pre-flight `target?.reachable === true
    // ?` conjunct in `#forwardToWorker` specifically -- deleting it leaves this test (and all
    // 1776 others) green, because `FakeDirectory.target()` already makes `client()` return
    // `undefined` whenever `reachable` is false, so the conjunct is redundant here. It is
    // redundant in production too: `WorkerLink#reachable` and `#client()` both mirror the same
    // `#closed` flag (`worker-link.ts`), so the conjunct can never change the outcome there
    // either. Left in place rather than dropped, since this PR makes no production changes.
    expect(client.calls.filter((call) => call.startsWith("device.exec"))).toEqual([]);
  });

  it("a request dispatched to a worker whose uplink then drops: the client sees WORKER_UNREACHABLE, and the lease is not silently double-granted once the worker's view catches up (§29)", async () => {
    // H4 (round 1 review, #119): everything through `rebuiltLeaseId`'s own assertion below
    // re-asserts what "maps a transport failure on lease.request to WORKER_UNREACHABLE" (P4,
    // above) already pins -- not new load-bearing coverage, just the setup this test's own
    // genuinely new part (the retry below) needs. That retry -- proving the fleet-wide rule the
    // rebuild just populated is what a same-requester retry finds, never a second grant -- is
    // what §29 adds here.
    const { coordinator, directory, workers, leaseIndex } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    // The worker's own answer to this dispatch never makes it back -- the uplink itself died
    // mid-call, exactly the `kind: "transport"` shape a real connection loss arrives as.
    client.requestLeaseQueue.push({
      error: new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Connection lost", {}),
      kind: "error",
    });

    const rejection = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
    // The client's own request is over -- nothing is left queued to double-settle later.
    expect(coordinator.queueDepth).toBe(0);

    // The worker actually granted it before the uplink dropped: the next real snapshot the
    // gateway sees once the uplink returns reports the lease, exactly as §29 describes ("if the
    // worker actually granted it, the lease exists on the worker"). This is the ordinary
    // reconcile path (`#onViewsChanged`/`rebuildFromWorker`), not a special case.
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
    expect(leaseIndex.resolve(rebuiltLeaseId)).toBeDefined();

    // The requester's retry -- "the same `409 → GET` recovery loop ... applied across the
    // uplink gap" -- must find the lease the fleet-wide rule now knows about, never a second
    // grant for the same requester.
    const retry = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    expect(retry).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((retry as RequesterAlreadyLeasedError).existingLeaseId).toBe(rebuiltLeaseId);
    // Only ever the one `lease.request` call this worker actually answered -- the retry above
    // was refused at admission, before ever reaching a worker again.
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });
});

describe("FleetLeaseCoordinator sends a worker only requests its catalog can serve (ADR 0009 §3)", () => {
  /** Connects a worker with one catalog entry stated in full, so pairings and aliases are explicit. */
  function connectWithCatalog(
    workers: WorkerRegistry,
    workerId: string,
    entry: Parameters<typeof catalogFixture>[0][number],
    downloads: "never" | "on-request" | "always" = "on-request",
  ): void {
    workers.connected(workerId, undefined, "0.3.0");
    workers.refresh(workerId, {
      capacity: statusFixture().capacity,
      catalog: catalogFixture([entry]).platforms,
      devices: [],
      downloads: { policy: downloads },
      health: "running",
      leases: [],
      queueDepth: 0,
    });
  }

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  it("dispatches a request in another letter case with the worker's own name for the model", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWithCatalog(workers, "wrk_a", {
      models: ["iPhone 16 Pro"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    await coordinator.request(
      { model: "iphone 16 pro", platform: "ios" },
      requestOptions({ noWait: true }),
    );

    expect(client.lastRequestLeaseInput?.model).toBe("iPhone 16 Pro");
    const requested = eventBus.replay().find((event) => event.event === "lease.requested");
    expect(requested?.payload).toMatchObject({ requestSpec: { model: "iphone 16 pro" } });
  });

  it("dispatches a request by an alias to the worker that lists it", async () => {
    const { coordinator, directory, workers } = harness();
    const other = new ScriptedWorkerClient();
    const lister = new ScriptedWorkerClient();
    directory.add("wrk_a", other);
    directory.add("wrk_b", lister);
    lister.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    // wrk_a sorts first and has the same free capacity, so only the alias can send it to wrk_b.
    connectWithCatalog(workers, "wrk_a", {
      models: ["Pixel 7"],
      platform: "android",
      runtimes: ["35"],
    });
    connectWithCatalog(workers, "wrk_b", {
      modelAliases: { "Pixel 7": ["pixel_7"] },
      models: ["Pixel 7"],
      platform: "android",
      runtimes: ["35"],
    });

    await coordinator.request(
      { model: "pixel_7", platform: "android" },
      requestOptions({ noWait: true }),
    );

    expect(leaseRequests(other)).toEqual([]);
    expect(lister.lastRequestLeaseInput?.model).toBe("Pixel 7");
  });

  it("passes over a worker with the model and the runtime unpaired for one that pairs them", async () => {
    const { coordinator, directory, workers } = harness();
    const unpaired = new ScriptedWorkerClient();
    const paired = new ScriptedWorkerClient();
    directory.add("wrk_a", unpaired);
    directory.add("wrk_b", paired);
    paired.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    // wrk_a lists iPhone 17 and 26.0, but pairs iPhone 17 only with 18.0.
    connectWithCatalog(workers, "wrk_a", {
      modelRuntimes: { "iPhone 15": ["26.0"], "iPhone 17": ["18.0"] },
      models: ["iPhone 17", "iPhone 15"],
      platform: "ios",
      runtimes: ["18.0", "26.0"],
    });
    connectWithCatalog(workers, "wrk_b", {
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    await coordinator.request(REQUEST, requestOptions({ noWait: true }));

    expect(leaseRequests(unpaired)).toEqual([]);
    expect(leaseRequests(paired)).toHaveLength(1);
  });

  it("with no runtime named, needs a model with at least one paired runtime", async () => {
    const { coordinator, directory, workers } = harness();
    const unpaired = new ScriptedWorkerClient();
    const paired = new ScriptedWorkerClient();
    directory.add("wrk_a", unpaired);
    directory.add("wrk_b", paired);
    paired.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWithCatalog(workers, "wrk_a", {
      modelRuntimes: { "iPhone 17": [] },
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });
    connectWithCatalog(workers, "wrk_b", {
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    await coordinator.request(
      { model: "iPhone 17", platform: "ios" },
      requestOptions({ noWait: true }),
    );

    expect(leaseRequests(unpaired)).toEqual([]);
    expect(leaseRequests(paired)).toHaveLength(1);
  });

  it("sends a request naming an image tag to the worker whose catalog lists that tag for the API level, not to one listing the API level with another tag, and forwards the tag", async () => {
    const { coordinator, directory, workers } = harness();
    const otherTag = new ScriptedWorkerClient();
    const lister = new ScriptedWorkerClient();
    directory.add("wrk_a", otherTag);
    directory.add("wrk_b", lister);
    lister.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    // wrk_a sorts first and has the same free capacity, so only the tag can send it to wrk_b.
    connectWithCatalog(workers, "wrk_a", {
      images: [
        { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis_playstore" },
      ],
      models: ["Pixel 8"],
      platform: "android",
      runtimes: ["34", "35"],
    });
    connectWithCatalog(workers, "wrk_b", {
      images: [{ abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" }],
      models: ["Pixel 8"],
      platform: "android",
      runtimes: ["34"],
    });

    await coordinator.request(
      {
        imageTag: "google_apis_playstore",
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
      },
      requestOptions({ noWait: true }),
    );

    expect(leaseRequests(otherTag)).toEqual([]);
    expect(lister.lastRequestLeaseInput).toMatchObject({
      imageTag: "google_apis_playstore",
      osVersion: "34",
    });
  });

  it("rejects a request naming an image tag no worker lists with RUNTIME_MISSING at once, sending it to no worker", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWithCatalog(workers, "wrk_a", {
      images: [{ abi: "arm64-v8a", runtime: "34", tag: "google_apis" }],
      models: ["Pixel 8"],
      platform: "android",
      runtimes: ["34"],
    });

    const outcome = coordinator.request(
      { imageTag: "google_apis_playstore", model: "Pixel 8", platform: "android" },
      requestOptions(),
    );
    const state = promiseState(outcome);
    await tick();

    expect(state.state).toBe("rejected");
    await expect(outcome).rejects.toMatchObject({ code: "RUNTIME_MISSING" });
    expect(leaseRequests(client)).toEqual([]);
  });

  it("does not make a worker eligible for allowDownload: true, and forwards allowDownload: false", async () => {
    const { coordinator, directory, workers } = harness();
    const downloader = new ScriptedWorkerClient();
    const installed = new ScriptedWorkerClient();
    directory.add("wrk_a", downloader);
    directory.add("wrk_b", installed);
    installed.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    // wrk_a would download 26.0 under its own policy; on main that made it eligible, and it
    // sorts first with the same free capacity.
    connectWithCatalog(
      workers,
      "wrk_a",
      { models: ["iPhone 17"], platform: "ios", runtimes: ["18.0"] },
      "always",
    );
    connectWithCatalog(workers, "wrk_b", {
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    await coordinator.request(REQUEST, requestOptions({ allowDownload: true, noWait: true }));

    expect(leaseRequests(downloader)).toEqual([]);
    expect(installed.lastRequestLeaseInput?.allowDownload).toBe(false);
  });
});

describe("FleetLeaseCoordinator fails a request no worker can serve at once (ADR 0009 §4)", () => {
  const capacity = statusFixture().capacity;

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  function lease(
    harnessed: ReturnType<typeof harness>,
    request: Parameters<FleetLeaseCoordinator["request"]>[0],
    options: Parameters<typeof requestOptions>[0] = {},
  ) {
    const outcome = harnessed.coordinator.request(request, requestOptions(options));
    return { outcome, state: promiseState(outcome) };
  }

  /** One scenario per row of ADR 0009 §4's table, each with the workers it needs connected. */
  const ROWS = [
    {
      code: "NO_CAPACITY",
      details: undefined,
      reason: "no-worker",
      request: REQUEST,
      row: "row 1: no worker takes requests",
      setup: async (_workers: WorkerRegistry) => {},
    },
    {
      code: "NO_DRIVER",
      details: { platform: "android" },
      reason: "unresolvable-spec",
      request: { model: "Pixel 8", platform: "android" as const },
      row: "row 2: no known worker has the platform",
      setup: async (workers: WorkerRegistry) => connectWorker(workers, "wrk_a"),
    },
    {
      code: "UNKNOWN_MODEL",
      details: { model: "iPhone 99", platform: "ios" },
      reason: "unresolvable-spec",
      request: { ...REQUEST, model: "iPhone 99" },
      row: "row 3: no known worker lists the model",
      setup: async (workers: WorkerRegistry) => connectWorker(workers, "wrk_a"),
    },
    {
      code: "RUNTIME_MISSING",
      details: { downloadable: false, osVersion: "99.0", platform: "ios" },
      reason: "unresolvable-spec",
      request: { ...REQUEST, osVersion: "99.0" },
      row: "row 4: no known worker has the runtime",
      setup: async (workers: WorkerRegistry) => connectWorker(workers, "wrk_a"),
    },
    {
      code: "NO_CAPACITY",
      details: undefined,
      reason: "no-worker",
      request: REQUEST,
      row: "row 5: a known worker can serve it and none that takes requests can",
      setup: async (workers: WorkerRegistry) => {
        connectWorker(workers, "wrk_a", { models: ["iPhone 16"] });
        connectWorker(workers, "wrk_b");
        await workers.setDrained("wrk_b", true);
      },
    },
  ] as const;
  const WAITS = [
    { options: {}, wait: "waiting" },
    { options: { noWait: true }, wait: "with --no-wait" },
    { options: { timeoutMs: 60_000 }, wait: "with a timeout" },
    { options: { noWait: true, timeoutMs: 60_000 }, wait: "with --no-wait and a timeout" },
  ] as const;

  it.each(ROWS.flatMap((row) => WAITS.map(({ options, wait }) => ({ ...row, options, wait }))))(
    "$row: answers $code at once and sends it to no worker, $wait",
    async (row) => {
      const { options } = row;
      const fleetHarness = harness();
      const client = new ScriptedWorkerClient();
      fleetHarness.directory.add("wrk_a", client);
      fleetHarness.directory.add("wrk_b", client);
      await row.setup(fleetHarness.workers);
      const rejected: unknown[] = [];
      fleetHarness.eventBus.subscribe("lease.rejected", (envelope) =>
        rejected.push(envelope.payload),
      );

      const { outcome, state } = lease(fleetHarness, row.request, options);
      await tick();

      // Settled with no clock advanced: neither the timeout nor a worker's answer was waited on.
      expect(state.state).toBe("rejected");
      await expect(outcome).rejects.toMatchObject({
        code: row.code,
        ...(row.details === undefined ? {} : { details: row.details }),
      });
      expect(rejected).toEqual([expect.objectContaining({ reason: row.reason })]);
      expect(leaseRequests(client)).toEqual([]);
      expect(fleetHarness.coordinator.queueDepth).toBe(0);
    },
  );

  describe("row 6: a worker that takes requests can serve it but is busy", () => {
    function busyFleet() {
      const fleetHarness = harness();
      const client = new ScriptedWorkerClient();
      fleetHarness.directory.add("wrk_a", client);
      connectWorker(fleetHarness.workers, "wrk_a", { capacity: saturatedIos() });
      return { client, fleetHarness };
    }

    it("queues it, sends it to no worker, waiting", async () => {
      const { client, fleetHarness } = busyFleet();

      const { state } = lease(fleetHarness, REQUEST);
      await tick();

      expect(state.state).toBe("pending");
      expect(fleetHarness.coordinator.queueDepth).toBe(1);
      expect(leaseRequests(client)).toEqual([]);
    });

    it("answers NO_CAPACITY at once with --no-wait, and queues nothing", async () => {
      const { client, fleetHarness } = busyFleet();

      const { outcome, state } = lease(fleetHarness, REQUEST, { noWait: true });
      await tick();

      expect(state.state).toBe("rejected");
      await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
      expect(leaseRequests(client)).toEqual([]);
      expect(fleetHarness.coordinator.queueDepth).toBe(0);
    });

    it("queues it with a timeout, and ends it at the deadline rather than at once", async () => {
      const { client, fleetHarness } = busyFleet();

      const { outcome, state } = lease(fleetHarness, REQUEST, { timeoutMs: 60_000 });
      const ended = outcome.catch((error: unknown) => error);
      await tick();
      expect(state.state).toBe("pending");
      expect(fleetHarness.coordinator.queueDepth).toBe(1);

      fleetHarness.clock.advance(60_000);
      await tick();

      expect(state.state).toBe("rejected");
      expect(await ended).toBeInstanceOf(QueueTimeoutError);
      expect(leaseRequests(client)).toEqual([]);
    });

    it("answers NO_CAPACITY at once with --no-wait and a timeout", async () => {
      const { fleetHarness } = busyFleet();

      const { outcome, state } = lease(fleetHarness, REQUEST, { noWait: true, timeoutMs: 60_000 });
      await tick();

      expect(state.state).toBe("rejected");
      await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
      expect(fleetHarness.coordinator.queueDepth).toBe(0);
    });
  });

  it("lets a rejected requester make a new request at once", async () => {
    const fleetHarness = harness();
    const { coordinator, directory, workers } = fleetHarness;
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    directory.add("wrk_b", client);
    connectWorker(workers, "wrk_a");
    const unknown = { ...REQUEST, model: "iPhone 99" };

    const first = lease(fleetHarness, unknown);
    await tick();
    expect(first.state.state).toBe("rejected");
    await expect(first.outcome).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });

    // The same requester asks again: a second rejection, not REQUESTER_ALREADY_LEASED.
    const second = lease(fleetHarness, unknown);
    await tick();
    expect(second.state.state).toBe("rejected");
    await expect(second.outcome).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });

    // And once a worker lists the model, the same requester is served.
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_b", { models: ["iPhone 99"] });
    const third = await coordinator.request(unknown, requestOptions());
    expect(third.lease.worker?.id).toBe("wrk_b");
  });

  it("emits no lease.queued and pushes no queued progress for a request it rejects on arrival", async () => {
    const { coordinator, eventBus, workers } = harness();
    connectWorker(workers, "wrk_a");
    const events: string[] = [];
    eventBus.subscribe("lease.queued", () => events.push("lease.queued"));
    eventBus.subscribe("lease.rejected", () => events.push("lease.rejected"));
    const progress: string[] = [];

    const outcome = coordinator.request(
      { ...REQUEST, model: "iPhone 99" },
      requestOptions({ onProgress: (update) => progress.push(update.stage) }),
    );
    const state = promiseState(outcome);
    await tick();

    expect(state.state).toBe("rejected");
    await expect(outcome).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
    expect(events).toEqual(["lease.rejected"]);
    expect(progress).toEqual([]);
  });

  it.each([
    ["is drained", (workers: WorkerRegistry) => workers.setDrained("wrk_a", true)],
    ["disconnects", (workers: WorkerRegistry) => workers.disconnected("wrk_a")],
  ] as const)(
    "fails a waiting request with NO_CAPACITY when its only capable worker %s",
    async (_change, change) => {
      const fleetHarness = harness();
      const { coordinator, directory, eventBus, workers } = fleetHarness;
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      directory.add("wrk_b", client);
      connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
      connectWorker(workers, "wrk_b", { models: ["iPhone 16"] });
      const rejected: unknown[] = [];
      eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

      const { outcome, state } = lease(fleetHarness, REQUEST);
      await tick();
      // Control: a busy worker makes it wait.
      expect(state.state).toBe("pending");
      expect(coordinator.queueDepth).toBe(1);

      await change(workers);
      await tick();

      expect(state.state).toBe("rejected");
      await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
      expect(rejected).toEqual([expect.objectContaining({ reason: "no-worker" })]);
      expect(coordinator.queueDepth).toBe(0);
      expect(leaseRequests(client)).toEqual([]);
    },
  );

  it("answers NO_CAPACITY, not UNKNOWN_MODEL, for a request only a disconnected worker lists while another worker takes requests", async () => {
    const fleetHarness = harness();
    const { workers } = fleetHarness;
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b", { models: ["iPhone 16"] });
    workers.disconnected("wrk_a");

    const { outcome, state } = lease(fleetHarness, REQUEST);
    await tick();

    expect(state.state).toBe("rejected");
    await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
  });

  it("answers NO_CAPACITY, not UNKNOWN_MODEL, while the only worker has connected for the first time and its catalog has not arrived", async () => {
    const fleetHarness = harness();
    const { workers } = fleetHarness;
    workers.connected("wrk_a", undefined, "0.3.0");
    // Its status has been read; its catalog has not.
    workers.refresh("wrk_a", { capacity, devices: [], health: "running", leases: [] });

    const { outcome, state } = lease(fleetHarness, REQUEST);
    await tick();

    expect(state.state).toBe("rejected");
    await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
  });

  it("still knows a reconnecting worker from its last catalog while its new catalog has not arrived", async () => {
    const fleetHarness = harness();
    const { workers } = fleetHarness;
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b", { models: ["iPhone 16"] });
    // wrk_a reconnects: its uplink is open again and nothing has been read from it yet.
    workers.connected("wrk_a", undefined, "0.3.0");

    const { outcome, state } = lease(fleetHarness, REQUEST);
    await tick();

    expect(state.state).toBe("rejected");
    // UNKNOWN_MODEL would say no worker has the model, and wrk_a's last catalog says it does.
    await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
  });

  it("names osVersion default in RUNTIME_MISSING when the request named no runtime", async () => {
    const fleetHarness = harness();
    const { workers } = fleetHarness;
    workers.connected("wrk_a", undefined, "0.3.0");
    workers.refresh("wrk_a", {
      capacity,
      catalog: catalogFixture([
        {
          modelRuntimes: { "iPhone 17": [] },
          models: ["iPhone 17"],
          platform: "ios",
          runtimes: ["26.0"],
        },
      ]).platforms,
      devices: [],
      health: "running",
      leases: [],
    });
    const { osVersion: _named, ...unnamed } = REQUEST;

    const { outcome, state } = lease(fleetHarness, unnamed);
    await tick();

    expect(state.state).toBe("rejected");
    await expect(outcome).rejects.toMatchObject({
      code: "RUNTIME_MISSING",
      details: { downloadable: false, osVersion: "default", platform: "ios" },
    });
  });

  it("queues a request for a capable worker that is busy and grants it when a device frees up", async () => {
    const fleetHarness = harness();
    const { coordinator, directory, workers } = fleetHarness;
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });

    const { outcome, state } = lease(fleetHarness, REQUEST);
    await tick();
    expect(state.state).toBe("pending");
    expect(coordinator.queueDepth).toBe(1);
    expect(leaseRequests(client)).toEqual([]);

    workers.refresh("wrk_a", { capacity });

    const grant = await outcome;
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(coordinator.queueDepth).toBe(0);
  });
});

describe("FleetLeaseCoordinator waits for a worker that is busy, not unable (ADR 0009 §2)", () => {
  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  it.each([
    ["is not healthy", { health: "starting" as const }, { health: "running" as const }],
    ["has its own waiters queued", { queueDepth: 2 }, { queueDepth: 0 }],
  ])(
    "queues a request, and does not fail it, when the only capable worker %s, and sends it once the worker is ready",
    async (_label, busy, ready) => {
      const { coordinator, directory, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      connectWorker(workers, "wrk_a");
      workers.refresh("wrk_a", busy);

      const granted = coordinator.request(REQUEST, requestOptions());
      await tick();

      expect(coordinator.queueDepth).toBe(1);
      expect(leaseRequests(client)).toHaveLength(0);

      workers.refresh("wrk_a", ready);
      await expect(granted).resolves.toMatchObject({ lease: { worker: { id: "wrk_a" } } });
      expect(leaseRequests(client)).toHaveLength(1);
    },
  );
});

describe("FleetLeaseCoordinator retries a worker's cannot-serve refusal on another worker (ADR 0009 §5)", () => {
  function runtimeMissing(): SimlockError<"RUNTIME_MISSING"> {
    return new SimlockError("RUNTIME_MISSING", "domain", "worker a has no such runtime", {
      downloadable: false,
      osVersion: "26.0",
      platform: "ios",
    });
  }

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  /** Two workers that both list the request; `wrk_a` is scripted first, `wrk_b` second. */
  function twoWorkers(options: { readonly busyB?: boolean; readonly logger?: Logger } = {}) {
    const fleetHarness = harness(options.logger === undefined ? {} : { logger: options.logger });
    const a = new ScriptedWorkerClient();
    const b = new ScriptedWorkerClient();
    fleetHarness.directory.add("wrk_a", a);
    fleetHarness.directory.add("wrk_b", b);
    connectWorker(fleetHarness.workers, "wrk_a");
    connectWorker(
      fleetHarness.workers,
      "wrk_b",
      options.busyB === true ? { capacity: saturatedIos() } : {},
    );
    return { a, b, ...fleetHarness };
  }

  /** Starts the request and lets it settle as far as it will without the clock moving, so each
   * test asserts where it stands instead of waiting for an outcome that may never come. */
  async function start(
    coordinator: FleetLeaseCoordinator,
    options: Parameters<typeof requestOptions>[0] = {},
  ) {
    const outcome = coordinator.request(REQUEST, requestOptions(options));
    const ended = outcome.catch((error: unknown) => error);
    const state = promiseState(outcome);
    await tick();
    return { ended, outcome, state };
  }

  it("grants from another worker after one answers RUNTIME_MISSING", async () => {
    const { a, b, coordinator } = twoWorkers();
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { outcome, state } = await start(coordinator);

    expect(state.state).toBe("fulfilled");
    expect(leaseRequests(a)).toHaveLength(1);
    expect((await outcome).lease.worker?.id).toBe("wrk_b");
  });

  it.each(["UNKNOWN_MODEL", "NO_DRIVER"] as const)(
    "grants from another worker after one answers %s",
    async (code) => {
      const { a, b, coordinator } = twoWorkers();
      a.requestLeaseQueue.push({
        error: new SimlockError(code, "domain", "no", { platform: "ios" }),
        kind: "error",
      });
      b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      const { outcome, state } = await start(coordinator);

      expect(state.state).toBe("fulfilled");
      expect(leaseRequests(a)).toHaveLength(1);
      expect((await outcome).lease.worker?.id).toBe("wrk_b");
    },
  );

  it("does not ask the refusing worker again for that request", async () => {
    const { a, b, coordinator, workers } = twoWorkers();
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    // wrk_b is busy at first, so the request waits with only wrk_a's refusal behind it.
    b.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { outcome, state } = await start(coordinator);
    expect(state.state).toBe("pending");
    expect(leaseRequests(a)).toHaveLength(1);
    // Every later view change re-walks the waiter; wrk_a must stay out of it.
    workers.refresh("wrk_a", { capacity: roomierIos() });
    workers.refresh("wrk_b", { queueDepth: 1 });
    workers.refresh("wrk_b", { capacity: roomierIos(), queueDepth: 0 });
    await tick();

    expect(leaseRequests(a)).toHaveLength(1);
    expect(state.state).toBe("fulfilled");
    expect((await outcome).lease.worker?.id).toBe("wrk_b");
  });

  it("gives the client the worker's own code and message when no worker is left", async () => {
    const { a, b, coordinator } = twoWorkers();
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({
      error: new SimlockError("UNKNOWN_MODEL", "domain", "worker b does not know it", {
        model: "iPhone 17",
        platform: "ios",
      }),
      kind: "error",
    });

    const { ended, state } = await start(coordinator);

    expect(state.state).toBe("rejected");
    // The most recent refusal, not the first and not the table's own.
    const rejection = await ended;
    expect(rejection).toBeInstanceOf(DispatchError);
    expect(rejection).toMatchObject({
      code: "UNKNOWN_MODEL",
      message: "worker b does not know it",
    });
    expect(leaseRequests(a)).toHaveLength(1);
    expect(leaseRequests(b)).toHaveLength(1);
  });

  it("keeps a refusal after a progress push final", async () => {
    const { a, b, coordinator } = twoWorkers();
    a.requestLeaseQueue.push({
      error: runtimeMissing(),
      kind: "error",
      progress: [{ etaMs: 1_000, stage: "booting" }],
    });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { ended, state } = await start(coordinator);

    expect(state.state).toBe("rejected");
    expect(await ended).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(leaseRequests(b)).toEqual([]);
  });

  it("does not reset the queue deadline when it retries to a queue position", async () => {
    // wrk_b is busy, so the only worker the retry can reach is wrk_a.
    const { a, clock, coordinator, workers } = twoWorkers({ busyB: true });
    a.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    // wrk_a's second answer takes 60 000 ms, all of the request's budget: the deadline passes
    // while the attempt is in flight, which is not itself a rejection.
    let calls = 0;
    const answer = a.requestLease.bind(a);
    a.requestLease = async (input, options) => {
      calls += 1;
      if (calls === 2) clock.advance(60_000);
      return answer(input, options);
    };

    const { ended, state } = await start(coordinator, { timeoutMs: 60_000 });
    expect(coordinator.queueDepth).toBe(1);
    expect(state.state).toBe("pending");
    // wrk_a's view changed, so it is asked again and refuses for good. The retry goes back to
    // the queue, and the original deadline has already passed.
    workers.refresh("wrk_a", { capacity: roomierIos() });
    await tick();

    expect(calls).toBe(2);
    expect(state.state).toBe("rejected");
    expect(await ended).toBeInstanceOf(QueueTimeoutError);
    expect(coordinator.queueDepth).toBe(0);
  });

  it("does not send a request to the next free worker after its queue deadline passed during a refused attempt", async () => {
    const { a, b, clock, coordinator, workers } = twoWorkers({ busyB: true });
    a.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    // During wrk_a's second attempt the whole budget passes and wrk_b frees up.
    let calls = 0;
    const answer = a.requestLease.bind(a);
    a.requestLease = async (input, options) => {
      calls += 1;
      if (calls === 2) {
        clock.advance(60_000);
        workers.refresh("wrk_b", { capacity: statusFixture().capacity });
      }
      return answer(input, options);
    };

    const { ended, state } = await start(coordinator, { timeoutMs: 60_000 });
    expect(state.state).toBe("pending");
    workers.refresh("wrk_a", { capacity: roomierIos() });
    await tick();

    expect(calls).toBe(2);
    expect(state.state).toBe("rejected");
    expect(await ended).toBeInstanceOf(QueueTimeoutError);
    expect(leaseRequests(b)).toEqual([]);
  });

  it.each([
    "BAD_REQUEST",
    "INSUFFICIENT_DISK_SPACE",
    "LICENSE_NOT_ACCEPTED",
    "REQUESTER_ALREADY_LEASED",
    "INTERNAL",
  ] as const)("keeps %s final instead of trying another worker", async (code) => {
    const { a, b, coordinator } = twoWorkers();
    a.requestLeaseQueue.push({
      error: new SimlockError(code, "domain", "nope", {}),
      kind: "error",
    });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { ended, state } = await start(coordinator);

    expect(state.state).toBe("rejected");
    expect(await ended).toMatchObject({ code });
    expect(leaseRequests(b)).toEqual([]);
  });

  it("reads the refusing worker's catalog again", async () => {
    const { a, b, coordinator, directory } = twoWorkers();
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    await start(coordinator);

    expect(directory.catalogRefreshCalls).toEqual(["wrk_a"]);
  });

  it("still retries when the refusing worker's catalog refresh fails, and logs it", async () => {
    const logger = new RecordingLogger();
    const { a, b, coordinator, directory } = twoWorkers({ logger });
    directory.failingRefresh.add("wrk_a");
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { outcome, state } = await start(coordinator);

    expect(state.state).toBe("fulfilled");
    expect((await outcome).lease.worker?.id).toBe("wrk_b");
    expect(logger.debugs).toEqual([
      {
        fields: { message: "refresh failed", workerId: "wrk_a" },
        message: "Failed to refresh a worker's view after a worker's refusal",
      },
    ]);
  });

  it("still retries when the refusing worker's link closed right after it refused", async () => {
    const { a, b, coordinator, directory } = twoWorkers();
    const answer = a.requestLease.bind(a);
    a.requestLease = async (input, options) => {
      directory.clients.delete("wrk_a");
      return answer(input, options);
    };
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { outcome, state } = await start(coordinator);

    expect(state.state).toBe("fulfilled");
    expect((await outcome).lease.worker?.id).toBe("wrk_b");
  });

  describe("gateway events when no worker is left", () => {
    function recordEvents(eventBus: EventBus) {
      const events: Array<{ name: string; payload: unknown }> = [];
      for (const name of ["lease.queued", "lease.rejected"] as const) {
        eventBus.subscribe(name, (envelope) => events.push({ name, payload: envelope.payload }));
      }
      return events;
    }

    it("emits lease.rejected with reason unresolvable-spec after lease.queued when the request had entered the gateway queue", async () => {
      const { a, b, coordinator, eventBus, workers } = twoWorkers();
      const events = recordEvents(eventBus);
      a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
      b.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });
      const { ended, state } = await start(coordinator);
      expect(state.state).toBe("pending");

      // The only worker left goes away: the table ends the request with wrk_a's stored refusal.
      workers.disconnected("wrk_b");
      await tick();

      expect(state.state).toBe("rejected");
      expect(await ended).toMatchObject({ code: "RUNTIME_MISSING" });
      expect(events.map((event) => event.name)).toEqual(["lease.queued", "lease.rejected"]);
      expect(events[1]?.payload).toMatchObject({ reason: "unresolvable-spec" });
    });

    it("emits no gateway lease.rejected for a request the stored refusal ends before it entered the gateway queue", async () => {
      const fleetHarness = harness();
      const a = new ScriptedWorkerClient();
      fleetHarness.directory.add("wrk_a", a);
      connectWorker(fleetHarness.workers, "wrk_a");
      const events = recordEvents(fleetHarness.eventBus);
      a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });

      const { ended, state } = await start(fleetHarness.coordinator);

      expect(state.state).toBe("rejected");
      expect(await ended).toMatchObject({ code: "RUNTIME_MISSING" });
      expect(events).toEqual([]);
    });
  });
});

describe("FleetLeaseCoordinator: lease.rejected names its request", () => {
  type Reason = EventMap["lease.rejected"]["reason"];
  type Fleet = ReturnType<typeof harness>;

  interface Outcome {
    readonly fleet: Fleet;
    readonly requester: string;
    /** The id the request was stored under, when it was stored. */
    readonly requestId?: string | undefined;
  }

  /** Asks for a device as `requesterId` and settles whatever the request ends with. */
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

  /** A fleet whose one worker is serving `agent-1`, saturated for everyone after. */
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

  /** One case per reason in `EventMap`, so a reason added there without a case fails typecheck. */
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
    cancelled: async () => {
      const fleet = await busyFleet();
      const requestId = await ask(fleet, { ownerId: "agent-2", requesterId: "agent-2" });
      await fleet.coordinator.cancelPending("agent-2");
      return { fleet, requestId, requester: "agent-2" };
    },
    "boot-timeout": "worker",
    killed: "worker",
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
    // Each request mints one id, in order: the refused one took the one before the admitted one.
    expect(requested).toEqual([admittedId]);
    expect(rejected[0]?.requestId).toMatch(/^req_/);
    expect(rejected[0]?.requestId).not.toBe(admittedId);
    expect(Number(rejected[0]?.requestId.replace("req_", ""))).toBe(
      Number(admittedId?.replace("req_", "")) - 1,
    );
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
