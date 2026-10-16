import type { Clock, IdGenerator, TimerHandle } from "../ports/index.js";
import { type DeviceRequest, type LeaseGrant, type LeaseProgress } from "../core/index.js";

export interface LeaseRequestOptions {
  readonly requesterId: string;
  /** ADR 0003 §4: the session principal the resulting lease is owned by -- distinct from
   * `requesterId`, which is attribution and defaults to the principal but may be set to
   * something else per request. Required: every caller of `LeaseCommands.request` (the daemon
   * dispatcher) always knows its own session's principal. */
  readonly ownerId: string;
  readonly timeoutMs?: number;
  readonly noWait?: boolean;
  readonly allowDownload?: boolean;
  readonly requires?: readonly string[];
  readonly onProgress?: (progress: LeaseProgress) => void;
  /** ADR 0004 §4: this lease's initial TTL, accepted on every request. Omitted means
   * `lease.defaultTtlMs`; the cap against `lease.maxTtlMs` is applied at the daemon boundary
   * before a request ever reaches here, so this type trusts what it is given. */
  readonly ttlMs?: number;
  /**
   * The caller's key for repeating this request (see `LeaseRequestBook`). Paired with
   * `requesterId`; both are the caller's own claims, so a replay is authorized on `ownerId`.
   */
  readonly idempotencyKey?: string;
  /**
   * ADR 0020: the lease ID the requester chose. The granted lease has exactly this ID; the
   * requester guarantees it is unique for all time, and while the request waits it holds the ID.
   * An option of the request, not part of the device it names.
   */
  readonly leaseId?: string;
  /**
   * ADR 0021: the gateway's request id. A request that has one is a probe: its refusals and
   * failures are `lease.declined`, and it is never queued. Set only for the gateway's uplink.
   */
  readonly fleetRequestId?: string;
  /** Called with the stored request's id once it is admitted (`replayed` false), or once a
   * repeat finds it (`replayed` true). */
  readonly onAdmitted?: (requestId: string, replayed: boolean) => void;
}

export class QueueTimeoutError extends Error {
  constructor(readonly requestId: string) {
    super(`Timed out waiting for a device: ${requestId}`);
    this.name = "QueueTimeoutError";
  }
}

export class RequestCancelledError extends Error {
  constructor(readonly requestId: string) {
    super(`Lease request cancelled: ${requestId}`);
    this.name = "RequestCancelledError";
  }
}

export interface RequesterLimitContext {
  readonly limit: number;
  readonly held: number;
  readonly waiting: boolean;
}

export class RequesterAlreadyLeasedError extends Error {
  constructor(
    readonly requesterId: string,
    readonly existingLeaseId?: string,
    context?: RequesterLimitContext,
  ) {
    super(requesterRefusalMessage(requesterId, existingLeaseId, context));
    this.name = "RequesterAlreadyLeasedError";
  }
}

function requesterRefusalMessage(
  requesterId: string,
  existingLeaseId: string | undefined,
  context: RequesterLimitContext | undefined,
): string {
  if (context !== undefined && context.limit > 1) {
    if (context.waiting) {
      return `Requester ${requesterId} already has a waiting request; wait for it to be granted or cancel it before requesting another device`;
    }
    return `Requester ${requesterId} already holds ${String(context.held)} leases and lease.maxPerRequester is ${String(context.limit)}; release one (\`simlock release ${String(existingLeaseId)}\`) before requesting another device`;
  }
  return existingLeaseId === undefined
    ? `Requester already has a lease or pending request: ${requesterId}`
    : `Requester ${requesterId} already holds lease ${existingLeaseId}; release it (\`simlock release ${existingLeaseId}\`) before requesting another device`;
}

/** A request named a lease ID an active lease or a waiting request already holds (ADR 0020). */
export class LeaseIdTakenError extends Error {
  constructor(readonly leaseId: string) {
    super(`lease ID ${leaseId} is already in use`);
    this.name = "LeaseIdTakenError";
  }
}

/** Thrown when a caller passes a waiter created by a different queue instance. */
export class ForeignWaiterError extends Error {
  constructor() {
    super("Waiter does not belong to this queue");
    this.name = "ForeignWaiterError";
  }
}

export type WaiterState = "new" | "queued" | "processing" | "granted" | "rejected";

/** Where a waiter stands (`WaitQueue#places`): `queuePosition` only while it is `queued`. */
export interface QueuePlace {
  readonly id: string;
  readonly queuePosition?: number;
}

export interface Waiter {
  readonly id: string;
  readonly request: DeviceRequest;
  readonly options: LeaseRequestOptions;
  readonly promise: Promise<LeaseGrant>;
  readonly state: WaiterState;
}

interface MutableWaiter extends Waiter {
  readonly onProgress: ((progress: LeaseProgress) => void) | undefined;
  rejectPromise: (error: Error) => void;
  resolvePromise: (grant: LeaseGrant) => void;
  state: WaiterState;
  timer: TimerHandle | undefined;
  /**
   * Fixed on the first arm and never moved, so a re-queue cannot restart the budget.
   */
  deadlineAt: number | undefined;
}

export type QueueLine = "virtual" | "physical";

export interface WaitQueueOptions {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly onTimeout?: (waiter: Waiter) => void;
  readonly onDepthChange?: ((depth: number, line: QueueLine) => void) | undefined;
}

export function lineOf(request: DeviceRequest): QueueLine {
  return request.physical === true ? "physical" : "virtual";
}

export class WaitQueue {
  readonly #ownedWaiters = new WeakSet<MutableWaiter>();
  readonly #waiters: MutableWaiter[] = [];
  readonly #pendingWaiters = new Set<MutableWaiter>();
  readonly #pendingRequesters = new Set<string>();

  constructor(private readonly options: WaitQueueOptions) {}

  get depth(): number {
    return this.#line("virtual").length;
  }

  get physicalDepth(): number {
    return this.#line("physical").length;
  }

  get head(): Waiter | undefined {
    return this.#line("virtual")[0];
  }

  list(): readonly Waiter[] {
    return [...this.#waiters];
  }

  places(): readonly QueuePlace[] {
    return [...this.#pendingWaiters].map((waiter) =>
      waiter.state === "queued"
        ? { id: waiter.id, queuePosition: this.#line(lineOf(waiter.request)).indexOf(waiter) + 1 }
        : { id: waiter.id },
    );
  }

  pending(): readonly Waiter[] {
    return [...this.#pendingWaiters];
  }

  hasPendingRequester(requesterId: string): boolean {
    return this.#pendingRequesters.has(requesterId);
  }

  /**
   * Includes a waiter driven straight to `processing`, which is never enqueued.
   */
  findPendingWaiter(requesterId: string): Waiter | undefined {
    for (const waiter of this.#pendingWaiters) {
      if (waiter.options.requesterId === requesterId) return waiter;
    }
    return undefined;
  }

  /**
   * `id` is the stored request's id when the caller stored one first (`LeaseRequestBook`), so
   * the waiter and its record share one name; omitted, the queue mints its own.
   *
   * One pending request per requester is the owner's rule, not the queue's: the owner asks
   * `hasPendingRequester` inside its admission decision, before it stores the request and calls
   * this, and answers a duplicate with its own refusal (`emitLeaseRefusal`). Checking again here would be a
   * second copy of that rule, firing only after the request was already stored.
   */
  create(request: DeviceRequest, requestOptions: LeaseRequestOptions, id?: string): Waiter {
    let resolvePromise!: (grant: LeaseGrant) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<LeaseGrant>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiter: MutableWaiter = {
      deadlineAt: undefined,
      id: id ?? `req_${this.options.idGenerator.generate()}`,
      onProgress: requestOptions.onProgress,
      options: requestOptions,
      promise,
      rejectPromise,
      request,
      resolvePromise,
      state: "new",
      timer: undefined,
    };
    this.#ownedWaiters.add(waiter);
    this.#pendingWaiters.add(waiter);
    this.#pendingRequesters.add(requestOptions.requesterId);
    return waiter;
  }

  /**
   * A re-queue keeps the first deadline (`deadlineAt`) instead of re-arming the full `timeoutMs`.
   */
  enqueue(waiter: Waiter): boolean {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return false;

    if (this.#expireIfPastDeadline(mutable)) return false;

    if (!this.#waiters.includes(mutable)) {
      this.#waiters.push(mutable);
      const line = lineOf(mutable.request);
      const depth = this.#line(line).length;
      this.options.onDepthChange?.(depth, line);
      this.notifyProgress(mutable, { queuePosition: depth, stage: "queued" });
    }
    mutable.state = "queued";
    this.#armTimeout(mutable);
    return true;
  }

  markProcessing(waiter: Waiter): boolean {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return false;
    // A retry does not reset the deadline, so a waiter past it is not handed to the next worker.
    if (this.#expireIfPastDeadline(mutable)) return false;
    mutable.state = "processing";
    return true;
  }

  #expireIfPastDeadline(mutable: MutableWaiter): boolean {
    if (mutable.deadlineAt === undefined || this.options.clock.now() < mutable.deadlineAt) {
      return false;
    }
    if (this.reject(mutable, new QueueTimeoutError(mutable.id))) {
      try {
        this.options.onTimeout?.(mutable);
      } catch {
        // Queue wake-up is an observer of this committed timeout fact.
      }
    }
    return true;
  }

  markNew(waiter: Waiter): boolean {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return false;
    mutable.state = this.#waiters.includes(mutable) ? "queued" : "new";
    return true;
  }

  isQueued(waiter: Waiter): boolean {
    return this.#waiters.includes(this.#mutable(waiter));
  }

  /**
   * P3 (round 2 review): a terminal waiter never gets a push. Before this guard, `enqueue`
   * rejecting synchronously (the deadline-check branch above) left a caller free to keep calling
   * `notifyProgress` on the same waiter regardless -- `LeaseAcquisitionCoordinator#defer`
   * unconditionally pushes a `reclaiming` progress right after its own `#enqueue` call, so a
   * request that had just settled `QUEUE_TIMEOUT` could still receive a push after its error,
   * with nothing here or at that call site distinguishing "still waiting" from "already told".
   */
  notifyProgress(waiter: Waiter, progress: LeaseProgress): void {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return;
    try {
      mutable.onProgress?.(progress);
    } catch {
      // Client feedback must not affect lease acquisition.
    }
  }

  resolve(waiter: Waiter, grant: LeaseGrant): boolean {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return false;
    this.#remove(mutable);
    mutable.state = "granted";
    this.#pendingRequesters.delete(mutable.options.requesterId);
    mutable.resolvePromise(grant);
    return true;
  }

  reject(waiter: Waiter, error: Error): boolean {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return false;
    this.#remove(mutable);
    mutable.state = "rejected";
    this.#pendingRequesters.delete(mutable.options.requesterId);
    mutable.rejectPromise(error);
    return true;
  }

  cancelAll(error: Error | ((waiter: Waiter) => Error)): readonly Waiter[] {
    const cancelled: Waiter[] = [];
    for (const waiter of this.#pendingWaiters) {
      const cancellation = typeof error === "function" ? error(waiter) : error;
      if (this.reject(waiter, cancellation)) cancelled.push(waiter);
    }
    return cancelled;
  }

  /**
   * Arms (or re-arms, after a cycle back through `queued`) this waiter's timeout. `deadlineAt` is
   * computed once, the first time a waiter with a `timeoutMs` is ever armed, and never moved
   * afterward -- every later call here (a re-enqueue `enqueue` already let through because the
   * deadline had not yet passed) times the remaining budget against that same fixed deadline
   * instead of starting a fresh `timeoutMs` window, which is what let the total wait exceed
   * `timeoutMs` by a multiple across repeated `processing` <-> `queued` cycles before this fix.
   *
   * If the timer fires while `waiter.state !== "queued"` (mid-attempt), it does *not* reject --
   * the request is actively being handled, and this class does not know whether that attempt is
   * about to succeed. `enqueue`'s own deadline check is what catches this case at the next
   * re-queue, since `waiter.timer` is already cleared by the time this branch returns.
   *
   * H5 (round 3 review): the `waiter.timer !== undefined` guard above means `remainingMs` is
   * only ever actually computed with a genuinely partial value in theory, essentially never in
   * practice under a real `Clock` -- every real call into this method lands in one of exactly two
   * cases. A fresh arm (`waiter.timer` was never set) always computes the *full* `timeoutMs`,
   * since `deadlineAt` is being fixed in the same line. Every later call finds one of two things:
   * the original timer is still counting down (`waiter.timer !== undefined`), so the guard above
   * returns immediately and the still-live timer -- already targeting the correct fixed
   * `deadlineAt` -- is left untouched, no second `setTimer` call, no recompute, no re-arm; or that
   * timer already fired at (or acceptably near) `deadlineAt` (clearing itself, above), in which
   * case `enqueue`'s own upfront `clock.now() >= deadlineAt` check rejects the waiter before this
   * method is even called again. That "acceptably near" is not exact under a real `Clock`: Node's
   * own timers can fire a little early (sub-millisecond to a few ms, platform- and load-
   * dependent), so a re-`enqueue` landing in that narrow window between the timer's early fire and
   * the deadline it was targeting can reach here with `waiter.timer === undefined`, `deadlineAt`
   * already set, and `clock.now()` still (fractionally) short of it -- the one shape this
   * arithmetic then computes a genuinely partial `remainingMs` for, rather than the full budget or
   * an already-expired one. Harmless (the re-armed timer still targets the same fixed
   * `deadlineAt`, just via a few-millisecond-shorter final `setTimer` call instead of one that
   * would have fired at the identical moment anyway), but real, not merely theoretical --
   * `FakeClock` (every test here) never fires early, so no test under it can ever land in this
   * window, which is why the difference is a doc claim to get right rather than a behavior to
   * cover with one. Separately: `markNew` (below) is a public path back to `queued` that arms no
   * timer at all -- a waiter it returns to `queued` sits with no deadline until some *other*
   * `enqueue` call re-arms it, which is a real gap in `timeoutMs` enforcement for whichever
   * caller uses that path (`LeaseAcquisitionCoordinator`'s own eviction and provision-retry
   * callers, not this module's problem to close on its own).
   */
  #armTimeout(waiter: MutableWaiter): void {
    if (waiter.timer !== undefined || waiter.options.timeoutMs === undefined) return;
    waiter.deadlineAt ??= this.options.clock.now() + waiter.options.timeoutMs;
    const remainingMs = Math.max(0, waiter.deadlineAt - this.options.clock.now());
    waiter.timer = this.options.clock.setTimer(remainingMs, () => {
      waiter.timer = undefined;
      if (waiter.state !== "queued") return;
      if (this.reject(waiter, new QueueTimeoutError(waiter.id))) {
        try {
          this.options.onTimeout?.(waiter);
        } catch {
          // Queue wake-up is an observer of this committed timeout fact.
        }
      }
    });
  }

  #remove(waiter: MutableWaiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index !== -1) {
      this.#waiters.splice(index, 1);
      const line = lineOf(waiter.request);
      this.options.onDepthChange?.(this.#line(line).length, line);
    }
    this.#pendingWaiters.delete(waiter);
    if (waiter.timer !== undefined) {
      this.options.clock.cancel(waiter.timer);
      waiter.timer = undefined;
    }
  }

  #line(line: QueueLine): MutableWaiter[] {
    return this.#waiters.filter((waiter) => lineOf(waiter.request) === line);
  }

  #mutable(waiter: Waiter): MutableWaiter {
    const mutable = waiter as MutableWaiter;
    if (!this.#ownedWaiters.has(mutable)) throw new ForeignWaiterError();
    return mutable;
  }
}

function isTerminal(state: WaiterState): boolean {
  return state === "granted" || state === "rejected";
}
