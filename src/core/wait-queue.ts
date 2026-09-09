import type { Clock, IdGenerator, TimerHandle } from "../ports/index.js";
import type { DeviceRecord, LeaseRecord } from "./domain.js";
import type { DeviceRequest } from "./driver.js";

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
  readonly onProgress?: (progress: LeaseProgress) => void;
  /** ADR 0004 §4: this lease's initial TTL, accepted on every request. Omitted means
   * `lease.defaultTtlMs`; the cap against `lease.maxTtlMs` is applied at the daemon boundary
   * before a request ever reaches here, so this type trusts what it is given. */
  readonly ttlMs?: number;
}

/** Request-scoped progress for the lease action currently being performed. */
export type LeaseProgress =
  | { readonly stage: "queued"; readonly queuePosition: number }
  | { readonly stage: "provisioning"; readonly etaMs: number }
  | { readonly stage: "booting"; readonly etaMs: number }
  | { readonly stage: "reclaiming"; readonly etaMs: number };

export interface LeaseTiming {
  readonly estimatedProvisionMs: number;
  readonly estimatedBootMs: number;
  readonly estimatedReclaimMs: number;
  readonly estimatedReadyMs: number;
}

export interface LeaseGrant {
  readonly device: DeviceRecord;
  /**
   * What the holder needs in its environment to reach this device at all -- the owning
   * driver's own answer, forwarded verbatim. Empty is a legitimate answer; the core never
   * reads a key here (architecture rule 2).
   */
  readonly environment: Readonly<Record<string, string>>;
  readonly lease: LeaseRecord;
  readonly timing: LeaseTiming;
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

export class RequesterAlreadyLeasedError extends Error {
  constructor(
    readonly requesterId: string,
    /** The requester's existing lease, when the conflict is a granted lease rather than a queued request. */
    readonly existingLeaseId?: string,
  ) {
    super(
      existingLeaseId === undefined
        ? `Requester already has a lease or pending request: ${requesterId}`
        : `Requester ${requesterId} already holds lease ${existingLeaseId}; release it (\`simlock release ${existingLeaseId}\`) before requesting another device`,
    );
    this.name = "RequesterAlreadyLeasedError";
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

export interface Waiter {
  readonly id: string;
  readonly request: DeviceRequest;
  readonly options: LeaseRequestOptions;
  readonly promise: Promise<LeaseGrant>;
  readonly state: WaiterState;
}

interface MutableWaiter extends Waiter {
  onProgress: ((progress: LeaseProgress) => void) | undefined;
  rejectPromise: (error: Error) => void;
  resolvePromise: (grant: LeaseGrant) => void;
  state: WaiterState;
  timer: TimerHandle | undefined;
  /**
   * The absolute clock reading `options.timeoutMs` counts down to, fixed the *first* time this
   * waiter is ever armed and never moved afterward -- see `#armTimeout`'s own doc comment for why
   * (pre-existing, now routinely triggered: round 2 review of ADR 0005's fleet queue).
   */
  deadlineAt: number | undefined;
}

export interface WaitQueueOptions {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Called after a timed-out waiter has been removed and rejected. */
  readonly onTimeout?: (waiter: Waiter) => void;
}

/**
 * FIFO state and promises for requests that are waiting to acquire a lease.
 *
 * This class deliberately does not decide whether capacity exists or perform
 * any lease work. Its owner advances waiters between `new`, `processing`, and
 * terminal states while this class owns queue membership and settlement.
 */
export class WaitQueue {
  readonly #ownedWaiters = new WeakSet<MutableWaiter>();
  readonly #waiters: MutableWaiter[] = [];
  readonly #pendingWaiters = new Set<MutableWaiter>();
  readonly #pendingRequesters = new Set<string>();

  constructor(private readonly options: WaitQueueOptions) {}

  get depth(): number {
    return this.#waiters.length;
  }

  get head(): Waiter | undefined {
    return this.#waiters[0];
  }

  /**
   * Every waiter currently holding a queue slot (`queued` or `processing`), oldest first. The
   * single-lease acquisition path never needs this -- it only ever advances `head` -- but a
   * caller that places requests across more than one resource (the gateway's fleet queue,
   * ADR 0005 §11: "for each queued request, oldest first, the routing policy picks an eligible
   * worker ... a request no worker can serve right now is passed over") has to walk the whole
   * FIFO in order rather than block on its front. Returns a snapshot copy, not a live view.
   */
  list(): readonly Waiter[] {
    return [...this.#waiters];
  }

  hasPendingRequester(requesterId: string): boolean {
    return this.#pendingRequesters.has(requesterId);
  }

  /**
   * Finds a requester's waiter across every non-terminal state, not just the FIFO list -- a
   * waiter driven straight to `processing` on its first attempt never gets enqueued at all, so
   * a caller deciding cancellability needs this broader membership, unlike `detachProgress`
   * which only ever needs to reach an already-queued entry.
   */
  findPendingWaiter(requesterId: string): Waiter | undefined {
    for (const waiter of this.#pendingWaiters) {
      if (waiter.options.requesterId === requesterId) return waiter;
    }
    return undefined;
  }

  create(request: DeviceRequest, requestOptions: LeaseRequestOptions): Waiter {
    if (this.hasPendingRequester(requestOptions.requesterId)) {
      throw new RequesterAlreadyLeasedError(requestOptions.requesterId);
    }

    let resolvePromise!: (grant: LeaseGrant) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<LeaseGrant>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiter: MutableWaiter = {
      deadlineAt: undefined,
      id: `req_${this.options.idGenerator.generate()}`,
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
   * Pre-existing gap, now routinely triggered (round 2 review): a waiter that cycles
   * `queued` -> `processing` -> `queued` again (a worker's own retry, or the gateway's stale-view
   * re-queue) used to have its whole `timeoutMs` budget re-armed from zero on every return to
   * `queued`, because `#armTimeout` only ever knew "start a fresh timer for the full duration."
   * `deadlineAt` (fixed once, on the very first arm) is what makes the budget survive the cycle:
   * a re-enqueue past that deadline is rejected on the spot instead of getting another full
   * `timeoutMs`, and one still short of it gets only the time actually left.
   */
  enqueue(waiter: Waiter): boolean {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return false;

    if (mutable.deadlineAt !== undefined && this.options.clock.now() >= mutable.deadlineAt) {
      if (this.reject(mutable, new QueueTimeoutError(mutable.id))) {
        try {
          this.options.onTimeout?.(mutable);
        } catch {
          // Queue wake-up is an observer of this committed timeout fact.
        }
      }
      return false;
    }

    if (!this.#waiters.includes(mutable)) {
      this.#waiters.push(mutable);
      this.notifyProgress(mutable, { queuePosition: this.#waiters.length, stage: "queued" });
    }
    mutable.state = "queued";
    this.#armTimeout(mutable);
    return true;
  }

  markProcessing(waiter: Waiter): boolean {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return false;
    mutable.state = "processing";
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

  detachProgress(requesterId: string): boolean {
    const waiter = this.#waiters.find((candidate) => candidate.options.requesterId === requesterId);
    if (waiter === undefined) return false;
    waiter.onProgress = undefined;
    return true;
  }

  attachProgress(waiter: Waiter, onProgress: (progress: LeaseProgress) => void): boolean {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return false;
    mutable.onProgress = onProgress;
    return true;
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
    if (index !== -1) this.#waiters.splice(index, 1);
    this.#pendingWaiters.delete(waiter);
    if (waiter.timer !== undefined) {
      this.options.clock.cancel(waiter.timer);
      waiter.timer = undefined;
    }
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
