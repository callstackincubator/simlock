import type { Clock } from "../ports/index.js";
import type { EndedLeaseIds } from "./ended-lease-ids.js";
import type { FleetViews } from "./fleet-ports.js";
import type { FleetLeaseIndex } from "./lease-index.js";
import type { WorkerView } from "./worker-registry.js";

export interface FleetIndexUpkeepOptions {
  readonly clock: Clock;
  readonly endedLeaseIds: EndedLeaseIds;
  readonly leaseIndex: FleetLeaseIndex;
  readonly views: Pick<FleetViews, "views">;
}

export class FleetIndexUpkeep {
  #knownWorkerIds = new Set<string>();
  /** why: C1 (round 2 review): the `view.leases` array reference this coordinator last reconciled
   * into `leaseIndex` for each worker, keyed by worker id. `onViewsChanged` fires for *every*
   * worker-view mutation on the whole registry (`connected`, `refresh`, `disconnected`,
   * `setDrained`, `remove`, `pruneExpired` -- see `FleetViews#onViewsChanged`'s own doc), not
   * just a change to the worker being reconciled, so calling `rebuildFromWorker` for every view
   * on every notification bumped a worker's reconciliation generation without a new snapshot
   * ever having arrived for it (see `#onViewsChanged`'s own doc for the eviction this caused).
   * `WorkerRegistry` only ever replaces a view's `leases` array when a snapshot naming `leases`
   * actually lands for that specific worker (`refresh`'s partial-update contract; `connected` and
   * `disconnected` never touch it) -- so this reference is exactly "a new snapshot for this
   * worker arrived" and nothing else, with no need to widen `FleetViews` to carry worker
   * identity on the notification itself. */
  readonly #lastReconciledLeases = new Map<string, NonNullable<WorkerView["leases"]>>();

  constructor(private readonly options: FleetIndexUpkeepOptions) {
    options.leaseIndex.onEnded((entry) => {
      if (entry.idChosenByRequester === true) {
        options.endedLeaseIds.record(entry.gatewayLeaseId, options.clock.now());
      }
    });
  }

  /**
   * why: §30's reconnect rebuild, and its own upkeep on every worker-view change: reconciles each
   * worker's entries against its current view -- adding any gateway-issued lease the index does
   * not already know and, a generation later, forgetting one the view has stopped reporting at
   * all (see `FleetLeaseIndex#rebuildFromWorker`'s own doc comment, C3 round 2 review) -- forgets
   * a worker's entries entirely once its view has disappeared (`worker.remove`, or retention),
   * then runs a dispatch pass.
   *
   * C1 (round 2 review): `rebuildFromWorker` runs *only* for a worker whose `view.leases`
   * reference actually changed since the last time this method reconciled it -- see
   * `#lastReconciledLeases`'s own doc. Before this fix, every view was reconciled on *every*
   * notification regardless of which worker it was about: two view changes on worker B alone
   * bumped worker A's reconciliation generation twice against A's own byte-identical, stale
   * cached snapshot, which is enough for `rebuildFromWorker`'s two-consecutive-misses rule to
   * evict a lease on A that was never actually missing from a real snapshot at all -- silently
   * violating ADR §14 (the fleet-wide one-lease check reads this same index) and losing the
   * `lease-lost` push `GatewayOwnerRoutedFacts` would otherwise emit for it.
   */
  reconcile(): void {
    const views = this.options.views.views();
    const currentIds = new Set(views.map((view) => view.id));
    for (const view of views) {
      // why: A starting worker's view has no `leases`: nothing was read, so the index keeps what it
      // holds for that worker until the worker answers `running`.
      if (view.leases === undefined) continue;
      if (this.#lastReconciledLeases.get(view.id) === view.leases) continue;
      this.options.leaseIndex.rebuildFromWorker(view.id, view.leases, view.devices);
      this.#lastReconciledLeases.set(view.id, view.leases);
    }
    for (const workerId of this.#knownWorkerIds) {
      if (!currentIds.has(workerId)) {
        this.options.leaseIndex.forgetWorker(workerId);
        this.#lastReconciledLeases.delete(workerId);
      }
    }
    this.#knownWorkerIds = currentIds;
  }
}
