/**
 * `GatewayOwnerRoutedFacts`: the gateway's own `OwnerRoutedFacts` (`src/daemon/owner-routed-facts.ts`),
 * replacing `inertOwnerRoutedFacts()` once #118 gives the gateway leases of its own to report
 * facts about.
 *
 * `WorkerLink#onWorkerEvent` republishes a worker's business events on the gateway's bus with
 * `workerId` added, under their original names -- including `lease.expired`/`lease.released`,
 * whose payload carries the *worker's* `ownerId` (the lease's real owner, since ADR §27a) and
 * the *worker's own* `leaseId`, not the gateway's synthesized one. **Do not trust either
 * verbatim**: a relayed event's `ownerId` is correct for a worker-local lease, but for a
 * gateway-issued one it is only ever recoverable through `FleetLeaseIndex` -- which is exactly
 * what round-tripped it home in the first place. Routing straight off the relayed payload would
 * still "work" in the sense of pushing *a* fact to *someone*, which is what makes the bug worth
 * naming: it would push one client's `lease-lost` at another, or at nobody, depending on which
 * `ownerId` string a worker's own local principal happened to collide with.
 *
 * `device.crash-detected`/`device.recovered` are looked up the same way, but never removed --
 * the lease those describe is still active; only `lease.expired`/`lease.released` end one, and
 * `FleetLeaseIndex#removeByWorkerLease` is the one place that happens for either (see its own
 * doc comment on why the lookup and the forget are one atomic step here rather than two
 * independently-ordered bus subscriptions).
 *
 * A lease not found in the index at all is a worker's own local lease (or, briefly, a race the
 * gateway lost against its own index rebuild) -- either way, not this gateway's fact to relay,
 * so nothing is emitted for it.
 */
import type { EventBus } from "../bus/index.js";
import type { FleetLeaseIndex } from "./lease-index.js";

/**
 * Structurally identical to `src/daemon/owner-routed-facts.ts`'s own `OwnerRoutedFact`/
 * `OwnerRoutedFacts` -- declared again here, rather than imported, because ADR 0005 §33 allows
 * `src/gateway` exactly one `src/daemon` import (`daemon/dispatch.js`, enforced by
 * `boundary.test.ts`) and this shape does not need to be the second one: `DaemonServer` accepts
 * anything satisfying it, and main.ts is what hands this class to a `DaemonServer` built outside
 * `src/gateway`, where the two names line up with no cast required.
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

/** The fields this class reads off a relayed event's payload -- deliberately not `EventMap`'s
 * own declared shape, which knows nothing about `workerId` (added only by the relay, at the
 * bus-agnostic edge `WorkerLink#onWorkerEvent` owns). */
interface RelayedLeaseEvent {
  readonly leaseId: string;
  readonly deviceId: string;
  readonly workerId: string;
}

export class GatewayOwnerRoutedFacts implements OwnerRoutedFacts {
  readonly #listeners = new Set<(fact: OwnerRoutedFact) => void>();
  readonly #unsubscribers: Array<() => void>;

  constructor(
    eventBus: EventBus,
    private readonly leaseIndex: Pick<FleetLeaseIndex, "removeByWorkerLease" | "findByWorkerLease">,
  ) {
    this.#unsubscribers = [
      eventBus.subscribe("lease.expired", (envelope) => {
        const relayed = envelope.payload as unknown as RelayedLeaseEvent;
        const entry = this.leaseIndex.removeByWorkerLease(relayed.workerId, relayed.leaseId);
        if (entry === undefined) return;
        this.#emit({
          deviceId: relayed.deviceId,
          leaseId: entry.gatewayLeaseId,
          ownerId: entry.ownerId,
          reason: "expired",
          type: "lease-lost",
        });
      }),
      eventBus.subscribe("lease.released", (envelope) => {
        const relayed = envelope.payload as unknown as RelayedLeaseEvent & {
          readonly reason: string;
        };
        const entry = this.leaseIndex.removeByWorkerLease(relayed.workerId, relayed.leaseId);
        if (entry === undefined) return;
        this.#emit({
          deviceId: relayed.deviceId,
          leaseId: entry.gatewayLeaseId,
          ownerId: entry.ownerId,
          reason: relayed.reason,
          type: "lease-lost",
        });
      }),
      eventBus.subscribe("device.crash-detected", (envelope) => {
        const relayed = envelope.payload as unknown as RelayedLeaseEvent;
        const entry = this.leaseIndex.findByWorkerLease(relayed.workerId, relayed.leaseId);
        if (entry === undefined) return;
        this.#emit({
          deviceId: relayed.deviceId,
          leaseId: entry.gatewayLeaseId,
          ownerId: entry.ownerId,
          type: "device-unhealthy",
        });
      }),
      eventBus.subscribe("device.recovered", (envelope) => {
        const relayed = envelope.payload as unknown as RelayedLeaseEvent & {
          readonly attempts: number;
        };
        const entry = this.leaseIndex.findByWorkerLease(relayed.workerId, relayed.leaseId);
        if (entry === undefined) return;
        this.#emit({
          attempts: relayed.attempts,
          deviceId: relayed.deviceId,
          leaseId: entry.gatewayLeaseId,
          ownerId: entry.ownerId,
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

  #emit(fact: OwnerRoutedFact): void {
    for (const listener of this.#listeners) listener(fact);
  }
}
