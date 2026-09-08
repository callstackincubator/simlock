import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { SimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { FakeClock, type Logger } from "../ports/index.js";
import type { WorkerDirectory, WorkerDispatchTarget } from "./fleet-ports.js";
import { FleetLeaseCoordinator } from "./fleet-coordinator.js";
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
  /** C1 (round 2 review): a worker id in here answers `reachable: true` but `client()`
   * `undefined` -- the real window `WorkerLink#reachable`/`#client` can disagree in, between a
   * reconnecting link's `#closed` clearing and its own handshake finishing (`#client` is not
   * assigned until `start()` completes). Distinct from `unreachable` above, which models
   * `reachable: false` instead -- a different code path in `#attempt`/`#forwardToWorker` that no
   * test previously exercised the *first* of the two ways. */
  readonly reachableButNoClient = new Set<string>();
  readonly refreshCalls: string[] = [];

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
      refresh: async () => {
        this.refreshCalls.push(workerId);
      },
      workerId,
    };
  }
}

/** Records every `warn` call -- for H6's own test, which asserts a mismatched ownerId echo is
 * logged rather than silently swallowed. */
class RecordingLogger implements Logger {
  readonly warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  debug(): void {}
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

    // Three requests queue up before any worker is connected -- all genuinely `queued`, not
    // settled at admission.
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

    // `connectWorker`'s default capacity reports two free iOS slots -- on paper, room for two of
    // the three queued waiters above. Without the per-pass cap, `#dispatch`'s single pass would
    // run `routing.select` against this same unchanged view for every one of the three, pick
    // worker A for every one of them, and fire three concurrent `lease.request`s in this one pass.
    connectWorker(workers, "wrk_a");
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

    const w1 = coordinator
      .request(REQUEST, requestOptions({ ownerId: "agent-1", requesterId: "agent-1" }))
      .catch((error: unknown) => error);
    const w2 = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(2);

    connectWorker(workers, "wrk_a");
    await tick();
    // H6's own per-pass cap: only w1 was attempted this pass, w2 passed over.
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    // w1's RPC settles terminally with WORKER_UNREACHABLE, never an immediate NO_CAPACITY -- so
    // `#staleView`'s own refresh-triggered self-heal never runs for it, and this test never
    // triggers any worker-view change of its own either.
    clock.advance(5_000);
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

    const rejection = coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    await tick();
    // Not stuck forever, and not answerable by a stale-view refresh either -- the waiter must
    // come back to a state the queue's own machinery can act on.
    expect(coordinator.queueDepth).toBe(0);
    expect(directory.refreshCalls).toEqual([]);

    clock.advance(5_000);
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
    // to keep pushing. `docs/EVENTS.md` defines `request.dispatched` as "the gateway's fleet queue
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

    const rejection = coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    await tick();

    clock.advance(5_000);
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

  it("passes over a request no worker can serve instead of blocking behind it, and never lets a brand-new admission jump an older, equally-eligible waiter still queued behind it (C2, round 3 review)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_ios", client);
    // `oldFirst`'s own attempt claims the worker for the whole test and never settles -- what
    // matters here is which *other* waiter gets a look at the worker's nominal second slot next,
    // not what `oldFirst` itself resolves to.
    client.requestLeaseQueue.push({ kind: "hang" });

    // Admitted oldest first: an unserviceable android request, then two genuinely iOS-eligible
    // waiters -- all enter the queue before any worker connects. The round 3 review's own
    // title-vs-body finding (C2): the previous version of this test had only one iOS-eligible
    // waiter, so its title's ordering claim asserted nothing a reader could not already get from
    // the "passed over" half alone -- `oldSecond` and `newPromise` below are what actually exercise it.
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

    // The one worker that connects can only ever serve iOS -- an android-then-iOS dispatch loop
    // that gives up (or blocks) on android's own "no worker" answer would never reach either iOS
    // waiter behind it in this same pass. Its reported capacity (two free slots) is on paper room
    // for both `oldFirst` and `oldSecond`, but H6's own per-worker-per-pass cap intentionally
    // leaves `oldSecond` passed over here -- genuinely `queued`, not the bug this test targets.
    connectWorker(workers, "wrk_ios", { platform: "ios", models: ["iPhone 17"] });
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

    // C2 (round 2 review): the full self-contained payload `docs/EVENTS.md` specifies -- not
    // just the gateway-internal `requestId`/`workerId` pair.
    expect(dispatched).toEqual([
      {
        model: "iPhone 17",
        platform: "ios",
        queuedMs: expect.any(Number) as number,
        reason: "free-capacity",
        requestId: expect.any(String) as string,
        requesterId: "agent-1",
        workerId: "wrk_a",
      },
    ]);
    // Sanity: the request really did land where the event says it did.
    expect(grant.lease.worker?.id).toBe("wrk_a");
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
        workerId: "wrk_a",
      },
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

    void coordinator.request(REQUEST, requestOptions({ noWait: true }));
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

    await expect(
      coordinator.request(
        REQUEST,
        requestOptions({
          noWait: true,
          onProgress: (update) => progress.push(update.stage),
          ownerId: "agent-3",
          requesterId: "agent-3",
        }),
      ),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });

    expect(events).toEqual(["lease.rejected"]);
    expect(progress).toEqual([]);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("a noWait request bounced back by a stale view stays queued even with other requests queued -- §11's exception does not depend on queue depth", async () => {
    // §11: "an immediate NO_CAPACITY is the only answer that leaves it queued", and `#staleView`
    // applies that unconditionally, "even for a caller that asked noWait: true". Deciding on
    // `waiter.state === "queued"` could not tell "never attempted" from "attempted and bounced
    // back inside the same pass", so the answer flipped with unrelated queue depth.
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    await coordinator.request(REQUEST, requestOptions());
    void coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    // A second worker the views advertise but the directory cannot resolve: routing picks it,
    // `#attempt` finds no client, and `#staleView` bounces the waiter straight back -- all
    // synchronously, inside the admission's own pass.
    connectWorker(workers, "wrk_b");

    let settled = "pending";
    void coordinator
      .request(
        REQUEST,
        requestOptions({ noWait: true, ownerId: "agent-3", requesterId: "agent-3" }),
      )
      .then(
        () => (settled = "granted"),
        () => (settled = "rejected"),
      );
    await tick();

    expect(settled).toBe("pending");
    expect(coordinator.queueDepth).toBe(2);
  });

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

    const rejection = coordinator
      .exec(
        { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
        { manageEventSubscription: () => undefined, principal: "agent-1", role: "agent" },
      )
      .catch((error: unknown) => error);
    await tick();
    clock.advance(5_000);

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
    const rejection = coordinator
      .exec(
        { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
        {
          manageEventSubscription: () => undefined,
          onOutput: (stream, chunk) => {
            relayed.push({ chunk, stream });
          },
          principal: "agent-1",
          role: "agent",
        },
      )
      .catch((error: unknown) => error);
    await tick();
    clock.advance(5_000);
    const error = await rejection;
    expect((error as DispatchError).code).toBe("EXEC_TIMEOUT");

    // The worker, unaware this gateway already timed the call out, keeps streaming -- this is
    // exactly the closure `client.exec` was given, invoked exactly as the worker's own RPC
    // handling would invoke it in production, well after `EXEC_TIMEOUT` already settled.
    client.lastExecOptions?.onOutput?.({ chunk: "late output", stream: "stdout" });
    await tick();

    expect(relayed).toEqual([]);
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
