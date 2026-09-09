/**
 * `src/gateway/fleet-ports.ts` -- the seam #118 (`FleetLeaseCoordinator`, in
 * `fleet-coordinator.ts`) codes against instead of importing `WorkerLink`/`WorkerRegistry`/
 * `GatewayService` directly, so a change *behind* one of these shapes (a call timeout, the
 * drain-flag split, a truncation guard) is not a change the coordinator has to see.
 *
 * Nothing here has an implementation of its own: `WorkerLink` satisfies `WorkerDispatchTarget`,
 * `WorkerRegistry` satisfies `FleetViews`, and `GatewayService` satisfies `WorkerDirectory`.
 * These shapes are #118's now: `refresh()` on `WorkerDispatchTarget` is this PR's own addition
 * (see its doc comment) -- the seam changes here, not around it, when one of these shapes turns
 * out to be missing something the coordinator needs.
 */
import type { SimlockAdminClient } from "../admin/index.js";
import type { WorkerView } from "./worker-registry.js";

/**
 * One worker, addressed for dispatch. `WorkerLink` satisfies this.
 *
 * `client()` is the gateway's own admin session on that worker -- the same one the link uses
 * for its refresh round trips -- because every call #118 forwards (`lease.request`,
 * `lease.renew`, `lease.release`, `lease.cancel`, `device.exec`, and `lease.list` for the
 * reconnect rebuild) is one that session can already make. It returns `undefined` before
 * `start()` has completed or after `close()`. #118 may narrow this to purpose-built methods
 * if the wider shape proves too permissive for `boundary.test.ts`.
 *
 * `reachable` is false once the uplink is closing or closed. Answering a forwarded call for
 * an unreachable worker is #119's `WORKER_UNREACHABLE`, not this PR's concern.
 */
export interface WorkerDispatchTarget {
  readonly workerId: string;
  readonly reachable: boolean;
  client(): SimlockAdminClient | undefined;
  /**
   * Added by #118. Forces this worker's view to be re-read now, rather than waiting for the
   * next lease event or the periodic tick. Called after a stale-view `NO_CAPACITY` (ADR §11:
   * "it means the view was stale, so the gateway refreshes that worker's view and the request
   * waits") -- without it, a request that lost a race to a stale view would sit queued for up
   * to the periodic tick's whole interval before the gateway even tried to find out whether the
   * view was right. `WorkerLink` already does this same refresh for every other trigger this
   * interface's other members are read from (a lease event, the periodic tick); this is the one
   * more call site, and `WorkerLink#refresh` already accepts being called with no arguments.
   * Never rejects, mirroring `WorkerLink#refresh`'s own best-effort contract.
   */
  refresh(): Promise<void>;
}

/** Resolves a worker id to its live link. `GatewayService` satisfies this;
 * `FleetLeaseCoordinator` is the consumer. */
export interface WorkerDirectory {
  target(workerId: string): WorkerDispatchTarget | undefined;
}

/**
 * The fleet's views, plus the signal that one changed. `WorkerRegistry` satisfies this.
 *
 * `onViewsChanged` is what makes ADR §11's "dispatch runs whenever the queue or any worker
 * view changes" implementable without #118 reaching into the registry's internals or polling
 * it. Listeners are called *after* the change is committed (and after the corresponding event
 * is emitted), per `events.md`'s post-commit rule; the returned function unsubscribes.
 */
export interface FleetViews {
  views(): readonly WorkerView[];
  view(workerId: string): WorkerView | undefined;
  onViewsChanged(listener: () => void): () => void;
}
