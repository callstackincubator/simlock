import type { Clock, IdGenerator } from "../ports/index.js";
import {
  isSettled,
  type LeaseProgress,
  type LeaseRequestFailure,
  type LeaseRequestLimits,
  type LeaseRequestOutcome,
  type LeaseRequestRecord,
  type LeaseRequestStore,
  type NewLeaseRequest,
  type SerializedDecision,
  newLeaseRequestId,
  newLeaseRequestRecord,
  retainedLeaseRequests,
  withNewLeaseRequest,
  withSettledLeaseRequest,
} from "../core/index.js";
import type { DeviceRequest } from "../core/index.js";
import { type LeaseRequestOptions, type QueuePlace, RequestCancelledError } from "./wait-queue.js";

/** A gateway's store: the same records and rules as the daemon's, kept only in memory. */
export class InMemoryLeaseRequestStore<Grant> implements LeaseRequestStore<Grant> {
  #records: readonly LeaseRequestRecord<Grant>[] = [];

  constructor(
    private readonly options: {
      readonly clock: Clock;
      readonly idGenerator: IdGenerator;
      readonly limits: LeaseRequestLimits;
    },
  ) {}

  leaseRequests(): readonly LeaseRequestRecord<Grant>[] {
    return retainedLeaseRequests(
      this.#records,
      this.options.clock.now(),
      this.options.limits.retentionMs,
    );
  }

  createLeaseRequest(input: NewLeaseRequest): Promise<LeaseRequestRecord<Grant>> {
    const now = this.options.clock.now();
    const record = newLeaseRequestRecord<Grant>(
      input.id ?? newLeaseRequestId(this.options.idGenerator),
      input,
      now,
    );
    this.#records = withNewLeaseRequest(this.#records, record, now, this.options.limits);
    return Promise.resolve(record);
  }

  settleLeaseRequest(
    id: string,
    outcome: LeaseRequestOutcome<Grant>,
  ): Promise<LeaseRequestRecord<Grant> | undefined> {
    const { records, settled } = withSettledLeaseRequest(
      this.#records,
      id,
      outcome,
      this.options.clock.now(),
    );
    this.#records = records;
    return Promise.resolve(settled);
  }
}

/**
 * A request still waiting for a device, as an operator sees it: who asked, for what, since when,
 * and where it stands. `queued` while it holds a place in the queue, `starting` while the daemon works
 * on it: placing it as it arrives, or finding, making, booting or downloading its device. Its idempotency key and owner are not here: they
 * are the requester's, not the operator's.
 */
export interface WaitingRequest {
  readonly id: string;
  readonly requesterId: string;
  /** The device as the request named it, with every field it left out left out. */
  readonly spec: DeviceRequest;
  readonly createdAt: number;
  readonly stage: "queued" | "starting";
  readonly queuePosition?: number;
}

/**
 * The one place a stored request and its place in a queue become a waiting entry. A daemon and a
 * gateway both list through it (`LeaseRequestBook#waiting`).
 */
function waitingRequest(
  record: Pick<LeaseRequestRecord<unknown>, "createdAt" | "id" | "request" | "requesterId">,
  place: QueuePlace,
): WaitingRequest {
  return {
    createdAt: record.createdAt,
    id: record.id,
    requesterId: record.requesterId,
    spec: { ...record.request },
    ...(place.queuePosition === undefined
      ? { stage: "starting" }
      : { queuePosition: place.queuePosition, stage: "queued" }),
  };
}

/** The same `(requesterId, idempotencyKey)` arrived again naming a different device. */
export class IdempotencyConflictError extends Error {
  constructor(
    readonly requesterId: string,
    readonly idempotencyKey: string,
  ) {
    super(
      `Idempotency key ${idempotencyKey} was already used by requester ${requesterId} for a different device request`,
    );
    this.name = "IdempotencyConflictError";
  }
}

/** A replay of a request another principal sent. */
export class LeaseRequestForbiddenError extends Error {
  constructor(readonly requestId: string) {
    super(`Lease request ${requestId} belongs to another principal`);
    this.name = "LeaseRequestForbiddenError";
  }
}

/** A stored failure, returned to a replay with the code and message it was stored with. */
export class ReplayedLeaseRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReplayedLeaseRequestError";
  }
}

/** A stored request read back with the progress of its live wait, if it has one. */
export interface LeaseRequestView<Grant> {
  readonly record: LeaseRequestRecord<Grant>;
  readonly progress?: LeaseProgress;
}

export interface LeaseRequestBookOptions<Grant> {
  readonly store: LeaseRequestStore<Grant>;
  /** The owner's serialized section; every store write runs inside it. */
  readonly decisions: Pick<SerializedDecision, "run">;
  /** Turns the error a request failed with into the code and message stored for it. */
  readonly describeFailure: (error: unknown) => LeaseRequestFailure;
}

interface OpenRequest<Grant> {
  readonly requesterId: string;
  promise: Promise<Grant> | undefined;
  progress: LeaseProgress | undefined;
  /** The callers waiting on this request. A caller that goes away silences its own callback. */
  readonly callers: Set<(progress: LeaseProgress) => void>;
  /** Readers of the stored record (the HTTP resource), told on every progress and on settlement. */
  readonly watchers: Set<() => void>;
  /**
   * The result once the wait has settled, from that moment until the record is written. `get`
   * reads it in that window, so a reader never sees a request as still waiting after its
   * caller already has the answer.
   */
  outcome: LeaseRequestOutcome<Grant> | undefined;
  /** `settled` once the write has finished, whether or not it succeeded. */
  phase: "open" | "settling" | "settled";
}

/**
 * The one place the lease-request rules live. A daemon's
 * `LeaseAcquisitionCoordinator` and a gateway's `FleetLeaseCoordinator` both admit through it, so
 * a replay is answered the same way whichever one a client reaches:
 *
 * - a request is stored before anything queues it (`admit`);
 * - a repeat under the same `(requesterId, idempotencyKey)` returns the stored result, or attaches
 *   to the wait that is still open, and never starts a second one (`replay`);
 * - the same key naming a different device is `IdempotencyConflictError`, and a repeat from
 *   another principal is `LeaseRequestForbiddenError`;
 * - a request's result is written once and never re-evaluated: when its own promise settles, or,
 *   for a daemon's grant, already in the commit that added the lease (`Registry.createLease`),
 *   in which case the settle that follows finds it granted and writes nothing.
 *
 * A caller that stops waiting -- a disconnect, an abort, its own timeout -- only stops listening:
 * nothing here writes a result for it. `cancelled` is written only when the request itself is
 * rejected with `RequestCancelledError`, which only an explicit cancel produces.
 */
export class LeaseRequestBook<Grant extends { readonly lease: { readonly id: string } }> {
  readonly #open = new Map<string, OpenRequest<Grant>>();

  constructor(private readonly options: LeaseRequestBookOptions<Grant>) {}

  /**
   * The stored answer to a repeated request, or `undefined` when no request is stored under its
   * key (including every request that carries no key). Call it inside the owner's serialized
   * admission section, before any other admission check: a stored result is returned whatever
   * has changed on the host since.
   */
  replay(request: DeviceRequest, options: LeaseRequestOptions): Promise<Grant> | undefined {
    const record = this.#stored(request, options);
    if (record === undefined) return undefined;
    const open = this.#open.get(record.id);
    if (open?.promise !== undefined) {
      options.onAdmitted?.(record.id, true);
      this.#attach(open, options.onProgress);
      return open.promise;
    }
    if (!isSettled(record)) {
      throw new Error(`Lease request ${record.id} is open but nothing is driving it`);
    }
    options.onAdmitted?.(record.id, true);
    return storedResult(record);
  }

  /** The record stored under this request's key, once the repeat is proven to be the same
   * request from the same principal; `undefined` when there is no key or nothing under it. */
  #stored(
    request: DeviceRequest,
    options: LeaseRequestOptions,
  ): LeaseRequestRecord<Grant> | undefined {
    const key = options.idempotencyKey;
    if (key === undefined) return undefined;
    const record = this.options.store
      .leaseRequests()
      .find(
        (candidate) =>
          candidate.requesterId === options.requesterId && candidate.idempotencyKey === key,
      );
    if (record === undefined) return undefined;
    if (record.ownerId !== options.ownerId) throw new LeaseRequestForbiddenError(record.id);
    if (!sameDeviceRequest(record.request, request)) {
      throw new IdempotencyConflictError(options.requesterId, key);
    }
    return record;
  }

  /**
   * Stores a new request, then calls `start` with its id and the progress sink its wait must
   * report through, and writes the result once the wait `start` returns settles. Call it inside
   * the owner's serialized admission section, after the owner's own admission checks. A `start`
   * that throws settles the stored request as failed with that error and rethrows it, so no
   * record is ever left open with nothing driving it. `id` is the one the owner minted before its
   * admission checks (`newLeaseRequestId`); omitted, the store mints it.
   */
  async admit<Started extends { readonly promise: Promise<Grant> }>(
    request: DeviceRequest,
    options: LeaseRequestOptions,
    start: (id: string, onProgress: (progress: LeaseProgress) => void) => Started,
    id?: string,
  ): Promise<{ readonly id: string; readonly started: Started }> {
    const record = await this.options.store.createLeaseRequest({
      id,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      ownerId: options.ownerId,
      request,
      requesterId: options.requesterId,
    });
    const open: OpenRequest<Grant> = {
      callers: new Set(options.onProgress === undefined ? [] : [options.onProgress]),
      outcome: undefined,
      phase: "open",
      progress: undefined,
      promise: undefined,
      requesterId: options.requesterId,
      watchers: new Set(),
    };
    this.#open.set(record.id, open);
    let started: Started;
    try {
      started = start(record.id, (progress) => this.#report(open, progress));
    } catch (error: unknown) {
      this.#track(record.id, open, Promise.reject(error));
      throw error;
    }
    this.#track(record.id, open, started.promise);
    options.onAdmitted?.(record.id, false);
    return { id: record.id, started };
  }

  #track(id: string, open: OpenRequest<Grant>, promise: Promise<Grant>): void {
    open.promise = promise;
    promise.then(
      (grant) => this.#settle(id, open, { grant, state: "granted" }),
      (error: unknown) => this.#settle(id, open, this.#outcomeOf(error)),
    );
  }

  /** A stored request and its live progress, or `undefined` once it is unknown or pruned. */
  get(id: string): LeaseRequestView<Grant> | undefined {
    const stored = this.options.store.leaseRequests().find((candidate) => candidate.id === id);
    if (stored === undefined) return undefined;
    const open = this.#open.get(id);
    if (open?.outcome !== undefined && !isSettled(stored)) {
      return { record: { ...stored, ...open.outcome } };
    }
    const progress = open?.progress;
    return progress === undefined ? { record: stored } : { progress, record: stored };
  }

  /**
   * Calls `listener` on every change to an open request -- each progress report, and its
   * settlement once the result is stored. `undefined` when nothing is open under `id`.
   */
  watch(id: string, listener: () => void): (() => void) | undefined {
    const open = this.#open.get(id);
    if (open === undefined || open.phase === "settled") return undefined;
    open.watchers.add(listener);
    return () => open.watchers.delete(listener);
  }

  /**
   * Every stored request that a live wait in `places` is driving, oldest first. A wait leaves
   * `places` when the queue resolves it. On the daemon a grant's commit comes first, so a granted
   * request is listed for that short window with its result already stored; on the gateway the
   * queue resolves first and the book's settle writes the grant after, so a granted request is
   * never listed. An open record no wait
   * drives, such as one a restarted daemon has not settled yet, is not listed.
   */
  waiting(places: readonly QueuePlace[]): WaitingRequest[] {
    const byId = new Map(places.map((place) => [place.id, place]));
    return this.options.store.leaseRequests().flatMap((record) => {
      const place = byId.get(record.id);
      return place === undefined ? [] : [waitingRequest(record, place)];
    });
  }

  /** The id of the stored request that was granted `leaseId`, while that record is retained. */
  requestIdForLease(leaseId: string): string | undefined {
    return this.options.store
      .leaseRequests()
      .find((record) => record.grant !== undefined && record.grant.lease.id === leaseId)?.id;
  }

  /** A repeat joins mid-wait: it hears where the wait stands now, not only what comes next. */
  #attach(open: OpenRequest<Grant>, onProgress: ((progress: LeaseProgress) => void) | undefined) {
    if (onProgress === undefined || open.phase !== "open") return;
    open.callers.add(onProgress);
    if (open.progress !== undefined) report(onProgress, open.progress);
  }

  #report(open: OpenRequest<Grant>, progress: LeaseProgress): void {
    if (open.phase !== "open") return;
    open.progress = progress;
    for (const caller of open.callers) report(caller, progress);
    notify(open.watchers);
  }

  #outcomeOf(error: unknown): LeaseRequestOutcome<Grant> {
    if (error instanceof RequestCancelledError) return { state: "cancelled" };
    return { failure: this.options.describeFailure(error), state: "failed" };
  }

  /**
   * Writes the result, then forgets the live wait. A request already granted by the same commit
   * as its lease is settled: the store leaves it alone, and this counts as success. A write that fails keeps the entry, so a
   * replay in this process still attaches to the settled promise and gets the real answer; the
   * record on disk stays open and startup recovery settles it.
   */
  async #settle(
    id: string,
    open: OpenRequest<Grant>,
    outcome: LeaseRequestOutcome<Grant>,
  ): Promise<void> {
    open.phase = "settling";
    open.outcome = outcome;
    try {
      await this.options.decisions.run(() => this.options.store.settleLeaseRequest(id, outcome));
      this.#open.delete(id);
    } catch {
      // See the method comment: the entry stays so in-process replays keep their answer.
    } finally {
      open.phase = "settled";
      notify(open.watchers);
      open.watchers.clear();
    }
  }
}

function report(caller: (progress: LeaseProgress) => void, progress: LeaseProgress): void {
  try {
    caller(progress);
  } catch {
    // A caller's feedback must not affect the request.
  }
}

/** Snapshotted with `Array.from`: a listener may unsubscribe itself while being told. */
function notify(listeners: ReadonlySet<() => void>): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // A reader's failure must not affect the request or the other readers.
    }
  }
}

function storedResult<Grant>(record: LeaseRequestRecord<Grant>): Promise<Grant> {
  if (record.state === "granted" && record.grant !== undefined) {
    return Promise.resolve(record.grant);
  }
  if (record.state === "cancelled") return Promise.reject(new RequestCancelledError(record.id));
  const failure = record.failure ?? { code: "INTERNAL", message: "Lease request failed" };
  return Promise.reject(new ReplayedLeaseRequestError(failure.code, failure.message));
}

/**
 * Whether two requests name the same device: what an idempotency key promises not to change. An
 * omitted `model`, `class`, `osVersion`, `mode` or `imageTag` compares equal to itself only: a request that named
 * no mode is not the same request as one that named the worker's default.
 */
function sameDeviceRequest(left: DeviceRequest, right: DeviceRequest): boolean {
  return (
    left.platform === right.platform &&
    left.model === right.model &&
    left.class === right.class &&
    left.osVersion === right.osVersion &&
    left.mode === right.mode &&
    left.imageTag === right.imageTag
  );
}
