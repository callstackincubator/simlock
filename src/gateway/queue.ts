/**
 * The fleet's one FIFO (ADR 0005 §10/§11): a thin composition over `src/core/wait-queue.ts`'s
 * `WaitQueue`, not a fork of it. `WaitQueue` already owns exactly the state a fleet queue needs
 * -- FIFO membership, per-request timeout/cancellation, and settlement promises -- and its
 * `LeaseRequestOptions` (`requesterId`, `ownerId`, `timeoutMs`, `noWait`, `allowDownload`,
 * `onProgress`, `ttlMs`) are already the fields a fleet request carries. This module only
 * narrows `WaitQueue`'s generic `Waiter`/`LeaseGrant` shapes to what the fleet actually produces
 * (a `DeviceRequest` for the request, and a lease record that may additionally carry `worker`
 * once it names a machine) and forwards every method through.
 *
 * `DeviceRequest`/`DeviceRecord`/`LeaseRecord`/`WaiterState` are `wait-queue.js`'s own transitive
 * type imports (`core/domain.js`, `core/driver.js`) -- see `boundary.test.ts`'s
 * `ALLOWED_CORE_IMPORTS` -- not a reach into the registry, capacity, or lifecycle engine ADR 0005
 * §33 keeps off limits.
 */
import type { Clock, IdGenerator } from "../ports/index.js";
import type { LeaseRecord } from "../core/domain.js";
import type { DeviceRequest } from "../core/driver.js";
import {
  WaitQueue,
  type LeaseProgress,
  type LeaseRequestOptions,
  type WaiterState,
} from "../core/wait-queue.js";

export type { LeaseProgress, LeaseRequestOptions } from "../core/wait-queue.js";
export { RequestCancelledError, RequesterAlreadyLeasedError } from "../core/wait-queue.js";

/**
 * The lease record a fleet grant carries. Identical to a worker's own `LeaseRecord` plus the
 * additive `worker` (ADR 0005 §18) `FleetLeaseCoordinator` stamps once it knows which machine
 * granted it -- absent on nothing this queue itself ever produces (it never grants; the
 * coordinator does), so the type says `?` rather than the coordinator having to fabricate one.
 */
export type FleetLeaseRecord = LeaseRecord & {
  readonly worker?: { readonly id: string; readonly label?: string };
};

/**
 * A fleet grant: the worker's own device/environment/timing, forwarded verbatim (the gateway
 * never interprets either -- it is not the driver that produced them), plus the lease record
 * above. Untyped (`unknown`) on `device`/`timing` for the same reason: this module has no
 * business knowing their shape, only relaying it.
 */
export interface FleetLeaseGrant {
  readonly device: unknown;
  readonly environment: Readonly<Record<string, string>>;
  readonly lease: FleetLeaseRecord;
  readonly timing: unknown;
}

export interface FleetWaiter {
  readonly id: string;
  readonly request: DeviceRequest;
  readonly options: LeaseRequestOptions;
  readonly promise: Promise<FleetLeaseGrant>;
  readonly state: WaiterState;
}

export interface FleetQueueOptions {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Called after a timed-out waiter has been removed and rejected -- the rejection itself
   * already happened inside `WaitQueue#armTimeout` by the time this fires; `FleetLeaseCoordinator`
   * uses it only to report the gateway's own `lease.rejected` fact for that already-committed
   * timeout (H10, round 2 review: this comment used to say it wakes the dispatch loop the same
   * way a release or worker-view change does -- it does not; the timed-out waiter is already
   * terminal and gone from the queue, and nothing here re-runs `#dispatch` for the *other*
   * waiters still behind it). */
  readonly onTimeout?: (waiter: FleetWaiter) => void;
}

/**
 * Casts a `WaitQueue`-native value to its fleet-shaped counterpart. `WaitQueue` itself has no
 * fleet awareness (by design -- it stays platform-agnostic and worker-agnostic alike), so the
 * cast is this module's whole job: every fleet-facing method below either takes a `FleetWaiter`
 * and hands `WaitQueue` back exactly what it minted (never a waiter from a different `FleetQueue`
 * or from the worker's own acquisition path, so the shapes always agree at runtime even though
 * `WaitQueue`'s own types do not know that).
 */
function asFleet<Value>(value: Value): Value extends undefined ? undefined : FleetWaiter {
  return value as never;
}

export class FleetQueue {
  readonly #queue: WaitQueue;

  constructor(options: FleetQueueOptions) {
    this.#queue = new WaitQueue({
      clock: options.clock,
      idGenerator: options.idGenerator,
      ...(options.onTimeout === undefined
        ? {}
        : { onTimeout: (waiter) => options.onTimeout?.(asFleet(waiter)) }),
    });
  }

  get depth(): number {
    return this.#queue.depth;
  }

  /** Every waiter still holding a slot, oldest first (ADR 0005 §11's dispatch order). See
   * `WaitQueue#list`. */
  list(): readonly FleetWaiter[] {
    return this.#queue.list().map((waiter) => asFleet(waiter));
  }

  hasPendingRequester(requesterId: string): boolean {
    return this.#queue.hasPendingRequester(requesterId);
  }

  findPendingWaiter(requesterId: string): FleetWaiter | undefined {
    return asFleet(this.#queue.findPendingWaiter(requesterId));
  }

  create(request: DeviceRequest, options: LeaseRequestOptions): FleetWaiter {
    return asFleet(this.#queue.create(request, options));
  }

  enqueue(waiter: FleetWaiter): boolean {
    return this.#queue.enqueue(waiter as never);
  }

  markProcessing(waiter: FleetWaiter): boolean {
    return this.#queue.markProcessing(waiter as never);
  }

  isQueued(waiter: FleetWaiter): boolean {
    return this.#queue.isQueued(waiter as never);
  }

  notifyProgress(waiter: FleetWaiter, progress: LeaseProgress): void {
    this.#queue.notifyProgress(waiter as never, progress);
  }

  resolve(waiter: FleetWaiter, grant: FleetLeaseGrant): boolean {
    return this.#queue.resolve(waiter as never, grant as never);
  }

  reject(waiter: FleetWaiter, error: Error): boolean {
    return this.#queue.reject(waiter as never, error);
  }

  cancelAll(error: Error | ((waiter: FleetWaiter) => Error)): readonly FleetWaiter[] {
    if (typeof error === "function") {
      return this.#queue
        .cancelAll((waiter) => error(asFleet(waiter)))
        .map((waiter) => asFleet(waiter));
    }
    return this.#queue.cancelAll(error).map((waiter) => asFleet(waiter));
  }
}
