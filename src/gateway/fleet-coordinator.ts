/**
 * why: `FleetLeaseCoordinator`: admission, the fleet-wide one-lease rule, dispatch, and lease/exec
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
 *
 * ## What this class does not do
 *
 * `WORKER_UNREACHABLE` retry/backoff semantics and "dispatched, then uplink lost" recovery are
 * #119's (ADR §28/§29) -- every forward in this class funnels through `#forwardToWorker`, the one
 * chokepoint #119 can wrap without touching every call site. This class answers
 * `WORKER_UNREACHABLE` when a target is not reachable *right now*, and nothing more.
 */
import type { EventBus, EventMap } from "../bus/index.js";
import type {
  LeaseGrant,
  LeaseRecord,
  RotateInput,
  RotateOutput,
  SimlockAdminClient,
} from "../admin/index.js";
import {
  isSimlockError,
  requestedClass,
  requestedDevice,
  capacityReasonSchema,
  type AnySimlockError,
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
import { isUplinkLost, liveClient, type WorkerDirectory } from "./fleet-ports.js";
import type { FleetViews } from "./fleet-ports.js";
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
  type WorkerExplanation,
} from "./routing.js";
import {
  type CapacityReason,
  type Rejection,
  viewLoadKey,
  type WorkerReason,
} from "./routing/index.js";

type WorkerEntry = WorkerReason & { readonly workerId: string };

// why: the gateway adds this to the leasing module's entry; the contract's schema is its wire shape.
export type FleetWaitingRequest = WaitingRequest & { readonly workers?: WorkerEntry[] };

interface Refusal {
  readonly key: string;
  readonly capacityReason?: CapacityReason;
  readonly provisionFailure?: DispatchError;
}

const CANNOT_SERVE_REASONS: Readonly<Record<string, WorkerReason["reason"]>> = {
  CAPABILITY_MISSING: "capability-missing",
  NO_DRIVER: "no-driver",
  RUNTIME_MISSING: "runtime-missing",
  UNKNOWN_MODEL: "unknown-model",
};

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
]);

export interface FleetExecInput {
  readonly leaseId: string;
  readonly tool: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

export interface FleetRotateInput {
  readonly leaseId: string;
  readonly orientation: RotateInput["orientation"];
}

export interface FleetLeaseCoordinatorOptions {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly directory: WorkerDirectory;
  readonly views: FleetViews;
  readonly routing: RoutingPolicy;
  readonly leaseIndex: FleetLeaseIndex;
  readonly execTimeoutMs: number;
  readonly leaseRequestTimeoutMs: number;
  readonly leaseRequestLimits: LeaseRequestLimits;
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
  readonly requests: LeaseRequestBook<FleetLeaseGrant>;
  readonly #logger: Logger;
  #knownWorkerIds = new Set<string>();
  /** why: C1 (round 2 review): the `view.leases` array reference this coordinator last reconciled
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
  /** why: A `WeakMap` so a waiter that never dispatches (rejected, cancelled, timed out) leaks no entry. */
  readonly #createdAt = new WeakMap<FleetWaiter, number>();
  /** why: A `WeakMap` so the memo dies with the waiter. */
  readonly #refusals = new WeakMap<FleetWaiter, Map<string, Refusal>>();
  readonly #workerReasons = new WeakMap<FleetWaiter, readonly WorkerEntry[]>();
  /** why: A `WeakMap` so the memo dies with the waiter. */
  readonly #cannotServe = new WeakMap<FleetWaiter, Map<string, DispatchError>>();
  #dispatchDepth = 0;
  #passRequested = false;

  constructor(private readonly options: FleetLeaseCoordinatorOptions) {
    this.#logger = options.logger ?? new NoopLogger();
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
      const { id, started: created } = await this.requests.admit(
        deviceRequest,
        options,
        (id, onProgress) => this.#queue.create(deviceRequest, { ...options, onProgress }, id),
        requestId,
      );
      this.#createdAt.set(created, this.options.clock.now());
      this.#emit("lease.requested", {
        requestId: id,
        requestSpec: deviceRequest,
        requester: options.requesterId,
        waitPolicy: options.noWait === true ? "no-wait" : "wait",
      });
      return { waiter: created };
    });
    if ("replay" in admitted) return admitted.replay;
    this.#admit(admitted.waiter);
    return admitted.waiter.promise;
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
    // why: Removed immediately rather than waiting on the relayed `lease.released` fact to make the
    // round trip back over the uplink: the release just succeeded, on this same call, so there
    // is nothing left to learn from that event. `removeByWorkerLease` still runs when it arrives
    // (idempotent -- see `FleetLeaseIndex`), which is what covers a release the worker's own
    // TTL or a local operator caused instead.
    this.options.leaseIndex.remove(gatewayLeaseId);
  }

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
          // why: C3: the worker already agrees this lease does not exist -- that is not a failure to
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
   * why: C3 (round 2 review): a worker answering `UNKNOWN_LEASE` to a release or renew is telling this
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
    // why: ADR §19b/§27: the worker checks this *namespaced* requester against the lease in front of
    // it (§19a'), so it must be built from the lease's own recorded requester -- never from
    // whatever `device.exec`'s own optional `requesterId` said, which the gateway's own
    // `authorize` hook (via `leaseRequesterId` above) has already resolved by the time this
    // handler runs.
    const namespacedRequesterId = `${this.options.leaseIndex.requesterPrefix}${entry.requesterId}`;
    // why: ADR §19a/§19e: `session.onStarted` means "the process now exists", and a transport chooses
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
    // why: H4 (round 3 review): `#withExecTimeout` settling `EXEC_TIMEOUT` only stops *this* call's
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
   * why: `device.rotate` forwarded to the worker that owns the lease, with the lease's own namespaced requester, bounded by `gateway.execTimeoutMs` like `exec`. A worker names the lease by its own id in any coded error; the caller holds the gateway's id, so the error names that instead.
   */
  async rotate(input: FleetRotateInput, _session: DispatchSession): Promise<RotateOutput> {
    const entry = this.#requireEntry(input.leaseId);
    const requesterId = `${this.options.leaseIndex.requesterPrefix}${entry.requesterId}`;
    try {
      const rotated = await this.#forwardToWorker(entry.workerId, (client) =>
        this.#withExecTimeout(
          client.rotate(entry.workerLeaseId, input.orientation, { requesterId }),
          entry.workerId,
          () => undefined,
          "device.rotate",
        ),
      );
      return { leaseId: input.leaseId, orientation: rotated.orientation };
    } catch (error) {
      throw this.#namedForCaller(error, entry);
    }
  }

  #namedForCaller(error: unknown, entry: FleetLeaseEntry): unknown {
    if (!(error instanceof DispatchError)) return error;
    const details =
      typeof error.details === "object" && error.details !== null ? error.details : undefined;
    const names = (details as { leaseId?: unknown } | undefined)?.leaseId === entry.workerLeaseId;
    const message = replaceWholeId(error.message, entry.workerLeaseId, entry.gatewayLeaseId);
    if (!names && message === error.message) return error;
    return new DispatchError(
      error.code,
      message,
      names ? { ...details, leaseId: entry.gatewayLeaseId } : error.details,
    );
  }

  #withExecTimeout<Value>(
    promise: Promise<Value>,
    workerId: string,
    onTimeout: () => void,
    operation = "device.exec",
  ): Promise<Value> {
    return this.#raceTimeout(
      promise,
      this.options.execTimeoutMs,
      () =>
        new DispatchError(
          "EXEC_TIMEOUT",
          `Worker ${workerId} did not answer ${operation} within gateway.execTimeoutMs (${String(this.options.execTimeoutMs)}ms)`,
        ),
      onTimeout,
    );
  }

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
   * why: Mirrors `WorkerLink#withTimeout`'s race-and-cancel shape: whichever of the timer or
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

  dispose(): void {
    this.#unsubscribeViews();
    this.#queue.cancelAll(() => new DispatchError("DAEMON_STOPPING", "Gateway is stopping"));
  }

  #admit(waiter: FleetWaiter): void {
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

  #dispatchPass(candidate?: FleetWaiter): boolean {
    // why: a virtual pick holds a worker; a physical pick holds a worker for the same match only.
    const claimedThisPass = { physical: new Set<string>(), virtual: new Set<string>() };
    const attempted = new Set<FleetWaiter | undefined>();
    const waiters =
      candidate === undefined || this.#queue.isQueued(candidate)
        ? this.#queue.list()
        : [...this.#queue.list(), candidate];
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
    const refusals = this.#cannotServe.get(waiter);
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
    const reasons = this.#reasonsFor(waiter, request, allViews, {
      claimed: (workerId) => claimedThisPass.has(claimKey(workerId)),
    });
    this.#workerReasons.set(waiter, reasons);
    const eligibleWorkers = views.filter(
      (worker) => !claimedThisPass.has(claimKey(worker.id)) && !this.#refused(waiter, worker),
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

  // why: the first failing check wins, in the order the spec lists: a filter reason, an unreachable target, a cannot-serve memo, a refusal at the current view, a claim this pass, a rank zero reason, else not-chosen.
  #reasonsFor(
    waiter: FleetWaiter,
    request: RoutableRequest,
    views: readonly WorkerView[],
    options: {
      readonly claimed?: (workerId: string) => boolean;
      readonly unreachable?: string;
    } = {},
  ): readonly WorkerEntry[] {
    const explained = new Map(
      this.options.routing.explain(request, views).map((entry) => [entry.workerId, entry]),
    );
    return views.map((view): WorkerEntry => ({
      ...this.#reasonFor(waiter, view, explained.get(view.id), options),
      workerId: view.id,
    }));
  }

  #reasonFor(
    waiter: FleetWaiter,
    view: WorkerView,
    entry: WorkerExplanation | undefined,
    options: { readonly claimed?: (workerId: string) => boolean; readonly unreachable?: string },
  ): WorkerReason {
    if (entry?.filter !== undefined) return entry.filter;
    if (options.unreachable === view.id) return { reason: "disconnected" };
    const claimed = options.claimed?.(view.id) === true;
    return (
      this.#cannotServeReason(waiter, view.id) ??
      this.#refusedReason(waiter, view, entry?.zero) ??
      passedOver(claimed, entry?.zero)
    );
  }

  #cannotServeReason(waiter: FleetWaiter, workerId: string): WorkerReason | undefined {
    const code = this.#cannotServe.get(waiter)?.get(workerId)?.code;
    const reason = code === undefined ? undefined : CANNOT_SERVE_REASONS[code];
    return reason === undefined ? undefined : { reason };
  }

  #refusedReason(
    waiter: FleetWaiter,
    view: WorkerView,
    zero: WorkerReason | undefined,
  ): WorkerReason | undefined {
    if (!this.#refused(waiter, view)) return undefined;
    const refusal = this.#refusals.get(waiter)?.get(view.id);
    // why: a failed provision is no capacity refusal; the worker lists as one that passed every check.
    if (refusal?.provisionFailure !== undefined) return undefined;
    const capacityReason = refusal?.capacityReason ?? zero?.capacityReason;
    return capacityReason === undefined ? { reason: "full" } : { capacityReason, reason: "full" };
  }

  // why: a second failed provision walks on like a cannot-serve code, and only when every worker that could take the request failed so does it end with the last answer; a worker held back only for now (full, busy, not ready, unhealthy) could take it later, so it keeps the request queued.
  #rejectIfEveryWorkerFailedProvisioning(
    waiter: FleetWaiter,
    request: RoutableRequest,
    views: readonly WorkerView[],
  ): void {
    const refusals = this.#refusals.get(waiter);
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

  #rejectUnservable(
    waiter: FleetWaiter,
    verdict: Rejection,
    refusals: ReadonlyMap<string, DispatchError> | undefined,
  ): void {
    const last = refusals === undefined ? undefined : [...refusals.values()].at(-1);
    if (last !== undefined) {
      this.#reject(waiter, last, "unresolvable-spec");
      return;
    }
    this.#reject(
      waiter,
      new DispatchError(verdict.code, verdict.message, verdict.details),
      verdict.reason,
    );
  }

  #beginAttempt(waiter: FleetWaiter, decision: RoutingDecision, rename: ModelName): void {
    if (!this.#queue.markProcessing(waiter)) return;
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

    // why: P4 (round 3 review): H4's own reasoning applies verbatim here -- `#withLeaseRequestTimeout`
    // settling `WORKER_UNREACHABLE` only stops *this* call's returned promise from being awaited
    // any further, not the worker's own still-pending `lease.request` RPC, whose `onProgress`
    // closure below stays live for as long as the worker keeps pushing progress. Before this,
    // a late `progress` push after the timeout had already rejected the waiter still called
    // `announceDispatched()` and emitted `request.dispatched` for a request this gateway had
    // already told its caller was `WORKER_UNREACHABLE` -- a false past-tense fact against
    // `docs/internal/EVENTS.md`'s own "and the worker took it". Same mechanism as `exec`'s `detached`, not
    // a second bespoke one: flipped by `#withLeaseRequestTimeout`'s own `onTimeout` hook, checked
    // here before either `announceDispatched()` or `notifyProgress` run.
    let detached = false;
    let grant: LeaseGrant;
    try {
      grant = await this.#withLeaseRequestTimeout(
        client.requestLease(
          {
            ...requestedDevice({ ...waiter.request, ...rename }),
            requesterId: namespacedRequesterId,
            owner: waiter.options.ownerId,
            allowDownload: false,
            noWait: true,
            ...(waiter.options.ttlMs === undefined ? {} : { ttlMs: waiter.options.ttlMs }),
            ...(waiter.options.leaseId === undefined ? {} : { leaseId: waiter.options.leaseId }),
            fleetRequestId: waiter.id,
            ...(waiter.options.requires === undefined
              ? {}
              : { requires: [...waiter.options.requires] }),
          },
          {
            onProgress: (progress) => {
              if (detached) return;
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
      // why: P1 (round 2 review): "an *immediate* NO_CAPACITY is the only answer that leaves it
      // queued ... the request waits" (§11) -- `announced` is exactly the "work has begun"
      // distinction the ADR draws, already maintained above for `request.dispatched`. A worker
      // can answer `NO_CAPACITY` *after* pushing progress (its own `#evictManaged` failure path,
      // reached from a `noWait` waiter's `#defer`, runs after `provisioning`/`reclaiming`), and
      // that is this request's own terminal failure -- not a stale view to retry, because device
      // work already started means the request was this worker's (§11's own wording). Re-queuing
      // it anyway silently reversed a dispatch the caller had already been told about.
      if (isSimlockError(error) && STALE_VIEW_CODES.has(error.code) && !announced) {
        this.#rememberRefusal(waiter, workerId, {
          capacityReason: refusedCapacityReason(error.details),
        });
        if (waiter.options.noWait === true) {
          this.#refreshView(workerId);
          this.#admit(waiter);
          return;
        }
        this.#staleView(waiter, workerId);
        return;
      }
      // why: a provision failure before the worker's progress push did no device work, so another worker may serve it and the walk goes on without this one; after a progress push it falls through to the terminal branch below, as today.
      if (isSimlockError(error) && error.code === "PROVISION_FAILED" && !announced) {
        this.#rememberRefusal(waiter, workerId, {
          provisionFailure: this.#classifyRelayedError(error, workerId),
        });
        this.#refreshView(workerId);
        this.#admit(waiter);
        return;
      }
      if (isSimlockError(error) && CANNOT_SERVE_CODES.has(error.code) && !announced) {
        this.#rememberCannotServe(waiter, workerId, this.#classifyRelayedError(error, workerId));
        this.#refreshView(workerId, { includeCatalog: true });
        this.#admit(waiter);
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
      this.#reject(waiter, failure, "worker-failed", { code: failure.code, worker: workerId });
      this.#dispatch();
      return;
    }

    announceDispatched();
    if (this.#settleGrant(waiter, workerId, grant) === "retry") {
      // why: The worker answered with an id the gateway did not ask for: the attempt failed, and the
      // request goes back to the queue as after an unreachable worker. This worker is left out
      // until its view changes, so a worker that keeps answering so is not asked in a loop.
      this.#rememberRefusal(waiter, workerId);
      this.#staleView(waiter, workerId);
      return;
    }
    this.#dispatch();
  }

  #classifyLeaseRequestError(error: unknown, workerId: string): DispatchError {
    if (error instanceof DispatchError) return error;
    if (isSimlockError(error)) return this.#classifyRelayedError(error, workerId);
    return new DispatchError(
      "INTERNAL",
      `Unexpected error forwarding lease.request to worker ${workerId}`,
      { workerId },
    );
  }

  #staleView(
    waiter: FleetWaiter,
    workerId: string,
    options: { readonly unreachable?: boolean } = {},
  ): void {
    // why: the walk that picked this worker ran before its answer; the entries must say what is true now.
    this.#workerReasons.set(
      waiter,
      this.#reasonsFor(
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

  #rememberCannotServe(waiter: FleetWaiter, workerId: string, refusal: DispatchError): void {
    const refusals = this.#cannotServe.get(waiter) ?? new Map<string, DispatchError>();
    refusals.set(workerId, refusal);
    this.#cannotServe.set(waiter, refusals);
  }

  #rememberRefusal(
    waiter: FleetWaiter,
    workerId: string,
    detail: {
      readonly capacityReason?: CapacityReason | undefined;
      readonly provisionFailure?: DispatchError;
    } = {},
  ): void {
    const view = this.options.views.views().find((worker) => worker.id === workerId);
    if (view === undefined) return;
    const refusals = this.#refusals.get(waiter) ?? new Map<string, Refusal>();
    // why: delete first so the map's order is the order the workers answered in; the last failure ends the request.
    refusals.delete(workerId);
    refusals.set(workerId, {
      key: viewLoadKey(view),
      ...(detail.capacityReason === undefined ? {} : { capacityReason: detail.capacityReason }),
      ...(detail.provisionFailure === undefined
        ? {}
        : { provisionFailure: detail.provisionFailure }),
    });
    this.#refusals.set(waiter, refusals);
  }

  #refused(waiter: FleetWaiter, worker: WorkerView): boolean {
    const refusals = this.#refusals.get(waiter);
    const key = refusals?.get(worker.id)?.key;
    if (key === undefined) return false;
    if (key === viewLoadKey(worker)) return true;
    // why: a device unplugged and plugged back in returns the view to the key it was refused at; the refusal must end at the first change.
    refusals?.delete(worker.id);
    return false;
  }

  /**
   * why: H6 (round 2 review): the entry's `ownerId` comes from `waiter.options.ownerId` -- what this
   * gateway itself forwarded as `owner` in the `lease.request` a moment ago -- never from the
   * worker's own echo of it (`grant.lease.ownerId`). Everything this gateway authorizes
   * afterwards (`lease.renew`/`release`/`device.exec`) keys on the index's `ownerId`, so a worker
   * that ignored or rewrote the field would otherwise redefine ownership at the gateway; the
   * rebuild path (`FleetLeaseIndex#rebuildFromWorker`) has no better source and must trust the
   * worker, but this path already knows the answer. A mismatched echo is logged -- it means
   * either a worker bug or something worth knowing about, never silently swallowed.
   */
  #settleGrant(waiter: FleetWaiter, workerId: string, grant: LeaseGrant): "settled" | "retry" {
    // why: ADR 0020: a forwarded `leaseId` is the gateway lease id, bare, and never the worker's echo
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
      this.#releaseOnWorker(workerId, grant.lease.id);
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
      // why: The index already routes this bare id to another worker, which got it there first: the
      // new worker's lease is given back and the caller is told the id is taken.
      this.#releaseOnWorker(workerId, grant.lease.id);
      this.#reject(waiter, leaseIdTaken(gatewayLeaseId), "lease-id-taken");
      return "settled";
    }
    const fleetGrant: FleetLeaseGrant = {
      device: grant.device,
      environment: grant.environment,
      lease: this.#projectRecord(grant.lease, entry),
      timing: grant.timing,
    };
    // why: ADR 0021 §4: the grant is the request's end only if the waiter was still open. One that
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

  #releaseOnWorker(workerId: string, workerLeaseId: string): void {
    void this.#forwardToWorker(workerId, (client) =>
      client.releaseLease({ leaseId: workerLeaseId }),
    ).catch((error: unknown) => {
      this.#logger.warn("Failed to release a lease the gateway will not route", {
        message: error instanceof Error ? error.message : String(error),
        workerId,
        workerLeaseId,
      });
    });
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
      // why: `worker`, never `workerId`: that key marks an event relayed from a worker (ADR 0014 §6).
      ...(failedOn === undefined ? {} : { code: failedOn.code, worker: failedOn.worker }),
    });
  }

  async #forwardToWorker<Result>(
    workerId: string,
    fn: (client: SimlockAdminClient) => Promise<Result>,
  ): Promise<Result> {
    const client = liveClient(this.options.directory.target(workerId));
    if (client === undefined) {
      throw new DispatchError("WORKER_UNREACHABLE", `Worker ${workerId} is not reachable`, {
        workerId,
      });
    }
    try {
      return await fn(client);
    } catch (error: unknown) {
      if (isSimlockError(error)) throw this.#classifyRelayedError(error, workerId);
      // why: H1 (round 2 review): rethrown unchanged before this fix, which let a `TypeError` in this
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

  #classifyRelayedError(error: AnySimlockError, workerId: string): DispatchError {
    if (isUplinkLost(error)) {
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
      ownerId: entry.ownerId,
      requesterId: entry.requesterId,
      ...(workerLabel === undefined
        ? { worker: { id: entry.workerId } }
        : { worker: { id: entry.workerId, label: workerLabel } }),
    };
  }

  #onViewsChanged(): void {
    const views = this.options.views.views();
    const currentIds = new Set(views.map((view) => view.id));
    for (const view of views) {
      // why: A starting worker's view has no `leases`: nothing was read, so the index keeps what it
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

function forwardedModel(
  request: RoutableRequest,
  views: readonly WorkerView[],
  decision: RoutingDecision,
): ModelName {
  if (request.model === undefined || request.physical === true) return {};
  const view = views.find((worker) => worker.id === decision.workerId);
  return { model: (view === undefined ? undefined : matchRequest(view, request)) ?? request.model };
}

// why: a relayed error's details are a claim; only a value of the contract's enum is kept.
function refusedCapacityReason(details: unknown): Refusal["capacityReason"] {
  const parsed = capacityReasonSchema.safeParse(
    typeof details === "object" && details !== null && "capacityReason" in details
      ? details.capacityReason
      : undefined,
  );
  return parsed.success ? parsed.data : undefined;
}

// why: a worker claimed earlier in the walk, or one nothing else names, lost to the worker picked.
function passedOver(claimed: boolean, zero: WorkerReason | undefined): WorkerReason {
  return claimed || zero === undefined ? { reason: "not-chosen" } : zero;
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
    ...(waiter.request.mode === undefined ? {} : { mode: waiter.request.mode }),
    ...(lineOf(waiter.request) === "physical" ? { physical: true as const } : {}),
    ...(waiter.options.requires === undefined ? {} : { requires: waiter.options.requires }),
  };
}

// why: a lease id is replaced only as a whole token, so a short id inside a longer word or id is left alone.
function replaceWholeId(text: string, id: string, replacement: string): string {
  const isIdCharacter = (character: string | undefined): boolean =>
    character !== undefined && /[\w-]/.test(character);
  let result = "";
  let from = 0;
  for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, from)) {
    const end = at + id.length;
    const whole = !isIdCharacter(text[at - 1]) && !isIdCharacter(text[end]);
    result += text.slice(from, at) + (whole ? replacement : id);
    from = end;
  }
  return result + text.slice(from);
}
