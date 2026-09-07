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
 * settled attempt. A waiter whose forwarded `lease.request` is still in flight to worker A must
 * never be picked up by a second pass and sent to worker B too -- if both granted, one requester
 * would hold two devices on two machines, and the fleet-wide admission check cannot catch it
 * (it runs once, at admission, before either RPC). `#dispatchTargets` is this class's `#driving`
 * (the same WeakMap-shaped guard `LeaseAcquisitionCoordinator` keeps, keyed here by target
 * worker id rather than a boolean, since a log line naming *which* worker a waiter is in flight
 * to is worth the extra byte): a waiter is added to it before the RPC starts and removed only on
 * a definitive stale-view `NO_CAPACITY` or a terminal grant/failure. Combined with
 * `queue.markProcessing` (which takes the waiter out of `queued` state, so a dispatch pass's own
 * `queue.list()` scan skips it too), a waiter can never be the target of two concurrent attempts.
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
import type { LeaseGrant, SimlockAdminClient } from "../admin/index.js";
import { isSimlockError, type Platform } from "../contract/index.js";
import { DispatchError, type DispatchSession } from "../daemon/dispatch.js";
import type { DeviceRequest } from "../core/driver.js";
import { SerializedDecision } from "../core/serialized-decision.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { WorkerDirectory } from "./fleet-ports.js";
import type { FleetViews } from "./fleet-ports.js";
import { type FleetLeaseEntry, type FleetLeaseIndex } from "./lease-index.js";
import {
  FleetQueue,
  RequestCancelledError,
  RequesterAlreadyLeasedError,
  type FleetLeaseGrant,
  type FleetLeaseRecord,
  type FleetWaiter,
  type LeaseRequestOptions,
} from "./queue.js";
import type { RoutableRequest, RoutingPolicy } from "./routing.js";

/** The one fleet-native refusal a worker never produces itself: no eligible worker exists for
 * this request right now. Named distinctly from the worker's own `NoCapacityError`
 * (`lease-acquisition-coordinator.ts`) because that module is off limits to `src/gateway`
 * (ADR §33) -- this is not the same class, but `daemon/error-code.ts` classifies both to the
 * same `NO_CAPACITY` code. */
export class NoCapacityError extends Error {
  constructor() {
    super("No worker in the fleet can currently serve this request");
    this.name = "NoCapacityError";
  }
}

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
  readonly logger?: Logger;
}

type FleetEventName = "lease.requested" | "lease.queued" | "lease.rejected" | "request.dispatched";

export class FleetLeaseCoordinator {
  readonly #queue: FleetQueue;
  readonly #decisions = new SerializedDecision();
  readonly #logger: Logger;
  /** `#driving`, mirrored from `LeaseAcquisitionCoordinator` -- see the module doc. Keyed by
   * waiter, valued by the worker id it is currently in flight to. */
  readonly #dispatchTargets = new Map<FleetWaiter, string>();
  #knownWorkerIds = new Set<string>();
  readonly #unsubscribeViews: () => void;

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

  // fallow-ignore-next-line unused-class-member -- see `cancelPending` above; reached via `#leaseRenew`.
  async renew(gatewayLeaseId: string, ttlMs: number | undefined): Promise<FleetLeaseRecord> {
    const entry = this.#requireEntry(gatewayLeaseId);
    const record = await this.#forwardToWorker(entry.workerId, (client) =>
      client.renewLease({
        leaseId: entry.workerLeaseId,
        ...(ttlMs === undefined ? {} : { ttlMs }),
      }),
    );
    return this.#projectRecord(record, entry);
  }

  // fallow-ignore-next-line unused-class-member -- see `cancelPending` above; reached via `#leaseRelease`.
  async release(gatewayLeaseId: string): Promise<void> {
    const entry = this.#requireEntry(gatewayLeaseId);
    await this.#forwardToWorker(entry.workerId, (client) =>
      client.releaseLease({ leaseId: entry.workerLeaseId }),
    );
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
   * one fails stays released; only the *answer* to this call surfaces the failure.
   *
   * `lease.release-all`'s output shape (`{ leaseIds }`) has no room to report a partial result
   * alongside a per-worker failure; #119, which owns `WORKER_UNREACHABLE` semantics, may want to
   * widen it. For now: attempt every worker, and if any failed, throw naming the first one that
   * did.
   */
  // fallow-ignore-next-line unused-class-member -- see `cancelPending` above; reached via `#leaseReleaseAll`.
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
        firstFailure ??= error;
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
    return released;
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
    return this.#forwardToWorker(entry.workerId, async (client) => {
      // The uplink surfaces no distinct "the worker's process started" signal separate from its
      // own settlement, so this is the earliest honest point to tell an HTTP caller "committed":
      // the lease and the worker are both resolved, and the call is about to go out.
      session.onStarted?.();
      return client.exec(
        {
          leaseId: entry.workerLeaseId,
          tool: input.tool,
          args: [...input.args],
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          requesterId: namespacedRequesterId,
        },
        {
          onOutput: (chunk) => {
            void session.onOutput?.(chunk.stream, chunk.chunk);
          },
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

  /** A brand-new waiter's first look, taken synchronously against the current views right after
   * admission -- the common warm-hit case never has to wait for an external trigger. Mirrors
   * `LeaseAcquisitionCoordinator#defer`'s noWait/wait split for the case routing finds nobody. */
  #admit(waiter: FleetWaiter): void {
    const decision = this.options.routing.select(routable(waiter), this.options.views.views());
    if (decision !== undefined) {
      this.#beginAttempt(waiter, decision.workerId);
      return;
    }
    if (waiter.options.noWait === true) {
      this.#reject(waiter, new NoCapacityError(), "no-wait");
      return;
    }
    this.#enqueue(waiter);
  }

  /** ADR §11: re-run on every worker-view change. Every already-queued waiter not currently in
   * flight gets one more look, oldest first; one no eligible worker can serve is passed over,
   * not blocked on -- there is no early exit from this loop. */
  #dispatch(): void {
    for (const waiter of this.#queue.list()) {
      if (waiter.state !== "queued" || this.#dispatchTargets.has(waiter)) continue;
      const decision = this.options.routing.select(routable(waiter), this.options.views.views());
      if (decision === undefined) continue;
      this.#beginAttempt(waiter, decision.workerId);
    }
  }

  #beginAttempt(waiter: FleetWaiter, workerId: string): void {
    this.#dispatchTargets.set(waiter, workerId);
    this.#queue.markProcessing(waiter);
    void this.#attempt(waiter, workerId);
  }

  async #attempt(waiter: FleetWaiter, workerId: string): Promise<void> {
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
      this.#emit("request.dispatched", { requestId: waiter.id, workerId });
    };

    let grant: LeaseGrant;
    try {
      grant = await client.requestLease(
        {
          platform: waiter.request.platform,
          model: waiter.request.model,
          ...(waiter.request.osVersion === undefined
            ? {}
            : { osVersion: waiter.request.osVersion }),
          ...(waiter.request.full === true ? { full: true } : {}),
          requesterId: namespacedRequesterId,
          // ADR §27a: only an admin session may set `owner`, and the gateway's uplink session
          // always is one (§5). The worker stores this verbatim as the lease's `ownerId` instead
          // of deriving it from the connection -- see `daemon/dispatcher.ts`'s worker-side change
          // in this same PR.
          owner: waiter.options.ownerId,
          allowDownload: waiter.options.allowDownload ?? false,
          // ADR §12: worker queues never hold gateway traffic. Every dispatch is `noWait`
          // regardless of what the original caller asked the gateway for -- the *gateway's own*
          // queue is where a "wait" request actually waits.
          noWait: true,
          ...(waiter.options.ttlMs === undefined ? {} : { ttlMs: waiter.options.ttlMs }),
        },
        {
          onProgress: (progress) => {
            // ADR §11: "the first `progress` push" is one of the two signals a request is this
            // worker's now -- device work having started means it is committed here even before
            // the grant itself arrives.
            announceDispatched();
            this.#queue.notifyProgress(waiter, progress);
          },
        },
      );
    } catch (error: unknown) {
      this.#dispatchTargets.delete(waiter);
      if (isSimlockError(error) && error.code === "NO_CAPACITY") {
        this.#staleView(waiter, workerId);
        return;
      }
      // A terminal failure past this point is the worker's own fact (it already emitted its own
      // `lease.rejected`, relayed onto this bus with `workerId` added by `WorkerLink`) -- this
      // class does not emit a second one for it (see the module doc, "two different fields" and
      // events.md's post-commit rule apply equally to not inventing a duplicate fact). Only the
      // error code is preserved so the caller sees what the worker actually said.
      this.#queue.reject(
        waiter,
        isSimlockError(error)
          ? new DispatchError(error.code, error.message, error.details)
          : new DispatchError(
              "WORKER_UNREACHABLE",
              `Worker ${workerId} did not answer lease.request`,
              { workerId },
            ),
      );
      return;
    }

    announceDispatched();
    this.#dispatchTargets.delete(waiter);
    this.#settleGrant(waiter, workerId, grant);
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

  #settleGrant(waiter: FleetWaiter, workerId: string, grant: LeaseGrant): void {
    const gatewayLeaseId = `${workerId}.${grant.lease.id}`;
    const entry: FleetLeaseEntry = {
      gatewayLeaseId,
      grantedAt: grant.lease.grantedAt,
      ownerId: grant.lease.ownerId,
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
      if (isSimlockError(error)) throw new DispatchError(error.code, error.message, error.details);
      throw error;
    }
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

  #projectRecord<Record extends { readonly id: string; readonly requesterId: string }>(
    record: Record,
    entry: FleetLeaseEntry,
  ): Record & { readonly worker?: { readonly id: string; readonly label?: string } } {
    const workerLabel = this.options.views.view(entry.workerId)?.label;
    return {
      ...record,
      id: entry.gatewayLeaseId,
      requesterId: entry.requesterId,
      ...(workerLabel === undefined
        ? { worker: { id: entry.workerId } }
        : { worker: { id: entry.workerId, label: workerLabel } }),
    };
  }

  /**
   * §30's reconnect rebuild, and its own upkeep on every worker-view change: adds any
   * gateway-issued lease a worker's current view reports that the index does not already know
   * (upsert-only -- see `FleetLeaseIndex#rebuildFromWorker`), forgets a worker's entries entirely
   * once its view has disappeared (`worker.remove`, or retention), then runs a dispatch pass.
   */
  #onViewsChanged(): void {
    const views = this.options.views.views();
    const currentIds = new Set(views.map((view) => view.id));
    for (const view of views) {
      this.options.leaseIndex.rebuildFromWorker(view.id, view.leases);
    }
    for (const workerId of this.#knownWorkerIds) {
      if (!currentIds.has(workerId)) this.options.leaseIndex.forgetWorker(workerId);
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
