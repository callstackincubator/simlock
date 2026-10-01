import type { Clock, IdGenerator } from "../ports/index.js";
import { isSettled, type LeaseRequestFailure, type LeaseRequestRecord } from "./domain.js";
import type { DeviceRequest } from "./driver.js";
import type { SerializedDecision } from "./serialized-decision.js";
import {
  type LeaseProgress,
  type LeaseRequestOptions,
  RequestCancelledError,
} from "./wait-queue.js";

/** `lease.requestRetentionMs` and `lease.maxRequestRecords`, as a store applies them. */
export interface LeaseRequestLimits {
  readonly retentionMs: number;
  readonly maxRecords: number;
}

export interface NewLeaseRequest {
  readonly requesterId: string;
  readonly ownerId: string;
  readonly idempotencyKey?: string;
  readonly request: DeviceRequest;
}

export type LeaseRequestOutcome<Grant> =
  | { readonly state: "granted"; readonly grant: Grant }
  | { readonly state: "failed"; readonly failure: LeaseRequestFailure }
  | { readonly state: "cancelled" };

/**
 * Where lease-request records live. The daemon's `Registry` keeps them in `state.json`; a
 * gateway keeps them in memory (`InMemoryLeaseRequestStore`). Both apply retention, the record
 * cap, and settlement through the functions below, so the two cannot disagree about them.
 */
export interface LeaseRequestStore<Grant> {
  /** Every record still inside its retention window, oldest first. */
  leaseRequests(): readonly LeaseRequestRecord<Grant>[];
  createLeaseRequest(input: NewLeaseRequest): Promise<LeaseRequestRecord<Grant>>;
  /** Writes a result onto an open record. A record that is already settled, or gone, is left alone. */
  settleLeaseRequest(
    id: string,
    outcome: LeaseRequestOutcome<Grant>,
  ): Promise<LeaseRequestRecord<Grant> | undefined>;
}

/** An open record is always retained; a settled one only until `retentionMs` after it settled. */
export function retainedLeaseRequests<Grant>(
  records: readonly LeaseRequestRecord<Grant>[],
  now: number,
  retentionMs: number,
): LeaseRequestRecord<Grant>[] {
  return records.filter(
    (record) => !isSettled(record) || (record.settledAt ?? now) + retentionMs > now,
  );
}

/**
 * Appends `record` after pruning expired records and, while the list is at the cap, evicting the
 * oldest settled one. An open record is never evicted: when every record is open the new one is
 * still admitted, because refusing it would turn the cap into an outage rather than a bound.
 */
export function withNewLeaseRequest<Grant>(
  records: readonly LeaseRequestRecord<Grant>[],
  record: LeaseRequestRecord<Grant>,
  now: number,
  limits: LeaseRequestLimits,
): LeaseRequestRecord<Grant>[] {
  const kept = retainedLeaseRequests(records, now, limits.retentionMs);
  while (kept.length >= limits.maxRecords) {
    const oldestSettled = kept.findIndex((candidate) => isSettled(candidate));
    if (oldestSettled === -1) break;
    kept.splice(oldestSettled, 1);
  }
  return [...kept, record];
}

export function withSettledLeaseRequest<Grant>(
  records: readonly LeaseRequestRecord<Grant>[],
  id: string,
  outcome: LeaseRequestOutcome<Grant>,
  now: number,
): {
  readonly records: readonly LeaseRequestRecord<Grant>[];
  readonly settled?: LeaseRequestRecord<Grant>;
} {
  const index = records.findIndex((record) => record.id === id);
  const open = records[index];
  if (open === undefined || isSettled(open)) return { records };
  const settled: LeaseRequestRecord<Grant> = { ...open, ...outcome, settledAt: now };
  const next = [...records];
  next[index] = settled;
  return { records: next, settled };
}

export function newLeaseRequestRecord<Grant>(
  id: string,
  input: NewLeaseRequest,
  now: number,
): LeaseRequestRecord<Grant> {
  return {
    createdAt: now,
    id,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    ownerId: input.ownerId,
    request: { ...input.request },
    requesterId: input.requesterId,
    state: "open",
  };
}

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
      `req_${this.options.idGenerator.generate()}`,
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
 * - a request's result is written once, when its own promise settles, and never re-evaluated.
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
   * report through, and writes the result once the promise `start` returns settles. Call it
   * inside the owner's serialized admission section, after the owner's own admission checks.
   * A `start` that throws settles the stored request as failed with that error, so no record is
   * ever left open with nothing driving it.
   */
  async admit(
    request: DeviceRequest,
    options: LeaseRequestOptions,
    start: (id: string, onProgress: (progress: LeaseProgress) => void) => Promise<Grant>,
  ): Promise<{ readonly id: string; readonly promise: Promise<Grant> }> {
    const record = await this.options.store.createLeaseRequest({
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
    let promise: Promise<Grant>;
    try {
      promise = start(record.id, (progress) => this.#report(open, progress));
    } catch (error: unknown) {
      promise = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    open.promise = promise;
    promise.then(
      (grant) => this.#settle(record.id, open, { grant, state: "granted" }),
      (error: unknown) => this.#settle(record.id, open, this.#outcomeOf(error)),
    );
    options.onAdmitted?.(record.id, false);
    return { id: record.id, promise };
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
  // fallow-ignore-next-line unused-class-member -- reached through the HTTP request resource's `LeaseRequestReader` port.
  watch(id: string, listener: () => void): (() => void) | undefined {
    const open = this.#open.get(id);
    if (open === undefined || open.phase === "settled") return undefined;
    open.watchers.add(listener);
    return () => open.watchers.delete(listener);
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
   * Writes the result, then forgets the live wait. A write that fails keeps the entry, so a
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
    open.callers.clear();
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
 * omitted `osVersion` and an omitted `full` compare equal to themselves only -- `full: false` and
 * omitted are the same request.
 */
function sameDeviceRequest(left: DeviceRequest, right: DeviceRequest): boolean {
  return (
    left.platform === right.platform &&
    left.model === right.model &&
    left.osVersion === right.osVersion &&
    (left.full ?? false) === (right.full ?? false)
  );
}
