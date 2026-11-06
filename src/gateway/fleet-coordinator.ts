/**
 * `FleetLeaseCoordinator`: admission, the fleet-wide one-lease rule, dispatch, and lease/exec
 * forwarding (ADR 0005 §10-§16, §19a-§19c, §27, §27a). Much smaller than the worker's own
 * `LeaseAcquisitionCoordinator` -- there is no provisioning, no eviction, and no driver to ask: a
 * worker either grants a forwarded `lease.request` immediately or refuses it, because every
 * dispatch is `noWait` (§12).
 *
 * ## The dispatch race (see the module's own tests for the one that catches a naive fix)
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
 *
 * ## Two different fields, two different rules
 *
 * The fleet-wide "already leased" admission check keys on **`requesterId`** (§14) and runs
 * inside one `SerializedDecision.run` together with the enqueue (`request` below), so two
 * concurrent requests for one requester cannot both pass before either is admitted. Ownership
 * authorization for `lease.renew`/`lease.release`/`device.exec` keys on **`ownerId`** instead
 * (§26) -- the gateway's own inbound principal, resolved by `GatewayDispatcher`'s
 * `authorizeLookups` from `ownerId()`/`leaseRequesterId()` below, never by this class directly.
 */
import type { EventBus, EventMap } from "../bus/index.js";
import type {
  BaselineSaveInput,
  BaselineSaveOutput,
  LeaseGrant,
  RotateOutput,
} from "../admin/index.js";
import {
  isSimlockError,
  requestedClass,
  requestedDevice,
  type Platform,
} from "../contract/index.js";
import { DispatchError, type DispatchSession } from "../daemon/dispatch.js";
import {
  type LeaseRequestFailure,
  type DeviceRequest,
  type LeaseRequestLimits,
  type MaxPerRequester,
  newLeaseRequestId,
  SerializedDecision,
} from "../core/index.js";
import {
  InMemoryLeaseRequestStore,
  LeaseRequestBook,
  requesterLimitDecision,
  type WaitingRequest,
} from "../leasing/index.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import {
  classifyRelayedError,
  FleetForwarding,
  type FleetExecInput,
  type FleetRotateInput,
} from "./fleet-forwarding.js";
import { liveClient, type WorkerDirectory } from "./fleet-ports.js";
import type { FleetViews } from "./fleet-ports.js";
import { FleetRefusals, refusedCapacityReason, type WorkerEntry } from "./fleet-refusals.js";
import { type FleetLeaseEntry, type FleetLeaseIndex } from "./lease-index.js";
import type { WorkerView } from "./worker-registry.js";
import {
  FleetQueue,
  lineOf,
  RequestCancelledError,
  type FleetLeaseGrant,
  type FleetLeaseRecord,
  type FleetWaiter,
  type LeaseRequestOptions,
} from "./queue.js";
import {
  matchRequest,
  type RoutableRequest,
  type RoutingDecision,
  type RoutingPolicy,
} from "./routing.js";
import { type Rejection, type WorkerReason } from "./routing/index.js";

// why: the gateway adds this to the leasing module's entry; the contract's schema is its wire shape.
export type FleetWaitingRequest = WaitingRequest & { readonly workers?: WorkerEntry[] };

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
]);

export interface FleetLeaseCoordinatorOptions {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly directory: WorkerDirectory;
  readonly views: FleetViews;
  readonly routing: RoutingPolicy;
  readonly leaseIndex: FleetLeaseIndex;
  /** ADR §19e (P5, round 2 review): `gateway.execTimeoutMs`, the backstop for a forwarded
   * `device.exec` whose worker never answers at all -- the worker's own `exec.timeoutMs` is
   * authoritative for an ordinary timeout (it owns the process and can kill it) and is expected
   * to fire first, since the gateway's default is deliberately the longer of the two. */
  readonly execTimeoutMs: number;
  /** why: P2 (round 2 review): `gateway.leaseRequestTimeoutMs` -- bounds a forwarded
   * `lease.request`, the one uplink call that used to have no timeout of its own. See
   * `FleetForwarding.withLeaseRequestTimeout`'s own doc comment. */
  readonly leaseRequestTimeoutMs: number;
  /**
   * `lease.requestRetentionMs`/`lease.maxRequestRecords`. A gateway keeps its lease requests in
   * memory only: a gateway restart loses every one it held, the same as before requests were
   * stored, while what it had already routed is stored on the worker that took it.
   */
  readonly leaseRequestLimits: LeaseRequestLimits;
  /** The same failure description a worker stores, so a replay answers with the same code. */
  readonly describeFailure: (error: unknown) => LeaseRequestFailure;
  readonly maxPerRequester?: MaxPerRequester;
  readonly logger?: Logger;
}

type FleetEventName =
  | "lease.requested"
  | "lease.queued"
  | "lease.rejected"
  | "queue.changed"
  | "request.dispatched"
  | "request.granted";

export class FleetLeaseCoordinator {
  readonly #queue: FleetQueue;
  readonly #decisions = new SerializedDecision();
  /** The gateway's lease requests, by the same rules a worker's are (`LeaseRequestBook`). */
  readonly requests: LeaseRequestBook<FleetLeaseGrant>;
  readonly #logger: Logger;
  #knownWorkerIds = new Set<string>();
  /** C1 (round 2 review): the `view.leases` array reference this coordinator last reconciled
   * into `leaseIndex` for each worker, keyed by worker id. `onViewsChanged` fires for *every*
   * worker-view mutation on the whole registry (`connected`, `refresh`, `disconnected`,
   * `setDrained`, `remove`, `pruneExpired` -- see `FleetViews#onViewsChanged`'s own doc), not
   * just a change to the worker being reconciled, so calling `rebuildFromWorker` for every view
   * on every notification bumped a worker's reconciliation generation without a new snapshot
   * ever having arrived for it (see `#onViewsChanged`'s own doc for the eviction this caused).
   * `WorkerRegistry` only ever replaces a view's `leases` array when a snapshot naming `leases`
   * actually lands for that specific worker (`refresh`'s partial-update contract; `connected` and
   * `disconnected` never touch it) -- so this reference is exactly "a new snapshot for this
   * worker arrived" and nothing else, with no need to widen `FleetViews` to carry worker
   * identity on the notification itself. */
  readonly #lastReconciledLeases = new Map<string, NonNullable<WorkerView["leases"]>>();
  readonly #unsubscribeViews: () => void;
  /** A `WeakMap` so a waiter that never dispatches (rejected, cancelled, timed out) leaks no entry. */
  readonly #createdAt = new WeakMap<FleetWaiter, number>();
  readonly #workerReasons = new WeakMap<FleetWaiter, readonly WorkerEntry[]>();
  readonly #refusals: FleetRefusals;
  readonly #forwarding: FleetForwarding;
  #dispatchDepth = 0;
  #passRequested = false;

  constructor(private readonly options: FleetLeaseCoordinatorOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#refusals = new FleetRefusals({ routing: options.routing, views: options.views });
    this.#forwarding = new FleetForwarding({
      clock: options.clock,
      directory: options.directory,
      execTimeoutMs: options.execTimeoutMs,
      leaseIndex: options.leaseIndex,
      leaseRequestTimeoutMs: options.leaseRequestTimeoutMs,
      logger: this.#logger,
      views: options.views,
    });
    this.#queue = new FleetQueue({
      clock: options.clock,
      idGenerator: options.idGenerator,
      onDepthChange: (depth, line) =>
        this.#emit("queue.changed", line === "physical" ? { depth, physical: true } : { depth }),
      onTimeout: (waiter) => this.#emitRejected(waiter, "timeout"),
    });
    this.requests = new LeaseRequestBook({
      decisions: this.#decisions,
      describeFailure: options.describeFailure,
      store: new InMemoryLeaseRequestStore({
        clock: options.clock,
        idGenerator: options.idGenerator,
        limits: options.leaseRequestLimits,
      }),
    });
    this.#unsubscribeViews = options.views.onViewsChanged(() => this.#onViewsChanged());
  }

  get queueDepth(): number {
    return this.#queue.depth;
  }

  // fallow-ignore-next-line unused-class-member -- reached only through `GatewayDispatcher`'s `Pick<FleetLeaseCoordinator, ...>`-typed `coordinator` option.
  get physicalQueueDepth(): number {
    return this.#queue.physicalDepth;
  }

  start(): void {
    this.#emit("queue.changed", { depth: this.#queue.depth });
  }

  waitingRequests(): readonly FleetWaitingRequest[] {
    const queued = new Map(this.#queue.list().map((waiter) => [waiter.id, waiter]));
    return this.requests.waiting(this.#queue.places()).map((entry) => {
      const waiter = queued.get(entry.id);
      const workers = waiter === undefined ? undefined : this.#workerReasons.get(waiter);
      return entry.stage === "queued" && workers !== undefined
        ? { ...entry, workers: [...workers] }
        : entry;
    });
  }

  // fallow-ignore-next-line unused-class-member -- reached through the dispatcher's Pick of the coordinator.
  ownerId(gatewayLeaseId: string): string | undefined {
    return this.options.leaseIndex.ownerId(gatewayLeaseId);
  }

  // fallow-ignore-next-line unused-class-member -- reached via `authorizeLookups.leaseRequesterId`.
  leaseRequesterId(gatewayLeaseId: string): string | undefined {
    return this.options.leaseIndex.leaseRequesterId(gatewayLeaseId);
  }

  // fallow-ignore-next-line unused-class-member -- reached via `authorizeLookups.pendingRequestOwner`.
  pendingRequestOwner(requesterId: string, platform?: Platform): string | undefined {
    return this.#queue.findPendingWaiter(requesterId, platform)?.options.ownerId;
  }

  /**
   * Admits a request and returns the eventual grant. The one-lease check and the enqueue commit
   * together, inside `SerializedDecision.run`, so two concurrent requests for the same
   * `requesterId` can never both be admitted (see the module doc's "two different fields").
   * Everything past admission -- reaching a worker at all -- is I/O and stays outside it.
   */
  async request(
    deviceRequest: DeviceRequest,
    options: LeaseRequestOptions,
  ): Promise<FleetLeaseGrant> {
    const admitted = await this.#decisions.run(async () => {
      const replay = this.requests.replay(deviceRequest, options);
      if (replay !== undefined) return { replay };
      const requestId = newLeaseRequestId(this.options.idGenerator);
      this.#refuseIfAlreadyLeased(deviceRequest, options.requesterId, requestId);
      this.#refuseIfLeaseIdTaken(deviceRequest, options, requestId);
      const { id, started } = await this.requests.admit(
        deviceRequest,
        options,
        (id, onProgress) => {
          const waiter = this.#queue.create(deviceRequest, { ...options, onProgress }, id);
          return { promise: this.#afterViewRead(waiter.promise), waiter };
        },
        requestId,
      );
      const created = started.waiter;
      this.#createdAt.set(created, this.options.clock.now());
      this.#emit("lease.requested", {
        requestId: id,
        requestSpec: deviceRequest,
        requester: options.requesterId,
        waitPolicy: options.noWait === true ? "no-wait" : "wait",
      });
      return { promise: started.promise, waiter: created };
    });
    if ("replay" in admitted) return admitted.replay;
    this.#admit(admitted.waiter);
    return admitted.promise;
  }

  /**
   * why: the request book stores `granted` and wakes its watchers when this promise settles, and the
   * worker's own `lease.granted` push starts its view read later; so the grant waits for one read of the
   * granting worker's view here, and a `lease.list` right after any answer lists the lease (#1370). A
   * failed read is the next tick's.
   */
  async #afterViewRead(grant: Promise<FleetLeaseGrant>): Promise<FleetLeaseGrant> {
    const granted = await grant;
    const entry = this.options.leaseIndex.resolve(granted.lease.id);
    if (entry !== undefined) {
      await this.options.directory
        .target(entry.workerId)
        ?.refresh()
        .catch((error: unknown) => {
          this.#logger.debug("Failed to refresh a worker's view after granting it a lease", {
            error: String(error),
            workerId: entry.workerId,
          });
        });
    }
    return granted;
  }

  #refuseIfAlreadyLeased(
    deviceRequest: DeviceRequest,
    requesterId: string,
    requestId: string,
  ): void {
    const refusal = requesterLimitDecision({
      held: this.options.leaseIndex
        .held(requesterId)
        .filter((lease) => !this.#isPastDeadlineOnDisconnectedWorker(lease.id)),
      maxPerRequester: this.options.maxPerRequester,
      platform: deviceRequest.platform,
      probe: false,
      requesterId,
      waiting: this.#queue.pendingPlatforms(requesterId),
    });
    if (refusal === undefined) return;
    this.#emit("lease.rejected", {
      requestId,
      requester: requesterId,
      requestSpec: deviceRequest,
      reason: "already-leased",
    });
    throw refusal;
  }

  /**
   * why: a lease past its last reported deadline on a disconnected worker cannot have been renewed
   * through this gateway, so it must not lock its requester out of the fleet. The entry stays in
   * the index: it is still routed to its worker (ADR 0005 §28).
   */
  #isPastDeadlineOnDisconnectedWorker(gatewayLeaseId: string): boolean {
    const entry = this.options.leaseIndex.resolve(gatewayLeaseId);
    if (entry === undefined) return false;
    const view = this.options.views.view(entry.workerId);
    if (view === undefined || view.connection !== "disconnected") return false;
    const reported = view.leases?.find((lease) => lease.id === entry.workerLeaseId);
    return reported !== undefined && reported.ttlDeadline <= this.options.clock.now();
  }

  /**
   * ADR 0020: the one clash check on a gateway, after the one-lease check and in the same
   * admission section. A caller-chosen id is held by one of this gateway's leases and by one of
   * its own requests still open; leases a local client holds on a worker are not checked (a
   * worker refuses its own, and the requester's uniqueness guarantee makes a clash unlikely).
   */
  #refuseIfLeaseIdTaken(
    deviceRequest: DeviceRequest,
    options: LeaseRequestOptions,
    requestId: string,
  ): void {
    const { leaseId } = options;
    if (leaseId === undefined) return;
    if (
      this.options.leaseIndex.resolve(leaseId) === undefined &&
      !this.requests.holdsLeaseId(leaseId)
    ) {
      return;
    }
    this.#emit("lease.rejected", {
      requestId,
      requester: options.requesterId,
      requestSpec: deviceRequest,
      reason: "lease-id-taken",
    });
    throw leaseIdTaken(leaseId);
  }

  async cancelPending(
    requesterId: string,
    platform?: Platform,
  ): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    return this.#decisions.run(async () => {
      const waiter = this.#queue.findPendingWaiter(requesterId, platform);
      if (waiter === undefined) return "not-found";
      if (waiter.state !== "queued") return "not-cancellable";
      if (this.#queue.reject(waiter, new RequestCancelledError(waiter.id))) {
        this.#emitRejected(waiter, "cancelled");
      }
      return "cancelled";
    });
  }

  renew(gatewayLeaseId: string, ttlMs: number | undefined): Promise<FleetLeaseRecord> {
    return this.#forwarding.renew(gatewayLeaseId, ttlMs);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the dispatcher's Pick of the coordinator.
  saveBaseline(
    gatewayLeaseId: string,
    input: Pick<BaselineSaveInput, "name" | "note">,
  ): Promise<BaselineSaveOutput> {
    return this.#forwarding.saveBaseline(gatewayLeaseId, input);
  }

  release(gatewayLeaseId: string): Promise<void> {
    return this.#forwarding.release(gatewayLeaseId);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the dispatcher's Pick of the coordinator.
  releaseAll(): Promise<readonly string[]> {
    return this.#forwarding.releaseAll();
  }

  // fallow-ignore-next-line unused-class-member -- reached through the dispatcher's Pick of the coordinator.
  exec(input: FleetExecInput, session: DispatchSession): Promise<{ readonly exitCode: number }> {
    return this.#forwarding.exec(input, session);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the dispatcher's Pick of the coordinator.
  rotate(input: FleetRotateInput, session: DispatchSession): Promise<RotateOutput> {
    return this.#forwarding.rotate(input, session);
  }

  /** Unsubscribes from worker-view changes and rejects every still-pending waiter -- a gateway
   * restart loses in-flight requests exactly as a worker restart does (ADR §30), so this makes
   * that explicit rather than leaving them to hang on a coordinator nothing will ever drive
   * again. */
  dispose(): void {
    this.#unsubscribeViews();
    this.#queue.cancelAll(() => new DispatchError("DAEMON_STOPPING", "Gateway is stopping"));
  }

  // ---- admission and dispatch ----------------------------------------------------------------

  /**
   * A brand-new waiter's admission. **Architecture rule 10: `noWait` is enforced in exactly one
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
  #admit(waiter: FleetWaiter): void {
    // Attempted. If that attempt is refused, `#attempt` decides the rest: one more walk for a
    // `noWait` caller (ADR 0009 §5). A target that turned out unreachable re-queues it. A
    // candidate the walk rejected as unservable (ADR 0009 §4) is terminal, so the rejection and
    // the enqueue below are no-ops on it: `WaitQueue` refuses both for a terminal waiter.
    if (this.#dispatch(waiter)) return;
    if (waiter.options.noWait === true) {
      this.#reject(
        waiter,
        new DispatchError("NO_CAPACITY", "No worker in the fleet can currently serve this request"),
        "no-wait",
      );
      return;
    }
    this.#enqueue(waiter);
  }

  #dispatch(candidate?: FleetWaiter): boolean {
    if (this.#dispatchDepth > 0) {
      // Round 4 review: a nested pass used to be *dropped*. The outer walk iterates a snapshot
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

  /**
   * `candidate` walks last, because it is the newest: that keeps the single fleet FIFO honest.
   * The return says whether it was attempted, which `waiter.state` alone cannot tell `#admit`.
   */
  #dispatchPass(candidate?: FleetWaiter): boolean {
    // why: a virtual pick holds a worker; a physical pick holds a worker for the same match only.
    const claimedThisPass = { physical: new Set<string>(), virtual: new Set<string>() };
    const attempted = new Set<FleetWaiter | undefined>();
    const waiters =
      candidate === undefined || this.#queue.isQueued(candidate)
        ? this.#queue.list()
        : [...this.#queue.list(), candidate];
    for (const waiter of waiters) {
      // The candidate is mid-admission, not `queued`, even when it holds a queue position.
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
    // A worker claimed this pass or one that answered `NO_CAPACITY` is busy, not unable, so it
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
    this.#reject(waiter, last.failure, "worker-failed", {
      code: last.failure.code,
      worker: last.workerId,
    });
  }

  /** Ends a request the table of ADR 0009 §4 says no worker can serve, with the code and
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
      // The worker's own refusal was only a probe's decline (ADR 0021), so the request's end is
      // this gateway's fact, whether or not the request had entered the queue.
      this.#reject(waiter, last, "unresolvable-spec");
      return;
    }
    this.#reject(
      waiter,
      new DispatchError(verdict.code, verdict.message, verdict.details),
      verdict.reason,
    );
  }

  /**
   * H2 (round 2 review): `markProcessing`'s own `false` return -- the waiter is already terminal
   * -- used to be ignored, issuing the RPC anyway. Masked in practice by every caller
   * (`#admit`/`#dispatch`) only ever reaching this with a live waiter today, but nothing enforced
   * that: a grant landing for a waiter that settled a moment earlier would still be indexed by
   * `#settleGrant` while `queue.resolve` quietly answers `false`, leaving an orphan lease no
   * client holds a reference to release.
   */
  #beginAttempt(waiter: FleetWaiter, decision: RoutingDecision, rename: ModelName): void {
    if (!this.#queue.markProcessing(waiter)) return;
    void this.#attempt(waiter, decision, rename);
  }

  /**
   * Every exit from this method leaves `waiter` either terminal (`resolve`/`reject`, inside
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
      // The view named a worker that is no longer reachable by the time we got here -- the same
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
      this.#emit("request.dispatched", {
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
      grant = await this.#forwarding.withLeaseRequestTimeout(
        client.requestLease(
          {
            // The request as it arrived, under the worker's own name for an exact model.
            ...requestedDevice({ ...waiter.request, ...rename }),
            requesterId: namespacedRequesterId,
            // ADR §27a (narrowed, round 3 review, H3): only the worker's own gateway-uplink
            // session may set `owner` -- and this RPC always travels over exactly that
            // connection (`WorkerLink#connect`, via `acceptUplink` on the worker's own end, see
            // `session.isGatewayUplink`'s doc). The worker stores this verbatim as the lease's
            // `ownerId` instead of deriving it from the connection -- see
            // `daemon/dispatcher.ts`'s `#leaseRequest`.
            owner: waiter.options.ownerId,
            // ADR 0009 §3: a download is never triggered through a gateway.
            allowDownload: false,
            // ADR §12: worker queues never hold gateway traffic. Every dispatch is `noWait`
            // regardless of what the original caller asked the gateway for -- the *gateway's
            // own* queue is where a "wait" request actually waits.
            noWait: true,
            ...(waiter.options.ttlMs === undefined ? {} : { ttlMs: waiter.options.ttlMs }),
            // ADR 0020: sent as the requester sent it. The worker grants exactly this id, and
            // its refusal (`LEASE_ID_TAKEN`) is the caller's answer: no other worker is tried.
            ...(waiter.options.leaseId === undefined ? {} : { leaseId: waiter.options.leaseId }),
            // ADR 0021: this gateway's id for the request marks the dispatch a probe. The worker
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
              // ADR §11: "the first `progress` push" is one of the two signals a request is
              // this worker's now -- device work having started means it is committed here even
              // before the grant itself arrives.
              announceDispatched();
              this.#queue.notifyProgress(waiter, progress);
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
      // P1 (round 2 review): "an *immediate* NO_CAPACITY is the only answer that leaves it
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
          // ADR 0009 §5: one more walk, with this worker left out until its view changes. A
          // `noWait` caller never asked to wait for that change, so `#admit` rejects it if no
          // worker is picked.
          this.#admit(waiter);
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
        this.#admit(waiter);
        return;
      }
      if (isSimlockError(error) && CANNOT_SERVE_CODES.has(error.code) && !announced) {
        this.#refusals.rememberCannotServe(waiter, workerId, classifyRelayedError(error, workerId));
        this.#refreshView(workerId, { includeCatalog: true });
        this.#admit(waiter);
        return;
      }
      // C1 (round 3 review): this waiter's own outcome is terminal, but the worker it just gave
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
      this.#reject(waiter, failure, "worker-failed", { code: failure.code, worker: workerId });
      this.#dispatch();
      return;
    }

    announceDispatched();
    if (this.#settleGrant(waiter, workerId, grant) === "retry") {
      // The worker answered with an id the gateway did not ask for: the attempt failed, and the
      // request goes back to the queue as after an unreachable worker. This worker is left out
      // until its view changes, so a worker that keeps answering so is not asked in a loop.
      this.#refusals.rememberRefusal(waiter, workerId);
      this.#staleView(waiter, workerId);
      return;
    }
    // C1 (round 3 review): see the catch branch above -- a grant settling this waiter is just as
    // much a reason for whoever else is queued to get another look, not only a terminal failure.
    this.#dispatch();
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

  /** ADR §11: "an immediate `NO_CAPACITY` is the only answer that leaves it queued ... the
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
    this.#enqueue(waiter);
    this.#refreshView(workerId);
  }

  #refreshView(workerId: string, options?: { readonly includeCatalog: true }): void {
    const target = this.options.directory.target(workerId);
    void target?.refresh(options).catch((error: unknown) => {
      this.#logger.debug("Failed to refresh a worker's view after a worker's refusal", {
        workerId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * H6 (round 2 review): the entry's `ownerId` comes from `waiter.options.ownerId` -- what this
   * gateway itself forwarded as `owner` in the `lease.request` a moment ago -- never from the
   * worker's own echo of it (`grant.lease.ownerId`). Everything this gateway authorizes
   * afterwards (`lease.renew`/`release`/`device.exec`) keys on the index's `ownerId`, so a worker
   * that ignored or rewrote the field would otherwise redefine ownership at the gateway; the
   * rebuild path (`FleetLeaseIndex#rebuildFromWorker`) has no better source and must trust the
   * worker, but this path already knows the answer. A mismatched echo is logged -- it means
   * either a worker bug or something worth knowing about, never silently swallowed.
   */
  #settleGrant(waiter: FleetWaiter, workerId: string, grant: LeaseGrant): "settled" | "retry" {
    // ADR 0020: a forwarded `leaseId` is the gateway lease id, bare, and never the worker's echo
    // of it -- a worker that granted something else is not believed, and its lease is given back.
    const forwardedLeaseId = waiter.options.leaseId;
    if (forwardedLeaseId !== undefined && grant.lease.id !== forwardedLeaseId) {
      this.#logger.warn(
        "Worker granted a lease ID different from the leaseId the gateway forwarded",
        {
          forwardedLeaseId,
          grantedLeaseId: grant.lease.id,
          workerId,
        },
      );
      this.#forwarding.releaseOnWorker(workerId, grant.lease.id);
      return "retry";
    }
    const gatewayLeaseId = forwardedLeaseId ?? `${workerId}.${grant.lease.id}`;
    if (grant.lease.ownerId !== waiter.options.ownerId) {
      this.#logger.warn("Worker echoed an ownerId different from the one the gateway forwarded", {
        echoedOwnerId: grant.lease.ownerId,
        forwardedOwnerId: waiter.options.ownerId,
        gatewayLeaseId,
        workerId,
      });
    }
    const entry: FleetLeaseEntry = {
      gatewayLeaseId,
      grantedAt: grant.lease.grantedAt,
      ownerId: waiter.options.ownerId,
      requesterId: waiter.options.requesterId,
      workerId,
      workerLeaseId: grant.lease.id,
    };
    if (!this.options.leaseIndex.add(entry, waiter.request.platform)) {
      // The index already routes this bare id to another worker, which got it there first: the
      // new worker's lease is given back and the caller is told the id is taken.
      this.#forwarding.releaseOnWorker(workerId, grant.lease.id);
      this.#reject(waiter, leaseIdTaken(gatewayLeaseId), "lease-id-taken");
      return "settled";
    }
    const fleetGrant: FleetLeaseGrant = {
      device: grant.device,
      environment: grant.environment,
      lease: this.#forwarding.projectRecord(grant.lease, entry),
      timing: grant.timing,
    };
    // ADR 0021 §4: the grant is the request's end only if the waiter was still open. One that
    // landed after a timeout, a cancel or `dispose()` handed nothing to a caller, so it is no fact.
    if (this.#queue.resolve(waiter, fleetGrant)) {
      this.#emit("request.granted", {
        leaseId: gatewayLeaseId,
        requestId: waiter.id,
        worker: workerId,
        workerLeaseId: grant.lease.id,
      });
    }
    return "settled";
  }

  #enqueue(waiter: FleetWaiter): void {
    const alreadyQueued = this.#queue.isQueued(waiter);
    if (this.#queue.enqueue(waiter) && !alreadyQueued) {
      this.#emit("lease.queued", {
        queuePosition:
          lineOf(waiter.request) === "physical" ? this.#queue.physicalDepth : this.#queue.depth,
        requestId: waiter.id,
      });
    }
  }

  #reject(
    waiter: FleetWaiter,
    error: Error,
    reason:
      | Rejection["reason"]
      | "no-wait"
      | "cancelled"
      | "timeout"
      | "lease-id-taken"
      | "worker-failed",
    failedOn?: { readonly code: string; readonly worker: string },
  ): void {
    if (this.#queue.reject(waiter, error)) {
      this.#emitRejected(waiter, reason, failedOn);
    }
  }

  #emitRejected(
    waiter: FleetWaiter,
    reason: EventMap["lease.rejected"]["reason"],
    failedOn?: { readonly code: string; readonly worker: string },
  ): void {
    this.#emit("lease.rejected", {
      requestId: waiter.id,
      requester: waiter.options.requesterId,
      requestSpec: waiter.request,
      reason,
      // `worker`, never `workerId`: that key marks an event relayed from a worker (ADR 0014 §6).
      ...(failedOn === undefined ? {} : { code: failedOn.code, worker: failedOn.worker }),
    });
  }

  /**
   * §30's reconnect rebuild, and its own upkeep on every worker-view change: reconciles each
   * worker's entries against its current view -- adding any gateway-issued lease the index does
   * not already know and, a generation later, forgetting one the view has stopped reporting at
   * all (see `FleetLeaseIndex#rebuildFromWorker`'s own doc comment, C3 round 2 review) -- forgets
   * a worker's entries entirely once its view has disappeared (`worker.remove`, or retention),
   * then runs a dispatch pass.
   *
   * C1 (round 2 review): `rebuildFromWorker` runs *only* for a worker whose `view.leases`
   * reference actually changed since the last time this method reconciled it -- see
   * `#lastReconciledLeases`'s own doc. Before this fix, every view was reconciled on *every*
   * notification regardless of which worker it was about: two view changes on worker B alone
   * bumped worker A's reconciliation generation twice against A's own byte-identical, stale
   * cached snapshot, which is enough for `rebuildFromWorker`'s two-consecutive-misses rule to
   * evict a lease on A that was never actually missing from a real snapshot at all -- silently
   * violating ADR §14 (the fleet-wide one-lease check reads this same index) and losing the
   * `lease-lost` push `GatewayOwnerRoutedFacts` would otherwise emit for it.
   */
  #onViewsChanged(): void {
    const views = this.options.views.views();
    const currentIds = new Set(views.map((view) => view.id));
    for (const view of views) {
      // A starting worker's view has no `leases`: nothing was read, so the index keeps what it
      // holds for that worker until the worker answers `running`.
      if (view.leases === undefined) continue;
      if (this.#lastReconciledLeases.get(view.id) === view.leases) continue;
      this.options.leaseIndex.rebuildFromWorker(view.id, view.leases, view.devices);
      this.#lastReconciledLeases.set(view.id, view.leases);
    }
    for (const workerId of this.#knownWorkerIds) {
      if (!currentIds.has(workerId)) {
        this.options.leaseIndex.forgetWorker(workerId);
        this.#lastReconciledLeases.delete(workerId);
      }
    }
    this.#knownWorkerIds = currentIds;
    this.#dispatch();
  }

  #emit<Event extends FleetEventName>(event: Event, payload: EventMap[Event]): void {
    this.options.eventBus.emit(event, payload, "fleet-lease-coordinator");
  }
}

/** A class request has no model to send: the worker applies its own rules to the class. */
function forwardedModel(
  request: RoutableRequest,
  views: readonly WorkerView[],
  decision: RoutingDecision,
): ModelName {
  // A physical request is matched by the worker against its enrolled devices, as typed.
  if (request.model === undefined || request.physical === true) return {};
  const view = views.find((worker) => worker.id === decision.workerId);
  return { model: (view === undefined ? undefined : matchRequest(view, request)) ?? request.model };
}

function leaseIdTaken(leaseId: string): DispatchError {
  return new DispatchError("LEASE_ID_TAKEN", `lease ID ${leaseId} is already in use`, { leaseId });
}

interface ModelName {
  readonly model?: string;
}

// why: keyed as the core's `fitsPhysical` compares: platform, model in any letter case or else the class (`phone` when absent), and the OS text.
function physicalMatchKey(request: FleetWaiter["request"]): string {
  const target =
    request.model === undefined
      ? `class:${requestedClass({ class: request.class })}`
      : `model:${request.model.toLowerCase()}`;
  return [request.platform, target, request.osVersion ?? ""].join("\u0000");
}

function routable(waiter: FleetWaiter): RoutableRequest {
  return {
    platform: waiter.request.platform as Platform,
    ...(waiter.request.model === undefined ? {} : { model: waiter.request.model }),
    ...(waiter.request.class === undefined ? {} : { class: waiter.request.class }),
    ...(waiter.request.osVersion === undefined ? {} : { osVersion: waiter.request.osVersion }),
    ...(waiter.request.imageTag === undefined ? {} : { imageTag: waiter.request.imageTag }),
    ...(waiter.request.baseline === undefined ? {} : { baseline: waiter.request.baseline }),
    ...(waiter.request.mode === undefined ? {} : { mode: waiter.request.mode }),
    ...(lineOf(waiter.request) === "physical" ? { physical: true as const } : {}),
    ...(waiter.options.requires === undefined ? {} : { requires: waiter.options.requires }),
  };
}
