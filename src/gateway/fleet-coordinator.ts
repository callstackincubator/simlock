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
 * again (via `#enqueue`, from `#staleView`) once that attempt has fully settled. There used to be
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
 *
 * ## What this class does not do
 *
 * `WORKER_UNREACHABLE` retry/backoff semantics and "dispatched, then uplink lost" recovery are
 * #119's (ADR §28/§29) -- every forward in this class funnels through `#forwardToWorker`, the one
 * chokepoint #119 can wrap without touching every call site. This class answers
 * `WORKER_UNREACHABLE` when a target is not reachable *right now*, and nothing more.
 */
import type { EventBus, EventMap } from "../bus/index.js";
import type { LeaseGrant, LeaseRecord, SimlockAdminClient } from "../admin/index.js";
import { isSimlockError, type AnySimlockError, type Platform } from "../contract/index.js";
import { DispatchError, type DispatchSession } from "../daemon/dispatch.js";
import type { DeviceRequest } from "../core/driver.js";
import { SerializedDecision } from "../core/serialized-decision.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { WorkerDirectory } from "./fleet-ports.js";
import type { FleetViews } from "./fleet-ports.js";
import { type FleetLeaseEntry, type FleetLeaseIndex } from "./lease-index.js";
import type { WorkerView } from "./worker-registry.js";
import {
  FleetQueue,
  RequestCancelledError,
  RequesterAlreadyLeasedError,
  type FleetLeaseGrant,
  type FleetLeaseRecord,
  type FleetWaiter,
  type LeaseRequestOptions,
} from "./queue.js";
import type { RoutableRequest, RoutingDecision, RoutingPolicy } from "./routing.js";

export interface FleetExecInput {
  readonly leaseId: string;
  readonly tool: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

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
  /** P2 (round 2 review): `gateway.leaseRequestTimeoutMs` -- bounds a forwarded `lease.request`,
   * the one uplink call that used to have no timeout of its own. See
   * `#withLeaseRequestTimeout`'s own doc comment. */
  readonly leaseRequestTimeoutMs: number;
  readonly logger?: Logger;
}

type FleetEventName = "lease.requested" | "lease.queued" | "lease.rejected" | "request.dispatched";

export class FleetLeaseCoordinator {
  readonly #queue: FleetQueue;
  readonly #decisions = new SerializedDecision();
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
  readonly #lastReconciledLeases = new Map<string, WorkerView["leases"]>();
  readonly #unsubscribeViews: () => void;
  /** C2 (round 2 review): when each waiter was created (`#queue.create`, in `request` below),
   * for `request.dispatched`'s `queuedMs` field -- a `WeakMap` rather than a `Map<string, number>`
   * so a waiter that never gets there (rejected at admission, cancelled, timed out) needs no
   * explicit clean-up call on every one of those exits to avoid an unbounded leak; the entry is
   * reclaimable the moment nothing else still references the waiter. */
  readonly #createdAt = new WeakMap<FleetWaiter, number>();
  /** C1 (round 3 review): re-entrancy guard for `#dispatch` -- see its own doc comment. */
  #dispatchDepth = 0;
  /** Set when a pass is requested while one is already running; the running pass then repeats
   * rather than dropping it (round 4 review, finding 6). */
  #passRequested = false;

  constructor(private readonly options: FleetLeaseCoordinatorOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#queue = new FleetQueue({
      clock: options.clock,
      idGenerator: options.idGenerator,
      // The rejection itself already happened inside `WaitQueue#armTimeout` by the time this
      // fires (see `queue.ts`); this only reports the gateway's own fact for it.
      onTimeout: (waiter) =>
        this.#emit("lease.rejected", { requestSpec: waiter.request, reason: "timeout" }),
    });
    this.#unsubscribeViews = options.views.onViewsChanged(() => this.#onViewsChanged());
  }

  get queueDepth(): number {
    return this.#queue.depth;
  }

  // fallow-ignore-next-line unused-class-member -- reached only through `GatewayDispatcher`'s `Pick<FleetLeaseCoordinator, ...>`-typed `coordinator` option (`authorizeLookups.ownerId`); the audit cannot follow a call through a structural type.
  ownerId(gatewayLeaseId: string): string | undefined {
    return this.options.leaseIndex.ownerId(gatewayLeaseId);
  }

  // fallow-ignore-next-line unused-class-member -- see `ownerId` above; reached via `authorizeLookups.leaseRequesterId`.
  leaseRequesterId(gatewayLeaseId: string): string | undefined {
    return this.options.leaseIndex.leaseRequesterId(gatewayLeaseId);
  }

  // fallow-ignore-next-line unused-class-member -- see `ownerId` above; reached via `authorizeLookups.pendingRequestOwner`.
  pendingRequestOwner(requesterId: string): string | undefined {
    return this.#queue.findPendingWaiter(requesterId)?.options.ownerId;
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
    const waiter = await this.#decisions.run(async () => {
      const existingLeaseId = this.options.leaseIndex.existingLeaseId(options.requesterId);
      if (existingLeaseId !== undefined || this.#queue.hasPendingRequester(options.requesterId)) {
        this.#emit("lease.rejected", { requestSpec: deviceRequest, reason: "already-leased" });
        throw new RequesterAlreadyLeasedError(options.requesterId, existingLeaseId);
      }
      const created = this.#queue.create(deviceRequest, options);
      this.#createdAt.set(created, this.options.clock.now());
      this.#emit("lease.requested", {
        requestSpec: deviceRequest,
        requester: options.requesterId,
        waitPolicy: options.noWait === true ? "no-wait" : "wait",
      });
      return created;
    });
    this.#admit(waiter);
    return waiter.promise;
  }

  // fallow-ignore-next-line unused-class-member -- reached only through `GatewayDispatcher`'s `Pick<FleetLeaseCoordinator, ...>`-typed `coordinator` option (`#leaseCancel`); the audit cannot follow a call through a structural type.
  async cancelPending(requesterId: string): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    return this.#decisions.run(async () => {
      const waiter = this.#queue.findPendingWaiter(requesterId);
      if (waiter === undefined) return "not-found";
      if (waiter.state !== "queued") return "not-cancellable";
      if (this.#queue.reject(waiter, new RequestCancelledError(waiter.id))) {
        this.#emit("lease.rejected", { requestSpec: waiter.request, reason: "cancelled" });
      }
      return "cancelled";
    });
  }

  async renew(gatewayLeaseId: string, ttlMs: number | undefined): Promise<FleetLeaseRecord> {
    const entry = this.#requireEntry(gatewayLeaseId);
    let record: LeaseRecord;
    try {
      record = await this.#forwardToWorker(entry.workerId, (client) =>
        client.renewLease({
          leaseId: entry.workerLeaseId,
          ...(ttlMs === undefined ? {} : { ttlMs }),
        }),
      );
    } catch (error: unknown) {
      this.#forgetIfUnknownToWorker(gatewayLeaseId, error);
      throw error;
    }
    return this.#projectRecord(record, entry);
  }

  async release(gatewayLeaseId: string): Promise<void> {
    const entry = this.#requireEntry(gatewayLeaseId);
    try {
      await this.#forwardToWorker(entry.workerId, (client) =>
        client.releaseLease({ leaseId: entry.workerLeaseId }),
      );
    } catch (error: unknown) {
      this.#forgetIfUnknownToWorker(gatewayLeaseId, error);
      throw error;
    }
    // Removed immediately rather than waiting on the relayed `lease.released` fact to make the
    // round trip back over the uplink: the release just succeeded, on this same call, so there
    // is nothing left to learn from that event. `removeByWorkerLease` still runs when it arrives
    // (idempotent -- see `FleetLeaseIndex`), which is what covers a release the worker's own
    // TTL or a local operator caused instead.
    this.options.leaseIndex.remove(gatewayLeaseId);
  }

  /**
   * ADR §34: releases only the leases this gateway issued, across every connected worker, and
   * never a worker's own local leases. A worker that cannot be reached is reported, naming it,
   * while every other worker's releases still complete -- what has already succeeded by the time
   * one fails stays released.
   *
   * H8 (round 2 review): the thrown error's `details.releasedLeaseIds` names everything that did
   * succeed before the failure, rather than leaving the operator to guess (§34's own "leaves the
   * operator guessing" is exactly the thing this closes) -- `lease.release-all`'s output shape
   * (`{ leaseIds }`) still has no room to carry a partial result on its *success* path, so this is
   * the one channel available on the answer that does exist. #119, which owns `WORKER_UNREACHABLE`
   * retry/backoff, may still want to widen the output shape itself.
   */
  async releaseAll(): Promise<readonly string[]> {
    const released: string[] = [];
    let firstFailure: unknown;
    for (const entry of this.options.leaseIndex.all()) {
      try {
        await this.#forwardToWorker(entry.workerId, (client) =>
          client.releaseLease({ leaseId: entry.workerLeaseId }),
        );
        this.options.leaseIndex.remove(entry.gatewayLeaseId);
        released.push(entry.gatewayLeaseId);
      } catch (error: unknown) {
        if (this.#forgetIfUnknownToWorker(entry.gatewayLeaseId, error)) {
          // C3: the worker already agrees this lease does not exist -- that is not a failure to
          // report, it is the release this call asked for, already true. Skip it (not a
          // `firstFailure`) rather than making a single zombie entry fail every future
          // `release-all` forever.
          released.push(entry.gatewayLeaseId);
          continue;
        }
        firstFailure ??= error;
      }
    }
    if (firstFailure !== undefined) {
      throw this.#withReleasedDetails(firstFailure, released);
    }
    return released;
  }

  /**
   * C3 (round 2 review): a worker answering `UNKNOWN_LEASE` to a release or renew is telling this
   * gateway its own index entry is wrong -- the one source of truth for removal
   * (`lease.released`/`lease.expired`) never fires for a lease the worker has no record of at
   * all, so without this the entry is immortal: every future request from the same requester is
   * refused `REQUESTER_ALREADY_LEASED` naming a lease that exists nowhere, and (`releaseAll`)
   * every future `lease.release-all` fails on it forever. Returns whether it acted, so a caller
   * (`releaseAll`) can fold that lease into its own success accounting instead of its failure one.
   */
  #forgetIfUnknownToWorker(gatewayLeaseId: string, error: unknown): boolean {
    if (!(error instanceof DispatchError) || error.code !== "UNKNOWN_LEASE") return false;
    this.options.leaseIndex.remove(gatewayLeaseId);
    return true;
  }

  #withReleasedDetails(error: unknown, released: readonly string[]): unknown {
    if (!(error instanceof DispatchError)) return error;
    const baseDetails =
      typeof error.details === "object" && error.details !== null ? error.details : {};
    return new DispatchError(error.code, error.message, {
      ...baseDetails,
      releasedLeaseIds: released,
    });
  }

  async exec(
    input: FleetExecInput,
    session: DispatchSession,
  ): Promise<{ readonly exitCode: number }> {
    const entry = this.#requireEntry(input.leaseId);
    // ADR §19b/§27: the worker checks this *namespaced* requester against the lease in front of
    // it (§19a'), so it must be built from the lease's own recorded requester -- never from
    // whatever `device.exec`'s own optional `requesterId` said, which the gateway's own
    // `authorize` hook (via `leaseRequesterId` above) has already resolved by the time this
    // handler runs.
    const namespacedRequesterId = `${this.options.leaseIndex.requesterPrefix}${entry.requesterId}`;
    // ADR §19a/§19e: `session.onStarted` means "the process now exists", and a transport chooses
    // its response shape on it -- HTTP commits its `200` and starts an SSE stream, so every
    // failure that can happen *before* a process exists (§19a''s `FORBIDDEN` when the worker's own
    // ownership check disagrees with this gateway's index, the driver's `PASSTHROUGH_REFUSED` /
    // `UNKNOWN_PASSTHROUGH_TOOL`) has to reach the caller as its own status code instead.
    //
    // This gateway cannot infer that moment: it holds no driver refusal list and does not
    // duplicate the worker-side ownership check. Two earlier attempts to infer it each broke one
    // half of the contract -- announcing before the forward went out turned a `FORBIDDEN` between
    // two fleet agents into a `200` + SSE `error` (round 2), and deferring to the first relayed
    // `output` chunk left a *silent* long-running command (§19b's own worked example,
    // `simctl install <path>`) with no `200` and no keepalives at all (round 3), then a timed
    // grace window put the first failure back for any refusal slower than the guess (round 4).
    //
    // So the worker sends the fact instead of the gateway guessing it. Its dispatcher already
    // computes this exact moment -- it spawns the child and then calls `onStarted` -- and ADR
    // §19a's request-scoped push family carries it (`started`, see `contract/pushes.ts`).
    // Relaying it is all this needs.
    //
    // `started` is part of protocol 5, not an addition on top of it: 5 has never shipped (`main`
    // advertises 3; 4 and 5 both land with this stack), so it releases as one version carrying
    // `device.exec`, its `output` family, `status.get`'s `mode`, the gateway surface and this
    // frame together. Nothing will ever advertise 5 without it, which is exactly why the grace
    // timer could be deleted outright rather than kept as a fallback -- there is no peer to fall
    // back for, and a second path to this signal would be the duplication architecture rule 10
    // forbids. A worker older than protocol 5 negotiates nothing and is `incompatible` by range
    // (§31), so it is never dispatched to at all.
    let started = false;
    const announceStarted = (): void => {
      if (started) return;
      started = true;
      session.onStarted?.();
    };
    // H4 (round 3 review): `#withExecTimeout` settling `EXEC_TIMEOUT` only stops *this* call's
    // returned promise from being awaited any further -- the worker's own `client.exec` RPC is
    // never cancelled, and its `onOutput` closure below stays live for as long as the worker
    // keeps sending chunks, relaying every one of them into `session.onOutput` long after the
    // caller has already been told this command timed out. Nothing here made that safe; it was
    // HTTP's own `OutputRelay.drop()` that happened to swallow a push arriving after an SSE
    // response had already ended, which is the transport saving this class, not this class
    // cancelling anything -- a future non-HTTP frontend has no such backstop. `detached` is
    // flipped by `#withExecTimeout`'s own `onTimeout` hook, right as it decides to reject, so no
    // late chunk reaches `session.onOutput` (or spuriously fires `onStarted`) once that has
    // happened.
    let detached = false;
    return this.#forwardToWorker(entry.workerId, async (client) => {
      // ADR §19e (P5, round 2 review): `gateway.execTimeoutMs` is the backstop for "the worker
      // never answers at all" -- the worker's own `exec.timeoutMs` is authoritative for an
      // ordinary timeout and is expected to answer first (the gateway's default is deliberately
      // the longer of the two), so this only ever fires when nothing else would have.
      return this.#withExecTimeout(
        client.exec(
          {
            leaseId: entry.workerLeaseId,
            tool: input.tool,
            args: [...input.args],
            ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
            requesterId: namespacedRequesterId,
          },
          {
            onOutput: (chunk) => {
              if (detached) return;
              void session.onOutput?.(chunk.stream, chunk.chunk);
            },
            // The worker's own "the process exists" fact, relayed verbatim -- the only thing
            // that announces `started` here, so there is exactly one path to it.
            onStarted: () => {
              if (detached) return;
              announceStarted();
            },
          },
        ),
        entry.workerId,
        () => {
          detached = true;
        },
      );
    });
  }

  /**
   * Races a forwarded `device.exec` against `gateway.execTimeoutMs` (ADR §19e). Before this,
   * `exec` awaited `client.exec` unbounded -- a worker that never answers at all (the case this
   * config value exists for, not an ordinary command timeout the worker's own `exec.timeoutMs`
   * already covers) hung the call and its SSE stream forever, and nothing here read the config
   * value the schema, validator, and docs already described.
   *
   * `onTimeout` (H4, round 3 review) is `#raceTimeout`'s own detach hook -- see `exec`'s own
   * `detached` flag for why: a client that only stops *awaiting* the worker's answer, without
   * also telling `exec`'s `onOutput` closure to stop relaying, would keep forwarding late chunks
   * to `session.onOutput` for as long as the worker cared to keep sending them.
   */
  #withExecTimeout<Value>(
    promise: Promise<Value>,
    workerId: string,
    onTimeout: () => void,
  ): Promise<Value> {
    return this.#raceTimeout(
      promise,
      this.options.execTimeoutMs,
      () =>
        new DispatchError(
          "EXEC_TIMEOUT",
          `Worker ${workerId} did not answer device.exec within gateway.execTimeoutMs (${String(this.options.execTimeoutMs)}ms)`,
        ),
      onTimeout,
    );
  }

  /**
   * P2 (round 2 review): races a forwarded `lease.request` against
   * `gateway.leaseRequestTimeoutMs`. Before this, the one uplink call this class makes with no
   * bound of its own left a waiter `processing` -- a state neither `WaitQueue#armTimeout` (it
   * declines to reject a `processing` waiter) nor `cancelPending` (`not-cancellable`) can reach
   * -- for as long as a wedged worker cared to hold it, with `timeoutMs`/`lease.cancel`
   * unenforceable the whole time (ADR §10). Expiry maps to `WORKER_UNREACHABLE`: not a fact
   * about this worker's capacity (a real answer might still have been a grant), but the same
   * "not reachable right now" story `#forwardToWorker`'s pre-flight check already answers that
   * code for.
   *
   * If the worker does eventually answer after this already gave up, that answer is discarded
   * here exactly as `#withExecTimeout`'s own doc describes -- a grant landing late becomes an
   * orphan lease on the worker (this gateway rejected the waiter and issued nothing to release
   * it by), the same class of gap H2/H8 already name for the RPCs this class does track state
   * for. A genuinely wedged worker is rare enough, and `leaseRequestTimeoutMs` generous enough,
   * that this is left as a known consequence rather than built out here.
   *
   * `onTimeout` (P4, round 3 review): the same detach hook `#withExecTimeout` already takes, for
   * the same reason -- see `#attempt`'s own `detached` flag.
   */
  #withLeaseRequestTimeout<Value>(
    promise: Promise<Value>,
    workerId: string,
    onTimeout: () => void,
  ): Promise<Value> {
    return this.#raceTimeout(
      promise,
      this.options.leaseRequestTimeoutMs,
      () =>
        new DispatchError(
          "WORKER_UNREACHABLE",
          `Worker ${workerId} did not answer lease.request within gateway.leaseRequestTimeoutMs (${String(this.options.leaseRequestTimeoutMs)}ms)`,
          { workerId },
        ),
      onTimeout,
    );
  }

  /**
   * Mirrors `WorkerLink#withTimeout`'s race-and-cancel shape: whichever of the timer or
   * `promise` settles first wins, and the other is inert from then on (the timer is cancelled on
   * a real answer; a promise that eventually does settle after the timer already fired is simply
   * ignored, not delivered late).
   *
   * That "ignored, not delivered late" is true of `promise`'s own eventual resolution -- it is
   * *not* true, on its own, of anything a callback reachable from `promise` keeps doing after the
   * timer wins (H4, round 3 review): `client.exec`'s `onOutput` closure is exactly such a
   * callback, invoked directly by the worker's own RPC handling, entirely outside this promise's
   * settlement. `onTimeout`, when given, runs synchronously the moment the timer decides to
   * reject -- before `buildTimeoutError` is even called -- so a caller with such a callback can
   * flip its own "stop relaying" flag in the same tick its timeout error is built, rather than
   * relying on a downstream transport (HTTP's `OutputRelay.drop()`) to swallow what this class
   * itself never stopped producing.
   */
  #raceTimeout<Value>(
    promise: Promise<Value>,
    timeoutMs: number,
    buildTimeoutError: () => DispatchError,
    onTimeout?: () => void,
  ): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const timer = this.options.clock.setTimer(timeoutMs, () => {
        if (settled) return;
        settled = true;
        onTimeout?.();
        reject(buildTimeoutError());
      });
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.options.clock.cancel(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          this.options.clock.cancel(timer);
          reject(error);
        },
      );
    });
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
   * as its `candidate` -- there is no second, out-of-order look of its own.
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
   * module graph into ordinary worker startup with no boundary test covering that direction.
   */
  #admit(waiter: FleetWaiter): void {
    // Attempted -- including attempted and bounced straight back by a stale view, which §11
    // keeps queued even for a `noWait` caller (`#staleView` has already re-enqueued it).
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

  /**
   * ADR §11: re-run on every worker-view change. Every already-queued waiter not currently in
   * flight gets one more look, oldest first; one no eligible worker can serve is passed over,
   * not blocked on -- there is no early exit from this loop.
   *
   * H6 (round 3 review): `routing.select` reads the same unchanged `views()` snapshot for every
   * waiter in this loop, so a worker whose view over-reports free capacity relative to what it
   * can actually grant right now used to look equally eligible to every one of them -- N queued
   * waiters could all pick that one worker in a single pass, and every one past the first came
   * back `NO_CAPACITY`, each triggering its own `#staleView` refresh. Self-limiting once the
   * refresh lands (the module doc's "the dispatch race"), but an over-reporting view that never
   * corrects itself between passes turns this into an RPC storm scaling with queue depth. Once a
   * worker is claimed by a waiter this pass, it drops out of the pool the rest of the pass sees:
   * at most one dispatch per worker per pass. A waiter left without a worker this way is not
   * rejected -- it stays `queued` for the next pass. C1 (round 3 review): that next pass is
   * guaranteed now, not merely hoped for -- `#attempt` runs one itself the moment *any* attempt
   * settles (a grant via `#settleGrant`, or a terminal rejection), on top of the existing
   * worker-view trigger, so a waiter passed over here always gets looked at again once whatever
   * claimed its worker this pass is done with it, the same "passed over, not blocked on" contract
   * this method already promises for a request no worker can serve at all. Before this, only a
   * worker's own event stream (a `lease.rejected`/`lease.expired` push, or the 30s refresh tick)
   * ever re-ran this method -- several of `#attempt`'s own terminal branches
   * (`WORKER_UNREACHABLE`, `INTERNAL`, a target that disappeared between routing and dispatch)
   * produce no such push at all, so a waiter passed over in the same pass as one of those had
   * nothing left to schedule another look.
   *
   * `#dispatchDepth` guards against this method ever running re-entrantly on the same call stack
   * (defensive: `#beginAttempt`'s own `#attempt` is `void`-async and every await point in it is
   * genuinely asynchronous -- see `#raceTimeout` -- so a nested synchronous call back into this
   * method should not be reachable today, but nothing about that is enforced by a type). A nested
   * call is *deferred*, not dropped: it sets `#passRequested` and the running call walks again
   * once it unwinds. Dropping it was C1's own stall reintroduced by the guard meant to prevent
   * recursion -- the outer walk iterates a snapshot and has already claimed workers, so a waiter
   * freed mid-pass would never be reconsidered (round 4 review, finding 6).
   *
   * `candidate` is a brand-new waiter with no queue membership yet; it walks last and the return
   * value says whether it was attempted. See `#dispatchPass`.
   *
   * The deferred passes above deliberately carry **no** candidate, and that is not a dropped
   * one (round 5 review): a nested `#dispatch` can only be raised from inside a `#beginAttempt`,
   * `#dispatchPass` re-reads `views.views()` per waiter rather than once per pass, and the
   * candidate walks last. So every view change a deferred pass exists to react to was already
   * raised *before* the candidate's own iteration read the views, and was already visible to it.
   * There is no state a second pass could show the candidate that its first look did not have,
   * which is why re-offering it there would add a branch no test can fail for the right reason.
   */
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
    let candidateAttempted = false;
    try {
      candidateAttempted = this.#dispatchPass(candidate);
      while (this.#passRequested) {
        this.#passRequested = false;
        this.#dispatchPass();
      }
    } finally {
      this.#dispatchDepth -= 1;
      this.#passRequested = false;
    }
    return candidateAttempted;
  }

  /**
   * One ordered, oldest-first walk -- the single place a waiter is matched to a worker.
   *
   * `candidate` is a brand-new waiter that has no queue membership yet (`#admit`'s). It walks
   * **last**, because it is the newest: that is what keeps ADR §10's single fleet FIFO honest,
   * since an admission can never take a slot an already-queued waiter would have had. Returns
   * whether the candidate was attempted, which is what lets `#admit` tell "nothing could serve
   * it" from "it was attempted and bounced straight back by a stale view" -- §11 keeps the
   * second one queued even for a `noWait` caller, and `waiter.state` alone cannot distinguish
   * them (round 4 review, finding 2).
   */
  #dispatchPass(candidate?: FleetWaiter): boolean {
    let candidateAttempted = false;
    const claimedThisPass = new Set<string>();
    const waiters =
      candidate === undefined ? this.#queue.list() : [...this.#queue.list(), candidate];
    for (const waiter of waiters) {
      // The candidate is not in the queue yet, so it has no `queued` state to check.
      if (waiter !== candidate && waiter.state !== "queued") continue;
      const eligibleWorkers = this.options.views
        .views()
        .filter((worker) => !claimedThisPass.has(worker.id));
      const decision = this.options.routing.select(routable(waiter), eligibleWorkers);
      if (decision === undefined) continue;
      claimedThisPass.add(decision.workerId);
      if (waiter === candidate) candidateAttempted = true;
      this.#beginAttempt(waiter, decision);
    }
    return candidateAttempted;
  }

  /**
   * H2 (round 2 review): `markProcessing`'s own `false` return -- the waiter is already terminal
   * -- used to be ignored, issuing the RPC anyway. Masked in practice by every caller
   * (`#admit`/`#dispatch`) only ever reaching this with a live waiter today, but nothing enforced
   * that: a grant landing for a waiter that settled a moment earlier would still be indexed by
   * `#settleGrant` while `queue.resolve` quietly answers `false`, leaving an orphan lease no
   * client holds a reference to release.
   */
  #beginAttempt(waiter: FleetWaiter, decision: RoutingDecision): void {
    if (!this.#queue.markProcessing(waiter)) return;
    void this.#attempt(waiter, decision);
  }

  /**
   * Every exit from this method leaves `waiter` either terminal (`resolve`/`reject`, inside
   * `#settleGrant`/the catch below) or back in `queued` (`#staleView`'s `#enqueue`) -- never
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
   * `#staleView`'s own branches (the unreachable-target check above, and the catch's immediate
   * `NO_CAPACITY`) do not need to: both already call a worker's `refresh()`, and a real snapshot
   * landing for it fires `#onViewsChanged` -> `#dispatch()` regardless of whether the numbers
   * actually changed. The terminal branches have no such follow-up of their own -- a worker this
   * class gave up on (`WORKER_UNREACHABLE`, `INTERNAL`) or was refused for a reason genuinely
   * unrelated to capacity (any other worker-side code) may still be exactly the worker a different
   * queued waiter needs, and nothing else would ever schedule that second look.
   */
  async #attempt(waiter: FleetWaiter, decision: RoutingDecision): Promise<void> {
    const workerId = decision.workerId;
    const target = this.options.directory.target(workerId);
    const client = target?.reachable === true ? target.client() : undefined;
    if (client === undefined) {
      // The view named a worker that is no longer reachable by the time we got here -- the same
      // "stale, not wrong" story as a worker's own `NO_CAPACITY`, just discovered a step earlier.
      this.#staleView(waiter, workerId);
      return;
    }

    const namespacedRequesterId = `${this.options.leaseIndex.requesterPrefix}${waiter.options.requesterId}`;
    let announced = false;
    const announceDispatched = (): void => {
      if (announced) return;
      announced = true;
      // C2 (round 2 review): the full payload `docs/EVENTS.md` always specified for this row --
      // see `bus/index.ts`'s own doc comment on why it was narrowed and then restored.
      const createdAt = this.#createdAt.get(waiter);
      this.#emit("request.dispatched", {
        model: waiter.request.model,
        platform: waiter.request.platform,
        queuedMs: createdAt === undefined ? 0 : Math.max(0, this.options.clock.now() - createdAt),
        reason: decision.reason,
        requestId: waiter.id,
        requesterId: waiter.options.requesterId,
        workerId,
      });
    };

    // P4 (round 3 review): H4's own reasoning applies verbatim here -- `#withLeaseRequestTimeout`
    // settling `WORKER_UNREACHABLE` only stops *this* call's returned promise from being awaited
    // any further, not the worker's own still-pending `lease.request` RPC, whose `onProgress`
    // closure below stays live for as long as the worker keeps pushing progress. Before this,
    // a late `progress` push after the timeout had already rejected the waiter still called
    // `announceDispatched()` and emitted `request.dispatched` for a request this gateway had
    // already told its caller was `WORKER_UNREACHABLE` -- a false past-tense fact against
    // `docs/EVENTS.md`'s own "and the worker took it". Same mechanism as `exec`'s `detached`, not
    // a second bespoke one: flipped by `#withLeaseRequestTimeout`'s own `onTimeout` hook, checked
    // here before either `announceDispatched()` or `notifyProgress` run.
    let detached = false;
    let grant: LeaseGrant;
    try {
      grant = await this.#withLeaseRequestTimeout(
        client.requestLease(
          {
            platform: waiter.request.platform,
            model: waiter.request.model,
            ...(waiter.request.osVersion === undefined
              ? {}
              : { osVersion: waiter.request.osVersion }),
            ...(waiter.request.full === true ? { full: true } : {}),
            requesterId: namespacedRequesterId,
            // ADR §27a (narrowed, round 3 review, H3): only the worker's own gateway-uplink
            // session may set `owner` -- and this RPC always travels over exactly that
            // connection (`WorkerLink#connect`, via `acceptUplink` on the worker's own end, see
            // `session.isGatewayUplink`'s doc). The worker stores this verbatim as the lease's
            // `ownerId` instead of deriving it from the connection -- see
            // `daemon/dispatcher.ts`'s `#leaseRequest`.
            owner: waiter.options.ownerId,
            allowDownload: waiter.options.allowDownload ?? false,
            // ADR §12: worker queues never hold gateway traffic. Every dispatch is `noWait`
            // regardless of what the original caller asked the gateway for -- the *gateway's
            // own* queue is where a "wait" request actually waits.
            noWait: true,
            ...(waiter.options.ttlMs === undefined ? {} : { ttlMs: waiter.options.ttlMs }),
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
    } catch (error: unknown) {
      // P1 (round 2 review): "an *immediate* NO_CAPACITY is the only answer that leaves it
      // queued ... the request waits" (§11) -- `announced` is exactly the "work has begun"
      // distinction the ADR draws, already maintained above for `request.dispatched`. A worker
      // can answer `NO_CAPACITY` *after* pushing progress (its own `#evictManaged` failure path,
      // reached from a `noWait` waiter's `#defer`, runs after `provisioning`/`reclaiming`), and
      // that is this request's own terminal failure -- not a stale view to retry, because device
      // work already started means the request was this worker's (§11's own wording). Re-queuing
      // it anyway silently reversed a dispatch the caller had already been told about.
      if (isSimlockError(error) && error.code === "NO_CAPACITY" && !announced) {
        this.#staleView(waiter, workerId);
        return;
      }
      // C1 (round 3 review): this waiter's own outcome is terminal, but the worker it just gave
      // up (or never actually reached) may still be free for whoever else is queued behind it --
      // and unlike `#staleView`'s branch above, nothing else here schedules another look at them.
      // `WORKER_UNREACHABLE`/`INTERNAL` in particular produce no worker-side event at all, so
      // without this a waiter passed over in this same pass had nothing left to wake it until the
      // next real worker-view change (the 30s refresh tick, at best).
      this.#queue.reject(waiter, this.#classifyLeaseRequestError(error, workerId));
      this.#dispatch();
      return;
    }

    announceDispatched();
    this.#settleGrant(waiter, workerId, grant);
    // C1 (round 3 review): see the catch branch above -- a grant settling this waiter is just as
    // much a reason for whoever else is queued to get another look, not only a terminal failure.
    this.#dispatch();
  }

  /**
   * A terminal failure past `#attempt`'s `NO_CAPACITY`/stale-view check is the worker's own fact
   * (it already emitted its own `lease.rejected`, relayed onto this bus with `workerId` added by
   * `WorkerLink`) -- this class does not emit a second one for it (see the module doc, "two
   * different fields", and events.md's post-commit rule apply equally to not inventing a
   * duplicate fact). Only the error code is preserved so the caller sees what the worker actually
   * said, with three exceptions:
   *
   * - a transport failure (the uplink itself, not the worker's own answer) -- ADR §28/§29 name
   *   `WORKER_UNREACHABLE` for that, not whatever the client's own connection loss happens to be
   *   called (`daemon/dispatch.js`'s `SimlockError.kind` is what tells the two apart);
   * - `#withLeaseRequestTimeout`'s own `DispatchError` (P2, round 2 review) -- never a
   *   `SimlockError`, since it never reached the worker at all -- forwarded as-is;
   * - anything else that is neither of those (H1, round 2 review): not a fact about the worker,
   *   since every real transport failure already arrives as a `kind: "transport"` `SimlockError`,
   *   so this is a bug in this coordinator's own request-building code. `WORKER_UNREACHABLE`
   *   used to answer this case too, misreporting a gateway-side crash as "the machine is
   *   unreachable"; `INTERNAL` is what `#forwardToWorker`'s matching branch answers for the same
   *   shape of failure.
   */
  #classifyLeaseRequestError(error: unknown, workerId: string): DispatchError {
    if (error instanceof DispatchError) return error;
    if (isSimlockError(error)) return this.#classifyRelayedError(error, workerId);
    return new DispatchError(
      "INTERNAL",
      `Unexpected error forwarding lease.request to worker ${workerId}`,
      { workerId },
    );
  }

  /** ADR §11: "an immediate `NO_CAPACITY` is the only answer that leaves it queued ... the
   * request waits" -- unconditionally, even for a caller that asked `noWait: true` (the one
   * explicit exception the ADR calls out), because this is a stale view, not a real refusal. */
  #staleView(waiter: FleetWaiter, workerId: string): void {
    this.#enqueue(waiter);
    const target = this.options.directory.target(workerId);
    void target?.refresh().catch((error: unknown) => {
      this.#logger.debug("Failed to refresh a worker's view after a stale-view NO_CAPACITY", {
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
  #settleGrant(waiter: FleetWaiter, workerId: string, grant: LeaseGrant): void {
    const gatewayLeaseId = `${workerId}.${grant.lease.id}`;
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
    this.options.leaseIndex.add(entry);
    const fleetGrant: FleetLeaseGrant = {
      device: grant.device,
      environment: grant.environment,
      lease: this.#projectRecord(grant.lease, entry),
      timing: grant.timing,
    };
    this.#queue.resolve(waiter, fleetGrant);
  }

  #enqueue(waiter: FleetWaiter): void {
    const alreadyQueued = this.#queue.isQueued(waiter);
    if (this.#queue.enqueue(waiter) && !alreadyQueued) {
      this.#emit("lease.queued", { queuePosition: this.#queue.depth, requestId: waiter.id });
    }
  }

  #reject(waiter: FleetWaiter, error: Error, reason: "no-wait" | "cancelled" | "timeout"): void {
    if (this.#queue.reject(waiter, error)) {
      this.#emit("lease.rejected", { requestSpec: waiter.request, reason });
    }
  }

  // ---- forwarding and views -------------------------------------------------------------------

  /** The one chokepoint every forwarded operation funnels through -- #119's seam for
   * `WORKER_UNREACHABLE` retry/backoff, without touching `renew`/`release`/`releaseAll`/`exec`
   * individually. */
  async #forwardToWorker<Result>(
    workerId: string,
    fn: (client: SimlockAdminClient) => Promise<Result>,
  ): Promise<Result> {
    const target = this.options.directory.target(workerId);
    const client = target?.reachable === true ? target.client() : undefined;
    if (client === undefined) {
      throw new DispatchError("WORKER_UNREACHABLE", `Worker ${workerId} is not reachable`, {
        workerId,
      });
    }
    try {
      return await fn(client);
    } catch (error: unknown) {
      if (isSimlockError(error)) throw this.#classifyRelayedError(error, workerId);
      // H1 (round 2 review): rethrown unchanged before this fix, which let a `TypeError` in this
      // coordinator's own request-building code surface exactly as if the worker itself had
      // produced it -- no code, no `kind`, nothing a caller could branch on the way it could on
      // every other failure this class answers. Every real transport failure already arrives as
      // a `kind: "transport"` `SimlockError` (handled above), so anything else here is this
      // gateway's own bug, not a fact about the worker -- `INTERNAL` names that, consistent with
      // `#attempt`'s matching branch for the one forward this chokepoint does not cover
      // (`lease.request`, bound by `#withLeaseRequestTimeout` instead).
      if (error instanceof DispatchError) throw error;
      throw new DispatchError(
        "INTERNAL",
        `Unexpected error forwarding a call to worker ${workerId}`,
        { workerId },
      );
    }
  }

  /**
   * P4 (round 2 review): `error.code` was preserved verbatim for every `SimlockError`, which
   * answered a fleet client its own `DAEMON_CONNECTION_LOST` whenever the uplink itself died
   * mid-call -- naming *this coordinator's* session to the worker, not the worker's own fact.
   * `kind: "transport"` is what the admin client's wire (`src/simlock-client/wire.ts`) stamps on
   * every rejection caused by the connection dying under an in-flight call, so it is what
   * distinguishes that case from an ordinary domain refusal (`RUNTIME_MISSING`,
   * `REQUESTER_ALREADY_LEASED`, ...), which is forwarded byte for byte -- ADR §28/§29 name
   * `WORKER_UNREACHABLE` for exactly the transport case, and `#forwardToWorker`'s "not reachable
   * right now" branch above already answers that same code for the pre-flight version of it.
   */
  #classifyRelayedError(error: AnySimlockError, workerId: string): DispatchError {
    if (error.kind === "transport") {
      return new DispatchError("WORKER_UNREACHABLE", error.message, { workerId });
    }
    return new DispatchError(error.code, error.message, error.details);
  }

  #requireEntry(gatewayLeaseId: string): FleetLeaseEntry {
    const entry = this.options.leaseIndex.resolve(gatewayLeaseId);
    if (entry === undefined) {
      throw new DispatchError("UNKNOWN_LEASE", `Unknown lease: ${gatewayLeaseId}`, {
        leaseId: gatewayLeaseId,
      });
    }
    return entry;
  }

  #projectRecord<
    Record extends { readonly id: string; readonly requesterId: string; readonly ownerId: string },
  >(
    record: Record,
    entry: FleetLeaseEntry,
  ): Record & { readonly worker?: { readonly id: string; readonly label?: string } } {
    const workerLabel = this.options.views.view(entry.workerId)?.label;
    return {
      ...record,
      id: entry.gatewayLeaseId,
      // H6 (round 2 review): the index's own `ownerId` (trusted -- see `#settleGrant`), never
      // this record's raw `ownerId` as a worker's own RPC answer echoed it back.
      ownerId: entry.ownerId,
      requesterId: entry.requesterId,
      ...(workerLabel === undefined
        ? { worker: { id: entry.workerId } }
        : { worker: { id: entry.workerId, label: workerLabel } }),
    };
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
      if (this.#lastReconciledLeases.get(view.id) === view.leases) continue;
      this.options.leaseIndex.rebuildFromWorker(view.id, view.leases);
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

function routable(waiter: FleetWaiter): RoutableRequest {
  return {
    platform: waiter.request.platform as Platform,
    model: waiter.request.model,
    ...(waiter.request.osVersion === undefined ? {} : { osVersion: waiter.request.osVersion }),
    allowDownload: waiter.options.allowDownload ?? false,
  };
}
