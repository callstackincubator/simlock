import type { Clock, IdGenerator } from "../ports/index.js";
import { type LeaseRecord, type DeviceRequest, type LeaseProgress } from "../core/index.js";
import type { Platform } from "../contract/index.js";
import {
  WaitQueue,
  type LeaseRequestOptions,
  type QueuePlace,
  type WaiterState,
} from "../leasing/index.js";

export type { LeaseProgress } from "../core/index.js";
export { lineOf } from "../leasing/index.js";
export type { LeaseRequestOptions } from "../leasing/index.js";
export { RequestCancelledError, RequesterAlreadyLeasedError } from "../leasing/index.js";

/** `worker` is optional because this queue never grants; the coordinator stamps it later. */
export type FleetLeaseRecord = LeaseRecord & {
  readonly worker?: { readonly id: string; readonly label?: string };
};

/** `device` and `timing` are `unknown`: the gateway only relays them. */
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
  /** Reports the timeout only; it does not wake the dispatch loop for the waiters behind. */
  readonly onTimeout?: (waiter: FleetWaiter) => void;
  readonly onDepthChange?: ((depth: number, line: "virtual" | "physical") => void) | undefined;
}

/** `WaitQueue` has no fleet awareness; every waiter reaching here was minted by this queue, so the cast holds. */
function asFleet<Value>(value: Value): Value extends undefined ? undefined : FleetWaiter {
  return value as never;
}

export class FleetQueue {
  readonly #queue: WaitQueue;

  constructor(options: FleetQueueOptions) {
    this.#queue = new WaitQueue({
      clock: options.clock,
      idGenerator: options.idGenerator,
      onDepthChange: options.onDepthChange,
      ...(options.onTimeout === undefined
        ? {}
        : { onTimeout: (waiter) => options.onTimeout?.(asFleet(waiter)) }),
    });
  }

  get depth(): number {
    return this.#queue.depth;
  }

  get physicalDepth(): number {
    return this.#queue.physicalDepth;
  }

  list(): readonly FleetWaiter[] {
    return this.#queue.list().map((waiter) => asFleet(waiter));
  }

  places(): readonly QueuePlace[] {
    return this.#queue.places();
  }

  pendingPlatforms(requesterId: string): readonly Platform[] {
    return this.#queue.pendingPlatforms(requesterId);
  }

  findPendingWaiter(requesterId: string, platform?: Platform): FleetWaiter | undefined {
    return asFleet(this.#queue.findPendingWaiter(requesterId, platform));
  }

  create(request: DeviceRequest, options: LeaseRequestOptions, id?: string): FleetWaiter {
    return asFleet(this.#queue.create(request, options, id));
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
