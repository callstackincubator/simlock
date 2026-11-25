import type { LeaseGrant } from "../admin/index.js";
import { isSimlockError, requestedDevice } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import type { Clock, Logger } from "../ports/index.js";
import type { FleetFacts, FleetOutcomes } from "./fleet-facts.js";
import type { FleetGrants } from "./fleet-grant.js";
import { classifyRelayedError, type FleetForwarding } from "./fleet-forwarding.js";
import { liveClient, type FleetViews, type WorkerDirectory } from "./fleet-ports.js";
import { FleetRefusals, refusedCapacityReason, type WorkerEntry } from "./fleet-refusals.js";
import {
  forwardedModel,
  physicalMatchKey,
  routable,
  type ModelName,
} from "./fleet-request-shape.js";
import type { FleetLeaseIndex } from "./lease-index.js";
import { lineOf, type FleetQueue, type FleetWaiter } from "./queue.js";
import type { RoutableRequest, RoutingDecision, RoutingPolicy } from "./routing.js";
import type { Rejection, WorkerReason } from "./routing/index.js";
import type { WorkerView } from "./worker-registry.js";
import { errorMessage } from "../shared/index.js";

/**
 * why: The dispatch race (see the module's own tests for the one that catches a naive fix)
 *
 * Dispatch re-runs on every worker-view change (`FleetViews#onViewsChanged`) and once more per
 * settled attempt. (C1/C2, round 3 review: `#attempt` now calls `#dispatch()` itself, right after
 * `#settleGrant` and right after its own terminal `reject` -- see `#attempt`'s own doc for why
 * this was previously false. `#admit` has no look of its own at all: it hands the
 * brand-new waiter to that same walk as its `candidate` -- see `#admit`'s own doc, and
 * architecture rule 10.) A waiter whose forwarded `lease.request` is still in
 * flight to worker A must never be picked up by a second pass and sent to worker B too -- if both granted, one requester
 * would hold two devices on two machines, and the fleet-wide admission check cannot catch it
 * (it runs once, at admission, before either RPC). `#beginAttempt` calls `queue.markProcessing`
 * *before* issuing the RPC, taking the waiter out of `queued` state, so `#dispatch`'s own
 * `queue.list()` scan skips it for the whole in-flight window; the waiter only becomes `queued`
 * again (via `#enqueue`, from `#staleView`) once that attempt has fully settled, or is rejected. There used to be
 * a second guard here too -- a `Map<FleetWaiter, string>` keyed by in-flight target -- but once
 * every exit from `#attempt` clears its waiter's processing state in exactly one place (the
 * `finally` below), the two checks can never disagree: nothing can observe a waiter that is both
 * `queued` and mid-attempt. Keeping a guard with no state it can ever catch was worse than
 * deleting it (round 2 review, C1/C2) -- if a future change reintroduces that race, the fix is a
 * new guard proven by a new failing test, not resurrecting one that only ever watched itself.
 */

// why: the filters that hold a worker back only for now (it is full, busy, not ready or unhealthy), so it could take the request later; any other reason (drained, disconnected, a missing driver, runtime, model or capability) means it will not take it by waiting.
const COULD_TAKE_LATER: ReadonlySet<WorkerReason["reason"]> = new Set([
  "busy",
  "full",
  "not-ready",
  "unhealthy",
  "updating",
]);

// why: ADR 0042 §3: a worker that began its update after the gateway's last read refuses with `DAEMON_UPDATING`, and its view is as stale as after `NO_CAPACITY`.
const STALE_VIEW_CODES: ReadonlySet<string> = new Set(["NO_CAPACITY", "DAEMON_UPDATING"]);

const CANNOT_SERVE_CODES: ReadonlySet<string> = new Set([
  "UNKNOWN_MODEL",
  "RUNTIME_MISSING",
  "NO_DRIVER",
  "CAPABILITY_MISSING",
  "UNKNOWN_BASELINE",
  "BASELINE_MISMATCH",
  "BASELINE_STALE",
  "MODE_UNAVAILABLE",
]);

export interface FleetDispatchOptions {
  readonly clock: Clock;
  readonly directory: WorkerDirectory;
  readonly views: FleetViews;
  readonly routing: RoutingPolicy;
  readonly leaseIndex: FleetLeaseIndex;
  readonly logger: Logger;
  readonly queue: FleetQueue;
  readonly forwarding: FleetForwarding;
  readonly facts: FleetFacts;
  readonly outcomes: FleetOutcomes;
  readonly grants: FleetGrants;
}

export class FleetDispatch {
  /** why: A `WeakMap` so a waiter that never dispatches (rejected, cancelled, timed out) leaks no entry. */
  readonly #createdAt = new WeakMap<FleetWaiter, number>();
  readonly #workerReasons = new WeakMap<FleetWaiter, readonly WorkerEntry[]>();
  readonly #refusals: FleetRefusals;
  #dispatchDepth = 0;
  #passRequested = false;

  constructor(private readonly options: FleetDispatchOptions) {
    this.#refusals = new FleetRefusals({ routing: options.routing, views: options.views });
  }

  /**
   * why: A brand-new waiter's admission. **Architecture rule 10: `noWait` is enforced in exactly one
   * place.** Every admission goes through `#dispatch`'s one ordered walk, carrying this waiter
   * as its `candidate` -- there is no second, out-of-order look of its own. A `noWait` waiter
   * whose worker answered `NO_CAPACITY` comes back through here too, for its one more walk
   * (ADR 0009 §5), so that rejection is decided here as well.
   *
   * There used to be two paths here: a direct `routing.select` when the queue was empty, and an
   * enqueue-then-dispatch when it was not. They answered the same question and drifted, exactly
   * as rule 10 describes. Four consecutive review rounds each found a fresh defect in that
   * disagreement, ending with a request that answered `NO_CAPACITY` immediately or waited in the
   * queue depending on whether *unrelated* requests happened to be queued at the time.
   *
   * Queue membership is committed only once the waiter is actually going to wait. That ordering
   * is load-bearing rather than tidy: `WaitQueue#enqueue` pushes a `queued` progress frame to
   * the caller and `#enqueue` emits `lease.queued`, and a `noWait` request that is about to be
   * refused must produce neither. ADR §10 requires "the same codes and progress states a worker
   * uses", and the worker's own `#defer` rejects a `noWait` waiter *before* it enqueues.
   *
   * H9 (round 2 review): throws a plain `DispatchError("NO_CAPACITY", ...)` rather than a
   * fleet-native error class -- `DispatchError`'s own code is used verbatim by
   * `daemon/error-code.ts#classifyError`'s first branch, so no gateway-specific class or import
   * is needed there to answer the same code the worker's own `NoCapacityError` answers. Before
   * this, `src/daemon` (every worker-mode daemon, not just gateway mode) imported that class
   * from `src/gateway/fleet-coordinator.js` just to recognize it, pulling the whole gateway
   * module graph into ordinary worker startup with no lint rule covering that direction.
   */
  admit(waiter: FleetWaiter): void {
    // why: Attempted. If that attempt is refused, `#attempt` decides the rest: one more walk for a
    // `noWait` caller (ADR 0009 §5). A target that turned out unreachable re-queues it. A
    // candidate the walk rejected as unservable (ADR 0009 §4) is terminal, so the rejection and
    // the enqueue below are no-ops on it: `WaitQueue` refuses both for a terminal waiter.
    if (this.dispatch(waiter)) return;
    if (waiter.options.noWait === true) {
      this.options.outcomes.reject(
        waiter,
        new DispatchError("NO_CAPACITY", "No worker in the fleet can currently serve this request"),
        "no-wait",
      );
      return;
    }
    this.options.outcomes.enqueue(waiter);
  }

  dispatch(candidate?: FleetWaiter): boolean {
    if (this.#dispatchDepth > 0) {
      // why: Round 4 review: a nested pass used to be *dropped*. The outer walk iterates a snapshot
      // and has already claimed workers, so a waiter freed mid-pass would never be reconsidered
      // -- C1's stall, reintroduced silently by the guard meant to prevent recursion. Defer
      // instead of dropping: the outer call runs another pass once this one unwinds.
      this.#passRequested = true;
      return false;
    }
    this.#dispatchDepth += 1;
    try {
      const candidateAttempted = this.#dispatchPass(candidate);
      while (this.#passRequested) {
        this.#passRequested = false;
        this.#dispatchPass();
      }
      return candidateAttempted;
    } finally {
      this.#dispatchDepth -= 1;
      this.#passRequested = false;
    }
  }

  // fallow-ignore-next-line unused-class-member -- FleetAdmission calls it through its options' Pick<FleetDispatch>.
  noteCreated(waiter: FleetWaiter): void {
    this.#createdAt.set(waiter, this.options.clock.now());
  }

  workerReasons(waiter: FleetWaiter): readonly WorkerEntry[] | undefined {
    return this.#workerReasons.get(waiter);
  }

  /**
   * why: `candidate` walks last, because it is the newest: that keeps the single fleet FIFO honest.
   * The return says whether it was attempted, which `waiter.state` alone cannot tell `#admit`.
   */
  #dispatchPass(candidate?: FleetWaiter): boolean {
    // why: a virtual pick holds a worker; a physical pick holds a worker for the same match only.
    const claimedThisPass = { physical: new Set<string>(), virtual: new Set<string>() };
    const attempted = new Set<FleetWaiter | undefined>();
    const waiters =
      candidate === undefined || this.options.queue.isQueued(candidate)
        ? this.options.queue.list()
        : [...this.options.queue.list(), candidate];
    for (const waiter of waiters) {
      // why: The candidate is mid-admission, not `queued`, even when it holds a queue position.
      if (waiter !== candidate && waiter.state !== "queued") continue;
      if (this.#walkWaiter(waiter, claimedThisPass)) attempted.add(waiter);
    }
    return attempted.has(candidate);
  }

  #walkWaiter(
    waiter: FleetWaiter,
    claims: { readonly physical: Set<string>; readonly virtual: Set<string> },
  ): boolean {
    const isPhysical = lineOf(waiter.request) === "physical";
    const claimedThisPass = isPhysical ? claims.physical : claims.virtual;
    const claimKey = (workerId: string): string =>
      isPhysical ? `${workerId}\u0000${physicalMatchKey(waiter.request)}` : workerId;
    const refusals = this.#refusals.cannotServe(waiter);
    // why: A worker claimed this pass or one that answered `NO_CAPACITY` is busy, not unable, so it
    // stays in the table's view.
    const allViews = this.options.views.routingViews();
    const views = allViews.filter((worker) => refusals?.has(worker.id) !== true);
    const request = routable(waiter);
    const verdict = this.options.routing.assess(request, views);
    if (verdict.kind === "reject") {
      this.#rejectUnservable(waiter, verdict, refusals);
      return false;
    }
    const reasons = this.#refusals.reasonsFor(waiter, request, allViews, {
      claimed: (workerId) => claimedThisPass.has(claimKey(workerId)),
    });
    this.#workerReasons.set(waiter, reasons);
    const eligibleWorkers = views.filter(
      (worker) =>
        !claimedThisPass.has(claimKey(worker.id)) && !this.#refusals.refused(waiter, worker),
    );
    const decision = this.options.routing.select(request, eligibleWorkers);
    if (decision === undefined) {
      this.#rejectIfEveryWorkerFailedProvisioning(waiter, request, views);
      return false;
    }
    claimedThisPass.add(claimKey(decision.workerId));
    this.#beginAttempt(waiter, decision, forwardedModel(request, eligibleWorkers, decision));
    return true;
  }

  // why: a second failed provision walks on like a cannot-serve code, and only when every worker that could take the request failed so does it end with the last answer; a worker held back only for now (full, busy, not ready, unhealthy) could take it later, so it keeps the request queued.
  #rejectIfEveryWorkerFailedProvisioning(
    waiter: FleetWaiter,
    request: RoutableRequest,
    views: readonly WorkerView[],
  ): void {
    const refusals = this.#refusals.refusals(waiter);
    if (refusals === undefined) return;
    const open = this.options.routing
      .explain(request, views)
      .filter((entry) => entry.filter === undefined || COULD_TAKE_LATER.has(entry.filter.reason))
      .map((entry) => entry.workerId);
    const failed = [...refusals]
      .filter(([workerId]) => open.includes(workerId))
      .flatMap(([workerId, refusal]) =>
        refusal.provisionFailure === undefined
          ? []
          : [{ failure: refusal.provisionFailure, workerId }],
      );
    const last = failed.at(-1);
    if (last === undefined || failed.length < open.length) return;
    this.options.outcomes.reject(waiter, last.failure, "worker-failed", {
      code: last.failure.code,
      worker: last.workerId,
    });
  }

  /** why: Ends a request the table of ADR 0009 §4 says no worker can serve, with the code and
   * details a worker gives the same request. A request that holds a worker's "cannot serve"
   * refusal ends with the last one instead (ADR 0009 §5). The worker only declined the dispatch
   * (`lease.declined`), so the end is this gateway's own fact (ADR 0021 §4): `lease.rejected`
   * with reason `unresolvable-spec`, whether or not the request had entered the gateway queue. */
  #rejectUnservable(
    waiter: FleetWaiter,
    verdict: Rejection,
    refusals: ReadonlyMap<string, DispatchError> | undefined,
  ): void {
    const last = refusals === undefined ? undefined : [...refusals.values()].at(-1);
    if (last !== undefined) {
      this.options.outcomes.reject(waiter, last, "unresolvable-spec");
      return;
    }
    this.options.outcomes.reject(
      waiter,
      new DispatchError(verdict.code, verdict.message, verdict.details),
      verdict.reason,
    );
  }

  /**
   * why: H2 (round 2 review): `markProcessing`'s own `false` return -- the waiter is already terminal
   * -- used to be ignored, issuing the RPC anyway. Masked in practice by every caller
   * (`#admit`/`#dispatch`) only ever reaching this with a live waiter today, but nothing enforced
   * that: a grant landing for a waiter that settled a moment earlier would still be indexed by
   * `#settleGrant` while `queue.resolve` quietly answers `false`, leaving an orphan lease no
   * client holds a reference to release.
   */
  #beginAttempt(waiter: FleetWaiter, decision: RoutingDecision, rename: ModelName): void {
    if (!this.options.queue.markProcessing(waiter)) return;
    void this.#attempt(waiter, decision, rename);
  }

  /**
   * why: Every exit from this method leaves `waiter` either terminal (`resolve`/`reject`, inside
   * `#settleGrant`/the catch below), back in `queued` (`#staleView`'s `#enqueue`), or -- a
   * `noWait` waiter refused with `NO_CAPACITY`, or any waiter refused with a cannot-serve code
   * before progress (ADR 0009 §5) -- handed back to `#admit`, which leaves it
   * terminal or `processing` in a new attempt that these same rules govern -- never
   * stuck `processing` with nothing left to drive it, and never in two places disagreeing about
   * which. C1 (round 2 review): the first early return used to skip straight to `#staleView`
   * without first clearing a separate `#dispatchTargets` mark this method used to set -- the mark
   * survived the re-queue, and `#dispatch`'s guard on it then skipped this waiter forever. Since
   * `queue.markProcessing`/`#enqueue` (`WaitQueue`'s own state, not a second map this class kept
   * beside it) is now the *only* bookkeeping a waiter's in-flight-ness lives in, every branch
   * below already leaves it in one of exactly those states on its own -- there is no second
   * clear-up step left to forget.
   *
   * C1 (round 3 review): the two branches that leave `waiter` *terminal* -- `#settleGrant`, and
   * the catch block's own `queue.reject` -- also each call `#dispatch()` themselves, right after.
   * `#staleView`'s own branches (the unreachable-target check above, the catch's immediate
   * `NO_CAPACITY`, and the mismatched-grant retry) do not need to: all already call a worker's `refresh()`, and a real snapshot
   * landing for it fires `#onViewsChanged` -> `#dispatch()`. That pass offers the waiter to every
   * other worker; it offers it to a worker that answered `NO_CAPACITY` only once that worker's
   * view has changed (ADR 0009 §5), so a worker that keeps refusing is asked once per change of
   * its state, not on every refresh. A `noWait` waiter refused with `NO_CAPACITY` is not
   * re-queued: it gets one more walk here, and is rejected if no worker is picked in it. The
   * terminal branches have no such follow-up of their own -- a worker this
   * class gave up on (`WORKER_UNREACHABLE`, `INTERNAL`) or was refused for a reason genuinely
   * unrelated to capacity (any other worker-side code) may still be exactly the worker a different
   * queued waiter needs, and nothing else would ever schedule that second look.
   */
  // fallow-ignore-next-line complexity -- one attempt, every exit of which is named in the doc comment above.
  async #attempt(waiter: FleetWaiter, decision: RoutingDecision, rename: ModelName): Promise<void> {
    const workerId = decision.workerId;
    const client = liveClient(this.options.directory.target(workerId));
    if (client === undefined) {
      // why: The view named a worker that is no longer reachable by the time we got here -- the same
      // "stale, not wrong" story as a worker's own `NO_CAPACITY`, just discovered a step earlier.
      this.#staleView(waiter, workerId, { unreachable: true });
      return;
    }

    const namespacedRequesterId = `${this.options.leaseIndex.requesterPrefix}${waiter.options.requesterId}`;
    let announced = false;
    const announceDispatched = (): void => {
      if (announced) return;
      announced = true;
      const createdAt = this.#createdAt.get(waiter);
      this.options.facts.emit("request.dispatched", {
        ...(waiter.request.model === undefined ? {} : { model: waiter.request.model }),
        ...(waiter.request.class === undefined ? {} : { class: waiter.request.class }),
        ...(waiter.request.mode === undefined ? {} : { mode: waiter.request.mode }),
        ...(lineOf(waiter.request) === "physical" ? { physical: true as const } : {}),
        platform: waiter.request.platform,
        queuedMs: createdAt === undefined ? 0 : Math.max(0, this.options.clock.now() - createdAt),
        reason: decision.reason,
        requestId: waiter.id,
        requesterId: waiter.options.requesterId,
        stage: decision.stage,
        workerId,
      });
    };

    // why: P4 (round 3 review): H4's own reasoning applies verbatim here --
    // `FleetForwarding.withLeaseRequestTimeout` settling `WORKER_UNREACHABLE` only stops *this*
    // call's returned promise from being awaited
    // any further, not the worker's own still-pending `lease.request` RPC, whose `onProgress`
    // closure below stays live for as long as the worker keeps pushing progress. Before this,
    // a late `progress` push after the timeout had already rejected the waiter still called
    // `announceDispatched()` and emitted `request.dispatched` for a request this gateway had
    // already told its caller was `WORKER_UNREACHABLE` -- a false past-tense fact against
    // `docs/internal/EVENTS.md`'s own "and the worker took it". Same mechanism as `exec`'s `detached`, not
    // a second bespoke one: flipped by `FleetForwarding.withLeaseRequestTimeout`'s own `onTimeout`
    // hook, checked here before either `announceDispatched()` or `notifyProgress` run.
    let detached = false;
    let grant: LeaseGrant;
    try {
      grant = await this.options.forwarding.withLeaseRequestTimeout(
        client.requestLease(
          {
            ...requestedDevice({ ...waiter.request, ...rename }),
            requesterId: namespacedRequesterId,
            // why: ADR §27a (narrowed, round 3 review, H3): only the worker's own gateway-uplink
            // session may set `owner` -- and this RPC always travels over exactly that
            // connection (`WorkerLink#connect`, via `acceptUplink` on the worker's own end, see
            // `session.isGatewayUplink`'s doc). The worker stores this verbatim as the lease's
            // `ownerId` instead of deriving it from the connection -- see
            // `daemon/dispatcher-leases.ts`'s `leaseRequest`.
            owner: waiter.options.ownerId,
            // why: ADR 0009 §3: a download is never triggered through a gateway.
            allowDownload: false,
            // why: ADR §12: worker queues never hold gateway traffic. Every dispatch is `noWait`
            // regardless of what the original caller asked the gateway for -- the *gateway's
            // own* queue is where a "wait" request actually waits.
            noWait: true,
            ...(waiter.options.ttlMs === undefined ? {} : { ttlMs: waiter.options.ttlMs }),
            // why: ADR 0020: sent as the requester sent it. The worker grants exactly this id, and
            // its refusal (`LEASE_ID_TAKEN`) is the caller's answer: no other worker is tried.
            ...(waiter.options.leaseId === undefined ? {} : { leaseId: waiter.options.leaseId }),
            ...(waiter.options.runId === undefined ? {} : { runId: waiter.options.runId }),
            ...(waiter.options.label === undefined ? {} : { label: waiter.options.label }),
            // why: ADR 0021: this gateway's id for the request marks the dispatch a probe. The worker
            // declines a probe it refuses (`lease.declined`) rather than rejecting it, and names
            // the id on the lease events of the dispatch.
            fleetRequestId: waiter.id,
            ...(waiter.options.requires === undefined
              ? {}
              : { requires: [...waiter.options.requires] }),
          },
          {
            onProgress: (progress) => {
              if (detached) return;
              // why: ADR §11: "the first `progress` push" is one of the two signals a request is
              // this worker's now -- device work having started means it is committed here even
              // before the grant itself arrives.
              announceDispatched();
              this.options.queue.notifyProgress(waiter, progress);
            },
          },
        ),
        workerId,
        () => {
          detached = true;
        },
      );
      // why: the grant crossed a wire; a worker must not be able to crash the gateway with an answer without a lease, so it fails this attempt like any other worker failure.
      if (typeof (grant as Partial<LeaseGrant> | null)?.lease?.id !== "string") {
        throw new DispatchError(
          "INTERNAL",
          `Worker ${workerId} answered lease.request with a malformed grant`,
          { workerId },
        );
      }
    } catch (error: unknown) {
      // why: P1 (round 2 review): "an *immediate* NO_CAPACITY is the only answer that leaves it
      // queued ... the request waits" (§11) -- `announced` is exactly the "work has begun"
      // distinction the ADR draws, already maintained above for `request.dispatched`. A worker
      // can answer `NO_CAPACITY` *after* pushing progress (its own `#evictManaged` failure path,
      // reached from a `noWait` waiter's `#defer`, runs after `provisioning`/`reclaiming`), and
      // that is this request's own terminal failure -- not a stale view to retry, because device
      // work already started means the request was this worker's (§11's own wording). Re-queuing
      // it anyway silently reversed a dispatch the caller had already been told about.
      if (isSimlockError(error) && STALE_VIEW_CODES.has(error.code) && !announced) {
        this.#refusals.rememberRefusal(waiter, workerId, {
          capacityReason: refusedCapacityReason(error.details),
        });
        if (waiter.options.noWait === true) {
          this.#refreshView(workerId);
          // why: ADR 0009 §5: one more walk, with this worker left out until its view changes. A
          // `noWait` caller never asked to wait for that change, so `#admit` rejects it if no
          // worker is picked.
          this.admit(waiter);
          return;
        }
        this.#staleView(waiter, workerId);
        return;
      }
      // why: a provision failure before the worker's progress push did no device work, so another worker may serve it and the walk goes on without this one; after a progress push it falls through to the terminal branch below, as today.
      if (isSimlockError(error) && error.code === "PROVISION_FAILED" && !announced) {
        this.#refusals.rememberRefusal(waiter, workerId, {
          provisionFailure: classifyRelayedError(error, workerId),
        });
        this.#refreshView(workerId);
        this.admit(waiter);
        return;
      }
      if (isSimlockError(error) && CANNOT_SERVE_CODES.has(error.code) && !announced) {
        this.#refusals.rememberCannotServe(waiter, workerId, classifyRelayedError(error, workerId));
        this.#refreshView(workerId, { includeCatalog: true });
        this.admit(waiter);
        return;
      }
      // why: C1 (round 3 review): this waiter's own outcome is terminal, but the worker it just gave
      // up (or never actually reached) may still be free for whoever else is queued behind it --
      // and unlike `#staleView`'s branch above, nothing else here schedules another look at them.
      // `WORKER_UNREACHABLE`/`INTERNAL` in particular need not produce any worker-side event, so
      // without this a waiter passed over in this same pass had nothing left to wake it until the
      // next real worker-view change (the 30s refresh tick, at best).
      // ADR 0021 §4: this is the request's end, and the worker emits no `lease.rejected` for a
      // probe (at most a `lease.declined`; for an unreachable worker or a gateway-side `INTERNAL`
      // there is usually none, and a dispatch timeout only stops this gateway waiting: the
      // worker's `lease.request` keeps running and can still end in a relayed `lease.declined`
      // or a grant), so this gateway records it, with the code the caller got and the worker it
      // failed on.
      const failure = this.#classifyLeaseRequestError(error, workerId);
      this.options.outcomes.reject(waiter, failure, "worker-failed", {
        code: failure.code,
        worker: workerId,
      });
      this.dispatch();
      return;
    }

    announceDispatched();
    if (this.options.grants.settle(waiter, workerId, grant) === "retry") {
      // why: The worker answered with an id the gateway did not ask for: the attempt failed, and the
      // request goes back to the queue as after an unreachable worker. This worker is left out
      // until its view changes, so a worker that keeps answering so is not asked in a loop.
      this.#refusals.rememberRefusal(waiter, workerId);
      this.#staleView(waiter, workerId);
      return;
    }
    // why: C1 (round 3 review): see the catch branch above -- a grant settling this waiter is just as
    // much a reason for whoever else is queued to get another look, not only a terminal failure.
    this.dispatch();
  }

  /**
   * why: a terminal failure past `#attempt`'s `NO_CAPACITY`/stale-view check. A worker never
   * rejects a probe: where it answered, it only declined (`lease.declined`, relayed onto this bus with
   * `workerId` added by `WorkerLink`), and where it did not (`WORKER_UNREACHABLE`, a gateway-side
   * `INTERNAL`) it usually emitted nothing; after a dispatch timeout the worker's request is
   * still running and may yet end in a relayed `lease.declined` or a grant, since the timeout
   * only stops this gateway waiting. Either way the request's end is this
   * gateway's own `lease.rejected` (ADR 0021 §4). The error code is
   * preserved so the caller sees what the worker actually said, with three exceptions:
   *
   * - a transport failure (the uplink itself, not the worker's own answer) -- ADR §28/§29 name
   *   `WORKER_UNREACHABLE` for that, not whatever the client's own connection loss happens to be
   *   called (`daemon/dispatch.js`'s `SimlockError.kind` is what tells the two apart);
   * - `FleetForwarding.withLeaseRequestTimeout`'s own `DispatchError` (P2, round 2 review) --
   *   never a `SimlockError`, since it is raised here, by this gateway's own timer, not by the worker's
   *   answer (the request itself did reach the worker and keeps running there) -- forwarded as-is;
   * - anything else that is neither of those (H1, round 2 review): not a fact about the worker,
   *   since every real transport failure already arrives as a `kind: "transport"` `SimlockError`,
   *   so this is a bug in this coordinator's own request-building code. `WORKER_UNREACHABLE`
   *   used to answer this case too, misreporting a gateway-side crash as "the machine is
   *   unreachable"; `INTERNAL` is what `FleetForwarding#forwardToWorker`'s matching branch
   *   answers for the same shape of failure.
   */
  #classifyLeaseRequestError(error: unknown, workerId: string): DispatchError {
    if (error instanceof DispatchError) return error;
    if (isSimlockError(error)) return classifyRelayedError(error, workerId);
    return new DispatchError(
      "INTERNAL",
      `Unexpected error forwarding lease.request to worker ${workerId}`,
      { workerId },
    );
  }

  /** why: ADR §11: "an immediate `NO_CAPACITY` is the only answer that leaves it queued ... the
   * request waits", because this is a stale view, not a real refusal. A waiter reaches
   * this from a target that turned out unreachable, and from a grant whose id was not the one
   * asked for (`noWait` included, in both); a `noWait` caller refused with `NO_CAPACITY` is
   * settled in `#attempt` instead (ADR 0009 §5). */
  #staleView(
    waiter: FleetWaiter,
    workerId: string,
    options: { readonly unreachable?: boolean } = {},
  ): void {
    // why: the walk that picked this worker ran before its answer; the entries must say what is true now.
    this.#workerReasons.set(
      waiter,
      this.#refusals.reasonsFor(
        waiter,
        routable(waiter),
        this.options.views.routingViews(),
        options.unreachable === true ? { unreachable: workerId } : {},
      ),
    );
    this.options.outcomes.enqueue(waiter);
    this.#refreshView(workerId);
  }

  #refreshView(workerId: string, options?: { readonly includeCatalog: true }): void {
    const target = this.options.directory.target(workerId);
    void target?.refresh(options).catch((error: unknown) => {
      this.options.logger.debug("Failed to refresh a worker's view after a worker's refusal", {
        workerId,
        message: errorMessage(error),
      });
    });
  }
}
