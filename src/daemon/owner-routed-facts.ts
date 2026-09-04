import type { EventBus } from "../bus/index.js";
import type { Registry } from "../core/index.js";

/**
 * ADR 0003 §8's three lease-scoped push facts, translated once from the raw event bus into a
 * shape that already carries the owning principal -- "pushed to every live connection whose
 * principal owns the lease". `DaemonServer` is the socket-side consumer (its per-connection
 * push routing lives in `#notifyLeaseLost`/`#notifyDeviceUnhealthy`/`#notifyDeviceRecovered`);
 * `LeaseNoticeBuffer` (HTTP, `src/http/notices.ts`) is the other -- both subscribe to the same
 * instance instead of each independently subscribing to the raw bus and re-deriving `ownerId`
 * (or, for `notices.ts` before this PR, not needing it at all because it only ever kept the
 * fact scoped by lease id -- but still duplicating the raw-event-to-fact translation).
 */
export type OwnerRoutedFact =
  | {
      readonly type: "lease-lost";
      readonly leaseId: string;
      readonly deviceId: string;
      readonly reason: string;
      readonly ownerId: string;
    }
  | {
      readonly type: "device-unhealthy";
      readonly leaseId: string;
      readonly deviceId: string;
      readonly ownerId: string;
    }
  | {
      readonly type: "device-recovered";
      readonly leaseId: string;
      readonly deviceId: string;
      readonly attempts: number;
      readonly ownerId: string;
    };

export interface OwnerRoutedFacts {
  subscribe(listener: (fact: OwnerRoutedFact) => void): () => void;
}

/**
 * Subscribes to the underlying event bus once (at construction) and re-emits the three
 * lease-scoped facts, each carrying the lease's owner. `lease.expired`/`lease.released` carry
 * `ownerId` on the event payload itself (the lease is already gone from the registry by the
 * time either fires, so there is nothing left to look up); `device.crash-detected`/
 * `device.recovered` fire for a lease that is still active, so `ownerId` is read from the live
 * registry at the moment the event arrives -- dropped silently if the lease has since gone
 * (matches the pre-extraction behaviour in `DaemonServer`).
 */
export class OwnerRoutedFactBus implements OwnerRoutedFacts {
  readonly #listeners = new Set<(fact: OwnerRoutedFact) => void>();
  readonly #unsubscribers: Array<() => void>;

  constructor(
    eventBus: EventBus,
    private readonly registry: Pick<Registry, "snapshot">,
  ) {
    this.#unsubscribers = [
      eventBus.subscribe("lease.expired", (envelope) =>
        this.#emit({
          deviceId: envelope.payload.deviceId,
          leaseId: envelope.payload.leaseId,
          ownerId: envelope.payload.ownerId,
          reason: "expired",
          type: "lease-lost",
        }),
      ),
      eventBus.subscribe("lease.released", (envelope) =>
        this.#emit({
          deviceId: envelope.payload.deviceId,
          leaseId: envelope.payload.leaseId,
          ownerId: envelope.payload.ownerId,
          reason: envelope.payload.reason,
          type: "lease-lost",
        }),
      ),
      eventBus.subscribe("device.crash-detected", (envelope) => {
        const ownerId = this.#leaseOwner(envelope.payload.leaseId);
        if (ownerId === undefined) return;
        this.#emit({
          deviceId: envelope.payload.deviceId,
          leaseId: envelope.payload.leaseId,
          ownerId,
          type: "device-unhealthy",
        });
      }),
      eventBus.subscribe("device.recovered", (envelope) => {
        const ownerId = this.#leaseOwner(envelope.payload.leaseId);
        if (ownerId === undefined) return;
        this.#emit({
          attempts: envelope.payload.attempts,
          deviceId: envelope.payload.deviceId,
          leaseId: envelope.payload.leaseId,
          ownerId,
          type: "device-recovered",
        });
      }),
    ];
  }

  subscribe(listener: (fact: OwnerRoutedFact) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
  }

  #leaseOwner(leaseId: string): string | undefined {
    return this.registry.snapshot.leases.find((lease) => lease.id === leaseId)?.ownerId;
  }

  #emit(fact: OwnerRoutedFact): void {
    for (const listener of this.#listeners) listener(fact);
  }
}
