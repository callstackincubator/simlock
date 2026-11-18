import type { EventBus, EventMap } from "../bus/index.js";
import type { FleetQueue, FleetWaiter } from "./queue.js";
import type { Rejection } from "./routing/index.js";

export interface FleetFactsOptions {
  readonly eventBus: Pick<EventBus, "emit">;
}

export type FleetEventName =
  | "lease.requested"
  | "lease.queued"
  | "lease.rejected"
  | "queue.changed"
  | "request.dispatched"
  | "request.granted";

export class FleetFacts {
  constructor(private readonly options: FleetFactsOptions) {}

  emit<Event extends FleetEventName>(event: Event, payload: EventMap[Event]): void {
    this.options.eventBus.emit(event, payload, "fleet-lease-coordinator");
  }

  rejected(
    waiter: FleetWaiter,
    reason: EventMap["lease.rejected"]["reason"],
    failedOn?: { readonly code: string; readonly worker: string },
  ): void {
    this.emit("lease.rejected", {
      requestId: waiter.id,
      requester: waiter.options.requesterId,
      requestSpec: waiter.request,
      reason,
      // why: `worker`, never `workerId`: that key marks an event relayed from a worker (ADR 0014 §6).
      ...(failedOn === undefined ? {} : { code: failedOn.code, worker: failedOn.worker }),
    });
  }
}

export interface FleetOutcomesOptions {
  readonly queue: FleetQueue;
  readonly facts: FleetFacts;
}

export class FleetOutcomes {
  constructor(private readonly options: FleetOutcomesOptions) {}

  enqueue(waiter: FleetWaiter): void {
    const alreadyQueued = this.options.queue.isQueued(waiter);
    if (this.options.queue.enqueue(waiter) && !alreadyQueued) {
      this.options.facts.emit("lease.queued", {
        queuePosition: this.options.queue.positionOf(waiter),
        requestId: waiter.id,
      });
    }
  }

  reject(
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
    if (this.options.queue.reject(waiter, error)) {
      this.options.facts.rejected(waiter, reason, failedOn);
    }
  }
}
