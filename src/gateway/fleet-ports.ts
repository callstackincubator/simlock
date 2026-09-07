/**
 * `src/gateway/fleet-ports.ts` -- the seam #118 (fleet queue, routing, forwarding) codes
 * against, declared here so that PR can be written while this one's internals are still
 * being revised.
 *
 * Nothing here has an implementation of its own: `WorkerLink`, `WorkerRegistry` and
 * `GatewayService` satisfy these shapes, and the point is that #118 never imports those
 * classes directly -- so a change *behind* one of these shapes (a call timeout, the
 * drain-flag split, a truncation guard) is not a change #118 has to see.
 *
 * Declared before its consumer exists, so `fallow` is told that is deliberate -- the same
 * annotation `DrainStore` already carries in `index.ts`. #118 owns these shapes once it
 * lands: if one is wrong, that PR changes it rather than working around it.
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
}

/** Resolves a worker id to its live link. `GatewayService` satisfies this. */
// fallow-ignore-next-line unused-type -- #118's seam; declared before its consumer exists.
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
// fallow-ignore-next-line unused-type -- #118's seam; declared before its consumer exists.
export interface FleetViews {
  views(): readonly WorkerView[];
  view(workerId: string): WorkerView | undefined;
  onViewsChanged(listener: () => void): () => void;
}
