/**
 * why: `FleetLeaseCoordinator`: admission, the fleet-wide one-lease rule, dispatch, and lease/exec
 * forwarding (ADR 0005 §10-§16, §19a-§19c, §27, §27a). Much smaller than the worker's own
 * `LeaseAcquisitionCoordinator` -- there is no provisioning, no eviction, and no driver to ask: a
 * worker either grants a forwarded `lease.request` immediately or refuses it, because every
 * dispatch is `noWait` (§12).
 *
 * The dispatch race (why a waiter in flight is never offered to a second worker) is documented in
 * `fleet-dispatch.ts`'s module doc.
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
import type { BaselineSaveInput, BaselineSaveOutput, RotateOutput } from "../admin/index.js";
import type { EventBus } from "../bus/index.js";
import type { Platform } from "../contract/index.js";
import type {
  DeviceRequest,
  LeaseRequestFailure,
  LeaseRequestLimits,
  MaxPerRequester,
} from "../core/index.js";
import { DispatchError, type DispatchSession } from "../daemon/dispatch.js";
import type { LeaseRequestBook, WaitingRequest } from "../leasing/index.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { AdmissionOptions } from "./admission.js";
import type { EndedLeaseIds } from "./ended-lease-ids.js";
import { FleetAdmission, type FleetRequestOptions } from "./fleet-admission.js";
import { FleetDispatch } from "./fleet-dispatch.js";
import { FleetFacts, FleetOutcomes } from "./fleet-facts.js";
import { FleetForwarding, type FleetExecInput, type FleetRotateInput } from "./fleet-forwarding.js";
import { FleetGrants } from "./fleet-grant.js";
import { FleetIndexUpkeep } from "./fleet-index-upkeep.js";
import type { FleetViews, WorkerDirectory } from "./fleet-ports.js";
import type { WorkerEntry } from "./fleet-refusals.js";
import type { FleetLeaseIndex } from "./lease-index.js";
import { FleetQueue, type FleetLeaseGrant, type FleetLeaseRecord } from "./queue.js";
import type { RoutingPolicy } from "./routing.js";

export type { FleetRequestOptions } from "./fleet-admission.js";

// why: the gateway adds this to the leasing module's entry; the contract's schema is its wire shape.
export type FleetWaitingRequest = WaitingRequest & { readonly workers?: WorkerEntry[] };

export interface FleetLeaseCoordinatorOptions {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly directory: WorkerDirectory;
  readonly views: FleetViews;
  readonly routing: RoutingPolicy;
  readonly leaseIndex: FleetLeaseIndex;
  /** why: ADR 0074 §4: the chosen ids this gateway learned ended from its workers. */
  readonly endedLeaseIds: EndedLeaseIds;
  /** why: ADR §19e (P5, round 2 review): `gateway.execTimeoutMs`, the backstop for a forwarded
   * `device.exec` whose worker never answers at all -- the worker's own `exec.timeoutMs` is
   * authoritative for an ordinary timeout (it owns the process and can kill it) and is expected
   * to fire first, since the gateway's default is deliberately the longer of the two. */
  readonly execTimeoutMs: number;
  /** why: P2 (round 2 review): `gateway.leaseRequestTimeoutMs` -- bounds a forwarded
   * `lease.request`, the one uplink call that used to have no timeout of its own. See
   * `FleetForwarding.withLeaseRequestTimeout`'s own doc comment. */
  readonly leaseRequestTimeoutMs: number;
  /**
   * why: `lease.requestRetentionMs`/`lease.maxRequestRecords`. A gateway keeps its lease requests in
   * memory only: a gateway restart loses every one it held, the same as before requests were
   * stored, while what it had already routed is stored on the worker that took it.
   */
  readonly leaseRequestLimits: LeaseRequestLimits;
  /** why: The same failure description a worker stores, so a replay answers with the same code. */
  readonly describeFailure: (error: unknown) => LeaseRequestFailure;
  readonly maxPerRequester?: MaxPerRequester;
  readonly logger?: Logger;
  /** why: ADR 0074 §1: set, the gateway asks this command about every new request; unset, every request has priority 0. */
  readonly admission?: AdmissionOptions;
}

export class FleetLeaseCoordinator {
  readonly #queue: FleetQueue;
  readonly #facts: FleetFacts;
  readonly #forwarding: FleetForwarding;
  readonly #dispatch: FleetDispatch;
  readonly #admission: FleetAdmission;
  readonly #upkeep: FleetIndexUpkeep;
  readonly requests: LeaseRequestBook<FleetLeaseGrant>;
  readonly #logger: Logger;
  readonly #unsubscribeViews: () => void;

  constructor(private readonly options: FleetLeaseCoordinatorOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#facts = new FleetFacts({ eventBus: options.eventBus });
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
        this.#facts.emit(
          "queue.changed",
          line === "physical" ? { depth, physical: true } : { depth },
        ),
      onTimeout: (waiter) => this.#facts.rejected(waiter, "timeout"),
    });
    const outcomes = new FleetOutcomes({ queue: this.#queue, facts: this.#facts });
    const grants = new FleetGrants({
      forwarding: this.#forwarding,
      leaseIndex: options.leaseIndex,
      logger: this.#logger,
      queue: this.#queue,
      facts: this.#facts,
      outcomes,
    });
    this.#dispatch = new FleetDispatch({
      clock: options.clock,
      directory: options.directory,
      views: options.views,
      routing: options.routing,
      leaseIndex: options.leaseIndex,
      logger: this.#logger,
      queue: this.#queue,
      forwarding: this.#forwarding,
      facts: this.#facts,
      outcomes,
      grants,
    });
    this.#admission = new FleetAdmission({
      ...(options.admission === undefined ? {} : { admission: options.admission }),
      clock: options.clock,
      idGenerator: options.idGenerator,
      describeFailure: options.describeFailure,
      leaseRequestLimits: options.leaseRequestLimits,
      ...(options.maxPerRequester === undefined
        ? {}
        : { maxPerRequester: options.maxPerRequester }),
      leaseIndex: options.leaseIndex,
      views: options.views,
      endedLeaseIds: options.endedLeaseIds,
      directory: options.directory,
      logger: this.#logger,
      queue: this.#queue,
      facts: this.#facts,
      dispatch: this.#dispatch,
    });
    this.requests = this.#admission.requests;
    this.#upkeep = new FleetIndexUpkeep({
      clock: options.clock,
      endedLeaseIds: options.endedLeaseIds,
      leaseIndex: options.leaseIndex,
      views: options.views,
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
    this.#facts.emit("queue.changed", { depth: this.#queue.depth });
  }

  waitingRequests(): readonly FleetWaitingRequest[] {
    const queued = new Map(this.#queue.list().map((waiter) => [waiter.id, waiter]));
    return this.requests.waiting(this.#queue.places()).map((entry) => {
      const waiter = queued.get(entry.id);
      const workers = waiter === undefined ? undefined : this.#dispatch.workerReasons(waiter);
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

  request(deviceRequest: DeviceRequest, options: FleetRequestOptions): Promise<FleetLeaseGrant> {
    return this.#admission.request(deviceRequest, options);
  }

  cancelPending(
    requesterId: string,
    platform?: Platform,
  ): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    return this.#admission.cancelPending(requesterId, platform);
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

  /** why: Unsubscribes from worker-view changes and rejects every still-pending waiter -- a gateway
   * restart loses in-flight requests exactly as a worker restart does (ADR §30), so this makes
   * that explicit rather than leaving them to hang on a coordinator nothing will ever drive
   * again. */
  dispose(): void {
    this.#unsubscribeViews();
    this.#admission.stopAsking();
    this.#queue.cancelAll(() => new DispatchError("DAEMON_STOPPING", "Gateway is stopping"));
  }

  #onViewsChanged(): void {
    this.#upkeep.reconcile();
    this.#dispatch.dispatch();
  }
}
