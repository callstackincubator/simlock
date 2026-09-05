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

  enqueue(waiter: Waiter): boolean {
    const mutable = this.#mutable(waiter);
    if (isTerminal(mutable.state)) return false;

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

  notifyProgress(waiter: Waiter, progress: LeaseProgress): void {
    const mutable = this.#mutable(waiter);
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

  #armTimeout(waiter: MutableWaiter): void {
    if (waiter.timer !== undefined || waiter.options.timeoutMs === undefined) return;
    waiter.timer = this.options.clock.setTimer(waiter.options.timeoutMs, () => {
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
